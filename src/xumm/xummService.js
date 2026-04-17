const XUMM_API_KEY = process.env.XUMM_API_KEY;
const XUMM_API_SECRET = process.env.XUMM_API_SECRET;
const BASE = 'https://xumm.app/api/v1/platform';

async function xummPost(endpoint, body) {
  const r = await fetch(\`\${BASE}\${endpoint}\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': XUMM_API_KEY, 'x-api-secret': XUMM_API_SECRET },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.message || 'Xumm error');
  return d;
}

async function xummGet(endpoint) {
  const r = await fetch(\`\${BASE}\${endpoint}\`, {
    headers: { 'x-api-key': XUMM_API_KEY, 'x-api-secret': XUMM_API_SECRET }
  });
  return r.json();
}

async function createSignInPayload() {
  console.log('[Xumm] Creating sign-in payload...');
  const d = await xummPost('/payload', {
    txjson: { TransactionType: 'SignIn' },
    options: { expire: 10 }
  });
  return { uuid: d.uuid, qrUrl: d.refs?.qr_png, wsUrl: d.refs?.websocket_status };
}

async function verifySignIn(uuid) {
  console.log('[Xumm] Verifying UUID:', uuid);
  for (let i = 0; i < 8; i++) {
    const d = await xummGet(\`/payload/\${uuid}\`);
    console.log(\`[Xumm] Poll \${i+1}: signed=\${d.meta?.signed}\`);
    if (d.meta?.signed === true) return { signed: true, walletAddress: d.response?.account };
    if (d.meta?.signed === false) return { signed: false };
    await new Promise(r => setTimeout(r, 2500));
  }
  return { signed: false };
}

async function createEscrowPayload({ buyerAddress, sellerAddress, xrpAmount, cancelAfter, orderId }) {
  const drops = Math.floor(parseFloat(xrpAmount) * 1000000).toString();
  const d = await xummPost('/payload', {
    txjson: {
      TransactionType: 'EscrowCreate',
      Account: buyerAddress,
      Destination: sellerAddress,
      Amount: drops,
      CancelAfter: cancelAfter,
      Memos: [{ Memo: { MemoData: Buffer.from(orderId).toString('hex').toUpperCase(), MemoType: Buffer.from('orderId').toString('hex').toUpperCase() } }]
    },
    options: { expire: 10, return_url: { web: \`\${process.env.FRONTEND_URL}/orders\` } }
  });
  return { uuid: d.uuid, qrUrl: d.refs?.qr_png, wsUrl: d.refs?.websocket_status, deepLink: d.next?.always };
}

async function createEscrowFinishPayload({ buyerAddress, escrowOwner, offerSequence }) {
  const d = await xummPost('/payload', {
    txjson: {
      TransactionType: 'EscrowFinish',
      Account: buyerAddress,
      Owner: escrowOwner,
      OfferSequence: offerSequence
    },
    options: { expire: 10, return_url: { web: \`\${process.env.FRONTEND_URL}/orders\` } }
  });
  return { uuid: d.uuid, qrUrl: d.refs?.qr_png, wsUrl: d.refs?.websocket_status, deepLink: d.next?.always };
}

async function getPayloadStatus(uuid) {
  return xummGet(\`/payload/\${uuid}\`);
}

module.exports = { createSignInPayload, verifySignIn, createEscrowPayload, createEscrowFinishPayload, getPayloadStatus };