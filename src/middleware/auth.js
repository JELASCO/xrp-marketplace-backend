const jwt = require('jsonwebtoken');
const db  = require('../db');

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token gerekli' });

    const token   = header.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await db.users.findById(decoded.id);
    if (!user)          return res.status(401).json({ error: 'Kullanıcı bulunamadı' });
    if (user.is_banned) return res.status(403).json({ error: 'Hesap askıya alındı' });

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Geçersiz token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin yetkisi gerekli' });
  next();
}

module.exports = { auth, requireAdmin };
