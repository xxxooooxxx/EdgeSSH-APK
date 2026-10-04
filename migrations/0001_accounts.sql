CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hosts_owner ON hosts(account_id, updated_at DESC);
