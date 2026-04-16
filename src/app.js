require('dotenv').config();
const express = require('express');
const http    = require('http');
const cors    = require('cors');
const helmet  = require('helmet');

const app    = express();
const server = http.createServer(app);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/',       (req, res) => res.json({ name: 'XRP Marketplace API', version: '1.0.0' }));

// Routes
try {
  app.use('/api', require('./routes'));
} catch(e) {
  console.warn('[Routes] Load error:', e.message);
  app.get('/api', (req, res) => res.json({ status: 'API starting up' }));
}

// 404 & error
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[API] Listening on port ${PORT}`);

  // Try XRPL connection (non-blocking)
  if (process.env.XRPL_NODE) {
    require('./xrplClient').get()
      .then(() => console.log('[XRPL] Connected'))
      .catch(e => console.warn('[XRPL] Not connected (will retry on first request):', e.message));
  }

  // Socket.IO
  try {
    require('./notifications/socket').init(server);
  } catch(e) {
    console.warn('[Socket.IO] Init failed:', e.message);
  }
});
