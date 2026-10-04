import type { CloudflareApi } from './cloudflare-api.ts';
import type { Database, DeploymentSettings } from './deployment-config.ts';

export interface DeploymentWorkspaceState {
  accountId: string;
  authProvider?: 'cloudflare' | 'github';
  authRevision: number;
  accessNotBefore: number;
  githubAdminId?: string;
}

interface StateRow {
  account_id: string;
  auth_provider: string;
  auth_revision: number;
  access_not_before: number;
  github_admin_id: string | null;
}

interface QueryResult<T> { success: boolean; results: T[] }

function databasePath(settings: DeploymentSettings, database: Database): string {
  return `/accounts/${settings.accountId}/d1/database/${database.uuid}/query`;
}

async function query<T>(
  api: CloudflareApi,
  settings: DeploymentSettings,
  database: Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await api.request<QueryResult<T>[]>(databasePath(settings, database), 'POST', { sql, params });
  if (result.length !== 1 || !result[0].success) throw new Error('无法读取管理员工作区状态，请重试。');
  return result[0].results;
}

export async function readWorkspaceState(
  api: CloudflareApi,
  settings: DeploymentSettings,
  database: Database,
): Promise<DeploymentWorkspaceState> {
  const tables = await query<{ name: string }>(api, settings, database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('hosts', 'workspace_state')");
  const names = new Set(tables.map((table) => table.name));
  const owners = names.has('hosts')
    ? await query<{ account_id: string }>(api, settings, database, 'SELECT DISTINCT account_id FROM hosts LIMIT 2') : [];
  if (owners.length > 1) {
    throw new Error('数据库存在多个资料所有者，无法自动转为单管理员；请先明确资料归属。');
  }

  if (names.has('workspace_state')) {
    const rows = await query<StateRow>(api, settings, database,
      'SELECT account_id, auth_provider, auth_revision, access_not_before, github_admin_id FROM workspace_state WHERE id = 1');
    const row = rows[0];
    if (row) {
      if (row.auth_provider !== 'cloudflare' && row.auth_provider !== 'github') {
        throw new Error('管理员工作区中的认证方式无效，请检查数据库状态。');
      }
      if (owners[0] && owners[0].account_id !== row.account_id) {
        throw new Error('数据库资料所有者与固定管理员工作区不一致，停止自动部署。');
      }
      return {
        accountId: row.account_id,
        authProvider: row.auth_provider,
        authRevision: row.auth_revision,
        accessNotBefore: row.access_not_before,
        githubAdminId: row.github_admin_id ?? undefined,
      };
    }
  }

  // 只在首次初始化读取旧 hosts；状态落库后，即使删除最后一台主机也不会改变 owner。
  return {
    accountId: owners[0]?.account_id || 'admin',
    authRevision: 0,
    accessNotBefore: 0,
  };
}

export async function updateWorkspaceState(
  api: CloudflareApi,
  settings: DeploymentSettings,
  database: Database,
  previous: DeploymentWorkspaceState,
  githubAdminId?: string,
  now = Math.floor(Date.now() / 1000),
): Promise<DeploymentWorkspaceState> {
  const rows = await query<StateRow>(api, settings, database,
    'SELECT account_id, auth_provider, auth_revision, access_not_before, github_admin_id FROM workspace_state WHERE id = 1');
  const current = rows[0];
  if (!current) throw new Error('数据库迁移未建立管理员工作区状态，停止部署。');
  if (current.account_id !== previous.accountId) throw new Error('管理员工作区在部署期间发生变化，停止部署。');

  const retainedGitHubId = settings.authProvider === 'github' ? githubAdminId : (current.github_admin_id ?? undefined);
  if (settings.authProvider === 'github' && !retainedGitHubId) {
    throw new Error('GitHub 管理员数字 ID 尚未固定，停止部署。');
  }
  const providerChanged = current.auth_provider !== settings.authProvider;
  const administratorChanged = settings.authProvider === 'github'
    && current.github_admin_id !== null && current.github_admin_id !== retainedGitHubId;
  const revision = current.auth_revision + (providerChanged || administratorChanged ? 1 : 0);
  const accessNotBefore = providerChanged ? now + 1 : current.access_not_before;
  await query(api, settings, database,
    `UPDATE workspace_state
     SET auth_provider = ?, auth_revision = ?, access_not_before = ?, github_admin_id = ?
     WHERE id = 1 AND account_id = ?`,
    [settings.authProvider, revision, accessNotBefore, retainedGitHubId ?? null, previous.accountId]);
  return {
    accountId: previous.accountId,
    authProvider: settings.authProvider,
    authRevision: revision,
    accessNotBefore,
    githubAdminId: retainedGitHubId,
  };
}
