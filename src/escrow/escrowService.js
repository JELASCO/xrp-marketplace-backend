const xrpl       = require('xrpl');
const xrplClient = require('../xrplClient');

const RIPPLE_EPOCH = 946684800;
const COMMISSION   = parseFloat(process.env.COMMISSION_RATE || '0.03');
const TIMEOUT_DAYS = parseInt(process.env.ESCROW_TIMEOUT_DAYS || '7');
const PLATFORM     = process.env.PLATFORM_WALLET_ADDRESS;

function rippleTime(days = TIMEOUT_DAYS) {
  return Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + days * 86400;
}

async function createEscrow({ buyerSeed, sellerAddress, xrpAmount, orderId }) {
  const client = await xrplClient.get();
  const wallet  = xrpl.Wallet.fromSeed(buyerSeed);
  const tx = {
    TransactionType: 'EscrowCreate',
    Account:     wallet.address,
    Destination: sellerAddress,
    Amount:      xrpl.xrpToDrops(String(xrpAmount)),
    CancelAfter: rippleTime(),
    Memos: [{ Memo: { MemoData: Buffer.from(orderId).toString('hex').toUpperCase(), MemoType: Buffer.from('orderId').toString('hex').toUpperCase() } }],
  };
  const prepared = await client.autofill(tx);
  const signed   = wallet.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);
  if (result.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error(`EscrowCreate failed: ${result.result.meta.TransactionResult}`);
  return { txHash: result.result.hash, escrowSequence: result.result.tx_json.Sequence, buyerAddress: wallet.address };
}

async function finishEscrow({ buyerSeed, escrowSequence, xrpAmount }) {
  const client = await xrplClient.get();
  const wallet  = xrpl.Wallet.fromSeed(buyerSeed);
  const tx = { TransactionType: 'EscrowFinish', Account: wallet.address, Owner: wallet.address, OfferSequence: escrowSequence };
  const prepared = await client.autofill(tx);
  const signed   = wallet.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);
  if (result.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error(`EscrowFinish failed: ${result.result.meta.TransactionResult}`);
  const commissionXrp  = parseFloat((xrpAmount * COMMISSION).toFixed(6));
  const sellerReceives = parseFloat((xrpAmount - commissionXrp).toFixed(6));
  return { txHash: result.result.hash, sellerReceives, commissionPaid: commissionXrp };
}

async function cancelEscrow({ cancellerSeed, escrowOwner, escrowSequence }) {
  const client = await xrplClient.get();
  const wallet  = xrpl.Wallet.fromSeed(cancellerSeed);
  const tx = { TransactionType: 'EscrowCancel', Account: wallet.address, Owner: escrowOwner, OfferSequence: escrowSequence };
  const prepared = await client.autofill(tx);
  const signed   = wallet.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);
  if (result.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error(`EscrowCancel failed: ${result.result.meta.TransactionResult}`);
  return { txHash: result.result.hash };
}

async function getEscrowStatus(ownerAddress, sequence) {
  try {
    const client = await xrplClient.get();
    const res = await client.request({ command: 'account_objects', account: ownerAddress, type: 'escrow', ledger_index: 'validated' });
    const obj  = res.result.account_objects.find(o => o.Sequence === sequence);
    if (!obj) return { status: 'not_found' };
    return { status: 'locked', amount: xrpl.dropsToXrp(obj.Amount), destination: obj.Destination };
  } catch { return { status: 'error' }; }
}

module.exports = { createEscrow, finishEscrow, cancelEscrow, getEscrowStatus };
