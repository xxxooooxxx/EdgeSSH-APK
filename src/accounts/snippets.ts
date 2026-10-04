import type { Env } from '../types';
import { decryptHost, encryptHost } from './crypto.ts';
import { APIError, json, readJSON } from './http.ts';
import { DEFAULT_SNIPPETS, type SnippetInput } from './snippet-data.ts';

interface SnippetRow { id: string; encrypted_payload: string; updated_at: number }

export function validateSnippet(body: Record<string, unknown>): SnippetInput {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) {
    throw new APIError('片段名称不能为空，且不能超过 80 个字符。');
  }
  if (typeof body.command !== 'string' || !body.command.trim() || body.command.length > 8192
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.command)) {
    throw new APIError('命令不能为空、超过 8192 个字符或包含终端控制字符。');
  }
  return { name: body.name.trim(), command: body.command.replace(/\r\n?/g, '\n') };
}

async function initializeLibrary(env: Env, accountId: string): Promise<void> {
  const initialized = await env.DB.prepare('SELECT account_id FROM snippet_libraries WHERE account_id = ?').bind(accountId).first();
  if (initialized) return;
  const now = Date.now();
  const statements = await Promise.all(DEFAULT_SNIPPETS.map(async (snippet, index) => {
    const id = crypto.randomUUID();
    // 独立 AAD 前缀隔离主机与片段密文，同时复用现有加密格式，避免更换生产密钥。
    const encrypted = await encryptHost(snippet, env.ENCRYPTION_KEY, accountId, `snippet:${id}`);
    return env.DB.prepare(`INSERT INTO snippets(id, account_id, encrypted_payload, updated_at)
      SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM snippet_libraries WHERE account_id = ?)`)
      .bind(id, accountId, encrypted, now - index, accountId);
  }));
  // 初始化标记和默认记录在一个事务里写入；并发首次访问不重复，删空后也不重新补回。
  await env.DB.batch([...statements,
    env.DB.prepare('INSERT INTO snippet_libraries(account_id) VALUES (?) ON CONFLICT DO NOTHING').bind(accountId),
  ]);
}

export async function snippetsRoute(request: Request, env: Env, accountId: string, pathname: string): Promise<Response> {
  const match = /^\/api\/snippets(?:\/([a-f0-9-]{36}))?$/.exec(pathname);
  if (!match) throw new APIError('接口不存在。', 404);
  const id = match[1];
  if (!id && request.method === 'GET') {
    await initializeLibrary(env, accountId);
    const rows = await env.DB.prepare('SELECT id, encrypted_payload, updated_at FROM snippets WHERE account_id = ? ORDER BY updated_at DESC, id')
      .bind(accountId).all<SnippetRow>();
    const snippets = await Promise.all(rows.results.map(async (row) => ({
      ...await decryptHost<SnippetInput>(row.encrypted_payload, env.ENCRYPTION_KEY, accountId, `snippet:${row.id}`),
      id: row.id, updatedAt: row.updated_at,
    })));
    return json({ snippets });
  }
  if (id && request.method === 'DELETE') {
    const result = await env.DB.prepare('DELETE FROM snippets WHERE id = ? AND account_id = ?').bind(id, accountId).run();
    if (!result.meta.changes) throw new APIError('片段不存在，请刷新列表。', 404);
    return json({ ok: true });
  }
  if (id ? request.method !== 'PUT' : request.method !== 'POST') throw new APIError('不支持此请求方法。', 405);
  const payload = validateSnippet(await readJSON(request));
  if (!id) await initializeLibrary(env, accountId);
  const snippetId = id ?? crypto.randomUUID();
  const encrypted = await encryptHost(payload, env.ENCRYPTION_KEY, accountId, `snippet:${snippetId}`);
  const now = Date.now();
  const result = id
    ? await env.DB.prepare('UPDATE snippets SET encrypted_payload = ?, updated_at = ? WHERE id = ? AND account_id = ?')
      .bind(encrypted, now, id, accountId).run()
    : await env.DB.prepare(`INSERT INTO snippets(id, account_id, encrypted_payload, updated_at)
      SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM snippets WHERE account_id = ?) < 200`)
      .bind(snippetId, accountId, encrypted, now, accountId).run();
  if (!result.meta.changes) throw new APIError(id ? '片段不存在，请刷新列表。' : '最多保存 200 条片段，请删除不再使用的片段。', id ? 404 : 409);
  return json({ snippet: { ...payload, id: snippetId, updatedAt: now } }, id ? 200 : 201);
}
