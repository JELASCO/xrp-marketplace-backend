const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', err => console.error('[DB]', err.message));

const db = {
  query: (t, p) => pool.query(t, p),
  users: {
    findById:     id  => pool.query('SELECT * FROM users WHERE id=$1', [id]).then(r => r.rows[0]),
    findByWallet: w   => pool.query('SELECT * FROM users WHERE wallet_address=$1', [w]).then(r => r.rows[0]),
    create: ({ walletAddress, username }) =>
      pool.query('INSERT INTO users (wallet_address,username) VALUES ($1,$2) RETURNING *', [walletAddress, username]).then(r => r.rows[0]),
    update: (id, fields) => {
      const keys = Object.keys(fields), vals = Object.values(fields);
      const set  = keys.map((k,i) => `${k}=$${i+2}`).join(',');
      return pool.query(`UPDATE users SET ${set} WHERE id=$1 RETURNING *`, [id,...vals]).then(r => r.rows[0]);
    },
  },
  listings: {
    findById: id => pool.query('SELECT l.*,u.username,u.reputation_score,u.is_verified,u.wallet_address FROM listings l JOIN users u ON l.seller_id=u.id WHERE l.id=$1',[id]).then(r=>r.rows[0]),
    list: ({ category, game, minXrp, maxXrp, sort='created_at', page=1, limit=24 } = {}) => {
      const conds=["l.status='active'"], params=[];
      if(category){params.push(category);conds.push(`l.category=$${params.length}`);}
      if(game)    {params.push(game);    conds.push(`l.game=$${params.length}`);}
      if(minXrp)  {params.push(minXrp); conds.push(`l.price_xrp>=$${params.length}`);}
      if(maxXrp)  {params.push(maxXrp); conds.push(`l.price_xrp<=$${params.length}`);}
      const orderMap={price_asc:'l.price_xrp ASC',price_desc:'l.price_xrp DESC',created_at:'l.created_at DESC',views:'l.views DESC'};
      params.push(limit,(page-1)*limit);
      return pool.query(`SELECT l.*,u.username,u.reputation_score,u.is_verified FROM listings l JOIN users u ON l.seller_id=u.id WHERE ${conds.join(' AND ')} ORDER BY l.is_featured DESC,${orderMap[sort]||'l.created_at DESC'} LIMIT $${params.length-1} OFFSET $${params.length}`,params).then(r=>r.rows);
    },
    create: d => pool.query('INSERT INTO listings (seller_id,title,description,category,game,price_xrp,images) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',[d.sellerId,d.title,d.description,d.category,d.game,d.priceXrp,d.images||[]]).then(r=>r.rows[0]),
    update: (id,fields) => { const keys=Object.keys(fields),vals=Object.values(fields),set=keys.map((k,i)=>`${k}=$${i+2}`).join(','); return pool.query(`UPDATE listings SET ${set} WHERE id=$1 RETURNING *`,[id,...vals]).then(r=>r.rows[0]); },
    incrementViews: id => pool.query('UPDATE listings SET views=views+1 WHERE id=$1',[id]),
  },
  orders: {
    findById: id => pool.query('SELECT * FROM orders WHERE id=$1',[id]).then(r=>r.rows[0]),
    findByUser: (userId,role='buyer') => pool.query(`SELECT o.*,l.title listing_title,l.category,l.images FROM orders o LEFT JOIN listings l ON o.listing_id=l.id WHERE o.${role==='seller'?'seller_id':'buyer_id'}=$1 ORDER BY o.created_at DESC`,[userId]).then(r=>r.rows),
    create: d => { const comm=parseFloat((d.totalXrp*d.commissionRate).toFixed(6)),recv=parseFloat((d.totalXrp-comm).toFixed(6)); return pool.query('INSERT INTO orders (listing_id,buyer_id,seller_id,buyer_wallet_address,seller_wallet_address,total_xrp,commission_rate,commission_xrp,seller_receives_xrp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[d.listingId,d.buyerId,d.sellerId,d.buyerWallet,d.sellerWallet,d.totalXrp,d.commissionRate,comm,recv]).then(r=>r.rows[0]); },
    update: (id,fields) => { const keys=Object.keys(fields),vals=Object.values(fields),set=keys.map((k,i)=>`${k}=$${i+2}`).join(','); return pool.query(`UPDATE orders SET ${set} WHERE id=$1 RETURNING *`,[id,...vals]).then(r=>r.rows[0]); },
  },
  disputes: {
    findById: id => pool.query('SELECT * FROM disputes WHERE id=$1',[id]).then(r=>r.rows[0]),
    findOpen: () => pool.query("SELECT d.*,o.total_xrp FROM disputes d JOIN orders o ON d.order_id=o.id WHERE d.status='open' ORDER BY d.created_at ASC").then(r=>r.rows),
    create: ({ orderId,openedById,reason,evidence }) => pool.query('INSERT INTO disputes (order_id,opened_by_id,reason,evidence) VALUES ($1,$2,$3,$4) RETURNING *',[orderId,openedById,reason,evidence||[]]).then(r=>r.rows[0]),
    update: (id,fields) => { const keys=Object.keys(fields),vals=Object.values(fields),set=keys.map((k,i)=>`${k}=$${i+2}`).join(','); return pool.query(`UPDATE disputes SET ${set} WHERE id=$1 RETURNING *`,[id,...vals]).then(r=>r.rows[0]); },
  },
  reviews: {
    forUser: userId => pool.query('SELECT r.*,u.username reviewer_name FROM reviews r JOIN users u ON r.reviewer_id=u.id WHERE r.reviewed_id=$1 ORDER BY r.created_at DESC',[userId]).then(r=>r.rows),
    create: ({ orderId,reviewerId,reviewedId,rating,comment }) => pool.query('INSERT INTO reviews (order_id,reviewer_id,reviewed_id,rating,comment) VALUES ($1,$2,$3,$4,$5) RETURNING *',[orderId,reviewerId,reviewedId,rating,comment]).then(r=>r.rows[0]),
  },
};

module.exports = db;
