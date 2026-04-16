const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => console.error('[DB] Unexpected error:', err));

// ── Generic helpers ──────────────────────────────────────────────
const db = {
  query: (text, params) => pool.query(text, params),

  // Users
  users: {
    findById:     (id)      => pool.query('SELECT * FROM users WHERE id=$1', [id]).then(r => r.rows[0]),
    findByWallet: (address) => pool.query('SELECT * FROM users WHERE wallet_address=$1', [address]).then(r => r.rows[0]),
    create: ({ walletAddress, username }) =>
      pool.query(
        'INSERT INTO users (wallet_address, username) VALUES ($1,$2) RETURNING *',
        [walletAddress, username]
      ).then(r => r.rows[0]),
    update: (id, fields) => {
      const keys   = Object.keys(fields);
      const values = Object.values(fields);
      const set    = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
      return pool.query(`UPDATE users SET ${set} WHERE id=$1 RETURNING *`, [id, ...values]).then(r => r.rows[0]);
    },
  },

  // Listings
  listings: {
    findById: (id) => pool.query(
      'SELECT l.*, u.username, u.reputation_score, u.is_verified FROM listings l JOIN users u ON l.seller_id=u.id WHERE l.id=$1',
      [id]
    ).then(r => r.rows[0]),

    list: ({ category, game, minXrp, maxXrp, sort = 'created_at', page = 1, limit = 24 } = {}) => {
      const conditions = ["l.status='active'"];
      const params = [];
      if (category)  { params.push(category);  conditions.push(`l.category=$${params.length}`); }
      if (game)      { params.push(game);       conditions.push(`l.game=$${params.length}`); }
      if (minXrp)    { params.push(minXrp);     conditions.push(`l.price_xrp>=$${params.length}`); }
      if (maxXrp)    { params.push(maxXrp);     conditions.push(`l.price_xrp<=$${params.length}`); }

      const orderMap = { price_asc: 'l.price_xrp ASC', price_desc: 'l.price_xrp DESC', created_at: 'l.created_at DESC', views: 'l.views DESC' };
      const orderBy  = orderMap[sort] || 'l.created_at DESC';
      const offset   = (page - 1) * limit;
      params.push(limit, offset);

      return pool.query(
        `SELECT l.*, u.username, u.reputation_score, u.is_verified
         FROM listings l JOIN users u ON l.seller_id=u.id
         WHERE ${conditions.join(' AND ')}
         ORDER BY l.is_featured DESC, ${orderBy}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ).then(r => r.rows);
    },

    create: (data) => {
      const { sellerId, title, description, category, game, priceXrp, images } = data;
      return pool.query(
        'INSERT INTO listings (seller_id,title,description,category,game,price_xrp,images) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [sellerId, title, description, category, game, priceXrp, images || []]
      ).then(r => r.rows[0]);
    },

    update: (id, fields) => {
      const keys   = Object.keys(fields);
      const values = Object.values(fields);
      const set    = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
      return pool.query(`UPDATE listings SET ${set} WHERE id=$1 RETURNING *`, [id, ...values]).then(r => r.rows[0]);
    },

    incrementViews: (id) => pool.query('UPDATE listings SET views=views+1 WHERE id=$1', [id]),
  },

  // Orders
  orders: {
    findById: (id) => pool.query('SELECT * FROM orders WHERE id=$1', [id]).then(r => r.rows[0]),

    findByUser: (userId, role = 'buyer') => {
      const col = role === 'seller' ? 'seller_id' : 'buyer_id';
      return pool.query(
        `SELECT o.*, l.title listing_title, l.category, l.images
         FROM orders o LEFT JOIN listings l ON o.listing_id=l.id
         WHERE o.${col}=$1 ORDER BY o.created_at DESC`,
        [userId]
      ).then(r => r.rows);
    },

    create: (data) => {
      const { listingId, buyerId, sellerId, buyerWallet, sellerWallet, totalXrp, commissionRate } = data;
      const commissionXrp   = parseFloat((totalXrp * commissionRate).toFixed(6));
      const sellerReceives  = parseFloat((totalXrp - commissionXrp).toFixed(6));
      return pool.query(
        `INSERT INTO orders (listing_id,buyer_id,seller_id,buyer_wallet_address,seller_wallet_address,
          total_xrp,commission_rate,commission_xrp,seller_receives_xrp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [listingId, buyerId, sellerId, buyerWallet, sellerWallet, totalXrp, commissionRate, commissionXrp, sellerReceives]
      ).then(r => r.rows[0]);
    },

    update: (id, fields) => {
      const keys   = Object.keys(fields);
      const values = Object.values(fields);
      const set    = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
      return pool.query(`UPDATE orders SET ${set} WHERE id=$1 RETURNING *`, [id, ...values]).then(r => r.rows[0]);
    },
  },

  // Disputes
  disputes: {
    findById:    (id)     => pool.query('SELECT * FROM disputes WHERE id=$1', [id]).then(r => r.rows[0]),
    findOpen:    ()       => pool.query("SELECT d.*, o.total_xrp, o.buyer_wallet_address FROM disputes d JOIN orders o ON d.order_id=o.id WHERE d.status='open' ORDER BY d.created_at ASC").then(r => r.rows),
    create: ({ orderId, openedById, reason, evidence }) =>
      pool.query(
        'INSERT INTO disputes (order_id,opened_by_id,reason,evidence) VALUES ($1,$2,$3,$4) RETURNING *',
        [orderId, openedById, reason, evidence || []]
      ).then(r => r.rows[0]),
    update: (id, fields) => {
      const keys   = Object.keys(fields);
      const values = Object.values(fields);
      const set    = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
      return pool.query(`UPDATE disputes SET ${set} WHERE id=$1 RETURNING *`, [id, ...values]).then(r => r.rows[0]);
    },
  },

  // Reviews
  reviews: {
    forUser: (userId) => pool.query(
      'SELECT r.*, u.username reviewer_name FROM reviews r JOIN users u ON r.reviewer_id=u.id WHERE r.reviewed_id=$1 ORDER BY r.created_at DESC',
      [userId]
    ).then(r => r.rows),
    create: ({ orderId, reviewerId, reviewedId, rating, comment }) =>
      pool.query(
        'INSERT INTO reviews (order_id,reviewer_id,reviewed_id,rating,comment) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [orderId, reviewerId, reviewedId, rating, comment]
      ).then(r => r.rows[0]),
  },
};

module.exports = db;
