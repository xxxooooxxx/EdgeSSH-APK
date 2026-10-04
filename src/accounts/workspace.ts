import type { Env } from '../types.ts';
import { APIError } from './http.ts';

export interface WorkspaceState {
  accountId: string;
  authProvider: 'cloudflare' | 'github';
  authRevision: number;
  accessNotBefore: number;
}

interface WorkspaceRow {
  account_id: string;
  auth_provider: string;
  auth_revision: number;
  access_not_before: number;
}

export async function workspaceState(env: Pick<Env, 'DB'>): Promise<WorkspaceState> {
  const row = await env.DB.prepare(
    'SELECT account_id, auth_provider, auth_revision, access_not_before FROM workspace_state WHERE id = 1',
  ).first<WorkspaceRow>();
  if (!row || (row.auth_provider !== 'cloudflare' && row.auth_provider !== 'github')) {
    throw new APIError('管理员工作区尚未完成部署初始化。', 503);
  }
  return {
    accountId: row.account_id,
    authProvider: row.auth_provider,
    authRevision: row.auth_revision,
    accessNotBefore: row.access_not_before,
  };
}

export async function revokeWorkspaceSessions(env: Pick<Env, 'DB'>, state: WorkspaceState): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE workspace_state
     SET auth_revision = auth_revision + 1, access_not_before = ?
     WHERE id = 1 AND auth_provider = ? AND auth_revision = ?`,
  ).bind(Math.floor(Date.now() / 1000) + 1, state.authProvider, state.authRevision).run();
  if (result.meta.changes !== 1) throw new APIError('登录状态已变化，请刷新页面后重试。', 409);
}
