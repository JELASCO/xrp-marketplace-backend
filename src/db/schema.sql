CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username         VARCHAR(40) UNIQUE NOT NULL,
  wallet_address   VARCHAR(60) UNIQUE NOT NULL,
  bio              TEXT,
  role             VARCHAR(10) DEFAULT 'user' CHECK (role IN ('user','admin')),
  reputation_score DECIMAL(3,1) DEFAULT 0,
  total_sales      INTEGER DEFAULT 0,
  total_volume_xrp DECIMAL(18,6) DEFAULT 0,
  is_verified      BOOLEAN DEFAULT false,
  is_banned        BOOLEAN DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS listings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id      UUID NOT NULL REFERENCES users(id),
  title          VARCHAR(120) NOT NULL,
  description    TEXT,
  category       VARCHAR(30) NOT NULL,
  game           VARCHAR(60),
  price_xrp      DECIMAL(18,6) NOT NULL CHECK (price_xrp > 0),
  images         TEXT[] DEFAULT '{}',
  status         VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','sold','paused','removed')),
  is_featured    BOOLEAN DEFAULT false,
  featured_until TIMESTAMPTZ,
  views          INTEGER DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id             UUID REFERENCES listings(id),
  buyer_id               UUID NOT NULL REFERENCES users(id),
  seller_id              UUID NOT NULL REFERENCES users(id),
  buyer_wallet_address   VARCHAR(60) NOT NULL,
  seller_wallet_address  VARCHAR(60) NOT NULL,
  total_xrp              DECIMAL(18,6) NOT NULL,
  commission_rate        DECIMAL(5,4) NOT NULL,
  commission_xrp         DECIMAL(18,6),
  seller_receives_xrp    DECIMAL(18,6),
  escrow_tx_hash         VARCHAR(80),
  escrow_sequence        INTEGER,
  finish_tx_hash         VARCHAR(80),
  cancel_tx_hash         VARCHAR(80),
  escrow_expires_at      TIMESTAMPTZ,
  status  VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','escrow_locked','delivered','completed','disputed','refunded','cancelled')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disputes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID NOT NULL REFERENCES orders(id),
  opened_by_id UUID NOT NULL REFERENCES users(id),
  reason       TEXT NOT NULL,
  evidence     TEXT[] DEFAULT '{}',
  admin_id     UUID REFERENCES users(id),
  decision     VARCHAR(20) CHECK (decision IN ('refund_buyer','release_seller')),
  admin_note   TEXT,
  status       VARCHAR(15) DEFAULT 'open' CHECK (status IN ('open','resolved','closed')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ad_slots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_name     VARCHAR(60) NOT NULL,
  advertiser_id UUID NOT NULL REFERENCES users(id),
  listing_id    UUID REFERENCES listings(id),
  price_xrp     DECIMAL(18,6) NOT NULL,
  payment_tx    VARCHAR(80),
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL UNIQUE REFERENCES orders(id),
  reviewer_id UUID NOT NULL REFERENCES users(id),
  reviewed_id UUID NOT NULL REFERENCES users(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES orders(id),
  sender_id  UUID NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_status   ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_seller   ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer      ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller     ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_disputes_status   ON disputes(status);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='listings_updated_at') THEN
    CREATE TRIGGER listings_updated_at BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='orders_updated_at') THEN
    CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END; $$;


CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at DESC);
