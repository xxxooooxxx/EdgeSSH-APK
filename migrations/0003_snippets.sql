CREATE TABLE IF NOT EXISTS snippet_libraries (
  account_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS snippets_account_updated ON snippets(account_id, updated_at DESC);
