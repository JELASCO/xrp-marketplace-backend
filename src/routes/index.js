const router       = require('express').Router();
const db           = require('../db');
const escrowSvc    = require('../escrow/escrowService');
const xummSvc      = require('../xumm/xummService');
const { auth, requireAdmin } = require('../middleware/auth');
const notify       = require('../notifications/socket');
const rateLimit    = require('express-rate-limit');

const limit = (max, windowMin = 15) => rateLimit({ windowMs: windowMin * 60 * 1000, max, standardHeaders: true, legacyHeaders: false });

// ══ AUTH ══════════════════════════════════════════════════════════

// POST /api/auth/signin  — get Xumm QR
router.post('/auth/signin', limit(10, 5), async (req, res) => {
  try {
    const data = await xummSvc.createSignInPayload();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/verify  — verify Xumm uuid, get JWT
router.post('/auth/verify', limit(10, 5), async (req, res) => {
  try {
    const { uuid } = req.body;
    if (!uuid) return res.status(400).json({ error: 'uuid gerekli' });
    const { token, user } = await xummSvc.verifySignIn(uuid);
    res.json({ token, user: { id: user.id, username: user.username, walletAddress: user.wallet_address, role: user.role } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/auth/me
router.get('/auth/me', auth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, username: u.username, walletAddress: u.wallet_address, role: u.role, reputationScore: u.reputation_score });
});

// POST /api/xumm/webhook  — Xumm sends callbacks here
router.post('/xumm/webhook', async (req, res) => {
  try { await xummSvc.handleWebhook(req.body); res.json({ ok: true }); }
  catch (e) { console.error('[Webhook]', e.message); res.json({ ok: true }); }
});

// ══ USERS ═════════════════════════════════════════════════════════

// GET /api/users/:id
router.get('/users/:id', async (req, res) => {
  try {
    const user = await db.users.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const reviews = await db.reviews.forUser(user.id);
    res.json({ ...user, reviews });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/users/me
router.patch('/users/me', auth, async (req, res) => {
  try {
    const { username, bio } = req.body;
    const updates = {};
    if (username) updates.username = username;
    if (bio !== undefined) updates.bio = bio;
    const user = await db.users.update(req.user.id, updates);
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ LISTINGS ══════════════════════════════════════════════════════

// GET /api/listings
router.get('/listings', async (req, res) => {
  try {
    const { category, game, minXrp, maxXrp, sort, page, limit: lim } = req.query;
    const items = await db.listings.list({ category, game, minXrp, maxXrp, sort, page: parseInt(page) || 1, limit: Math.min(parseInt(lim) || 24, 48) });
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/listings/:id
router.get('/listings/:id', async (req, res) => {
  try {
    const listing = await db.listings.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'İlan bulunamadı' });
    await db.listings.incrementViews(req.params.id);
    res.json(listing);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/listings
router.post('/listings', auth, limit(20), async (req, res) => {
  try {
    const { title, description, category, game, priceXrp, images } = req.body;
    if (!title || !category || !priceXrp) return res.status(400).json({ error: 'title, category, priceXrp zorunlu' });

    const listing = await db.listings.create({
      sellerId: req.user.id, title, description, category, game, priceXrp, images,
    });
    res.status(201).json(listing);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/listings/:id
router.patch('/listings/:id', auth, async (req, res) => {
  try {
    const listing = await db.listings.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'İlan bulunamadı' });
    if (listing.seller_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Yetkisiz' });

    const allowed = ['title', 'description', 'price_xrp', 'images', 'status'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    const updated = await db.listings.update(req.params.id, updates);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ ORDERS ════════════════════════════════════════════════════════

// GET /api/orders/mine
router.get('/orders/mine', auth, async (req, res) => {
  try {
    const role  = req.query.role || 'buyer';
    const items = await db.orders.findByUser(req.user.id, role);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/:id
router.get('/orders/:id', auth, async (req, res) => {
  try {
    const order = await db.orders.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı' });
    if (![order.buyer_id, order.seller_id].includes(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Yetkisiz' });
    }
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders  — create order (before escrow)
router.post('/orders', auth, limit(30), async (req, res) => {
  try {
    const { listingId } = req.body;
    const listing = await db.listings.findById(listingId);
    if (!listing) return res.status(404).json({ error: 'İlan bulunamadı' });
    if (listing.status !== 'active') return res.status(400).json({ error: 'İlan aktif değil' });
    if (listing.seller_id === req.user.id) return res.status(400).json({ error: 'Kendi ilanınızı satın alamazsınız' });

    const order = await db.orders.create({
      listingId,
      buyerId:       req.user.id,
      sellerId:      listing.seller_id,
      buyerWallet:   req.user.wallet_address,
      sellerWallet:  listing.wallet_address || (await db.users.findById(listing.seller_id)).wallet_address,
      totalXrp:      listing.price_xrp,
      commissionRate: parseFloat(process.env.COMMISSION_RATE || '0.03'),
    });

    res.status(201).json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ ESCROW ════════════════════════════════════════════════════════

// POST /api/orders/:id/escrow/xumm-payload  — get Xumm QR for escrow
router.post('/orders/:id/escrow/xumm-payload', auth, async (req, res) => {
  try {
    const order = await db.orders.findById(req.params.id);
    if (!order || order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Yetkisiz' });
    if (order.status !== 'pending') return res.status(400).json({ error: 'Bu sipariş için escrow başlatılamaz' });

    const seller = await db.users.findById(order.seller_id);
    const payload = await xummSvc.createEscrowPayload({
      buyerAddress:  req.user.wallet_address,
      sellerAddress: seller.wallet_address,
      xrpAmount:     order.total_xrp,
      orderId:       order.id,
    });

    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/escrow/create  — manual (seed-based, for testing)
router.post('/orders/:id/escrow/create', auth, async (req, res) => {
  try {
    const order = await db.orders.findById(req.params.id);
    if (!order || order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Yetkisiz' });

    const { buyerSeed } = req.body;
    const result = await escrowSvc.createEscrow({
      buyerSeed,
      sellerAddress: order.seller_wallet_address,
      xrpAmount:     order.total_xrp,
      orderId:       order.id,
    });

    await db.orders.update(order.id, {
      status:            'escrow_locked',
      escrow_tx_hash:    result.txHash,
      escrow_sequence:   result.escrowSequence,
      escrow_expires_at: result.cancelAfter,
    });

    notify.notify(order.seller_id, 'ESCROW_CREATED', { orderId: order.id, amount: order.total_xrp });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/escrow/confirm  — buyer confirms delivery
router.post('/orders/:id/escrow/confirm', auth, async (req, res) => {
  try {
    const order = await db.orders.findById(req.params.id);
    if (!order || order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Yetkisiz' });
    if (order.status !== 'escrow_locked' && order.status !== 'delivered') return res.status(400).json({ error: 'Escrow aktif değil' });

    const { buyerSeed } = req.body;
    const result = await escrowSvc.finishEscrow({
      buyerSeed,
      escrowSequence: order.escrow_sequence,
      xrpAmount:      order.total_xrp,
    });

    await db.orders.update(order.id, {
      status:           'completed',
      finish_tx_hash:   result.txHash,
      seller_receives_xrp: result.sellerReceives,
      commission_xrp:   result.commissionPaid,
      completed_at:     new Date(),
    });
    await db.listings.update(order.listing_id, { status: 'sold' });

    notify.notify(order.seller_id, 'PAYMENT_RECEIVED', { orderId: order.id, amount: result.sellerReceives });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/:id/escrow/status
router.get('/orders/:id/escrow/status', auth, async (req, res) => {
  try {
    const order = await db.orders.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı' });
    const ledger = await escrowSvc.getEscrowStatus(order.buyer_wallet_address, order.escrow_sequence);
    res.json({ dbStatus: order.status, ledger, expiresAt: order.escrow_expires_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ DISPUTES ══════════════════════════════════════════════════════

// POST /api/orders/:id/dispute
router.post('/orders/:id/dispute', auth, limit(5, 60), async (req, res) => {
  try {
    const order = await db.orders.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı' });
    if (![order.buyer_id, order.seller_id].includes(req.user.id)) return res.status(403).json({ error: 'Yetkisiz' });

    const { reason, evidence } = req.body;
    const dispute = await db.disputes.create({ orderId: order.id, openedById: req.user.id, reason, evidence });
    await db.orders.update(order.id, { status: 'disputed' });

    res.status(201).json({ success: true, disputeId: dispute.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/disputes/:id/resolve  — admin only
router.post('/disputes/:id/resolve', auth, requireAdmin, async (req, res) => {
  try {
    const dispute = await db.disputes.findById(req.params.id);
    if (!dispute) return res.status(404).json({ error: 'Dispute bulunamadı' });

    const order    = await db.orders.findById(dispute.order_id);
    const { decision, adminNote, adminSeed } = req.body;

    let txResult;
    if (decision === 'refund_buyer') {
      txResult = await escrowSvc.cancelEscrow({ cancellerSeed: adminSeed, escrowOwner: order.buyer_wallet_address, escrowSequence: order.escrow_sequence });
      await db.orders.update(order.id, { status: 'refunded', cancel_tx_hash: txResult.txHash });
    } else {
      txResult = await escrowSvc.finishEscrow({ buyerSeed: adminSeed, escrowSequence: order.escrow_sequence, xrpAmount: order.total_xrp });
      await db.orders.update(order.id, { status: 'completed', finish_tx_hash: txResult.txHash, completed_at: new Date() });
    }

    await db.disputes.update(dispute.id, { status: 'resolved', decision, admin_note: adminNote, admin_id: req.user.id, resolved_at: new Date() });

    notify.notify(order.buyer_id,  'DISPUTE_RESOLVED', { orderId: order.id, decision });
    notify.notify(order.seller_id, 'DISPUTE_RESOLVED', { orderId: order.id, decision });

    res.json({ success: true, txHash: txResult.txHash, decision });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ REVIEWS ═══════════════════════════════════════════════════════

// POST /api/orders/:id/review
router.post('/orders/:id/review', auth, async (req, res) => {
  try {
    const order = await db.orders.findById(req.params.id);
    if (!order || order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Yetkisiz' });
    if (order.status !== 'completed') return res.status(400).json({ error: 'Tamamlanan siparişler için yorum yapılabilir' });

    const { rating, comment } = req.body;
    const review = await db.reviews.create({ orderId: order.id, reviewerId: req.user.id, reviewedId: order.seller_id, rating, comment });
    res.status(201).json(review);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ ADMIN ═════════════════════════════════════════════════════════

// GET /api/admin/disputes
router.get('/admin/disputes', auth, requireAdmin, async (req, res) => {
  try {
    const disputes = await db.disputes.findOpen();
    res.json(disputes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/stats
router.get('/admin/stats', auth, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM listings WHERE status='active') AS active_listings,
        (SELECT COUNT(*) FROM orders WHERE status='completed') AS completed_orders,
        (SELECT COALESCE(SUM(total_xrp),0) FROM orders WHERE status='completed') AS total_volume,
        (SELECT COALESCE(SUM(commission_xrp),0) FROM orders WHERE status='completed') AS total_commission,
        (SELECT COUNT(*) FROM disputes WHERE status='open') AS open_disputes
    `);
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/users/:id/ban
router.patch('/admin/users/:id/ban', auth, requireAdmin, async (req, res) => {
  try {
    const { banned } = req.body;
    const user = await db.users.update(req.params.id, { is_banned: banned });
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/listings/:id/remove
router.patch('/admin/listings/:id/remove', auth, requireAdmin, async (req, res) => {
  try {
    const listing = await db.listings.update(req.params.id, { status: 'removed' });
    res.json(listing);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
