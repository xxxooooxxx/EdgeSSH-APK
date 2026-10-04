CREATE TABLE IF NOT EXISTS forward_rules (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS forward_rules_account_updated ON forward_rules(account_id, updated_at DESC);
