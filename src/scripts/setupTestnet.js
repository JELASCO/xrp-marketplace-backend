require('dotenv').config();
const xrpl = require('xrpl');

async function main() {
  console.log('Testnet cüzdanları oluşturuluyor...\n');

  const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
  await client.connect();

  const [platform, buyer, seller] = await Promise.all([
    client.fundWallet(),
    client.fundWallet(),
    client.fundWallet(),
  ]);

  console.log('=== .env dosyasına kopyala ===\n');
  console.log(`XRPL_NODE=wss://s.altnet.rippletest.net:51233`);
  console.log(`PLATFORM_WALLET_ADDRESS=${platform.wallet.address}`);
  console.log(`PLATFORM_WALLET_SEED=${platform.wallet.seed}\n`);

  console.log('=== Test walletları ===\n');
  console.log('Alıcı wallet:');
  console.log(`  Address: ${buyer.wallet.address}`);
  console.log(`  Seed:    ${buyer.wallet.seed}`);
  console.log(`  Bakiye:  ${buyer.balance} XRP\n`);

  console.log('Satıcı wallet:');
  console.log(`  Address: ${seller.wallet.address}`);
  console.log(`  Seed:    ${seller.wallet.seed}`);
  console.log(`  Bakiye:  ${seller.balance} XRP\n`);

  // Quick escrow test
  console.log('Escrow akışı test ediliyor...');

  const RIPPLE_EPOCH = 946684800;
  const cancelAfter  = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + 300; // 5 dk

  const createTx = {
    TransactionType: 'EscrowCreate',
    Account:         buyer.wallet.address,
    Destination:     seller.wallet.address,
    Amount:          xrpl.xrpToDrops('10'),
    CancelAfter:     cancelAfter,
  };

  const prepared = await client.autofill(createTx);
  const signed   = buyer.wallet.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);

  if (result.result.meta.TransactionResult === 'tesSUCCESS') {
    console.log(`✓ EscrowCreate başarılı — TX: ${result.result.hash}`);
    const seq = result.result.tx_json.Sequence;

    const finishTx   = { TransactionType: 'EscrowFinish', Account: buyer.wallet.address, Owner: buyer.wallet.address, OfferSequence: seq };
    const prepFinish  = await client.autofill(finishTx);
    const signFinish  = buyer.wallet.sign(prepFinish);
    const finResult   = await client.submitAndWait(signFinish.tx_blob);
    console.log(`✓ EscrowFinish başarılı  — TX: ${finResult.result.hash}`);
    console.log('\nTüm testler geçti. Sisteminiz hazır!');
  } else {
    console.error('✗ Escrow testi başarısız:', result.result.meta.TransactionResult);
  }

  await client.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
