const XUMM_API_KEY = process.env.XUMM_API_KEY;
const XUMM_API_SECRET = process.env.XUMM_API_SECRET;
const BASE = 'https://xumm.app/api/v1/platform';

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-key': String(XUMM_API_KEY).trim(),
    'x-api-secret': String(XUMM_API_SECRET).trim()
  };
}

async function xummPost(endpoint, body) {
  const url = BASE + endpoint;
  console.log('[Xumm] POST', url, 'key:', XUMM_API_KEY && XUMM_API_KEY.slice(0,8));
  const r = await fetch(url, { method: 'POST', headers: getHeaders(), body: JSON.stringify(body) });
  const text = await r.text();
  console.log('[Xumm]', r.status, text.slice(0, 300));
  let d;
  try { d = JSON.parse(text); } catch(e) { throw new Error('non-JSON: ' + text.slice(0,100)); }
  if (!r.ok) throw new Error(JSON.stringify(d));
  return d;
}

async function xummGet(endpoint) {
  const r = await fetch(BASE + endpoint, { headers: getHeaders() });
  const text = await r.text();
  try { return JSON.parse(text); } catch(e) { return {}; }
}

async function createSignInPayload() {
  const d = await xummPost('/payload', { txjson: { TransactionType: 'SignIn' }, options: { expire: 10 } });
  return { uuid: d.uuid, qrUrl: d.refs && d.refs.qr_png ? d.refs.qr_png : null, wsUrl: d.refs && d.refs.websocket_status ? d.refs.websocket_status : null };
}

async function verifySignIn(uuid) {
  for (var i = 0; i < 8; i++) {
    var d = await xummGet('/payload/' + uuid);
    console.log('[Xumm] poll', i+1, JSON.stringify(d.meta));
    if (d.meta && d.meta.signed === true) return { signed: true, walletAddress: d.response && d.response.account ? d.response.account : null };
    if (d.meta && d.meta.signed === false) return { signed: false };
    await new Promise(function(res) { setTimeout(res, 2500); });
  }
  return { signed: false };
}

async function createEscrowPayload(opts) {
  var drops = Math.floor(parseFloat(opts.xrpAmount) * 1000000).toString();
  var d = await xummPost('/payload', { txjson: { TransactionType: 'EscrowCreate', Account: opts.buyerAddress, Destination: opts.sellerAddress, Amount: drops, CancelAfter: opts.cancelAfter, Memos: [{ Memo: { MemoData: Buffer.from(opts.orderId).toString('hex').toUpperCase(), MemoType: Buffer.from('orderId').toString('hex').toUpperCase() } }] }, options: { expire: 10, return_url: { web: (process.env.FRONTEND_URL || '') + '/orders' } } });
  return { uuid: d.uuid, qrUrl: d.refs && d.refs.qr_png ? d.refs.qr_png : null, wsUrl: d.refs && d.refs.websocket_status ? d.refs.websocket_status : null, deepLink: d.next && d.next.always ? d.next.always : null };
}

async function createEscrowFinishPayload(opts) {
  var d = await xummPost('/payload', { txjson: { TransactionType: 'EscrowFinish', Account: opts.buyerAddress, Owner: opts.escrowOwner, OfferSequence: opts.offerSequence }, options: { expire: 10, return_url: { web: (process.env.FRONTEND_URL || '') + '/orders' } } });
  return { uuid: d.uuid, qrUrl: d.refs && d.refs.qr_png ? d.refs.qr_png : null, wsUrl: d.refs && d.refs.websocket_status ? d.refs.websocket_status : null, deepLink: d.next && d.next.always ? d.next.always : null };
}

async function getPayloadStatus(uuid) { return xummGet('/payload/' + uuid); }

module.exports = { createSignInPayload, verifySignIn, createEscrowPayload, createEscrowFinishPayload, getPayloadStatus };
