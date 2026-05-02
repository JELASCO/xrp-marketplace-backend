const express = require('express');
const router = express.Router();
const _rateLimit = require('express-rate-limit');
const rateLimit = _rateLimit.default || _rateLimit;
const db = require('../db');
const jwt = require('jsonwebtoken');
const escrowService = require('../escrow/escrowService');
const xummService = require('../xumm/xummService');
const { notify } = require('../notifications/socket');
async function pushNotif(userId, type, payload) {
  try {
    await db.query('INSERT INTO notifications (user_id, type, payload) VALUES ($1,$2,$3)', [userId, type, JSON.stringify(payload)]);
    notify(userId, 'notification', { type, payload, created_at: new Date().toISOString() });
  } catch(e) { console.warn('[Notif]', e.message); }
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  validate: { xForwardedForHeader: false }
});
router.use(limiter);

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// Auth
router.post('/auth/signin', async (req, res) => {
  try {
    const result = await xummService.createSignInPayload();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/auth/verify', async (req, res) => {
  try {
    const { uuid } = req.body;
    const result = await xummService.verifySignIn(uuid);
    if (!result.signed) return res.status(400).json({ error: 'Not signed yet' });
    const walletAddress = result.walletAddress;
    let user = await db.query('SELECT * FROM users WHERE wallet_address = $1', [walletAddress]);
    if (user.rows.length === 0) {
      const username = 'user_' + walletAddress.slice(-6).toLowerCase();
      user = await db.query('INSERT INTO users (wallet_address, username) VALUES ($1, $2) RETURNING *', [walletAddress, username]);
    }
    const u = user.rows[0];
    const token = jwt.sign(
      { id: u.id, walletAddress: u.wallet_address, role: u.role || 'user' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    res.json({ token, user: { id: u.id, username: u.username, walletAddress: u.wallet_address, role: u.role || 'user' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/auth/me', auth, async (req, res) => {
  try {
    const user = await db.query('SELECT id, username, wallet_address, role, bio, reputation_score, is_verified FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });
    const u = user.rows[0];
    res.json({ id: u.id, username: u.username, walletAddress: u.wallet_address, role: u.role || 'user', bio: u.bio, reputationScore: u.reputation_score, isVerified: u.is_verified });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Users
router.get('/users/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT id, username, wallet_address, bio, reputation_score, is_verified, avatar_url, created_at FROM users WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/users/me', auth, async (req, res) => {
  try {
    const { username, bio, avatar_url } = req.body;
    await db.query(
      'UPDATE users SET username = COALESCE($1, username), bio = COALESCE($2, bio), avatar_url = COALESCE($3, avatar_url) WHERE id = $4::uuid',
      [username || null, bio || null, avatar_url || null, req.user.id]
    );
    const r = await db.query('SELECT * FROM users WHERE id = $1::uuid', [req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Listings
router.get('/listings', async (req, res) => {
  try {
    const { category, game, sort, limit = 48, offset = 0, q: search } = req.query;
    let sql = "SELECT l.*, u.username, u.reputation_score, u.is_verified FROM listings l JOIN users u ON l.seller_id = u.id WHERE l.status = 'active'";
    const params = [];
    if (category) { params.push(category); sql += ' AND l.category = $' + params.length; }
    if (game) { params.push(game); sql += ' AND l.game = $' + params.length; }
    if (search) { params.push('%' + search + '%'); sql += ' AND l.title ILIKE $' + params.length; }
    const orderMap = { price_asc: 'l.price_xrp ASC', price_desc: 'l.price_xrp DESC', views: 'l.views DESC', created_at: 'l.created_at DESC' };
    sql += ' ORDER BY l.is_featured DESC, ' + (orderMap[sort] || 'l.created_at DESC');
    params.push(parseInt(limit)); sql += ' LIMIT $' + params.length;
    params.push(parseInt(offset)); sql += ' OFFSET $' + params.length;
    const r = await db.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/listings/:id', async (req, res) => {
  try {
    await db.query('UPDATE listings SET views = views + 1 WHERE id = $1', [req.params.id]);
    const r = await db.query('SELECT l.*, u.username, u.reputation_score, u.is_verified, u.wallet_address FROM listings l JOIN users u ON l.seller_id = u.id WHERE l.id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/listings', auth, async (req, res) => {
  try {
    const { title, description, category, game, priceXrp, images } = req.body;
    if (!title || !priceXrp) return res.status(400).json({ error: 'title and priceXrp required' });
    const r = await db.query('INSERT INTO listings (seller_id, title, description, category, game, price_xrp, images) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [req.user.id, title, description, category, game, priceXrp, images || []]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/listings/:id', auth, async (req, res) => {
  try {
    const listing = await db.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!listing.rows[0]) return res.status(404).json({ error: 'Not found' });
    if (listing.rows[0].seller_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { title, description, price_xrp, status } = req.body;
    const r = await db.query('UPDATE listings SET title=COALESCE($1,title), description=COALESCE($2,description), price_xrp=COALESCE($3,price_xrp), status=COALESCE($4,status) WHERE id=$5 RETURNING *', [title, description, price_xrp, status, req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Orders
router.post('/orders', auth, async (req, res) => {
  try {
    const { listingId } = req.body;
    const listing = await db.query("SELECT * FROM listings WHERE id = $1 AND status = 'active'", [listingId]);
    if (!listing.rows[0]) return res.status(404).json({ error: 'Listing not found or not active' });
    const l = listing.rows[0];
    if (l.seller_id === req.user.id) return res.status(400).json({ error: 'Cannot buy your own listing' });
    const commissionRate = parseFloat(process.env.COMMISSION_RATE || '0.03');
    const commission = parseFloat((l.price_xrp * commissionRate).toFixed(6));
    const sellerReceives = parseFloat((l.price_xrp - commission).toFixed(6));
    const buyer = await db.query('SELECT wallet_address FROM users WHERE id = $1', [req.user.id]);
    const seller = await db.query('SELECT wallet_address FROM users WHERE id = $1', [l.seller_id]);
    const order = await db.query(
      'INSERT INTO orders (buyer_id, seller_id, listing_id, buyer_wallet_address, seller_wallet_address, total_xrp, commission_rate, commission_xrp, seller_receives_xrp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [req.user.id, l.seller_id, listingId, buyer.rows[0].wallet_address, seller.rows[0].wallet_address, l.price_xrp, commissionRate, commission, sellerReceives]
    );
    pushNotif(l.seller_id, 'new_order', { orderId: order.rows[0].id, listingTitle: l.title, priceXrp: l.price_xrp });
      res.status(201).json({ ...order.rows[0], listing_title: l.title });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders/mine', auth, async (req, res) => {
  try {
    const role = req.query.role === 'seller' ? 'seller' : 'buyer';
    const col = role === 'buyer' ? 'o.buyer_id' : 'o.seller_id';
    const r = await db.query('SELECT o.*, l.title as listing_title, l.images FROM orders o JOIN listings l ON o.listing_id = l.id WHERE ' + col + ' = $1 ORDER BY o.created_at DESC', [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders/:id', auth, async (req, res) => {
  try {
    const r = await db.query('SELECT o.*, l.title as listing_title FROM orders o JOIN listings l ON o.listing_id = l.id WHERE o.id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const order = r.rows[0];
    if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/orders/:id/escrow/xumm-payload', auth, async (req, res) => {
  try {
    const order = await db.query('SELECT o.*, l.price_xrp, u.wallet_address as seller_address FROM orders o JOIN listings l ON o.listing_id = l.id JOIN users u ON o.seller_id = u.id WHERE o.id = $1', [req.params.id]);
    if (!order.rows[0]) return res.status(404).json({ error: 'Order not found' });
    const o = order.rows[0];
    if (o.buyer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (o.status !== 'pending') return res.status(400).json({ error: 'Order not pending' });
    const buyer = await db.query('SELECT wallet_address FROM users WHERE id = $1', [req.user.id]);
    const buyerAddress = buyer.rows[0].wallet_address;
    const RIPPLE_EPOCH = 946684800;
    const cancelAfter = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + 7 * 86400;
    const payload = await xummService.createEscrowPayload({ buyerAddress, sellerAddress: o.seller_address, xrpAmount: o.total_xrp, cancelAfter, orderId: o.id });
    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders/:id/escrow/status', auth, async (req, res) => {
  try {
    const order = await db.query('SELECT o.*, u.wallet_address as buyer_address FROM orders o JOIN users u ON o.buyer_id = u.id WHERE o.id = $1', [req.params.id]);
    if (!order.rows[0]) return res.status(404).json({ error: 'Not found' });
    const o = order.rows[0];
    if (!o.escrow_sequence) return res.json({ status: o.status });
    const onChain = await escrowService.getEscrowStatus(o.buyer_address, o.escrow_sequence);
    res.json({ status: o.status, onChain });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/orders/:id/escrow/confirm', auth, async (req, res) => {
  try {
    const order = await db.query('SELECT o.*, u.wallet_address as buyer_address FROM orders o JOIN users u ON o.buyer_id = u.id WHERE o.id = $1', [req.params.id]);
    if (!order.rows[0]) return res.status(404).json({ error: 'Not found' });
    const o = order.rows[0];
    if (o.buyer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (o.status === 'completed' || o.status === 'refunded' || o.status === 'disputed') return res.status(400).json({ error: 'Order already ' + o.status });
    if (!o.escrow_sequence) {
      await db.query("UPDATE orders SET status = 'completed' WHERE id = $1", [o.id]);
      await db.query("UPDATE listings SET status = 'sold' WHERE id = $1", [o.listing_id]);
      pushNotif(o.seller_id, 'order_completed', { orderId: o.id });
      pushNotif(o.buyer_id, 'order_completed', { orderId: o.id });
      return res.json({ status: 'completed', message: 'Order completed' });
    }
    const payload = await xummService.createEscrowFinishPayload({ buyerAddress: o.buyer_address, escrowOwner: o.buyer_address, offerSequence: o.escrow_sequence });
    res.json({ xumm: payload, orderId: o.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/orders/:id/escrow/webhook', async (req, res) => {
  try {
    const { signed, txHash, txData } = req.body;
    if (!signed) return res.json({ ok: true });
    const order = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!order.rows[0]) return res.status(404).json({ error: 'Not found' });
    const o = order.rows[0];
    const txType = txData && txData.TransactionType;
    if (txType === 'EscrowCreate') {
      await db.query("UPDATE orders SET status = 'escrow_locked', escrow_tx_hash = $1, escrow_sequence = $2 WHERE id = $3", [txHash, txData && txData.Sequence, o.id]);
    } else if (txType === 'EscrowFinish') {
      await db.query("UPDATE orders SET status = 'completed', escrow_finish_tx_hash = $1 WHERE id = $2", [txHash, o.id]);
      await db.query("UPDATE listings SET status = 'sold' WHERE id = $1", [o.listing_id]);
      pushNotif(o.seller_id, 'order_completed', { orderId: o.id });
      pushNotif(o.buyer_id, 'order_completed', { orderId: o.id });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/orders/:id/dispute', auth, async (req, res) => {
  try {
    const { reason } = req.body;
    const order = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!order.rows[0]) return res.status(404).json({ error: 'Not found' });
    const o = order.rows[0];
    if (o.buyer_id !== req.user.id && o.seller_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    await db.query("UPDATE orders SET status = 'disputed' WHERE id = $1", [o.id]);
    await db.query('INSERT INTO disputes (order_id, opened_by_id, reason) VALUES ($1,$2,$3)', [o.id, req.user.id, reason]);
    const otherParty = req.user.id === o.buyer_id ? o.seller_id : o.buyer_id;
    pushNotif(otherParty, 'dispute_opened', { orderId: o.id, reason });
    res.json({ status: 'disputed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/orders/:id/review', auth, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const order = await db.query('SELECT * FROM orders WHERE id = $1 AND buyer_id = $2', [req.params.id, req.user.id]);
    if (!order.rows[0]) return res.status(404).json({ error: 'Not found' });
    const o = order.rows[0];
    if (o.status !== 'completed') return res.status(400).json({ error: 'Can only review completed orders' });
    await db.query('INSERT INTO reviews (order_id, reviewer_id, reviewed_id, rating, comment) VALUES ($1,$2,$3,$4,$5)', [o.id, req.user.id, o.seller_id, rating, comment]);
      pushNotif(o.seller_id, 'new_review', { orderId: o.id, rating });
    await db.query('UPDATE users SET reputation_score = (SELECT AVG(rating) FROM reviews WHERE reviewed_id = $1) WHERE id = $1', [o.seller_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const [users, listings, orders, revenue] = await Promise.all([
      db.query('SELECT COUNT(*) as cnt FROM users'),
      db.query("SELECT COUNT(*) as cnt FROM listings WHERE status = 'active'"),
      db.query("SELECT COUNT(*) as cnt FROM orders WHERE status = 'completed'"),
      db.query("SELECT COALESCE(SUM(commission_xrp),0) as total FROM orders WHERE status = 'completed'")
    ]);
    res.json({
      totalUsers: Number(users.rows[0].cnt),
      activeListings: Number(listings.rows[0].cnt),
      completedOrders: Number(orders.rows[0].cnt),
      totalRevenue: parseFloat(revenue.rows[0].total)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/admin/disputes', adminAuth, async (req, res) => {
  try {
    const r = await db.query("SELECT d.*, o.total_xrp, ub.username as buyer_name, us.username as seller_name FROM disputes d JOIN orders o ON d.order_id = o.id JOIN users ub ON o.buyer_id = ub.id JOIN users us ON o.seller_id = us.id WHERE d.status = 'open' ORDER BY d.created_at DESC");
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/disputes/:id/resolve', adminAuth, async (req, res) => {
  try {
    const { resolution, favorBuyer } = req.body;
    await db.query("UPDATE disputes SET status = 'resolved', admin_note = $1, admin_id = $2, decision = $3, resolved_at = NOW() WHERE id = $4", [resolution, req.user.id, favorBuyer ? 'refund_buyer' : 'release_seller', req.params.id]);
    const dispute = await db.query('SELECT * FROM disputes WHERE id = $1', [req.params.id]);
    const status = favorBuyer ? 'refunded' : 'completed';
    await db.query('UPDATE orders SET status = $1 WHERE id = $2', [status, dispute.rows[0].order_id]);
    const ord = await db.query('SELECT buyer_id, seller_id FROM orders WHERE id = UPDATE orders SET status = $1 WHERE id = $2', [status, dispute.rows[0].order_id]);', [dispute.rows[0].order_id]);
    if (ord.rows[0]) {
      pushNotif(ord.rows[0].buyer_id, 'dispute_resolved', { orderId: dispute.rows[0].order_id, favorBuyer });
      pushNotif(ord.rows[0].seller_id, 'dispute_resolved', { orderId: dispute.rows[0].order_id, favorBuyer });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/admin/users/:id/ban', adminAuth, async (req, res) => {
  try {
    const { banned } = req.body;
    await db.query('UPDATE users SET is_banned = $1 WHERE id = $2', [banned, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/admin/listings/:id/remove', adminAuth, async (req, res) => {
  try {
    await db.query("UPDATE listings SET status = 'removed' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Notifications
router.get('/notifications', auth, async (req, res) => {
  try {
    const r = await db.query('SELECT id, type, payload, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    const u = await db.query('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = $1 AND is_read = false', [req.user.id]);
    res.json({ items: r.rows, unread: Number(u.rows[0].cnt) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/notifications/:id/read', auth, async (req, res) => {
  try {
    await db.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/notifications/read-all', auth, async (req, res) => {
  try {
    await db.query('UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false', [req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
