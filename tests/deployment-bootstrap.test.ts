import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudflareApi, resolveAccountId } from '../scripts/cloudflare-api.ts';
import { ensureAccess, resolveWorkerHostname } from '../scripts/cloudflare-access.ts';
import { prepareEncryptionSecret, readWorkerSecretNames, readWorkerVariable } from '../scripts/deployment-secrets.ts';
import type { DeploymentSettings } from '../scripts/deployment-config.ts';

const settings: DeploymentSettings = {
  accountId: 'a'.repeat(32), apiToken: 'test-token', workerName: 'edgessh',
  databaseName: 'edgessh-accounts', adminEmail: 'admin@example.com',
  authProvider: 'cloudflare', identityProviderIds: [], secrets: {},
};
const database = { uuid: 'test-database', name: settings.databaseName };
const json = (result: unknown) => Response.json({ success: true, result });

test('account discovery accepts exactly one account; explicit selection avoids list permission', async () => {
  for (const count of [0, 1, 2]) {
    const api = new CloudflareApi('token', async () => json(Array.from({ length: count }, () => ({ id: settings.accountId }))));
    if (count === 1) assert.equal(await resolveAccountId(api, ''), settings.accountId);
    else await assert.rejects(resolveAccountId(api, ''), /唯一确定/);
  }
  assert.equal(await resolveAccountId(new CloudflareApi('token', async () => { throw Error('unexpected'); }), 'selected'), 'selected');
});

test('API pagination uses metadata and errors never echo upstream response details', async () => {
  let pages = 0;
  const api = new CloudflareApi('token', async () => {
    pages++;
    return Response.json({ success: true, result: [pages], result_info: { total_pages: 2 } });
  });
  assert.deepEqual(await api.list('/accounts'), [1, 2]);
  await new CloudflareApi('token', async (url) => {
    assert.equal(new URL(String(url)).searchParams.get('per_page'), '50');
    return json([]);
  }).list('/accounts');
  const denied = new CloudflareApi('token', async () => new Response('private-token-response', { status: 403 }));
  await assert.rejects(denied.list('/accounts'), (error: Error) => {
    assert.match(error.message, /HTTP 403/);
    assert.equal(error.message.includes('private-token-response'), false);
    return true;
  });
});

test('workers.dev subdomain reuses existing value and registers only on documented missing code', async () => {
  const api = new CloudflareApi('token', async () => json({ subdomain: 'existing' }));
  assert.equal(await resolveWorkerHostname(api, settings), 'edgessh.existing.workers.dev');
  let writes = 0;
  const fresh = new CloudflareApi('token', async (_url, init) => {
    if (init?.method === 'GET') return Response.json({ errors: [{ code: 10007 }] }, { status: 404 });
    writes++;
    assert.deepEqual(JSON.parse(String(init?.body)), { subdomain: 'edgessh-aaaaaaaa' });
    return json({});
  });
  assert.equal(await resolveWorkerHostname(fresh, settings), 'edgessh.edgessh-aaaaaaaa.workers.dev');
  assert.equal(writes, 1);
  const denied = new CloudflareApi('token', async () => new Response('', { status: 403 }));
  await assert.rejects(resolveWorkerHostname(denied, settings), /HTTP 403/);
});

test('bootstrap creates OTP and a single application with email policy; rerun is read-only', async () => {
  let app: Record<string, unknown> | undefined;
  const providers: unknown[] = [];
  const writes: string[] = [];
  const policy = { id: 'policy', name: 'EdgeSSH edgessh administrator', decision: 'allow', include: [{ email: { email: settings.adminEmail } }] };
  const api = new CloudflareApi('token', async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method !== 'GET') writes.push(path);
    if (path.endsWith('/organizations')) return json({ auth_domain: 'team.cloudflareaccess.com' });
    if (path.endsWith('/identity_providers')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        assert.equal(body.type, 'onetimepin');
        providers.push({ ...body, id: 'otp' });
        return json(providers[0]);
      }
      return json(providers);
    }
    if (path.endsWith('/policies')) return json([policy]);
    if (path.endsWith('/apps')) {
      if (init?.method === 'POST') {
        app = { ...JSON.parse(String(init.body)), id: 'app', aud: 'aud' };
        return json(app);
      }
      return json(app ? [app] : []);
    }
    throw Error(`Unexpected path ${path}`);
  });
  const result = await ensureAccess(api, settings, 'edgessh.example.workers.dev');
  assert.deepEqual(result, { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud' });
  assert.deepEqual(app?.allowed_idps, ['otp']);
  assert.equal(app?.session_duration, '720h');
  assert.deepEqual(app?.policies, [{
    name: policy.name, decision: 'allow', include: policy.include, precedence: 1,
  }]);
  assert.equal(writes.length, 2);
  await ensureAccess(api, settings, 'edgessh.example.workers.dev');
  assert.equal(writes.length, 2);
});

test('explicit IdPs support GitHub plus OTP without creating a provider or forcing redirect', async () => {
  let payload: Record<string, unknown> | undefined;
  const api = new CloudflareApi('token', async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/organizations')) return json({ auth_domain: 'team.cloudflareaccess.com' });
    if (path.endsWith('/identity_providers')) {
      assert.equal(init?.method, 'GET');
      return json([{ id: 'github', type: 'github' }, { id: 'otp', type: 'onetimepin' }]);
    }
    if (init?.method === 'POST') {
      payload = JSON.parse(String(init.body));
      return json({ id: 'app', aud: 'aud' });
    }
    return json([]);
  });
  await ensureAccess(api, { ...settings, identityProviderIds: ['github', 'otp'] }, 'ssh.example.com');
  assert.deepEqual(payload?.allowed_idps, ['github', 'otp']);
  assert.equal(payload?.auto_redirect_to_identity, false);
});

test('existing custom application and GitHub provider configuration are never rewritten', async () => {
  const api = new CloudflareApi('token', async (url, init) => {
    assert.equal(init?.method, 'GET');
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/organizations')) return json({ auth_domain: 'team.cloudflareaccess.com' });
    if (path.endsWith('/policies')) return json([{ name: 'Custom GitHub admins', decision: 'allow', include: [{ github: { name: 'team' } }] }]);
    return json([{ id: 'app', aud: 'aud', domain: 'ssh.example.com', type: 'self_hosted', allowed_idps: ['github'], auto_redirect_to_identity: false }]);
  });
  assert.equal((await ensureAccess(api, settings, 'ssh.example.com')).ACCESS_AUD, 'aud');
});

test('only managed email changes are applied, preserving policy precedence', async () => {
  let writes = 0;
  const api = new CloudflareApi('token', async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'PUT') {
      assert.ok(path.endsWith('/policies/managed'));
      assert.deepEqual(JSON.parse(String(init.body)), {
        name: 'EdgeSSH edgessh administrator', decision: 'allow',
        include: [{ email: { email: settings.adminEmail } }], precedence: 7,
      });
      writes++;
      return json({});
    }
    if (path.endsWith('/organizations')) return json({ auth_domain: 'team.cloudflareaccess.com' });
    if (path.endsWith('/policies')) return json([{
      id: 'managed', name: 'EdgeSSH edgessh administrator', decision: 'allow',
      include: [{ email: { email: 'previous@example.com' } }], precedence: 7,
    }]);
    return json([{ id: 'app', aud: 'aud', domain: 'ssh.example.com', type: 'self_hosted' }]);
  });
  await ensureAccess(api, settings, 'ssh.example.com');
  assert.equal(writes, 1);
});

test('missing Zero Trust initialization stops before creating anything', async () => {
  const api = new CloudflareApi('token', async (url, init) => {
    assert.ok(String(url).endsWith('/organizations'));
    assert.equal(init?.method, 'GET');
    return json({});
  });
  await assert.rejects(ensureAccess(api, settings, 'ssh.example.com'), /启用 Zero Trust/);
});

test('unsafe existing policy is rejected without writes', async () => {
  for (const policy of [
    { decision: 'bypass', include: [{ everyone: {} }] },
    { decision: 'allow', include: [{ email_domain: { domain: 'example.com' } }] },
    { decision: 'allow', include: [{ everyone: {} }] },
  ]) {
    const api = new CloudflareApi('token', async (url, init) => {
      assert.equal(init?.method, 'GET');
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/organizations')) return json({ auth_domain: 'team.cloudflareaccess.com' });
      if (path.endsWith('/policies')) return json([policy]);
      return json([{ id: 'app', aud: 'aud', domain: 'ssh.example.com', type: 'self_hosted' }]);
    });
    await assert.rejects(ensureAccess(api, settings, 'ssh.example.com'), /收紧/);
  }
});

test('worker lookup does not treat unauthorized or missing secret reads as a fresh deployment', async () => {
  const absent = new CloudflareApi('token', async () => json([]));
  assert.deepEqual(await readWorkerSecretNames(absent, settings), new Set());
  const existing = new CloudflareApi('token', async (url) => {
    if (String(url).includes('/secrets')) return new Response('', { status: 403 });
    return json([{ id: settings.workerName }]);
  });
  await assert.rejects(readWorkerSecretNames(existing, settings), /HTTP 403/);
});

test('Worker list is unpaginated, including accounts with more than 100 Workers', async () => {
  const api = new CloudflareApi('token', async (url) => {
    assert.equal(new URL(String(url)).search, '');
    if (String(url).endsWith('/secrets')) return json([{ name: 'ENCRYPTION_KEY' }]);
    return json([...Array.from({ length: 100 }, (_, index) => ({ id: `other-${index}` })), { id: settings.workerName }]);
  });
  assert.deepEqual(await readWorkerSecretNames(api, settings), new Set(['ENCRYPTION_KEY']));
});

test('existing plain-text administrator ID can seed the persistent deployment state', async () => {
  const api = new CloudflareApi('token', async (url) => {
    if (String(url).endsWith('/settings')) return json({ bindings: [
      { name: 'AUTH_PROVIDER', type: 'plain_text', text: 'github' },
      { name: 'GH_ADMIN_ID', type: 'plain_text', text: '123456' },
      { name: 'GH_CLIENT_SECRET', type: 'secret_text' },
    ] });
    return json([{ id: settings.workerName }]);
  });
  assert.equal(await readWorkerVariable(api, settings, 'GH_ADMIN_ID'), '123456');
  assert.equal(await readWorkerVariable(api, settings, 'GH_CLIENT_SECRET'), undefined);
});

test('existing encryption key is never overwritten, including stale Actions secrets', async () => {
  const api = new CloudflareApi('token', async () => { throw Error('must not query'); });
  assert.deepEqual(await prepareEncryptionSecret(api, {
    ...settings, secrets: { ENCRYPTION_KEY: 'stale-secret' },
  }, database, new Set(['ENCRYPTION_KEY'])), {});
});

test('new key is 32 random bytes, but missing key with existing ciphertext is a hard failure', async () => {
  const empty = new CloudflareApi('token', async () => json([{ success: true, results: [] }]));
  const first = await prepareEncryptionSecret(empty, settings, database, new Set());
  const second = await prepareEncryptionSecret(empty, settings, database, new Set());
  assert.equal(Buffer.from(first.ENCRYPTION_KEY!, 'base64').length, 32);
  assert.notEqual(first.ENCRYPTION_KEY, second.ENCRYPTION_KEY);
  const data = new CloudflareApi('token', async () => json([{ success: true, results: [{ name: 'hosts' }] }]));
  await assert.rejects(prepareEncryptionSecret(data, settings, database, new Set()), /恢复原密钥/);
  const restored = { ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
  assert.deepEqual(await prepareEncryptionSecret(data, { ...settings, secrets: restored }, database, new Set()), restored);
});

test('a previously migrated but empty hosts table permits first key generation', async () => {
  let queries = 0;
  const api = new CloudflareApi('token', async (_url, init) => {
    queries++;
    const { sql } = JSON.parse(String(init?.body));
    return json([{ success: true, results: sql.includes('sqlite_master') ? [{ name: 'hosts' }] : [] }]);
  });
  assert.ok((await prepareEncryptionSecret(api, settings, database, new Set())).ENCRYPTION_KEY);
  assert.equal(queries, 2);
});
