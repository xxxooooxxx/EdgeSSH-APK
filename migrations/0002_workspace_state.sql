CREATE TABLE IF NOT EXISTS workspace_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_id TEXT NOT NULL,
  auth_provider TEXT NOT NULL CHECK (auth_provider IN ('cloudflare', 'github')),
  auth_revision INTEGER NOT NULL,
  access_not_before INTEGER NOT NULL,
  github_admin_id TEXT
);

-- 旧库只有一个资料所有者时原样沿用，避免改变既有密文的 AAD。
-- 多所有者库不会写入状态，部署脚本会明确停止并要求人工确认。
INSERT OR IGNORE INTO workspace_state (
  id, account_id, auth_provider, auth_revision, access_not_before, github_admin_id
)
SELECT 1, COALESCE(MIN(account_id), 'admin'), 'cloudflare', 1, 0, NULL
FROM hosts
HAVING COUNT(DISTINCT account_id) <= 1;
