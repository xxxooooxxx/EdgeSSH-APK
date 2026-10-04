import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '../types.ts';
import { accessToken } from './access-token.ts';
import { APIError } from './http.ts';
import { authProvider } from './auth-provider.ts';
import { githubAccount } from './github-auth.ts';
import { workspaceState, type WorkspaceState } from './workspace.ts';

export interface WorkspaceAccount { id: string; username: string }
const resolvers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function currentAccount(request: Request, env: Env): Promise<WorkspaceAccount> {
  const provider = authProvider(env);
  const workspace = await workspaceState(env);
  if (workspace.authProvider !== provider) throw new APIError('登录方式切换尚未完成，请重新部署。', 503);
  const identity = provider === 'github'
    ? await githubAccount(request, env, workspace.authRevision) : await accessAccount(request, env, workspace);
  // 登录身份只用于展示；所有获准身份始终进入 D1 中固定的同一个管理员工作区。
  return { id: workspace.accountId, username: identity.username };
}

async function accessAccount(request: Request, env: Env, workspace: WorkspaceState): Promise<{ username: string }> {
  if (!env.ACCESS_AUD || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN ?? '')) {
    throw new APIError('管理员尚未配置 Zero Trust Access。', 503);
  }
  const token = accessToken(request);
  if (!token) throw new APIError('请通过 Cloudflare Access 登录后访问。', 401);
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let keys = resolvers.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    resolvers.set(issuer, keys);
  }
  try {
    // 不信任邮箱请求头：校验签名、有效期、团队与应用，防止绕过 Access 直连 Worker。
    const { payload } = await jwtVerify(token, keys, {
      issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string'
      || typeof payload.iat !== 'number' || payload.iat < workspace.accessNotBefore) throw new Error('Missing identity');
    return { username: payload.email };
  } catch {
    throw new APIError('Access 登录已失效，请重新登录。', 401);
  }
}
