CREATE TABLE billing_payple_bridge_results (
  token_hash TEXT PRIMARY KEY NOT NULL REFERENCES billing_sessions(token_hash) ON DELETE CASCADE,
  encrypted_result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
