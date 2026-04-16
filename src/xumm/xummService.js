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
  const res = await fetch(`${XUMM_API}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text(); throw new Error(`Xumm ${res.status}: ${t}`); }
  return res.json();
}

async function get(path) {
  const res = await fetch(`${XUMM_API}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`Xumm GET ${res.status}`);
  return res.json();
}

async function createSignInPayload() {
  const d = await post('/payload', {
    txjson: { TransactionType: 'SignIn' },
    options: { submit: false, return_url: { web: `${process.env.FRONTEND_URL}/auth/callback?uuid={id}` } },
    custom_meta: { instruction: 'Sign in to XRP Market' },
  });
  return { uuid: d.uuid, qrUrl: d.refs?.qr_png, mobileUrl: d.next?.always, wsUrl: d.refs?.websocket_status };
}

async function createEscrowPayload({ buyerAddress, sellerAddress, xrpAmount, orderId, cancelAfterDays = 7 }) {
  const cancelAfter = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + cancelAfterDays * 86400;
  const d = await post('/payload', {
    txjson: { TransactionType: 'EscrowCreate', Account: buyerAddress, Destination: sellerAddress, Amount: String(Math.floor(xrpAmount * 1_000_000)), CancelAfter: cancelAfter },
    options: { submit: true },
    custom_meta: { instruction: `${xrpAmount} XRP will be locked in escrow`, blob: { orderId, type: 'escrow_create' } },
  });
  return { uuid: d.uuid, qrUrl: d.refs?.qr_png, mobileUrl: d.next?.always, wsUrl: d.refs?.websocket_status };
}

async function createFinishPayload({ buyerAddress, escrowOwner, escrowSequence, orderId }) {
  const d = await post('/payload', {
    txjson: { TransactionType: 'EscrowFinish', Account: buyerAddress, Owner: escrowOwner, OfferSequence: escrowSequence },
    options: { submit: true },
    custom_meta: { instruction: 'Confirm delivery and release payment', blob: { orderId, type: 'escrow_finish' } },
  });
  return { uuid: d.uuid, qrUrl: d.refs?.qr_png, mobileUrl: d.next?.always };
}

async function getPayloadResult(uuid) {
  const d = await get(`/payload/${uuid}`);
  return { resolved: d.meta?.resolved || false, signed: d.meta?.signed || false, txid: d.response?.txid || null, account: d.response?.account || null };
}

async function waitForPayload(uuid, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await getPayloadResult(uuid);
    if (r.resolved) return r;
    await new Promise(res => setTimeout(res, 2000));
  }
  throw new Error('Xumm payload timed out');
}

async function verifySignIn(uuid) {
  const { signed, account } = await waitForPayload(uuid, 30_000);
  if (!signed) throw new Error('User rejected sign-in');
  let user = await db.users.findByWallet(account);
  if (!user) user = await db.users.create({ walletAddress: account, username: `user_${account.slice(-6).toLowerCase()}` });
  const token = jwt.sign({ id: user.id, wallet: account, role: user.role }, process.env.JWT_SECRET || 'dev-secret', { expiresIn: '7d' });
  return { token, user };
}

async function handleWebhook(body) {
  const { meta, custom_meta, txid } = body;
  const blob = custom_meta?.blob || {};
  if (!meta?.signed || !blob.orderId) return;
  if (blob.type === 'escrow_create' && txid) await db.orders.update(blob.orderId, { status: 'escrow_locked', escrow_tx_hash: txid });
  if (blob.type === 'escrow_finish' && txid) await db.orders.update(blob.orderId, { status: 'completed', finish_tx_hash: txid, completed_at: new Date() });
}

module.exports = { createSignInPayload, createEscrowPayload, createFinishPayload, getPayloadResult, waitForPayload, verifySignIn, handleWebhook };
