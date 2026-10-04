import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse, stringify } from 'smol-toml';
import { CloudflareApi } from '../scripts/cloudflare-api.ts';
import { prepareAuthentication, requiredAuthSecrets } from '../scripts/deployment-auth.ts';
import { createDeploymentConfig, readDeploymentSettings } from '../scripts/deployment-config.ts';
import { readWorkspaceState, updateWorkspaceState, type DeploymentWorkspaceState } from '../scripts/workspace-state.ts';

const template = parse(await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8'));
const environment = {
  CLOUDFLARE_API_TOKEN: 'cf-token', AUTH_PROVIDER: 'github',
  GH_CLIENT_ID: 'test-client', GH_CLIENT_SECRET: 'test-client-secret', GH_ADMIN: 'admin',
};
const settings = readDeploymentSettings(template, environment);
const database = { uuid: 'test-db', name: settings.databaseName };
const envelope = (result: unknown) => Response.json({ success: true, result });
const queryEnvelope = (results: unknown[]) => envelope([{ success: true, results }]);

test('each deployment mode validates only its own inputs', () => {
  assert.deepEqual(settings.identityProviderIds, []);
  assert.equal(readDeploymentSettings(template, { ...environment, GH_ADMIN: '' }).githubAdmin, undefined);
  assert.equal(readDeploymentSettings(template, {
    ...environment, GH_ADMIN: '', GH_ADMIN_ID: '123', ADMIN_EMAIL: 'invalid', ACCESS_TEAM_DOMAIN: 'invalid', ACCESS_IDP_IDS: 'invalid',
  }).githubAdminId, '123');
  assert.equal(readDeploymentSettings(template, { CLOUDFLARE_API_TOKEN: 'token', AUTH_PROVIDER: 'cloudflare', GH_ADMIN: 'invalid value' }).authProvider, 'cloudflare');
  for (const field of ['GH_CLIENT_ID', 'GH_CLIENT_SECRET']) {
    assert.throws(() => readDeploymentSettings(template, { ...environment, [field]: '' }), new RegExp(field));
  }
  assert.throws(() => readDeploymentSettings(template, { ...environment, GH_ADMIN_ID: 'name' }), /GH_ADMIN_ID/);
  assert.throws(() => readDeploymentSettings(template, { ...environment, AUTH_PROVIDER: 'other' }), /AUTH_PROVIDER/);
});

test('first GitHub deployment resolves a numeric administrator without Zero Trust API', async () => {
  const cloudflare = new CloudflareApi('token', async () => { throw Error('must not call Zero Trust'); });
  const calls: string[] = [];
  const prepared = await prepareAuthentication(cloudflare, settings, 'ssh.example.com', {
    fetcher: async (url) => {
      calls.push(String(url));
      return String(url).includes('/api/auth/me')
        ? new Response('', { status: 401 }) : Response.json({ id: 123, type: 'User' });
    },
  });
  assert.deepEqual(calls, ['https://ssh.example.com/api/auth/me', 'https://api.github.com/users/admin']);
  assert.equal(prepared.githubAdminId, '123');
  assert.deepEqual(prepared.secrets, { GH_CLIENT_SECRET: environment.GH_CLIENT_SECRET });
  assert.deepEqual(requiredAuthSecrets('github'), ['GH_CLIENT_SECRET']);
  const config = createDeploymentConfig(template, settings, database, { hostname: 'ssh.example.com', githubAdminId: '123' });
  const vars = config.vars as Record<string, string>;
  assert.equal(vars.AUTH_PROVIDER, 'github');
  assert.equal(vars.ADMIN_ACCOUNT_ID, undefined);
  assert.equal(vars.APP_ORIGIN, 'https://ssh.example.com');
  assert.equal(vars.GH_ADMIN_ID, '123');
  assert.equal(stringify(config).includes(environment.GH_CLIENT_SECRET), false);
});

test('ordinary GitHub redeployments retain the fixed ID and explicit numeric changes are visible', async () => {
  let githubLookups = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).includes('/users/')) githubLookups++;
    return new Response('', { status: 401 });
  };
  const retained = await prepareAuthentication(new CloudflareApi('token'), settings, 'ssh.example.com', {
    fixedGithubAdminId: '123', fetcher,
  });
  assert.equal(retained.githubAdminId, '123');
  const explicit = readDeploymentSettings(template, { ...environment, GH_ADMIN_ID: '456', GH_ADMIN: 'renamed-user' });
  assert.equal((await prepareAuthentication(new CloudflareApi('token'), explicit, 'ssh.example.com', {
    fixedGithubAdminId: '123', fetcher,
  })).githubAdminId, '456');
  assert.equal(githubLookups, 0);
});

test('organization names and unresolved first administrators are rejected', async () => {
  const cloudflare = new CloudflareApi('token');
  for (const response of [new Response('', { status: 404 }), Response.json({ id: 123, type: 'Organization' })]) {
    let calls = 0;
    await assert.rejects(prepareAuthentication(cloudflare, settings, 'ssh.example.com', {
      fetcher: async () => (++calls === 1 ? new Response('', { status: 401 }) : response),
    }), /GH_ADMIN/);
  }
  const noName = readDeploymentSettings(template, { ...environment, GH_ADMIN: '' });
  await assert.rejects(prepareAuthentication(cloudflare, noName, 'ssh.example.com', {
    fetcher: async () => new Response('', { status: 401 }),
  }), /首次配置/);
});

test('a mode switch stops rather than leaving GitHub behind an existing Access login', async () => {
  const cloudflare = new CloudflareApi('token', async () => { throw Error('must not mutate Access'); });
  await assert.rejects(prepareAuthentication(cloudflare, settings, 'ssh.example.com', {
    existingSecrets: new Set(['ACCESS_TEAM_DOMAIN']),
    previousProvider: 'cloudflare',
    fetcher: async () => new Response(null, {
      status: 302, headers: { Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' },
    }),
  }), /解除/);
  await assert.rejects(prepareAuthentication(cloudflare, settings, 'ssh.example.com', {
    existingSecrets: new Set(['ACCESS_AUD']), previousProvider: 'cloudflare',
    fetcher: async () => { throw Error('dns failure'); },
  }), /无法确认入口/);
});

test('ordinary Cloudflare redeployment confirms the live Access gateway without requiring Zero Trust API', async () => {
  const cf = readDeploymentSettings(template, { CLOUDFLARE_API_TOKEN: 'token' });
  const api = new CloudflareApi('token', async () => { throw Error('must not call Zero Trust'); });
  assert.deepEqual(await prepareAuthentication(api, cf, 'ssh.example.com', {
    previousProvider: 'cloudflare',
    existingSecrets: new Set(['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']),
    fetcher: async () => new Response(null, {
      status: 302, headers: { Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' },
    }),
  }), { secrets: {} });
});

test('switching to Cloudflare validates the real Access app instead of trusting old secret names', async () => {
  const cf = readDeploymentSettings(template, { CLOUDFLARE_API_TOKEN: 'token' });
  const paths: string[] = [];
  const api = new CloudflareApi('token', async (url) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path.endsWith('/organizations')) return envelope({ auth_domain: 'team.cloudflareaccess.com' });
    if (path.endsWith('/apps')) return envelope([{ id: 'app', aud: 'current-aud', type: 'self_hosted', domain: 'ssh.example.com' }]);
    if (path.endsWith('/policies')) return envelope([{
      id: 'manual', name: 'Manual identities', decision: 'allow', include: [{ email: { email: 'one@example.com' } }],
    }]);
    throw Error(`unexpected ${path}`);
  });
  assert.deepEqual(await prepareAuthentication(api, cf, 'ssh.example.com', {
    previousProvider: 'github', existingSecrets: new Set(['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']),
  }), {
    secrets: { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'current-aud' },
  });
  assert.ok(paths.some((path) => path.endsWith('/organizations')));
  assert.ok(paths.some((path) => path.endsWith('/apps')));
  assert.ok(paths.some((path) => path.endsWith('/policies')));
});

function workspaceApi(options: { owners?: string[]; state?: DeploymentWorkspaceState }) {
  const memory = options.state ? {
    account_id: options.state.accountId,
    auth_provider: options.state.authProvider!,
    auth_revision: options.state.authRevision,
    access_not_before: options.state.accessNotBefore,
    github_admin_id: options.state.githubAdminId ?? null,
  } : undefined;
  const api = new CloudflareApi('token', async (_url, init) => {
    const { sql, params = [] } = JSON.parse(String(init?.body)) as { sql: string; params?: unknown[] };
    if (sql.includes('sqlite_master')) {
      return queryEnvelope(memory ? [{ name: 'hosts' }, { name: 'workspace_state' }] : [{ name: 'hosts' }]);
    }
    if (sql.includes('SELECT DISTINCT account_id')) return queryEnvelope((options.owners ?? []).map((account_id) => ({ account_id })));
    if (sql.startsWith('SELECT account_id')) return queryEnvelope(memory ? [{ ...memory }] : []);
    if (sql.startsWith('UPDATE workspace_state')) {
      memory!.auth_provider = params[0] as 'cloudflare' | 'github';
      memory!.auth_revision = params[1] as number;
      memory!.access_not_before = params[2] as number;
      memory!.github_admin_id = params[3] as string | null;
      return queryEnvelope([]);
    }
    throw Error(`unexpected SQL: ${sql}`);
  });
  return { api, memory };
}

test('single-owner legacy databases initialize safely and multiple owners stop', async () => {
  for (const owners of [[], ['legacy-sub'], ['admin']]) {
    const { api } = workspaceApi({ owners });
    assert.equal((await readWorkspaceState(api, settings, database)).accountId, owners[0] ?? 'admin');
  }
  const multiple = workspaceApi({ owners: ['first', 'second'] });
  await assert.rejects(readWorkspaceState(multiple.api, settings, database), /多个资料所有者/);
});

test('persisted workspace survives an empty host table and provider changes revoke old sessions', async () => {
  const initial: DeploymentWorkspaceState = {
    accountId: 'legacy-owner', authProvider: 'cloudflare', authRevision: 4, accessNotBefore: 10, githubAdminId: '123',
  };
  const { api } = workspaceApi({ owners: [], state: initial });
  const loaded = await readWorkspaceState(api, settings, database);
  assert.equal(loaded.accountId, 'legacy-owner');
  const switched = await updateWorkspaceState(api, settings, database, loaded, '123', 100);
  assert.deepEqual(switched, {
    accountId: 'legacy-owner', authProvider: 'github', authRevision: 5,
    accessNotBefore: 101, githubAdminId: '123',
  });
  const renamed = await updateWorkspaceState(api, { ...settings, githubAdminId: '456' }, database, switched, '456', 200);
  assert.equal(renamed.accountId, 'legacy-owner');
  assert.equal(renamed.authRevision, 6);
  assert.equal(renamed.githubAdminId, '456');
});
