import { base64url, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { Env } from '../types.ts';
import { APIError, apiFailure } from './http.ts';
import { secureResponse } from '../http-security.ts';
import { workspaceState } from './workspace.ts';

const sessionCookie = '__Host-edgessh-session';
const flowCookie = '__Host-edgessh-oauth';
// Cookie 与签名令牌共用 30 天期限，避免浏览器仍保留 Cookie 时服务端已判定过期。
const sessionSeconds = 30 * 24 * 60 * 60;
const flowSeconds = 10 * 60;
const encoder = new TextEncoder();
type GitHubConfig = Env & Required<Pick<Env, 'APP_ORIGIN' | 'GH_CLIENT_ID' | 'GH_CLIENT_SECRET' | 'GH_ADMIN_ID'>>;

function config(env: Env): GitHubConfig {
  if (!env.APP_ORIGIN || !env.GH_CLIENT_ID || !env.GH_CLIENT_SECRET || !env.GH_ADMIN_ID || !env.ENCRYPTION_KEY) {
    throw new APIError('管理员尚未配置 GitHub 登录。', 503);
  }
  return env as GitHubConfig;
}

function cookie(request: Request, name: string): string | undefined {
  return request.headers.get('Cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

// 使用 HKDF 做用途隔离，不直接把资料加密密钥用于签名，也不新增用户需要维护的密钥。
async function signingKey(secret: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', new Uint8Array(base64url.decode(secret)), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('edgessh:v1'),
    info: encoder.encode('github-oauth-cookie'),
  }, material, 256));
}

function audience(env: GitHubConfig, purpose: string): string {
  return `edgessh:${purpose}:${env.GH_CLIENT_ID}:${env.GH_ADMIN_ID}`;
}

async function sign(env: GitHubConfig, purpose: string, payload: JWTPayload, seconds: number): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuer(env.APP_ORIGIN)
    .setAudience(audience(env, purpose)).setIssuedAt().setExpirationTime(`${seconds}s`)
    .sign(await signingKey(env.ENCRYPTION_KEY));
}

async function verify(env: GitHubConfig, purpose: string, token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, await signingKey(env.ENCRYPTION_KEY), {
    issuer: env.APP_ORIGIN, audience: audience(env, purpose), algorithms: ['HS256'], requiredClaims: ['exp', 'iat'],
  });
  return payload;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return secureResponse(new Response(null, { status: 302, headers }));
}

export async function githubLogin(request: Request, env: Env): Promise<Response> {
  const settings = config(env);
  if (new URL(request.url).origin !== settings.APP_ORIGIN) throw new APIError('请从配置的正式入口登录。', 400);
  const state = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
  const url = new URL('https://github.com/login/oauth/authorize');
  // 只验证公开身份，不申请仓库、邮箱或组织权限。
  url.search = new URLSearchParams({
    client_id: settings.GH_CLIENT_ID, redirect_uri: `${settings.APP_ORIGIN}/auth/callback`,
    state, code_challenge: challenge, code_challenge_method: 'S256', scope: '',
  }).toString();
  const flow = await sign(settings, 'flow', { state, verifier }, flowSeconds);
  return redirect(url.toString(), [setCookie(flowCookie, flow, flowSeconds)]);
}

export async function githubCallback(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  let response: Response;
  try {
    const settings = config(env);
    const url = new URL(request.url);
    if (url.origin !== settings.APP_ORIGIN) throw new APIError('登录回调地址不匹配。', 400);
    const saved = cookie(request, flowCookie);
    const code = url.searchParams.get('code');
    if (!saved || !code || url.searchParams.has('error')) throw new APIError('GitHub 登录已取消或过期，请重新登录。', 401);
    let flow: JWTPayload;
    try { flow = await verify(settings, 'flow', saved); }
    catch { throw new APIError('登录请求已过期，请重新登录。', 401); }
    if (typeof flow.state !== 'string' || flow.state !== url.searchParams.get('state') || typeof flow.verifier !== 'string') {
      throw new APIError('登录请求不匹配，请重新登录。', 401);
    }
    const tokenResponse = await fetcher('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: settings.GH_CLIENT_ID, client_secret: settings.GH_CLIENT_SECRET,
        redirect_uri: `${settings.APP_ORIGIN}/auth/callback`, code, code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenResponse.ok) throw new APIError('GitHub 登录服务暂时不可用，请重试。', 502);
    const token = await tokenResponse.json() as { access_token?: string };
    if (!token.access_token) throw new APIError('GitHub 授权码无效或已使用，请重新登录。', 401);
    const userResponse = await fetcher('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'EdgeSSH' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!userResponse.ok) throw new APIError('无法验证 GitHub 身份，请重试。', 502);
    const user = await userResponse.json() as { id: number; login: string };
    // 以数字 ID 授权，不信任可改名的用户名，也不把任意 GitHub 用户视为管理员。
    if (!Number.isSafeInteger(user.id) || String(user.id) !== settings.GH_ADMIN_ID || typeof user.login !== 'string') {
      throw new APIError('此 GitHub 账号不是本实例的管理员。', 403);
    }
    const workspace = await workspaceState(env);
    if (workspace.authProvider !== 'github') throw new APIError('当前未启用 GitHub 登录。', 503);
    const session = await sign(settings, 'session', {
      sub: String(user.id), username: user.login, revision: workspace.authRevision,
    }, sessionSeconds);
    // GitHub access_token 只在本次验证中使用，不写数据库、Cookie 或日志。
    response = redirect('/', [setCookie(sessionCookie, session, sessionSeconds)]);
  } catch (error) {
    response = apiFailure(error);
  }
  response.headers.append('Set-Cookie', setCookie(flowCookie, '', 0));
  return response;
}

export async function githubAccount(request: Request, env: Env, authRevision: number): Promise<{ username: string }> {
  const settings = config(env);
  const token = cookie(request, sessionCookie);
  if (!token) throw new APIError('请先使用 GitHub 登录。', 401);
  try {
    const payload = await verify(settings, 'session', token);
    if (payload.sub !== settings.GH_ADMIN_ID || typeof payload.username !== 'string'
      || payload.revision !== authRevision) throw new Error('Invalid identity');
    return { username: payload.username };
  } catch {
    throw new APIError('登录已过期，请重新登录。', 401);
  }
}

export function clearGithubCookies(response: Response): Response {
  response.headers.append('Set-Cookie', setCookie(sessionCookie, '', 0));
  response.headers.append('Set-Cookie', setCookie(flowCookie, '', 0));
  return response;
}
