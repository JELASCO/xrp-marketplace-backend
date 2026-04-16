const router    = require('express').Router();
const rateLimit = require('express-rate-limit');
const db        = require('../db');
const escrowSvc = require('../escrow/escrowService');
const xummSvc   = require('../xumm/xummService');
const { auth, requireAdmin } = require('../middleware/auth');
const notify    = require('../notifications/socket');

const limit = (max, min=15) => rateLimit({ windowMs: min*60*1000, max, standardHeaders: true, legacyHeaders: false });

// ── AUTH ──────────────────────────────────────────────────────
router.post('/auth/signin',  limit(10,5), async (req,res) => { try { res.json(await xummSvc.createSignInPayload()); } catch(e) { res.status(500).json({error:e.message}); } });
router.post('/auth/verify',  limit(10,5), async (req,res) => {
  try {
    const { uuid } = req.body;
    if (!uuid) return res.status(400).json({ error: 'uuid required' });
    const { token, user } = await xummSvc.verifySignIn(uuid);
    res.json({ token, user: { id:user.id, username:user.username, walletAddress:user.wallet_address, role:user.role } });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.get('/auth/me', auth, (req,res) => {
  const u = req.user;
  res.json({ id:u.id, username:u.username, walletAddress:u.wallet_address, role:u.role, reputationScore:u.reputation_score });
});
router.post('/xumm/webhook', async (req,res) => { try { await xummSvc.handleWebhook(req.body); res.json({ok:true}); } catch(e) { console.error('[Webhook]',e.message); res.json({ok:true}); } });

// ── USERS ─────────────────────────────────────────────────────
router.get('/users/:id', async (req,res) => {
  try {
    const user = await db.users.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const reviews = await db.reviews.forUser(user.id);
    res.json({ ...user, reviews });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.patch('/users/me', auth, async (req,res) => {
  try {
    const { username, bio } = req.body;
    const updates = {};
    if (username) updates.username = username;
    if (bio !== undefined) updates.bio = bio;
    res.json(await db.users.update(req.user.id, updates));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LISTINGS ──────────────────────────────────────────────────
router.get('/listings', async (req,res) => {
  try {
    const { category, game, minXrp, maxXrp, sort, page, limit:lim } = req.query;
    res.json(await db.listings.list({ category, game, minXrp, maxXrp, sort, page:parseInt(page)||1, limit:Math.min(parseInt(lim)||24,48) }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/listings/:id', async (req,res) => {
  try {
    const l = await db.listings.findById(req.params.id);
    if (!l) return res.status(404).json({ error: 'Listing not found' });
    await db.listings.incrementViews(req.params.id);
    res.json(l);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/listings', auth, limit(20), async (req,res) => {
  try {
    const { title, description, category, game, priceXrp, images } = req.body;
    if (!title || !category || !priceXrp) return res.status(400).json({ error: 'title, category, priceXrp required' });
    res.status(201).json(await db.listings.create({ sellerId:req.user.id, title, description, category, game, priceXrp, images }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.patch('/listings/:id', auth, async (req,res) => {
  try {
    const l = await db.listings.findById(req.params.id);
    if (!l) return res.status(404).json({ error: 'Not found' });
    if (l.seller_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const allowed = ['title','description','price_xrp','images','status'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    res.json(await db.listings.update(req.params.id, updates));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ORDERS ────────────────────────────────────────────────────
router.get('/orders/mine', auth, async (req,res) => {
  try { res.json(await db.orders.findByUser(req.user.id, req.query.role||'buyer')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/orders/:id', auth, async (req,res) => {
  try {
    const o = await db.orders.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'Not found' });
    if (![o.buyer_id,o.seller_id].includes(req.user.id) && req.user.role!=='admin') return res.status(403).json({ error: 'Forbidden' });
    res.json(o);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/orders', auth, limit(30), async (req,res) => {
  try {
    const { listingId } = req.body;
    const l = await db.listings.findById(listingId);
    if (!l) return res.status(404).json({ error: 'Listing not found' });
    if (l.status !== 'active') return res.status(400).json({ error: 'Listing not active' });
    if (l.seller_id === req.user.id) return res.status(400).json({ error: 'Cannot buy own listing' });
    const seller = await db.users.findById(l.seller_id);
    const o = await db.orders.create({ listingId, buyerId:req.user.id, sellerId:l.seller_id, buyerWallet:req.user.wallet_address, sellerWallet:seller.wallet_address, totalXrp:l.price_xrp, commissionRate:parseFloat(process.env.COMMISSION_RATE||'0.03') });
    res.status(201).json(o);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ESCROW ────────────────────────────────────────────────────
router.post('/orders/:id/escrow/xumm-payload', auth, async (req,res) => {
  try {
    const o = await db.orders.findById(req.params.id);
    if (!o || o.buyer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (o.status !== 'pending') return res.status(400).json({ error: 'Order not pending' });
    const seller = await db.users.findById(o.seller_id);
    res.json(await xummSvc.createEscrowPayload({ buyerAddress:req.user.wallet_address, sellerAddress:seller.wallet_address, xrpAmount:o.total_xrp, orderId:o.id }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/orders/:id/escrow/create', auth, async (req,res) => {
  try {
    const o = await db.orders.findById(req.params.id);
    if (!o || o.buyer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const result = await escrowSvc.createEscrow({ buyerSeed:req.body.buyerSeed, sellerAddress:o.seller_wallet_address, xrpAmount:o.total_xrp, orderId:o.id });
    await db.orders.update(o.id, { status:'escrow_locked', escrow_tx_hash:result.txHash, escrow_sequence:result.escrowSequence });
    notify.notify(o.seller_id, 'ESCROW_CREATED', { orderId:o.id, amount:o.total_xrp });
    res.json({ success:true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/orders/:id/escrow/confirm', auth, async (req,res) => {
  try {
    const o = await db.orders.findById(req.params.id);
    if (!o || o.buyer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const result = await escrowSvc.finishEscrow({ buyerSeed:req.body.buyerSeed, escrowSequence:o.escrow_sequence, xrpAmount:o.total_xrp });
    await db.orders.update(o.id, { status:'completed', finish_tx_hash:result.txHash, seller_receives_xrp:result.sellerReceives, commission_xrp:result.commissionPaid, completed_at:new Date() });
    await db.listings.update(o.listing_id, { status:'sold' });
    notify.notify(o.seller_id, 'PAYMENT_RECEIVED', { orderId:o.id, amount:result.sellerReceives });
    res.json({ success:true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/orders/:id/escrow/status', auth, async (req,res) => {
  try {
    const o = await db.orders.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'Not found' });
    const ledger = await escrowSvc.getEscrowStatus(o.buyer_wallet_address, o.escrow_sequence);
    res.json({ dbStatus:o.status, ledger, expiresAt:o.escrow_expires_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DISPUTES ──────────────────────────────────────────────────
router.post('/orders/:id/dispute', auth, limit(5,60), async (req,res) => {
  try {
    const o = await db.orders.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'Not found' });
    if (![o.buyer_id,o.seller_id].includes(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
    const d = await db.disputes.create({ orderId:o.id, openedById:req.user.id, reason:req.body.reason, evidence:req.body.evidence });
    await db.orders.update(o.id, { status:'disputed' });
    res.status(201).json({ success:true, disputeId:d.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/disputes/:id/resolve', auth, requireAdmin, async (req,res) => {
  try {
    const d = await db.disputes.findById(req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    const o = await db.orders.findById(d.order_id);
    const { decision, adminNote, adminSeed } = req.body;
    let result;
    if (decision === 'refund_buyer') {
      result = await escrowSvc.cancelEscrow({ cancellerSeed:adminSeed, escrowOwner:o.buyer_wallet_address, escrowSequence:o.escrow_sequence });
      await db.orders.update(o.id, { status:'refunded', cancel_tx_hash:result.txHash });
    } else {
      result = await escrowSvc.finishEscrow({ buyerSeed:adminSeed, escrowSequence:o.escrow_sequence, xrpAmount:o.total_xrp });
      await db.orders.update(o.id, { status:'completed', finish_tx_hash:result.txHash, completed_at:new Date() });
    }
    await db.disputes.update(d.id, { status:'resolved', decision, admin_note:adminNote, admin_id:req.user.id, resolved_at:new Date() });
    notify.notify(o.buyer_id,  'DISPUTE_RESOLVED', { orderId:o.id, decision });
    notify.notify(o.seller_id, 'DISPUTE_RESOLVED', { orderId:o.id, decision });
    res.json({ success:true, txHash:result.txHash, decision });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REVIEWS ───────────────────────────────────────────────────
router.post('/orders/:id/review', auth, async (req,res) => {
  try {
    const o = await db.orders.findById(req.params.id);
    if (!o || o.buyer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (o.status !== 'completed') return res.status(400).json({ error: 'Order not completed' });
    res.status(201).json(await db.reviews.create({ orderId:o.id, reviewerId:req.user.id, reviewedId:o.seller_id, rating:req.body.rating, comment:req.body.comment }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ─────────────────────────────────────────────────────
router.get('/admin/stats', auth, requireAdmin, async (req,res) => {
  try {
    const r = await db.query(`SELECT (SELECT COUNT(*) FROM users) total_users,(SELECT COUNT(*) FROM listings WHERE status='active') active_listings,(SELECT COUNT(*) FROM orders WHERE status='completed') completed_orders,(SELECT COALESCE(SUM(total_xrp),0) FROM orders WHERE status='completed') total_volume,(SELECT COALESCE(SUM(commission_xrp),0) FROM orders WHERE status='completed') total_commission,(SELECT COUNT(*) FROM disputes WHERE status='open') open_disputes`);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/admin/disputes', auth, requireAdmin, async (req,res) => {
  try { res.json(await db.disputes.findOpen()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
router.patch('/admin/users/:id/ban', auth, requireAdmin, async (req,res) => {
  try { res.json(await db.users.update(req.params.id, { is_banned:req.body.banned })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
router.patch('/admin/listings/:id/remove', auth, requireAdmin, async (req,res) => {
  try { res.json(await db.listings.update(req.params.id, { status:'removed' })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
