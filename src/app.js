require('dotenv').config();
// Fixed
const express = require('express');
const http    = require('http');
const { Pool } = require('pg');

const app    = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/',       (req, res) => res.json({ name: 'XRP Marketplace API', version: '1.0.0' }));

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), username VARCHAR(40) UNIQUE NOT NULL, wallet_address VARCHAR(60) UNIQUE NOT NULL, bio TEXT, role VARCHAR(10) DEFAULT 'user', reputation_score DECIMAL(3,1) DEFAULT 0, total_sales INTEGER DEFAULT 0, total_volume_xrp DECIMAL(18,6) DEFAULT 0, is_verified BOOLEAN DEFAULT false, is_banned BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS listings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), seller_id UUID NOT NULL REFERENCES users(id), title VARCHAR(120) NOT NULL, description TEXT, category VARCHAR(30) NOT NULL, game VARCHAR(60), price_xrp DECIMAL(18,6) NOT NULL, images TEXT[] DEFAULT '{}', status VARCHAR(20) DEFAULT 'active', is_featured BOOLEAN DEFAULT false, featured_until TIMESTAMPTZ, views INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), listing_id UUID REFERENCES listings(id), buyer_id UUID NOT NULL REFERENCES users(id), seller_id UUID NOT NULL REFERENCES users(id), buyer_wallet_address VARCHAR(60) NOT NULL, seller_wallet_address VARCHAR(60) NOT NULL, total_xrp DECIMAL(18,6) NOT NULL, commission_rate DECIMAL(5,4) NOT NULL, commission_xrp DECIMAL(18,6), seller_receives_xrp DECIMAL(18,6), escrow_tx_hash VARCHAR(80), escrow_sequence INTEGER, finish_tx_hash VARCHAR(80), cancel_tx_hash VARCHAR(80), escrow_expires_at TIMESTAMPTZ, status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS disputes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID NOT NULL REFERENCES orders(id), opened_by_id UUID NOT NULL REFERENCES users(id), reason TEXT NOT NULL, evidence TEXT[] DEFAULT '{}', admin_id UUID REFERENCES users(id), decision VARCHAR(20), admin_note TEXT, status VARCHAR(15) DEFAULT 'open', created_at TIMESTAMPTZ DEFAULT NOW(), resolved_at TIMESTAMPTZ)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS reviews (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID NOT NULL UNIQUE REFERENCES orders(id), reviewer_id UUID NOT NULL REFERENCES users(id), reviewed_id UUID NOT NULL REFERENCES users(id), rating SMALLINT NOT NULL, comment TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID NOT NULL REFERENCES orders(id), sender_id UUID NOT NULL REFERENCES users(id), content TEXT NOT NULL, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ad_slots (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slot_name VARCHAR(60) NOT NULL, advertiser_id UUID NOT NULL REFERENCES users(id), listing_id UUID REFERENCES listings(id), price_xrp DECIMAL(18,6) NOT NULL, payment_tx VARCHAR(80), starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
    console.log('[DB] Migration complete');
  } catch(e) {
    console.error('[DB] Migration error:', e.message);
  } finally {
    await pool.end();
  }
}

try {
  app.use('/api', require('./routes');return typeof r==='function'?r:r.default||r.router||Object.values(r)[0];})());
  console.log('[Routes] Loaded');
} catch(e) {
  console.error('[Routes] Load error:', e.message);
  app.use('/api', (req, res) => res.status(500).json({ error: 'Routes failed: ' + e.message }));
}

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[API] Port ${PORT}`);
  if (process.env.DATABASE_URL) await migrate();
  if (process.env.XRPL_NODE) require('./xrplClient').get().then(() => console.log('[XRPL] Connected')).catch(e => console.warn('[XRPL]', e.message));
  try { require('./notifications/socket').init(server); console.log('[Socket.IO] Ready'); } catch(e) { console.warn('[Socket.IO]', e.message); }
});
