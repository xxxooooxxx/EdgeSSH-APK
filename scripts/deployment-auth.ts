import { ensureAccess } from './cloudflare-access.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import type { DeploymentSettings, RuntimeSecrets } from './deployment-config.ts';

interface AuthenticationOptions {
  existingSecrets?: Set<string>;
  fixedGithubAdminId?: string;
  previousProvider?: DeploymentSettings['authProvider'];
  fetcher?: typeof fetch;
}

export function requiredAuthSecrets(provider: DeploymentSettings['authProvider']): string[] {
  return provider === 'github' ? ['GH_CLIENT_SECRET'] : ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'];
}

export async function prepareAuthentication(
  api: CloudflareApi,
  settings: DeploymentSettings,
  hostname: string,
  options: AuthenticationOptions = {},
): Promise<{ secrets: Partial<RuntimeSecrets>; githubAdminId?: string }> {
  const fetcher = options.fetcher ?? fetch;
  if (settings.authProvider === 'cloudflare') {
    const canRetain = options.previousProvider === 'cloudflare'
      && requiredAuthSecrets('cloudflare').every((name) => options.existingSecrets?.has(name));
    if (canRetain) {
      try {
        const response = await fetcher(`https://${hostname}/api/auth/me`, {
          redirect: 'manual', signal: AbortSignal.timeout(30_000),
        });
        const location = response.headers.get('Location');
        const target = location ? new URL(location, `https://${hostname}`) : null;
        if (target && (target.hostname.endsWith('.cloudflareaccess.com')
          || target.pathname.startsWith('/cdn-cgi/access/'))) {
          console.log('已确认当前入口仍由 Cloudflare Access 保护，保留现有认证 Secret。');
          return { secrets: {} };
        }
      } catch {
        throw new Error('无法确认当前入口的 Cloudflare Access 登录是否可用，请检查域名后重试。');
      }
    }
    // 首次启用、切回 Access 或现有配置不完整时，必须从对应应用刷新配置。
    return { secrets: await ensureAccess(api, settings, hostname) };
  }
  // GitHub 新部署完全不调用 Zero Trust API。旧域名若仍在 Access 后面，明确停止，
  // 不擅自删除用户的安全配置，也不把“双重登录”误报为部署成功。
  try {
    const response = await fetcher(`https://${hostname}/api/auth/me`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    const location = response.headers.get('Location');
    const target = location ? new URL(location, `https://${hostname}`) : null;
    if (target && (target.hostname.endsWith('.cloudflareaccess.com')
      || target.pathname.startsWith('/cdn-cgi/access/'))) {
      throw new Error('当前域名仍由 Cloudflare Access 保护。请先在 Access 解除该域名的保护，再切换 GitHub；不会删除主机资料或加密密钥。');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('仍由 Cloudflare Access 保护')) throw error;
    if (options.previousProvider === 'cloudflare'
      || [...(options.existingSecrets ?? [])].some((name) => name.startsWith('ACCESS_'))) {
      throw new Error('无法确认入口是否已解除 Cloudflare Access 保护，请检查域名后重试；不会自动删除现有策略。');
    }
  }
  const fixed = settings.githubAdminId ?? options.fixedGithubAdminId;
  if (fixed) {
    return { githubAdminId: fixed, secrets: { GH_CLIENT_SECRET: settings.secrets.GH_CLIENT_SECRET! } };
  }
  if (!settings.githubAdmin) {
    throw new Error('首次配置 GitHub 登录需要 GH_ADMIN 用户名，或显式设置 GH_ADMIN_ID。');
  }
  const response = await fetcher(`https://api.github.com/users/${settings.githubAdmin}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EdgeSSH' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`无法确认 GH_ADMIN（HTTP ${response.status}），请检查用户名或稍后重试。`);
  const user = await response.json() as { id: number; type: string };
  if (user.type !== 'User' || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new Error('GH_ADMIN 必须是个人 GitHub 账号，不能是组织。');
  }
  return { githubAdminId: String(user.id), secrets: { GH_CLIENT_SECRET: settings.secrets.GH_CLIENT_SECRET! } };
}
