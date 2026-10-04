import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Env } from '../src/types.ts';
import { decryptHost } from '../src/accounts/crypto.ts';
import { forwardRulesRoute, validateForwardRule } from '../src/accounts/forward-rules.ts';

const hostId = '00000000-0000-4000-8000-000000000001';
const input = { name: ' 服务 A ', hostId, port: 8080, mode: 'trusted' };

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE hosts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL)');
  sqlite.exec(readFileSync(new URL('../migrations/0004_forward_rules.sql', import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO hosts(id, account_id) VALUES (?, ?)').run(hostId, 'owner');
  const prepare = (sql: string) => {
    let params: (string | number)[] = [];
    const query = sqlite.prepare(sql);
    const statement = {
      bind(...values: (string | number)[]) { params = values; return statement; },
      async first() { return query.get(...params) ?? null; },
      async all() { return { results: query.all(...params) }; },
      async run() { return { meta: { changes: Number(query.run(...params).changes) } }; },
    };
    return statement;
  };
  const env = { ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), DB: { prepare } } as unknown as Env;
  const request = async (method = 'GET', id = '', body?: unknown, owner = 'owner') => {
    const path = `/api/forward-rules${id ? `/${id}` : ''}`;
    return forwardRulesRoute(new Request(`https://example.com${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }), env, owner, path);
  };
  return { sqlite, env, request };
}

test('规则只接受有效名称、所属主机、端口与连接方式', () => {
  assert.deepEqual(validateForwardRule(input), { ...input, name: '服务 A' });
  for (const invalid of [
    { ...input, name: ' ' }, { ...input, name: 'A'.repeat(81) }, { ...input, name: 'x\n' },
    { ...input, hostId: 'other' }, { ...input, port: 0 }, { ...input, port: 65536 },
    { ...input, port: '8080' }, { ...input, port: 22.5 }, { ...input, mode: 'unknown' },
  ]) assert.throws(() => validateForwardRule(invalid), /规则名称|主机|端口|转发方式/);
});

test('规则云端加密、按账户隔离并允许增改删', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  const created = await f.request('POST', '', input);
  assert.equal(created.status, 201);
  const { rule } = await created.json() as { rule: { id: string; name: string; port: number } };
  const row = f.sqlite.prepare('SELECT encrypted_payload FROM forward_rules WHERE id = ?').get(rule.id)!;
  assert.equal(String(row.encrypted_payload).includes('服务 A'), false);
  await assert.rejects(decryptHost(String(row.encrypted_payload), f.env.ENCRYPTION_KEY, 'owner', rule.id));
  assert.equal((await (await f.request()).json() as { rules: unknown[] }).rules.length, 1);
  assert.deepEqual((await (await f.request('GET', '', undefined, 'other')).json() as { rules: unknown[] }).rules, []);
  await assert.rejects(f.request('POST', '', input, 'other'), /主机不存在/);
  await assert.rejects(f.request('PUT', rule.id, input, 'other'), /主机不存在/);
  await assert.rejects(f.request('DELETE', rule.id, undefined, 'other'), /规则不存在/);
  await f.request('PUT', rule.id, { ...input, name: '更新', port: 3000, mode: 'isolated' });
  const listed = (await (await f.request()).json() as { rules: Array<{ name: string; port: number; mode: string }> }).rules;
  assert.deepEqual([listed[0].name, listed[0].port, listed[0].mode], ['更新', 3000, 'isolated']);
  await f.request('DELETE', rule.id);
  assert.equal((await (await f.request()).json() as { rules: unknown[] }).rules.length, 0);
});

test('主机删除后旧规则仍可列出，但无法保存新的无效引用', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  await f.request('POST', '', input);
  f.sqlite.prepare('DELETE FROM hosts WHERE id = ?').run(hostId);
  assert.equal((await (await f.request()).json() as { rules: unknown[] }).rules.length, 1);
  await assert.rejects(f.request('POST', '', input), /主机不存在/);
});
