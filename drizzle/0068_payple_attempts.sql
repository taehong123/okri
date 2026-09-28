CREATE TABLE billing_payple_attempts (
  order_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  price_won INTEGER NOT NULL CHECK (price_won > 0),
  pay_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'refund_pending', 'refunded')),
  transaction_id TEXT,
  receipt_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
