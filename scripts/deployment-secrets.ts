import { randomBytes } from 'node:crypto';
import { CloudflareApi } from './cloudflare-api.ts';
import type { Database, DeploymentSettings, RuntimeSecrets } from './deployment-config.ts';

export async function readWorkerSecretNames(api: CloudflareApi, settings: DeploymentSettings): Promise<Set<string>> {
  const base = `/accounts/${settings.accountId}/workers/scripts`;
  // 明确查找 Worker，而不是把 403/404 一律当成“首次部署”，避免误生成新密钥。
  const workers = await api.request<{ id: string }[]>(base);
  if (!workers.some((worker) => worker.id === settings.workerName)) return new Set();
  const secrets = await api.request<{ name: string }[]>(`${base}/${settings.workerName}/secrets`);
  return new Set(secrets.map((secret) => secret.name));
}

export async function readWorkerVariable(
  api: CloudflareApi,
  settings: DeploymentSettings,
  name: string,
): Promise<string | undefined> {
  const base = `/accounts/${settings.accountId}/workers/scripts`;
  const workers = await api.request<{ id: string }[]>(base);
  if (!workers.some((worker) => worker.id === settings.workerName)) return undefined;
  const configuration = await api.request<{ bindings: { name: string; type: string; text?: string }[] }>(
    `${base}/${settings.workerName}/settings`,
  );
  const binding = configuration.bindings.find((entry) => entry.name === name && entry.type === 'plain_text');
  return binding?.text;
}

export async function prepareEncryptionSecret(
  api: CloudflareApi,
  settings: DeploymentSettings,
  database: Database,
  existing: Set<string>,
): Promise<Partial<RuntimeSecrets>> {
  // Cloudflare 中的原密钥始终优先，不允许旧 Actions Secret 意外覆盖线上密钥。
  if (existing.has('ENCRYPTION_KEY')) return {};
  if (settings.secrets.ENCRYPTION_KEY) return { ENCRYPTION_KEY: settings.secrets.ENCRYPTION_KEY };
  const path = `/accounts/${settings.accountId}/d1/database/${database.uuid}/query`;
  const tables = await api.request<{ results: { name: string }[]; success: boolean }[]>(path, 'POST', {
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hosts'",
  });
  if (tables.some((query) => !query.success)) throw new Error('无法确认 D1 状态，停止生成密钥。');
  if (tables[0].results.length) {
    const rows = await api.request<{ results: unknown[]; success: boolean }[]>(path, 'POST', {
      sql: 'SELECT 1 FROM hosts LIMIT 1',
    });
    if (rows.some((query) => !query.success)) throw new Error('无法确认 D1 状态，停止生成密钥。');
    if (rows[0].results.length) {
      throw new Error('D1 已有加密资料但 Worker 缺少 ENCRYPTION_KEY。请恢复原密钥，不能生成替代密钥。');
    }
  }
  return { ENCRYPTION_KEY: randomBytes(32).toString('base64') };
}

export function maskSecrets(secrets: Partial<RuntimeSecrets>): void {
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const value of Object.values(secrets)) console.log(`::add-mask::${value}`);
  }
}
