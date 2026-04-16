require('dotenv').config();
const xrpl = require('xrpl');

async function main() {
  const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
  await client.connect();
  console.log('Connected to testnet...\n');
  const [platform, buyer, seller] = await Promise.all([client.fundWallet(), client.fundWallet(), client.fundWallet()]);
  console.log('=== Copy these to Railway environment variables ===\n');
  console.log(`XRPL_NODE=wss://s.altnet.rippletest.net:51233`);
  console.log(`PLATFORM_WALLET_ADDRESS=${platform.wallet.address}`);
  console.log(`PLATFORM_WALLET_SEED=${platform.wallet.seed}\n`);
  console.log('=== Test wallets ===\n');
  console.log(`Buyer:  ${buyer.wallet.address} | Seed: ${buyer.wallet.seed}`);
  console.log(`Seller: ${seller.wallet.address} | Seed: ${seller.wallet.seed}`);
  await client.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
