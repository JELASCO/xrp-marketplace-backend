require('dotenv').config();
const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const helmet     = require('helmet');

const app    = express();
const server = http.createServer(app);

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

// Health check — Railway bunu kontrol eder
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), env: process.env.NODE_ENV });
});

// Routes — DB ve XRPL bağlantısı olmadan da çalışsın
try {
  const routes = require('./routes');
  app.use('/api', routes);
} catch(e) {
  console.warn('[Routes] Could not load routes:', e.message);
  app.get('/api', (req, res) => res.json({ message: 'XRP Marketplace API', status: 'starting' }));
}

// Error handler
app.use((err, req, res, _next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Server error' });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[API] Running on port ${PORT}`);
  
  // XRPL bağlantısını arka planda dene
  if (process.env.XRPL_NODE) {
    try {
      const xrplClient = require('./xrplClient');
      xrplClient.get()
        .then(() => console.log('[XRPL] Connected'))
        .catch(e => console.warn('[XRPL] Connection failed (non-fatal):', e.message));
    } catch(e) {
      console.warn('[XRPL] Module error:', e.message);
    }
  }

  // Socket.io
  try {
    const socket = require('./notifications/socket');
    socket.init(server);
    console.log('[Socket.IO] Ready');
  } catch(e) {
    console.warn('[Socket.IO] Failed:', e.message);
  }
});
