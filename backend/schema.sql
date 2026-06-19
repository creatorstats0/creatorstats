-- ============================================
-- CreatorStats Database Schema (PostgreSQL / Supabase)
-- ============================================

-- USERS
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- TODAY'S VIDEO (one active video being tracked, set by admin each day)
CREATE TABLE videos (
  id SERIAL PRIMARY KEY,
  youtube_video_id VARCHAR(50) NOT NULL,   -- e.g. dQw4w9WgXcQ
  title VARCHAR(300) NOT NULL,
  thumbnail_url VARCHAR(500),
  tracking_started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  admin_rating VARCHAR(20) CHECK (admin_rating IN ('bad', 'neutral', 'good', 'very_good')),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- VIEW SNAPSHOTS (fetched every 5 minutes by cron job, the core raw data)
CREATE TABLE view_snapshots (
  id SERIAL PRIMARY KEY,
  video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
  views BIGINT NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_snapshots_video_time ON view_snapshots(video_id, fetched_at);

-- EVENTS (Predik-style prediction events, linked to today's video)
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
  question VARCHAR(300) NOT NULL,         -- "Video to cross 2.86M views at 7PM?"
  target_views BIGINT NOT NULL,
  deadline TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  resolved_outcome VARCHAR(10) CHECK (resolved_outcome IN ('yes', 'no', NULL)),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_events_active ON events(is_active, deadline);

-- TRADES (one trade = one event + one user, contains multiple entries)
CREATE TABLE trades (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id),
  event_question_snapshot VARCHAR(300),    -- store text in case event is later deleted
  gross_profit NUMERIC(12,2) NOT NULL DEFAULT 0,   -- sum of all winning entries
  total_losses NUMERIC(12,2) NOT NULL DEFAULT 0,   -- sum of all losing entries (negative)
  commission NUMERIC(12,2) NOT NULL DEFAULT 0,     -- 15% of gross_profit (only if > 0)
  net_profit NUMERIC(12,2) NOT NULL DEFAULT 0,     -- gross_profit - commission + total_losses
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_trades_user ON trades(user_id, created_at);

-- TRADE ENTRIES (individual buy/sell legs within one trade)
CREATE TABLE trade_entries (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
  side VARCHAR(3) NOT NULL CHECK (side IN ('yes', 'no')),
  buy_price NUMERIC(6,2) NOT NULL,
  sell_price NUMERIC(6,2) NOT NULL,
  quantity NUMERIC(10,2) NOT NULL,
  pnl NUMERIC(12,2) NOT NULL,    -- (sell_price - buy_price) * quantity, computed on save
  created_at TIMESTAMP DEFAULT NOW()
);

-- MONEY LOG (deposits & withdrawals, personal per user)
CREATE TABLE money_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL CHECK (type IN ('deposit', 'withdrawal')),
  amount NUMERIC(12,2) NOT NULL,
  withdrawal_commission NUMERIC(12,2) DEFAULT 0,  -- 3% of amount, only if type = withdrawal
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_money_user ON money_log(user_id, created_at);

-- RULES (admin-editable universal rules)
CREATE TABLE rules (
  id SERIAL PRIMARY KEY,
  category VARCHAR(30) NOT NULL CHECK (category IN ('golden_rule', 'risk_tier', 'time_slot', 'extra_rule', 'checklist_item')),
  sort_order INTEGER DEFAULT 0,
  -- flexible fields used differently per category:
  text_content VARCHAR(500),         -- golden_rule, extra_rule, checklist_item text
  range_min NUMERIC(12,2),           -- risk_tier: balance min
  range_max NUMERIC(12,2),           -- risk_tier: balance max
  risk_min_pct NUMERIC(5,2),         -- risk_tier: min %
  risk_max_pct NUMERIC(5,2),         -- risk_tier: max %
  time_start VARCHAR(10),            -- time_slot: "10:00"
  time_end VARCHAR(10),              -- time_slot: "12:00"
  bias VARCHAR(10) CHECK (bias IN ('yes', 'no', 'cautious', NULL)),  -- time_slot
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Seed default rules (matches the locked-in mockup content)
INSERT INTO rules (category, sort_order, text_content) VALUES
('golden_rule', 1, 'Always take the trade which HAS TO GO — not the trade which CAN GO according to analysis.');

INSERT INTO rules (category, sort_order, range_min, range_max, risk_min_pct, risk_max_pct) VALUES
('risk_tier', 1, 200, 1000, 50, 100),
('risk_tier', 2, 1000, 5000, 20, 30),
('risk_tier', 3, 5000, 10000, 10, 20);

INSERT INTO rules (category, sort_order, time_start, time_end, bias, text_content) VALUES
('time_slot', 1, '10:00', '12:00', 'cautious', 'Neck to neck — take 50% less risk'),
('time_slot', 2, '12:00', '16:00', 'yes', 'Views rising — lean YES'),
('time_slot', 3, '16:00', '23:59', 'no', 'Views decreasing — lean NO');

INSERT INTO rules (category, sort_order, text_content) VALUES
('extra_rule', 1, 'Buy price should always be less than ₹7'),
('extra_rule', 2, 'Sell some quantity always before settlement');

INSERT INTO rules (category, sort_order, text_content) VALUES
('checklist_item', 1, 'Is this a "HAS TO GO" trade, not just "CAN GO"?'),
('checklist_item', 2, 'Is the current time in the cautious zone (10AM–12PM)? If so, halve my risk.'),
('checklist_item', 3, 'Is the buy price less than ₹7?'),
('checklist_item', 4, 'Does this fit my current balance risk tier?');
