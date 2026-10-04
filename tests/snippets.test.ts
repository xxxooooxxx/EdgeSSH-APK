import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Env } from '../src/types.ts';
import { snippetsRoute, validateSnippet } from '../src/accounts/snippets.ts';
import { DEFAULT_SNIPPETS, type Snippet } from '../src/accounts/snippet-data.ts';
import { decryptHost } from '../src/accounts/crypto.ts';

// 使用真实 SQLite 执行迁移和参数化 SQL，而不是用字符串匹配模拟数据库行为。
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0003_snippets.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string) => {
    let params: (string | number)[] = [];
    const query = sqlite.prepare(sql);
    const statement = {
      bind(...values: (string | number)[]) { params = values; return statement; },
      async first() { return query.get(...params) ?? null; },
      async all() { return { results: query.all(...params) }; },
      execute() { return { meta: { changes: Number(query.run(...params).changes) } }; },
      async run() { return statement.execute(); },
    };
    return statement;
  };
  const env = {
    ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    DB: {
      prepare,
      async batch(statements: ReturnType<typeof prepare>[]) {
        sqlite.exec('BEGIN');
        try { const results = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      },
    },
  } as unknown as Env;
  const request = async (method = 'GET', id = '', body?: unknown, owner = 'owner') => {
    const path = `/api/snippets${id ? `/${id}` : ''}`;
    return snippetsRoute(new Request(`https://example.com${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }), env, owner, path);
  };
  const list = async (owner = 'owner'): Promise<Snippet[]> => (await (await request('GET', '', undefined, owner)).json() as { snippets: Snippet[] }).snippets;
  return { sqlite, env, request, list };
}

test('内置命令不超过十条，名称唯一且全部通过校验', () => {
  assert.equal(DEFAULT_SNIPPETS.length, 10);
  assert.equal(new Set(DEFAULT_SNIPPETS.map((item) => item.name)).size, 10);
  for (const item of DEFAULT_SNIPPETS) assert.deepEqual(validateSnippet(item as unknown as Record<string, unknown>), item);
});

test('校验保留多行脚本语义，拒绝空白、超长与终端控制字符', () => {
  assert.deepEqual(validateSnippet({ name: ' 多行 ', command: 'echo a\r\necho b\r' }), { name: '多行', command: 'echo a\necho b\n' });
  for (const body of [
    { name: '', command: 'pwd' }, { name: ' ', command: 'pwd' }, { name: 'a'.repeat(81), command: 'pwd' },
    { name: '测试', command: '' }, { name: '测试', command: ' '.repeat(10) }, { name: '测试', command: 'a'.repeat(8193) },
    { name: '测试', command: '\x1b[201~pwd' }, { name: '测试', command: '\x03pwd' }, { name: 1, command: 'pwd' },
  ]) assert.throws(() => validateSnippet(body), /片段名称|命令/);
});

test('并发首次读取只生成十条；删空和重复读取不补回', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  await Promise.all([f.list(), f.list(), f.list()]);
  const items = await f.list();
  assert.equal(items.length, 10);
  for (const item of items) await f.request('DELETE', item.id);
  assert.equal((await f.list()).length, 0);
  assert.equal((await f.list()).length, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM snippet_libraries').get()!.count, 1);
});

test('片段增改删、持久化、加密与账户隔离', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  await f.list();
  const payload = { name: '<img src=x onerror=alert(1)>', command: 'echo private-token\npwd' };
  const created = await f.request('POST', '', payload);
  assert.equal(created.status, 201);
  const { snippet } = await created.json() as { snippet: Snippet };
  assert.deepEqual((await f.list()).find((item) => item.id === snippet.id), snippet);
  const row = f.sqlite.prepare('SELECT encrypted_payload FROM snippets WHERE id = ?').get(snippet.id)!;
  assert.equal(String(row.encrypted_payload).includes('private-token'), false);
  await assert.rejects(decryptHost(String(row.encrypted_payload), f.env.ENCRYPTION_KEY, 'owner', snippet.id));
  await assert.rejects(f.request('PUT', snippet.id, payload, 'other'), /不存在/);
  await assert.rejects(f.request('DELETE', snippet.id, undefined, 'other'), /不存在/);
  await f.request('PUT', snippet.id, { name: '新名称', command: 'ls -lah' });
  assert.equal((await f.list()).find((item) => item.id === snippet.id)!.command, 'ls -lah');
  await f.request('DELETE', snippet.id);
  await assert.rejects(f.request('DELETE', snippet.id), /不存在/);
  assert.equal((await f.list()).length, 10);
});

test('200 条总配额不限制用户添加到十条以上，错误路径与方法明确拒绝', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  await f.list();
  for (let i = 10; i < 200; i++) await f.request('POST', '', { name: `命令 ${i}`, command: 'pwd' });
  await assert.rejects(f.request('POST', '', { name: '满额', command: 'pwd' }), /最多保存 200/);
  assert.equal((await f.list()).length, 200);
  await assert.rejects(f.request('PATCH'), /不支持/);
  await assert.rejects(f.request('GET', 'invalid'), /不存在/);
});
