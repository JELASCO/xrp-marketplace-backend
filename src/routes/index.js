const express = require('express');
const router = express.Router();
const _rateLimit = require('express-rate-limit');
const rateLimit = _rateLimit.default || _rateLimit;
const db = require('../db');
const jwt = require('jsonwebtoken');
const escrowService = require('../escrow/escrowService');
const xummService = require('../xumm/xummService');
const { notify } = require('../notifications/socket');

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
    const user = await db.query('SELECT id, username, wallet_address, role, bio, reputation_score, is_verified, avatar_url, notification_prefs FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });
    const u = user.rows[0];
    res.json({ id: u.id, username: u.username, walletAddress: u.wallet_address, role: u.role || 'user', bio: u.bio, reputationScore: u.reputation_score, isVerified: u.is_verified, avatar_url: u.avatar_url, notification_prefs: u.notification_prefs || {} });
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
    const { username, bio, avatar_url, notification_prefs } = req.body;
    await db.query(
      'UPDATE users SET username = COALESCE($1, username), bio = COALESCE($2, bio), avatar_url = COALESCE($3, avatar_url), notification_prefs = COALESCE($4, notification_prefs) WHERE id = $5::uuid',
      [username || null, bio || null, avatar_url || null, notification_prefs ? JSON.stringify(notification_prefs) : null, req.user.id]
    );
    const r = await db.query('SELECT * FROM users WHERE id = $1::uuid', [req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Listings
router.get('/listings', async (req, res) => {
  try {
    const { category, game, sort, search, minPrice, maxPrice, limit = 48, offset = 0 } = req.query;
    let q = "SELECT l.*, u.username, u.reputation_score, u.is_verified FROM listings l JOIN users u ON l.seller_id = u.id WHERE l.status = 'active'";
    const params = [];
    if (category) { params.push(category); q += ' AND l.category = $' + params.length; }
    if (game) { params.push(game); q += ' AND l.game = $' + params.length; }
    if (search) {
      params.push('%' + search.toLowerCase() + '%');
      q += ' AND (LOWER(l.title) LIKE $' + params.length + ' OR LOWER(l.description) LIKE $' + params.length + ')';
    }
    if (minPrice) { params.push(parseFloat(minPrice)); q += ' AND l.price_xrp >= $' + params.length; }
    if (maxPrice) { params.push(parseFloat(maxPrice)); q += ' AND l.price_xrp <= $' + params.length; }
    const orderMap = { price_asc: 'l.price_xrp ASC', price_desc: 'l.price_xrp DESC', views: 'l.views DESC', created_at: 'l.created_at DESC' };
    q += ' ORDER BY l.is_featured DESC, ' + (orderMap[sort] || 'l.created_at DESC');
    params.push(parseInt(limit)); q += ' LIMIT $' + params.length;
    params.push(parseInt(offset)); q += ' OFFSET $' + params.length;
    const r = await db.query(q, params);
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
    await db.query('INSERT INTO disputes (order_id, raised_by, reason) VALUES ($1,$2,$3)', [o.id, req.user.id, reason]);
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
    await db.query("UPDATE disputes SET status = 'resolved', resolution = $1, resolved_by = $2 WHERE id = $3", [resolution, req.user.id, req.params.id]);
    const dispute = await db.query('SELECT * FROM disputes WHERE id = $1', [req.params.id]);
    const status = favorBuyer ? 'refunded' : 'completed';
    await db.query('UPDATE orders SET status = $1 WHERE id = $2', [status, dispute.rows[0].order_id]);
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


// Seller stats
router.get('/me/stats', auth, async (req, res) => {
  try {
    const ar = await db.query("SELECT COUNT(*) as cnt FROM listings WHERE seller_id = $1 AND status = 'active'", [req.user.id]);
    const sr = await db.query("SELECT COUNT(*) as cnt FROM listings WHERE seller_id = $1 AND status = 'sold'", [req.user.id]);
    const cr = await db.query("SELECT COUNT(*) as cnt FROM orders WHERE seller_id = $1 AND status = 'completed'", [req.user.id]);
    const tr = await db.query("SELECT COALESCE(SUM(seller_receives_xrp),0) as total FROM orders WHERE seller_id = $1 AND status = 'completed'", [req.user.id]);
    const er = await db.query("SELECT COUNT(*) as cnt FROM orders WHERE seller_id = $1 AND status = 'escrow_locked'", [req.user.id]);
    const pr = await db.query("SELECT COUNT(*) as cnt FROM orders WHERE buyer_id = $1 AND status = 'completed'", [req.user.id]);
    const dr = await db.query("SELECT COUNT(*) as cnt FROM disputes d JOIN orders o ON d.order_id = o.id WHERE (o.seller_id = $1 OR o.buyer_id = $1) AND d.status = 'open'", [req.user.id]);
    const rr = await db.query("SELECT COUNT(*) as cnt, COALESCE(AVG(rating),0) as avg FROM reviews WHERE reviewed_id = $1", [req.user.id]);
    res.json({ activeListings: Number(ar.rows[0].cnt), soldListings: Number(sr.rows[0].cnt), completedSales: Number(cr.rows[0].cnt), totalRevenueXrp: Number(tr.rows[0].total), inEscrow: Number(er.rows[0].cnt), completedPurchases: Number(pr.rows[0].cnt), openDisputes: Number(dr.rows[0].cnt), reviewCount: Number(rr.rows[0].cnt), avgRating: Number(rr.rows[0].avg) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/users/:id/listings', async (req, res) => {
  try {
    const r = await db.query("SELECT l.*, u.username, u.reputation_score, u.is_verified FROM listings l JOIN users u ON l.seller_id = u.id WHERE l.seller_id = $1 AND l.status IN ('active','sold') ORDER BY l.created_at DESC LIMIT 48", [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/users/:id/reviews', async (req, res) => {
  try {
    const r = await db.query("SELECT rv.id, rv.rating, rv.comment, rv.created_at, u.id as reviewer_id, u.username as reviewer_username, u.avatar_url as reviewer_avatar FROM reviews rv JOIN users u ON rv.reviewer_id = u.id WHERE rv.reviewed_id = $1 ORDER BY rv.created_at DESC LIMIT 20", [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Favorites
router.get('/favorites', auth, async (req, res) => {
  try {
    const r = await db.query("SELECT l.*, u.username, u.reputation_score, u.is_verified, f.created_at as favorited_at FROM favorites f JOIN listings l ON f.listing_id = l.id JOIN users u ON l.seller_id = u.id WHERE f.user_id = $1 ORDER BY f.created_at DESC", [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/favorites/ids', auth, async (req, res) => {
  try {
    const r = await db.query("SELECT listing_id FROM favorites WHERE user_id = $1", [req.user.id]);
    res.json(r.rows.map(row => row.listing_id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/favorites/:listingId', auth, async (req, res) => {
  try {
    await db.query("INSERT INTO favorites (user_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.user.id, req.params.listingId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/favorites/:listingId', auth, async (req, res) => {
  try {
    await db.query("DELETE FROM favorites WHERE user_id = $1 AND listing_id = $2", [req.user.id, req.params.listingId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Messages
router.get('/messages', auth, async (req, res) => {
  try {
    // Get all conversations (distinct order_id) with latest message
    const r = await db.query(`
      SELECT DISTINCT ON (m.order_id)
        m.order_id, m.content, m.created_at, m.sender_id,
        o.listing_id, l.title as listing_title, l.images as listing_images,
        CASE WHEN o.buyer_id = $1 THEN o.seller_id ELSE o.buyer_id END as other_user_id,
        CASE WHEN o.buyer_id = $1 THEN su.username ELSE bu.username END as other_username,
        (SELECT COUNT(*) FROM messages m2 WHERE m2.order_id = m.order_id AND m2.sender_id != $1 AND m2.read_at IS NULL) as unread
      FROM messages m
      JOIN orders o ON m.order_id = o.id
      JOIN listings l ON o.listing_id = l.id
      JOIN users su ON o.seller_id = su.id
      JOIN users bu ON o.buyer_id = bu.id
      WHERE o.buyer_id = $1 OR o.seller_id = $1
      ORDER BY m.order_id, m.created_at DESC
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/messages/:orderId', auth, async (req, res) => {
  try {
    const o = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.orderId]);
    if (!o.rows[0]) return res.status(404).json({ error: 'Order not found' });
    const order = o.rows[0];
    if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });
    // Mark messages as read
    await db.query('UPDATE messages SET read_at = NOW() WHERE order_id = $1 AND sender_id != $2 AND read_at IS NULL', [req.params.orderId, req.user.id]);
    const r = await db.query(`
      SELECT m.*, u.username, u.avatar_url FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.order_id = $1 ORDER BY m.created_at ASC
    `, [req.params.orderId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/messages/:orderId', auth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message required' });
    const o = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.orderId]);
    if (!o.rows[0]) return res.status(404).json({ error: 'Order not found' });
    const order = o.rows[0];
    if (order.buyer_id !== req.user.id && order.seller_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });
    const r = await db.query(
      'INSERT INTO messages (order_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *',
      [req.params.orderId, req.user.id, content.trim()]
    );
    const msg = r.rows[0];
    const recipientId = order.buyer_id === req.user.id ? order.seller_id : order.buyer_id;
    try { notify(recipientId, 'new_message', { orderId: req.params.orderId, content: content.trim().slice(0, 80) }); } catch(ne) {}
    res.json(msg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Contact seller (inquiry - no order needed)
router.post('/contact/:listingId', auth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message required' });
    const lr = await db.query("SELECT * FROM listings WHERE id = $1", [req.params.listingId]);
    if (!lr.rows[0]) return res.status(404).json({ error: 'Listing not found' });
    const listing = lr.rows[0];
    if (listing.seller_id === req.user.id) return res.status(400).json({ error: 'Cannot message yourself' });
    const mr = await db.query(
      "INSERT INTO contact_messages (listing_id, sender_id, receiver_id, content) VALUES ($1,$2,$3,$4) RETURNING *",
      [listing.id, req.user.id, listing.seller_id, content.trim()]
    );
    await db.query("UPDATE contact_messages SET read_at = NULL WHERE id = $1", [mr.rows[0].id]);
    try { notify(listing.seller_id, 'new_inquiry', { listingId: listing.id, listingTitle: listing.title, content: content.trim().slice(0, 80) }); } catch(ne) { console.error('notify err:', ne.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/contact/:listingId', auth, async (req, res) => {
  try {
    const r = await db.query(
      "SELECT cm.*, u.username as sender_username, u.avatar_url as sender_avatar FROM contact_messages cm JOIN users u ON cm.sender_id = u.id WHERE cm.listing_id = $1 AND (cm.sender_id = $2 OR cm.receiver_id = $2) ORDER BY cm.created_at ASC",
      [req.params.listingId, req.user.id]
    );
    // Mark as read
    await db.query("UPDATE contact_messages SET read_at = NOW() WHERE listing_id = $1 AND receiver_id = $2 AND read_at IS NULL", [req.params.listingId, req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/inquiries', auth, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT DISTINCT ON (cm.listing_id) cm.*, l.title as listing_title, l.images as listing_images,
        u.username as other_username,
        (SELECT COUNT(*) FROM contact_messages cm2 WHERE cm2.listing_id = cm.listing_id AND cm2.receiver_id = $1 AND cm2.read_at IS NULL) as unread
      FROM contact_messages cm
      JOIN listings l ON cm.listing_id = l.id
      JOIN users u ON (CASE WHEN cm.sender_id = $1 THEN cm.receiver_id ELSE cm.sender_id END) = u.id
      WHERE cm.sender_id = $1 OR cm.receiver_id = $1
      ORDER BY cm.listing_id, cm.created_at DESC
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
