import type { Database, DeploymentSettings } from './deployment-config.ts';

export async function ensureDatabase(
  settings: Pick<DeploymentSettings, 'accountId' | 'apiToken' | 'databaseName' | 'databaseId'>,
  fetcher: typeof fetch = fetch,
): Promise<Database> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/d1/database`;
  async function request<T>(suffix: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetcher(`${base}${suffix}`, {
      method,
      headers: { Authorization: `Bearer ${settings.apiToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    // 不回显 API 响应体，防止远端诊断信息意外包含凭据或内部细节。
    if (!response.ok) throw new Error(`D1 ${method} 请求失败（HTTP ${response.status}）。请检查目标账户、数据库 ID 和 Token 的 D1 权限。`);
    const payload = await response.json() as { success: boolean; result: T };
    if (!payload.success) throw new Error(`D1 ${method} 请求未成功，请检查 Token 权限与账户资源配额。`);
    return payload.result;
  }

  // 显式 ID 必须属于目标账户；不存在或无权限时直接失败，不能偷偷创建空库替代。
  if (settings.databaseId) return await request<Database>(`/${settings.databaseId}`);

  // 按名称复用并读取全部分页，避免已有数据库在后续页时误创建同名资源。
  const pageSize = 100;
  for (let page = 1; ; page++) {
    const databases = await request<Database[]>(`?per_page=${pageSize}&page=${page}`);
    const existing = databases.find((database) => database.name === settings.databaseName);
    if (existing) return existing;
    if (databases.length < pageSize) break;
  }
  return await request<Database>('', 'POST', { name: settings.databaseName });
}
