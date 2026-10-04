import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64url, decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Env } from '../src/types.ts';
import { currentAccount } from '../src/accounts/auth.ts';
import { authRoute } from '../src/accounts/auth-routes.ts';
import { githubCallback, githubLogin } from '../src/accounts/github-auth.ts';
import { encryptHost, decryptHost } from '../src/accounts/crypto.ts';

const origin = 'https://ssh.example.com';
const baseEnv = {
  AUTH_PROVIDER: 'github', APP_ORIGIN: origin,
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  GH_CLIENT_ID: 'test-client', GH_CLIENT_SECRET: 'test-client-secret', GH_ADMIN_ID: '123',
  ACCESS_TEAM_DOMAIN: 'test-oauth.cloudflareaccess.com', ACCESS_AUD: 'access-audience',
};

interface MemoryWorkspace {
  account_id: string;
  auth_provider: 'cloudflare' | 'github';
  auth_revision: number;
  access_not_before: number;
}

function environment(overrides: Partial<MemoryWorkspace> = {}) {
  const state: MemoryWorkspace = {
    account_id: 'legacy-access-owner', auth_provider: 'github', auth_revision: 1, access_not_before: 0,
    ...overrides,
  };
  const DB = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { params = values; return statement; },
        async first<T>() { return { ...state } as T; },
        async run() {
          let changes = 0;
          if (sql.includes('UPDATE workspace_state')
            && params[1] === state.auth_provider && params[2] === state.auth_revision) {
            state.auth_revision++;
            state.access_not_before = params[0] as number;
            changes = 1;
          }
          return { success: true, meta: { changes } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { env: { ...baseEnv, DB } as Env, state };
}

const shared = environment();
const env = shared.env;
const accessKeys = await generateKeyPair('RS256');
const accessJwk = await exportJWK(accessKeys.publicKey);
const request = (path: string, cookie = '', headers = {}) => new Request(`${origin}${path}`, {
  headers: { Cookie: cookie, ...headers },
});
const cookieValue = (response: Response, name: string) =>
  response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))!.split(';')[0];

async function start(target = env) {
  const response = await githubLogin(request('/auth/login'), target);
  const authorization = new URL(response.headers.get('Location')!);
  return { response, authorization, cookie: cookieValue(response, '__Host-edgessh-oauth') };
}

function exchange(id = 123): typeof fetch {
  return async (url, init) => {
    if (String(url).endsWith('/access_token')) {
      assert.equal(init?.method, 'POST');
      const body = init?.body as URLSearchParams;
      assert.equal(body.get('client_secret'), baseEnv.GH_CLIENT_SECRET);
      assert.equal(body.get('redirect_uri'), `${origin}/auth/callback`);
      assert.equal(body.get('code_verifier')?.length, 43);
      return Response.json({ access_token: 'private-github-token' });
    }
    assert.equal(String(url), 'https://api.github.com/user');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer private-github-token');
    return Response.json({ id, login: 'administrator' });
  };
}

async function login(target = env) {
  const flow = await start(target);
  const response = await githubCallback(
    request(`/auth/callback?code=valid&state=${flow.authorization.searchParams.get('state')}`, flow.cookie),
    target,
    exchange(),
  );
  assert.equal(response.status, 302);
  return { response, cookie: cookieValue(response, '__Host-edgessh-session') };
}

async function accessToken(
  payload: { sub?: string; email?: string } = {},
  options: { issuer?: string; audience?: string; expires?: string; key?: CryptoKey } = {},
) {
  return await new SignJWT({ email: payload.email ?? 'admin@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(options.issuer ?? `https://${baseEnv.ACCESS_TEAM_DOMAIN}`)
    .setAudience(options.audience ?? baseEnv.ACCESS_AUD)
    .setSubject(payload.sub ?? 'access-subject')
    .setIssuedAt()
    .setExpirationTime(options.expires ?? '5m')
    .sign(options.key ?? accessKeys.privateKey);
}

async function withAccessKeys<T>(work: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ keys: [{ ...accessJwk, kid: 'test', alg: 'RS256' }] });
  try { return await work(); } finally { globalThis.fetch = originalFetch; }
}

test('OAuth starts with random state, S256 PKCE and no privileged scopes', async () => {
  const first = await start();
  const second = await start();
  assert.equal(first.authorization.origin, 'https://github.com');
  assert.equal(first.authorization.searchParams.get('redirect_uri'), `${origin}/auth/callback`);
  assert.equal(first.authorization.searchParams.get('scope'), '');
  assert.equal(first.authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.notEqual(first.authorization.searchParams.get('state'), second.authorization.searchParams.get('state'));
  const payload = decodeJwt(first.cookie.split('=')[1]);
  const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(payload.verifier)))));
  assert.equal(challenge, first.authorization.searchParams.get('code_challenge'));
  assert.equal(payload.state, first.authorization.searchParams.get('state'));
  assert.ok(first.response.headers.get('Set-Cookie')?.includes('Secure; HttpOnly; SameSite=Lax'));
  assert.match(first.response.headers.get('Set-Cookie')!, /Max-Age=600(?:;|$)/);
  assert.equal(first.authorization.toString().includes(baseEnv.GH_CLIENT_SECRET), false);
});

test('callback binds state to its browser cookie before any token exchange', async () => {
  const flow = await start();
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw Error('must not fetch'); };
  for (const [query, cookie] of [
    ['code=valid&state=wrong', flow.cookie],
    [`code=valid&state=${flow.authorization.searchParams.get('state')}`, ''],
    [`code=valid&state=${flow.authorization.searchParams.get('state')}`, `${flow.cookie}tampered`],
    ['error=access_denied', flow.cookie],
  ]) {
    const response = await githubCallback(request(`/auth/callback?${query}`, cookie), env, fetcher);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('Set-Cookie')!, /Max-Age=0/);
  }
  assert.equal(calls, 0);
});

test('only the numeric GitHub administrator receives a revision-bound session', async () => {
  const flow = await start();
  const denied = await githubCallback(request(`/auth/callback?code=valid&state=${flow.authorization.searchParams.get('state')}`, flow.cookie), env, exchange(456));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.getSetCookie().some((value) => value.startsWith('__Host-edgessh-session=')), false);
  const { response, cookie } = await login();
  const account = await currentAccount(request('/api/auth/me', cookie), env);
  assert.deepEqual(account, { id: shared.state.account_id, username: 'administrator' });
  assert.equal(response.headers.get('Location'), '/');
  assert.equal(cookie.includes('private-github-token'), false);
  assert.deepEqual({ sub: decodeJwt(cookie.split('=')[1]).sub, revision: decodeJwt(cookie.split('=')[1]).revision }, { sub: '123', revision: 1 });
});

test('login cookie and signed session last 30 days and expire together', async (context) => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  context.mock.timers.enable({ apis: ['Date'], now });
  const runtime = environment();
  const { response, cookie } = await login(runtime.env);
  const duration = 30 * 24 * 60 * 60;
  const header = response.headers.getSetCookie().find((value) => value.startsWith('__Host-edgessh-session='))!;
  assert.match(header, /Secure; HttpOnly; SameSite=Lax/);
  assert.match(header, /Max-Age=2592000(?:;|$)/);
  const payload = decodeJwt(cookie.split('=')[1]);
  assert.equal(payload.exp! - payload.iat!, duration);
  context.mock.timers.setTime(now + (duration - 1) * 1000);
  assert.equal((await currentAccount(request('/api/auth/me', cookie), runtime.env)).username, 'administrator');
  context.mock.timers.setTime(now + duration * 1000);
  await assert.rejects(currentAccount(request('/api/auth/me', cookie), runtime.env), /过期/);
});

test('wrong signing key, tampered cookies and changed administrator cannot access APIs', async () => {
  const { cookie } = await login();
  for (const [token, settings] of [
    [`${cookie}tampered`, env],
    [cookie, { ...env, ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64') }],
    [cookie, { ...env, GH_ADMIN_ID: '456' }],
    [cookie, { ...env, APP_ORIGIN: 'https://another.example.com' }],
  ] as const) {
    await assert.rejects(currentAccount(request('/api/hosts', token), settings), (error: Error & { status: number }) => error.status === 401);
  }
});

test('providers accept only their own credentials and deployment state must match', async () => {
  const flow = await start();
  await assert.rejects(currentAccount(request('/api/hosts', flow.cookie.replace('__Host-edgessh-oauth=', '__Host-edgessh-session=')), env), /过期/);
  await assert.rejects(currentAccount(request('/api/hosts', 'CF_Authorization=access-token'), env), /GitHub 登录/);
  const { cookie } = await login();
  const cloudflare = environment({ auth_provider: 'cloudflare' }).env;
  await assert.rejects(currentAccount(request('/api/hosts', cookie), { ...cloudflare, AUTH_PROVIDER: 'cloudflare' }), /Cloudflare Access/);
  await assert.rejects(currentAccount(request('/api/hosts', cookie), { ...env, AUTH_PROVIDER: 'cloudflare' }), /切换尚未完成/);
  await assert.rejects(currentAccount(request('/api/hosts', cookie), { ...env, AUTH_PROVIDER: 'unknown' }), /登录方式/);
  const callback = await authRoute(request('/auth/callback?code=anything'), { ...cloudflare, AUTH_PROVIDER: 'cloudflare' });
  assert.equal(callback?.status, 404);
});

test('OAuth rejects an unexpected callback origin and hides upstream errors', async () => {
  await assert.rejects(githubLogin(new Request('https://wrong.example.com/auth/login'), env), /正式入口/);
  assert.equal((await githubCallback(new Request('https://wrong.example.com/auth/callback?code=x'), env)).status, 400);
  const flow = await start();
  const response = await githubCallback(request(`/auth/callback?code=valid&state=${flow.authorization.searchParams.get('state')}`, flow.cookie), env,
    async () => { throw Error('client-secret-and-token-in-internal-error'); });
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes('client-secret'), false);
});

test('logout revokes the presented GitHub session instead of only clearing cookies', async () => {
  const runtime = environment();
  const { cookie } = await login(runtime.env);
  const req = new Request(`${origin}/api/auth/logout`, {
    method: 'POST', headers: { Origin: origin, Cookie: cookie },
  });
  const response = (await authRoute(req, runtime.env))!;
  assert.equal((await response.json() as { redirect: string }).redirect, '/');
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.ok(response.headers.getSetCookie().every((value) => value.includes('Max-Age=0')));
  assert.equal(runtime.state.auth_revision, 2);
  await assert.rejects(currentAccount(request('/api/auth/me', cookie), runtime.env), /过期/);
  await assert.rejects(authRoute(new Request(`${origin}/api/auth/logout`, { method: 'POST', headers: { Origin: origin } }), runtime.env), /GitHub 登录/);
  assert.equal((await authRoute(request('/api/auth/logout'), runtime.env))?.status, 405);
});

test('Cloudflare logout revokes the old Access JWT and delegates the upstream logout', async () => {
  await withAccessKeys(async () => {
    const runtime = environment({ auth_provider: 'cloudflare' });
    const token = await accessToken();
    const req = new Request(`${origin}/api/auth/logout`, {
      method: 'POST', headers: { Origin: origin, 'Cf-Access-Jwt-Assertion': token },
    });
    const response = (await authRoute(req, { ...runtime.env, AUTH_PROVIDER: 'cloudflare' }))!;
    assert.equal((await response.json() as { redirect: string }).redirect, '/cdn-cgi/access/logout');
    await assert.rejects(currentAccount(request('/api/auth/me', `CF_Authorization=${token}`), {
      ...runtime.env, AUTH_PROVIDER: 'cloudflare',
    }), /失效/);
  });
});

test('multiple Access identities share one workspace while invalid application tokens are rejected', async () => {
  await withAccessKeys(async () => {
    const runtime = environment({ auth_provider: 'cloudflare' });
    const cloudflare = { ...runtime.env, AUTH_PROVIDER: 'cloudflare' };
    const first = await accessToken({ sub: 'first-subject', email: 'first@example.com' });
    const second = await accessToken({ sub: 'second-subject', email: 'second@example.com' });
    assert.deepEqual(await currentAccount(request('/api/auth/me', `CF_Authorization=${first}`), cloudflare), {
      id: runtime.state.account_id, username: 'first@example.com',
    });
    assert.deepEqual(await currentAccount(request('/api/auth/me', `CF_Authorization=${second}`), cloudflare), {
      id: runtime.state.account_id, username: 'second@example.com',
    });

    const wrongKeys = await generateKeyPair('RS256');
    for (const token of [
      await accessToken({}, { issuer: 'https://other.cloudflareaccess.com' }),
      await accessToken({}, { audience: 'another-application' }),
      await accessToken({}, { expires: '0s' }),
      await accessToken({}, { key: wrongKeys.privateKey }),
    ]) {
      await assert.rejects(currentAccount(request('/api/auth/me', `CF_Authorization=${token}`), cloudflare), /失效/);
    }
  });
});

test('provider round trips preserve encrypted data but never revive an old session', async () => {
  await withAccessKeys(async () => {
    const runtime = environment();
    const { cookie } = await login(runtime.env);
    const github = await currentAccount(request('/api/auth/me', cookie), runtime.env);
    const secret = { host: 'example.com', password: 'test-password' };
    const ciphertext = await encryptHost(secret, runtime.env.ENCRYPTION_KEY, github.id, 'host-1');

    runtime.state.auth_provider = 'cloudflare';
    runtime.state.auth_revision++;
    runtime.state.access_not_before = Math.floor(Date.now() / 1000) - 1;
    const token = await accessToken({ sub: 'another-access-identity', email: 'second@example.com' });
    const cloudflareEnv = { ...runtime.env, AUTH_PROVIDER: 'cloudflare' };
    const cloudflare = await currentAccount(request('/api/auth/me', `CF_Authorization=${token}`), cloudflareEnv);
    assert.equal(cloudflare.id, github.id);
    assert.deepEqual(await decryptHost(ciphertext, runtime.env.ENCRYPTION_KEY, cloudflare.id, 'host-1'), secret);

    runtime.state.auth_provider = 'github';
    runtime.state.auth_revision++;
    await assert.rejects(currentAccount(request('/api/auth/me', cookie), runtime.env), /过期/);
    const fresh = await login(runtime.env);
    const restored = await currentAccount(request('/api/auth/me', fresh.cookie), runtime.env);
    assert.equal(restored.id, github.id);
    assert.deepEqual(await decryptHost(ciphertext, runtime.env.ENCRYPTION_KEY, restored.id, 'host-1'), secret);
  });
});

test('expired sessions are rejected even with a correct signature and revision', async () => {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', base64url.decode(env.ENCRYPTION_KEY), 'HKDF', false, ['deriveBits']);
  const key = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('edgessh:v1'), info: encoder.encode('github-oauth-cookie'),
  }, material, 256));
  const token = await new SignJWT({ sub: '123', username: 'admin', revision: 1 }).setProtectedHeader({ alg: 'HS256' })
    .setIssuer(origin).setAudience(`edgessh:session:${env.GH_CLIENT_ID}:123`)
    .setIssuedAt(1).setExpirationTime(2).sign(key);
  await assert.rejects(currentAccount(request('/api/auth/me', `__Host-edgessh-session=${token}`), env), /过期/);
});
