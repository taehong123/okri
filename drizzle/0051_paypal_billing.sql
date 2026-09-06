CREATE TABLE IF NOT EXISTS billing_paypal_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('team','business')),
  provider_plan_id TEXT NOT NULL,
  provider_subscription_id TEXT UNIQUE,
  approval_url TEXT,
  currency TEXT NOT NULL,
  price_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATING',
  paid_through TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_paypal_open_workspace
  ON billing_paypal_subscriptions(workspace_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS billing_paypal_transactions (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES billing_paypal_subscriptions(id),
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  price_value TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paypal_transactions_workspace
  ON billing_paypal_transactions(workspace_id, paid_at);
CREATE TABLE IF NOT EXISTS billing_paypal_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  processed_at TEXT NOT NULL
);
