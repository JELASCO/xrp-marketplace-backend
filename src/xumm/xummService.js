const { Xumm }  = require('@xumm/sdk');
const jwt        = require('jsonwebtoken');
const db         = require('../db');

let _xumm = null;
function getXumm() {
  if (!_xumm) _xumm = new Xumm(process.env.XUMM_API_KEY, process.env.XUMM_API_SECRET);
  return _xumm;
}

const RIPPLE_EPOCH = 946684800;

// ── Sign-in payload ──────────────────────────────────────────────
async function createSignInPayload() {
  const xumm = getXumm();
  const p = await xumm.payload.create({
    txjson: { TransactionType: 'SignIn' },
    options: {
      submit: false,
      return_url: { web: `${process.env.FRONTEND_URL}/auth/callback?uuid={id}` }
    },
    custom_meta: { instruction: 'XRP Market\'e giriş yapmak için imzalayın' },
  });
  return { uuid: p.uuid, qrUrl: p.refs.qr_png, mobileUrl: p.next.always, wsUrl: p.refs.websocket_status };
}

// ── EscrowCreate payload ─────────────────────────────────────────
async function createEscrowPayload({ buyerAddress, sellerAddress, xrpAmount, orderId, cancelAfterDays = 7 }) {
  const xumm = getXumm();
  const cancelAfter = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + cancelAfterDays * 86400;

  const p = await xumm.payload.create({
    txjson: {
      TransactionType: 'EscrowCreate',
      Account:         buyerAddress,
      Destination:     sellerAddress,
      Amount:          String(Math.floor(xrpAmount * 1_000_000)),
      CancelAfter:     cancelAfter,
    },
    options: { submit: true },
    custom_meta: {
      identifier: `order_${orderId}`,
      instruction: `${xrpAmount} XRP escrow'a kilitlenecek.\nSatıcı teslim edince onaylayacaksınız.`,
      blob: { orderId, type: 'escrow_create' },
    },
  });

  return { uuid: p.uuid, qrUrl: p.refs.qr_png, mobileUrl: p.next.always, wsUrl: p.refs.websocket_status };
}

// ── EscrowFinish payload ─────────────────────────────────────────
async function createFinishPayload({ buyerAddress, escrowOwner, escrowSequence, orderId }) {
  const xumm = getXumm();
  const p = await xumm.payload.create({
    txjson: {
      TransactionType: 'EscrowFinish',
      Account:         buyerAddress,
      Owner:           escrowOwner,
      OfferSequence:   escrowSequence,
    },
    options: { submit: true },
    custom_meta: {
      instruction: 'Onayladığınızda ödeme satıcıya aktarılacak.',
      blob: { orderId, type: 'escrow_finish' },
    },
  });

  return { uuid: p.uuid, qrUrl: p.refs.qr_png, mobileUrl: p.next.always };
}

// ── Poll payload status ──────────────────────────────────────────
async function waitForPayload(uuid, timeoutMs = 120_000) {
  const xumm  = getXumm();
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const r = await xumm.payload.get(uuid);
    if (r.meta.resolved) return { signed: r.meta.signed, txid: r.response?.txid, account: r.response?.account };
    await new Promise(res => setTimeout(res, 2000));
  }
  throw new Error('Xumm payload timed out');
}

// ── Verify sign-in and return JWT ────────────────────────────────
async function verifySignIn(uuid) {
  const { signed, account } = await waitForPayload(uuid, 30_000);
  if (!signed) throw new Error('Kullanıcı imzalamadı');

  let user = await db.users.findByWallet(account);
  if (!user) {
    user = await db.users.create({
      walletAddress: account,
      username: `user_${account.slice(-6).toLowerCase()}`,
    });
  }

  const token = jwt.sign({ id: user.id, wallet: account, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
  return { token, user };
}

// ── Webhook handler ──────────────────────────────────────────────
async function handleWebhook(body) {
  const { meta, custom_meta, txid } = body;
  const blob = custom_meta?.blob || {};

  if (!meta?.signed || !blob.orderId) return;

  if (blob.type === 'escrow_create' && txid) {
    await db.orders.update(blob.orderId, { status: 'escrow_locked', escrow_tx_hash: txid });
  }
  if (blob.type === 'escrow_finish' && txid) {
    await db.orders.update(blob.orderId, { status: 'completed', finish_tx_hash: txid, completed_at: new Date() });
  }
}

module.exports = { createSignInPayload, createEscrowPayload, createFinishPayload, waitForPayload, verifySignIn, handleWebhook };
