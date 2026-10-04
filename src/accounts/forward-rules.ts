import type { Env } from '../types.ts';
import { decryptHost, encryptHost } from './crypto.ts';
import { APIError, json, readJSON } from './http.ts';

export interface ForwardRuleInput {
  name: string;
  hostId: string;
  port: number;
  mode: 'trusted' | 'isolated';
}

interface RuleRow { id: string; encrypted_payload: string; updated_at: number }

export function validateForwardRule(body: Record<string, unknown>): ForwardRuleInput {
  const name = body.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new APIError('规则名称不能为空、超过 80 个字符或包含控制字符。');
  }
  if (typeof body.hostId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.hostId)) throw new APIError('请选择已保存的主机。');
  if (typeof body.port !== 'number' || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new APIError('网站端口必须为 1 到 65535 的整数。');
  }
  if (body.mode !== 'trusted' && body.mode !== 'isolated') throw new APIError('转发方式无效。');
  return { name: name.trim(), hostId: body.hostId, port: body.port, mode: body.mode };
}

export async function forwardRulesRoute(request: Request, env: Env, accountId: string, pathname: string): Promise<Response> {
  const match = /^\/api\/forward-rules(?:\/([a-f0-9-]{36}))?$/.exec(pathname);
  if (!match) throw new APIError('接口不存在。', 404);
  const id = match[1];
  if (!id && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, encrypted_payload, updated_at FROM forward_rules WHERE account_id = ? ORDER BY updated_at DESC, id')
      .bind(accountId).all<RuleRow>();
    const rules = await Promise.all(rows.results.map(async (row) => ({
      ...await decryptHost<ForwardRuleInput>(row.encrypted_payload, env.ENCRYPTION_KEY, accountId, `forward-rule:${row.id}`),
      id: row.id, updatedAt: row.updated_at,
    })));
    return json({ rules });
  }
  if (id && request.method === 'DELETE') {
    const result = await env.DB.prepare('DELETE FROM forward_rules WHERE id = ? AND account_id = ?').bind(id, accountId).run();
    if (!result.meta.changes) throw new APIError('规则不存在，请刷新列表。', 404);
    return json({ ok: true });
  }
  if (id ? request.method !== 'PUT' : request.method !== 'POST') throw new APIError('不支持此请求方法。', 405);
  const payload = validateForwardRule(await readJSON(request));
  // 引用必须属于当前账户；删除主机后，规则保留并在界面标明不可连接。
  const host = await env.DB.prepare('SELECT id FROM hosts WHERE id = ? AND account_id = ?').bind(payload.hostId, accountId).first();
  if (!host) throw new APIError('所选主机不存在，请刷新主机列表。', 404);
  const ruleId = id ?? crypto.randomUUID();
  const encrypted = await encryptHost(payload, env.ENCRYPTION_KEY, accountId, `forward-rule:${ruleId}`);
  const now = Date.now();
  const result = id
    ? await env.DB.prepare('UPDATE forward_rules SET encrypted_payload = ?, updated_at = ? WHERE id = ? AND account_id = ?')
      .bind(encrypted, now, id, accountId).run()
    : await env.DB.prepare(`INSERT INTO forward_rules(id, account_id, encrypted_payload, updated_at)
      SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM forward_rules WHERE account_id = ?) < 200`)
      .bind(ruleId, accountId, encrypted, now, accountId).run();
  if (!result.meta.changes) throw new APIError(id ? '规则不存在，请刷新列表。' : '最多保存 200 条转发规则。', id ? 404 : 409);
  return json({ rule: { ...payload, id: ruleId, updatedAt: now } }, id ? 200 : 201);
}
