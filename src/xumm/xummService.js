const fetch = require('node-fetch');
const jwt   = require('jsonwebtoken');
const db    = require('../db');

const XUMM_API = 'https://xumm.app/api/v1/platform';

function headers() {
  return {
    'Content-Type':  'application/json',
    'x-api-key':    process.env.XUMM_API_KEY    || '',
    'x-api-secret': process.env.XUMM_API_SECRET || '',
  };
}

async function xummPost(path, body) {
  const res  = await fetch(`${XUMM_API}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const text = await res.text();
  console.log(`[Xumm POST ${path}] ${res.status}: ${text.slice(0, 200)}`);
  if (!res.ok) throw new Error(`Xumm ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function xummGet(path) {
  const res  = await fetch(`${XUMM_API}${path}`, { headers: headers() });
  const text = await res.text();
  console.log(`[Xumm GET ${path}] ${res.status}: ${text.slice(0, 300)}`);
  if (!res.ok) throw new Error(`Xumm GET ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function createSignInPayload() {
  const d = await xummPost('/payload', {
    txjson:  { TransactionType: 'SignIn' },
    options: {
      submit:     false,
      return_url: { web: `${process.env.FRONTEND_URL}/auth/callback?uuid={id}` },
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

async function getPayloadResult(uuid) {
  const d = await xummGet(`/payload/${uuid}`);
  console.log(`[Xumm] payload meta:`, JSON.stringify(d.meta));
  console.log(`[Xumm] payload response:`, JSON.stringify(d.response));
  return {
    resolved: d.meta?.resolved  || false,
    signed:   d.meta?.signed    || false,
    txid:     d.response?.txid  || null,
    account:  d.response?.account || null,
  };
}

async function verifySignIn(uuid) {
  console.log(`[Xumm] verifySignIn called for uuid: ${uuid}`);

  let result = null;
  for (let i = 0; i < 8; i++) {
    try {
      result = await getPayloadResult(uuid);
      console.log(`[Xumm] attempt ${i+1}: resolved=${result.resolved} signed=${result.signed} account=${result.account}`);
      if (result.resolved && result.signed && result.account) break;
    } catch(e) {
      console.warn(`[Xumm] attempt ${i+1} error:`, e.message);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  if (!result) throw new Error('Could not get payload result from Xumm');
  if (!result.signed) throw new Error('User did not sign the request');
  if (!result.account) throw new Error('No wallet address returned from Xumm');

  console.log(`[Xumm] Sign-in successful for wallet: ${result.account}`);

  let user;
  try {
    console.log(`[DB] Looking up wallet: ${result.account}`);
    user = await db.users.findByWallet(result.account);
    console.log(`[DB] findByWallet result: ${JSON.stringify(user)}`);
  } catch(dbErr) {
    console.error(`[DB] findByWallet error:`, dbErr.message, dbErr.stack);
    throw new Error(`DB lookup failed: ${dbErr.message}`);
  }

  if (!user) {
    try {
      console.log(`[DB] Creating new user for wallet: ${result.account}`);
      user = await db.users.create({
        walletAddress: result.account,
        username: `user_${result.account.slice(-6).toLowerCase()}`,
      });
      console.log(`[DB] User created: ${JSON.stringify(user)}`);
    } catch(createErr) {
      console.error(`[DB] create error:`, createErr.message, createErr.stack);
      throw new Error(`DB create failed: ${createErr.message}`);
    }
  }

  const token = jwt.sign(
    { id: user.id, wallet: result.account, role: user.role },
    process.env.JWT_SECRET || 'dev-secret',
    { expiresIn: '7d' }
  );

  return { token, user };
}

async function createEscrowPayload({ buyerAddress, sellerAddress, xrpAmount, orderId, cancelAfterDays = 7 }) {
  const RIPPLE_EPOCH = 946684800;
  const cancelAfter  = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + cancelAfterDays * 86400;
  const d = await xummPost('/payload', {
    txjson: { TransactionType: 'EscrowCreate', Account: buyerAddress, Destination: sellerAddress, Amount: String(Math.floor(xrpAmount * 1_000_000)), CancelAfter: cancelAfter },
    options: { submit: true },
    custom_meta: { instruction: `${xrpAmount} XRP will be locked in escrow`, blob: { orderId, type: 'escrow_create' } },
  });
  return { uuid: d.uuid, qrUrl: d.refs?.qr_png, mobileUrl: d.next?.always, wsUrl: d.refs?.websocket_status };
}

async function createFinishPayload({ buyerAddress, escrowOwner, escrowSequence, orderId }) {
  const d = await xummPost('/payload', {
    txjson: { TransactionType: 'EscrowFinish', Account: buyerAddress, Owner: escrowOwner, OfferSequence: escrowSequence },
    options: { submit: true },
    custom_meta: { instruction: 'Confirm delivery and release payment', blob: { orderId, type: 'escrow_finish' } },
  });
  return { uuid: d.uuid, qrUrl: d.refs?.qr_png, mobileUrl: d.next?.always };
}

async function handleWebhook(body) {
  const { meta, custom_meta, txid } = body;
  const blob = custom_meta?.blob || {};
  if (!meta?.signed || !blob.orderId) return;
  if (blob.type === 'escrow_create' && txid) await db.orders.update(blob.orderId, { status: 'escrow_locked', escrow_tx_hash: txid });
  if (blob.type === 'escrow_finish' && txid) await db.orders.update(blob.orderId, { status: 'completed', finish_tx_hash: txid, completed_at: new Date() });
}

module.exports = { createSignInPayload, createEscrowPayload, createFinishPayload, getPayloadResult, verifySignIn, handleWebhook };
