-- Add native authentication tables after the currently deployed web migrations.
CREATE TABLE IF NOT EXISTS native_auth_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS native_auth_codes_expiry ON native_auth_codes(expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS native_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS native_sessions_user ON native_sessions(user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS native_apple_nonces (
  nonce_hash TEXT PRIMARY KEY NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS native_apple_grants (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  encrypted_token TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS native_identity_revocations (
  identity_hash TEXT PRIMARY KEY NOT NULL,
  deleted_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS native_account_deletion_guards (
  id TEXT PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CONSTRAINT native_account_deletion_safe CHECK(valid = 1)
);
