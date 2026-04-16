const xrpl       = require('xrpl');
const xrplClient = require('../xrplClient');

const RIPPLE_EPOCH   = 946684800;
const COMMISSION     = parseFloat(process.env.COMMISSION_RATE || '0.03');
const TIMEOUT_DAYS   = parseInt(process.env.ESCROW_TIMEOUT_DAYS || '7');
const PLATFORM_ADDR  = process.env.PLATFORM_WALLET_ADDRESS;

function rippleTime(daysFromNow = TIMEOUT_DAYS) {
  return Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + daysFromNow * 86400;
}

// ── Create escrow ────────────────────────────────────────────────
async function createEscrow({ buyerSeed, sellerAddress, xrpAmount, orderId }) {
  const client = await xrplClient.get();
  const wallet  = xrpl.Wallet.fromSeed(buyerSeed);

  const tx = {
    TransactionType: 'EscrowCreate',
    Account:         wallet.address,
    Destination:     sellerAddress,
    Amount:          xrpl.xrpToDrops(String(xrpAmount)),
    CancelAfter:     rippleTime(),
    Memos: [{
      Memo: {
        MemoData: Buffer.from(orderId).toString('hex').toUpperCase(),
        MemoType: Buffer.from('orderId').toString('hex').toUpperCase(),
      }
    }]
  };

  const prepared = await client.autofill(tx);
  const signed   = wallet.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);

  if (result.result.meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`EscrowCreate failed: ${result.result.meta.TransactionResult}`);
  }

  return {
    txHash:         result.result.hash,
    escrowSequence: result.result.tx_json.Sequence,
    buyerAddress:   wallet.address,
    cancelAfter:    new Date((rippleTime() + RIPPLE_EPOCH) * 1000).toISOString(),
  };
}

// ── Finish escrow (buyer confirms) ───────────────────────────────
async function finishEscrow({ buyerSeed, escrowSequence, xrpAmount }) {
  const client = await xrplClient.get();
  const wallet  = xrpl.Wallet.fromSeed(buyerSeed);

  const tx = {
    TransactionType: 'EscrowFinish',
    Account:         wallet.address,
    Owner:           wallet.address,
    OfferSequence:   escrowSequence,
  };

  const prepared = await client.autofill(tx);
  const signed   = wallet.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);

  if (result.result.meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`EscrowFinish failed: ${result.result.meta.TransactionResult}`);
  }

  const commissionXrp  = parseFloat((xrpAmount * COMMISSION).toFixed(6));
  const sellerReceives = parseFloat((xrpAmount - commissionXrp).toFixed(6));

  // Send commission to platform wallet
  if (PLATFORM_ADDR && process.env.PLATFORM_WALLET_SEED) {
    await sendPayment({
      fromSeed: process.env.PLATFORM_WALLET_SEED,
      toAddress: PLATFORM_ADDR,
      xrpAmount: commissionXrp,
      memo: `commission:${result.result.hash}`
    }).catch(e => console.error('[Commission] Failed:', e.message));
  }

  return {
    txHash:         result.result.hash,
    sellerReceives,
    commissionPaid: commissionXrp,
  };
}

// ── Cancel escrow (admin or timeout) ────────────────────────────
async function cancelEscrow({ cancellerSeed, escrowOwner, escrowSequence }) {
  const client = await xrplClient.get();
  const wallet  = xrpl.Wallet.fromSeed(cancellerSeed);

  const tx = {
    TransactionType: 'EscrowCancel',
    Account:         wallet.address,
    Owner:           escrowOwner,
    OfferSequence:   escrowSequence,
  };

  const prepared = await client.autofill(tx);
  const signed   = wallet.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);

  if (result.result.meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`EscrowCancel failed: ${result.result.meta.TransactionResult}`);
  }

  return { txHash: result.result.hash };
}

// ── Generic payment ──────────────────────────────────────────────
async function sendPayment({ fromSeed, toAddress, xrpAmount, memo }) {
  const client = await xrplClient.get();
  const wallet  = xrpl.Wallet.fromSeed(fromSeed);

  const tx = {
    TransactionType: 'Payment',
    Account:         wallet.address,
    Destination:     toAddress,
    Amount:          xrpl.xrpToDrops(String(xrpAmount)),
  };

  if (memo) {
    tx.Memos = [{ Memo: { MemoData: Buffer.from(memo).toString('hex').toUpperCase(), MemoType: Buffer.from('type').toString('hex').toUpperCase() } }];
  }

  const prepared = await client.autofill(tx);
  const signed   = wallet.sign(prepared);
  return client.submitAndWait(signed.tx_blob);
}

// ── Check ledger escrow status ───────────────────────────────────
async function getEscrowStatus(ownerAddress, sequence) {
  const client = await xrplClient.get();
  try {
    const res = await client.request({ command: 'account_objects', account: ownerAddress, type: 'escrow', ledger_index: 'validated' });
    const obj  = res.result.account_objects.find(o => o.Sequence === sequence);
    if (!obj) return { status: 'not_found' };
    return { status: 'locked', amount: xrpl.dropsToXrp(obj.Amount), destination: obj.Destination, cancelAfter: obj.CancelAfter };
  } catch {
    return { status: 'error' };
  }
}

module.exports = { createEscrow, finishEscrow, cancelEscrow, getEscrowStatus };
