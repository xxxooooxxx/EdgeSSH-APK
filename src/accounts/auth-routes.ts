import type { Env } from '../types.ts';
import { authProvider } from './auth-provider.ts';
import { githubCallback, githubLogin, clearGithubCookies } from './github-auth.ts';
import { json } from './http.ts';
import { currentAccount } from './auth.ts';
import { revokeWorkspaceSessions, workspaceState } from './workspace.ts';

export async function authRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!['/auth/login', '/auth/callback', '/api/auth/logout'].includes(path)) return null;
  const provider = authProvider(env);
  if (path === '/api/auth/logout') {
    if (request.method !== 'POST') return json({ error: '请使用 POST 退出登录。' }, 405);
    await currentAccount(request, env);
    const workspace = await workspaceState(env);
    await revokeWorkspaceSessions(env, workspace);
    return clearGithubCookies(json({ redirect: provider === 'cloudflare' ? '/cdn-cgi/access/logout' : '/' }));
  }
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (provider === 'github') {
    return path === '/auth/login' ? await githubLogin(request, env) : await githubCallback(request, env);
  }
  // Cloudflare 模式不接受 GitHub 回调或会话；登录入口由域名前的 Access 网关处理。
  return path === '/auth/login' ? new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store' } })
    : json({ error: '当前未启用 GitHub 登录。' }, 404);
}
