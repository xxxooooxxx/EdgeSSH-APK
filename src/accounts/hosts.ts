import { parseConnectMessage, type Env } from '../types';
import { decryptHost, encryptHost } from './crypto';
import { APIError, json, readJSON } from './http';
import { locateHost, type HostLocation } from './location';
import type { SystemInfo } from '../backend/system-info';

export interface HostPayload {
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'publickey';
  password?: string;
  privateKey?: string;
  initialCommand: string;
  termType: string;
  encoding: string;
  fingerprint: string;
  location: HostLocation | null;
  locationCheckedAt?: number;
  system?: SystemInfo | null;
}
interface HostRow { id: string; encrypted_payload: string; updated_at: number }

const LOCATION_RETRY_MS = 24 * 60 * 60 * 1000;
const LOCATION_REFRESH_BATCH = 8;

function metadata(id: string, payload: HostPayload, updatedAt: number) {
  const { password, privateKey, locationCheckedAt, ...safe } = payload;
  return { ...safe, system: payload.system ?? null, id, updatedAt, hasCredential: password !== undefined || Boolean(privateKey) };
}

async function refreshLocation(payload: HostPayload): Promise<void> {
  payload.location = await locateHost(payload.host);
  payload.locationCheckedAt = Date.now();
}

function text(body: Record<string, unknown>, key: string, max: number, fallback = ''): string {
  const value = body[key] ?? fallback;
  if (typeof value !== 'string' || value.length > max) throw new APIError(`${key} 格式无效。`);
  return value;
}

function systemInfo(body: Record<string, unknown>): SystemInfo {
  const family = body.family;
  if (!['linux', 'darwin', 'freebsd', 'windows', 'unknown'].includes(String(family))) throw new APIError('系统类型无效。');
  return {
    family: family as SystemInfo['family'],
    distribution: text(body, 'distribution', 40).toLowerCase(),
    name: text(body, 'name', 120),
    version: text(body, 'version', 80),
    architecture: text(body, 'architecture', 32),
  };
}

function validate(body: Record<string, unknown>, previous?: HostPayload): HostPayload {
  const authMethod = body.authMethod;
  const credential = authMethod === 'publickey'
    ? { privateKey: body.privateKey ?? (previous && previous.authMethod === authMethod ? previous.privateKey : undefined) }
    : { password: body.password ?? (previous && previous.authMethod === authMethod ? previous.password : undefined) };
  let connection;
  try {
    connection = parseConnectMessage({
      type: 'connect', host: body.host, port: body.port, username: body.username, authMethod, ...credential,
      term: body.termType, expectedFingerprint: body.fingerprint || undefined,
    });
  } catch { throw new APIError('请检查主机地址、端口、用户名、凭据和指纹格式。'); }
  if (connection.port === 25) throw new APIError('不支持端口 25。');
  const encoding = text(body, 'encoding', 20, 'utf-8');
  if (!['utf-8', 'gb18030', 'big5'].includes(encoding.toLowerCase())) throw new APIError('不支持此终端编码。');
  return {
    name: text(body, 'name', 80, connection.host).trim() || connection.host,
    group: text(body, 'group', 40, '个人').trim() || '个人',
    host: connection.host, port: connection.port, username: connection.username,
    authMethod: connection.authMethod, password: connection.password, privateKey: connection.privateKey,
    initialCommand: text(body, 'initialCommand', 4096), termType: connection.term,
    encoding, fingerprint: connection.expectedFingerprint ?? '', location: previous?.location ?? null,
    locationCheckedAt: previous?.locationCheckedAt,
    system: previous?.host === connection.host ? previous.system ?? null : null,
  };
}

export async function hostsRoute(request: Request, env: Env, accountId: string, pathname: string): Promise<Response> {
  const match = /^\/api\/hosts(?:\/([a-f0-9-]{36})(?:\/(credentials|location|system))?)?$/.exec(pathname);
  if (!match) throw new APIError('接口不存在。', 404);
  const [, id, action] = match;
  if (!id && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, encrypted_payload, updated_at FROM hosts WHERE account_id = ? ORDER BY updated_at DESC')
      .bind(accountId).all<HostRow>();
    const records = await Promise.all(rows.results.map(async (row) => ({
      row, payload: await decryptHost<HostPayload>(row.encrypted_payload, env.ENCRYPTION_KEY, accountId, row.id),
    })));
    const retryBefore = Date.now() - LOCATION_RETRY_MS;
    const stale = records.filter(({ payload }) => !payload.location && (payload.locationCheckedAt ?? 0) < retryBefore)
      .slice(0, LOCATION_REFRESH_BATCH);
    if (stale.length) {
      // 每次列表最多回填少量旧记录，避免大账户刷新时同时发起过多外部查询。
      await Promise.all(stale.map(async ({ row, payload }) => {
        await refreshLocation(payload);
        row.encrypted_payload = await encryptHost(payload, env.ENCRYPTION_KEY, accountId, row.id);
      }));
      await env.DB.batch(stale.map(({ row }) => env.DB.prepare('UPDATE hosts SET encrypted_payload = ? WHERE id = ? AND account_id = ?')
        .bind(row.encrypted_payload, row.id, accountId)));
    }
    return json({ hosts: records.map(({ row, payload }) => metadata(row.id, payload, row.updated_at)) });
  }
  let previous: HostPayload | undefined;
  let previousRow: HostRow | undefined;
  if (id) {
    const row = await env.DB.prepare('SELECT id, encrypted_payload, updated_at FROM hosts WHERE id = ? AND account_id = ?')
      .bind(id, accountId).first<HostRow>();
    if (!row) throw new APIError('主机不存在。', 404);
    previousRow = row;
    if (request.method === 'DELETE' && !action) {
      await env.DB.prepare('DELETE FROM hosts WHERE id = ? AND account_id = ?').bind(id, accountId).run();
      return json({ ok: true });
    }
    previous = await decryptHost<HostPayload>(previousRow.encrypted_payload, env.ENCRYPTION_KEY, accountId, id);
    if (action === 'credentials' && request.method === 'POST') {
      return json({ password: previous.password, privateKey: previous.privateKey });
    }
    if (action === 'location' && request.method === 'POST') {
      await refreshLocation(previous);
      const encrypted = await encryptHost(previous, env.ENCRYPTION_KEY, accountId, id);
      const result = await env.DB.prepare('UPDATE hosts SET encrypted_payload = ? WHERE id = ? AND account_id = ?')
        .bind(encrypted, id, accountId).run();
      if (!result.meta.changes) throw new APIError('主机已被删除，请刷新列表。', 404);
      return json({ host: metadata(id, previous, previousRow.updated_at) });
    }
    if (action === 'system' && request.method === 'POST') {
      previous.system = systemInfo(await readJSON(request));
      const encrypted = await encryptHost(previous, env.ENCRYPTION_KEY, accountId, id);
      const result = await env.DB.prepare('UPDATE hosts SET encrypted_payload = ? WHERE id = ? AND account_id = ?')
        .bind(encrypted, id, accountId).run();
      if (!result.meta.changes) throw new APIError('主机已被删除，请刷新列表。', 404);
      return json({ host: metadata(id, previous, previousRow.updated_at) });
    }
  }
  if (action || (id ? request.method !== 'PUT' : request.method !== 'POST')) throw new APIError('不支持此请求方法。', 405);
  const payload = validate(await readJSON(request), previous);
  const hostId = id ?? crypto.randomUUID();
  if (!previous || previous.host !== payload.host || !previous.location) {
    await refreshLocation(payload);
  }
  const encrypted = await encryptHost(payload, env.ENCRYPTION_KEY, accountId, hostId);
  const now = Date.now();
  if (id) {
    const result = await env.DB.prepare('UPDATE hosts SET encrypted_payload = ?, updated_at = ? WHERE id = ? AND account_id = ?')
      .bind(encrypted, now, id, accountId).run();
    if (!result.meta.changes) throw new APIError('主机已被删除，请刷新列表。', 404);
  } else {
    // 在同一 SQL 语句里检查配额，避免并发新增绕过限制，也限制列表解密的 CPU 开销。
    const result = await env.DB.prepare(`INSERT INTO hosts(id, account_id, encrypted_payload, updated_at)
      SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM hosts WHERE account_id = ?) < 200`)
      .bind(hostId, accountId, encrypted, now, accountId).run();
    if (!result.meta.changes) throw new APIError('第一版每个账户最多保存 200 台主机。', 409);
  }
  return json({ host: metadata(hostId, payload, now) }, id ? 200 : 201);
}
