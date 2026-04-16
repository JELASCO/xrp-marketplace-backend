const fetch = require('node-fetch');
const jwt   = require('jsonwebtoken');
const db    = require('../db');

const XUMM_API     = 'https://xumm.app/api/v1/platform';
const RIPPLE_EPOCH = 946684800;

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-api-key':    process.env.XUMM_API_KEY    || '',
    'x-api-secret': process.env.XUMM_API_SECRET || '',
  };
}

async function post(path, body) {
  const res = await fetch(`${XUMM_API}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Xumm ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function get(path) {
  const res = await fetch(`${XUMM_API}${path}`, { headers: headers() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Xumm GET ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ── Create sign-in payload ────────────────────────────────────
async function createSignInPayload() {
  const d = await post('/payload', {
    txjson: { TransactionType: 'SignIn' },
    options: {
      submit: false,
      return_url: {
        web: `${process.env.FRONTEND_URL}/auth/callback?uuid={id}`,
      },
    },
    custom_meta: { instruction: 'Sign in to XRP Market' },
  });
  return {
    uuid:      d.uuid,
    qrUrl:     d.refs?.qr_png,
    mobileUrl: d.next?.always,
    wsUrl:     d.refs?.websocket_status,
  };
}

// ── Get payload result (single check, no polling) ─────────────
async function getPayloadResult(uuid) {
  const d = await get(`/payload/${uuid}`);
  return {
    resolved: d.meta?.resolved  || false,
    signed:   d.meta?.signed    || false,
    txid:     d.response?.txid  || null,
    account:  d.response?.account || null,
  };
}

// ── Verify sign-in — called after user signs on phone ─────────
// This does ONE check, not polling. Frontend calls this after
// WebSocket confirms signed=true.
async function verifySignIn(uuid) {
  // Try up to 5 times with 1s delay (Xumm sometimes needs a moment)
  let last;
  for (let i = 0; i < 5; i++) {
    const r = await getPayloadResult(uuid);
    last = r;
    if (r.resolved && r.signed && r.account) break;
    await new Promise(res => setTimeout(res, 1000));
  }

  if (!last?.signed)   throw new Error('User did not sign the request');
  if (!last?.account)  throw new Error('No wallet address returned from Xumm');

  // Find or create user in DB
  let user = await db.users.findByWallet(last.account);
  if (!user) {
    user = await db.users.create({
      walletAddress: last.account,
      username: `user_${last.account.slice(-6).toLowerCase()}`,
    });
  }

  const token = jwt.sign(
    { id: user.id, wallet: last.account, role: user.role },
    process.env.JWT_SECRET || 'dev-secret',
    { expiresIn: '7d' }
  );

  return { token, user };
}

// ── Escrow create payload ─────────────────────────────────────
async function createEscrowPayload({ buyerAddress, sellerAddress, xrpAmount, orderId, cancelAfterDays = 7 }) {
  const cancelAfter = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + cancelAfterDays * 86400;
  const d = await post('/payload', {
    txjson: {
      TransactionType: 'EscrowCreate',
      Account:     buyerAddress,
      Destination: sellerAddress,
      Amount:      String(Math.floor(xrpAmount * 1_000_000)),
      CancelAfter: cancelAfter,
    },
    options: { submit: true },
    custom_meta: {
      instruction: `${xrpAmount} XRP will be locked in escrow`,
      blob: { orderId, type: 'escrow_create' },
    },
  });
  return {
    uuid:      d.uuid,
    qrUrl:     d.refs?.qr_png,
    mobileUrl: d.next?.always,
    wsUrl:     d.refs?.websocket_status,
  };
}

// ── Escrow finish payload ─────────────────────────────────────
async function createFinishPayload({ buyerAddress, escrowOwner, escrowSequence, orderId }) {
  const d = await post('/payload', {
    txjson: {
      TransactionType: 'EscrowFinish',
      Account:       buyerAddress,
      Owner:         escrowOwner,
      OfferSequence: escrowSequence,
    },
    options: { submit: true },
    custom_meta: {
      instruction: 'Confirm delivery and release payment',
      blob: { orderId, type: 'escrow_finish' },
    },
  });
  return {
    uuid:      d.uuid,
    qrUrl:     d.refs?.qr_png,
    mobileUrl: d.next?.always,
  };
}

// ── Xumm webhook handler ──────────────────────────────────────
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

module.exports = {
  createSignInPayload,
  createEscrowPayload,
  createFinishPayload,
  getPayloadResult,
  verifySignIn,
  handleWebhook,
};
