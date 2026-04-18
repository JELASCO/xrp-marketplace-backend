const XUMM_API_KEY = process.env.XUMM_API_KEY;
const XUMM_API_SECRET = process.env.XUMM_API_SECRET;
const BASE = 'https://xumm.app/api/v2';

async function xummPost(endpoint, body) {
  const r = await fetch(BASE + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': XUMM_API_KEY,
      'x-api-secret': XUMM_API_SECRET
    },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error && d.error.message ? d.error.message : JSON.stringify(d));
  return d;
}

async function xummGet(endpoint) {
  const r = await fetch(BASE + endpoint, {
    headers: {
      'x-api-key': XUMM_API_KEY,
      'x-api-secret': XUMM_API_SECRET
    }
  });
  return r.json();
}

async function createSignInPayload() {
  console.log('[Xumm] Creating sign-in payload...');
  const d = await xummPost('/payload', {
    txjson: { TransactionType: 'SignIn' },
    options: { expire: 10 }
  });
  return {
    uuid: d.uuid,
    qrUrl: d.refs && d.refs.qr_png ? d.refs.qr_png : null,
    wsUrl: d.refs && d.refs.websocket_status ? d.refs.websocket_status : null
  };
}

async function verifySignIn(uuid) {
  console.log('[Xumm] Verifying UUID:', uuid);
  for (var i = 0; i < 8; i++) {
    var d = await xummGet('/payload/' + uuid);
    console.log('[Xumm] Poll ' + (i+1) + ': signed=' + (d.meta && d.meta.signed));
    if (d.meta && d.meta.signed === true) return { signed: true, walletAddress: d.response && d.response.account };
    if (d.meta && d.meta.signed === false) return { signed: false };
    await new Promise(function(r) { setTimeout(r, 2500); });
  }
  return { signed: false };
}

async function createEscrowPayload(opts) {
  var buyerAddress = opts.buyerAddress;
  var sellerAddress = opts.sellerAddress;
  var xrpAmount = opts.xrpAmount;
  var cancelAfter = opts.cancelAfter;
  var orderId = opts.orderId;
  var drops = Math.floor(parseFloat(xrpAmount) * 1000000).toString();
  var d = await xummPost('/payload', {
    txjson: {
      TransactionType: 'EscrowCreate',
      Account: buyerAddress,
      Destination: sellerAddress,
      Amount: drops,
      CancelAfter: cancelAfter,
      Memos: [{
        Memo: {
          MemoData: Buffer.from(orderId).toString('hex').toUpperCase(),
          MemoType: Buffer.from('orderId').toString('hex').toUpperCase()
        }
      }]
    },
    options: {
      expire: 10,
      return_url: { web: (process.env.FRONTEND_URL || '') + '/orders' }
    }
  });
  return {
    uuid: d.uuid,
    qrUrl: d.refs && d.refs.qr_png ? d.refs.qr_png : null,
    wsUrl: d.refs && d.refs.websocket_status ? d.refs.websocket_status : null,
    deepLink: d.next && d.next.always ? d.next.always : null
  };
}

async function createEscrowFinishPayload(opts) {
  var buyerAddress = opts.buyerAddress;
  var escrowOwner = opts.escrowOwner;
  var offerSequence = opts.offerSequence;
  var d = await xummPost('/payload', {
    txjson: {
      TransactionType: 'EscrowFinish',
      Account: buyerAddress,
      Owner: escrowOwner,
      OfferSequence: offerSequence
    },
    options: {
      expire: 10,
      return_url: { web: (process.env.FRONTEND_URL || '') + '/orders' }
    }
  });
  return {
    uuid: d.uuid,
    qrUrl: d.refs && d.refs.qr_png ? d.refs.qr_png : null,
    wsUrl: d.refs && d.refs.websocket_status ? d.refs.websocket_status : null,
    deepLink: d.next && d.next.always ? d.next.always : null
  };
}

async function getPayloadStatus(uuid) {
  return xummGet('/payload/' + uuid);
}

module.exports = { createSignInPayload, verifySignIn, createEscrowPayload, createEscrowFinishPayload, getPayloadStatus };
