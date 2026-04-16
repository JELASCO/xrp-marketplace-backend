const jwt = require('jsonwebtoken');
const db  = require('../db');

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token required' });
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET || 'dev-secret');
    const user = await db.users.findById(decoded.id);
    if (!user)          return res.status(401).json({ error: 'User not found' });
    if (user.is_banned) return res.status(403).json({ error: 'Account suspended' });
    req.user = user;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  next();
}

module.exports = { auth, requireAdmin };
