import { CloudflareApi, CloudflareApiError } from './cloudflare-api.ts';
import type { DeploymentSettings } from './deployment-config.ts';

interface AccessApplication {
  id: string;
  aud: string;
  type: string;
  domain: string;
  self_hosted_domains?: string[];
}

interface IdentityProvider { id: string; type: string }
interface AccessPolicy {
  id: string;
  name: string;
  decision: string;
  include: unknown[];
  exclude?: unknown[];
  require?: unknown[];
  precedence?: number;
}

export async function resolveWorkerHostname(api: CloudflareApi, settings: DeploymentSettings): Promise<string> {
  const subdomain = await resolveWorkersDevSubdomain(api, settings);
  return `${settings.workerName}.${subdomain}.workers.dev`;
}

export async function resolveWorkersDevSubdomain(api: CloudflareApi, settings: DeploymentSettings): Promise<string> {
  const path = `/accounts/${settings.accountId}/workers/subdomain`;
  let subdomain: string | null = null;
  try {
    ({ subdomain } = await api.request<{ subdomain: string | null }>(path));
  } catch (error) {
    // 与 Wrangler 一样，只将 10007 识别为“尚未注册”；权限/网络失败不能触发资源创建。
    if (!(error instanceof CloudflareApiError) || !error.codes.includes(10007)) throw error;
  }
  if (!subdomain) {
    // 只有账户尚未注册子域时才初始化，避免改动同账户其他 Worker 的地址。
    subdomain = `${settings.workerName}-${settings.accountId.slice(0, 8)}`;
    await api.request(path, 'PUT', { subdomain });
  }
  return subdomain;
}

export async function ensureAccess(
  api: CloudflareApi,
  settings: DeploymentSettings,
  hostname: string,
): Promise<{ ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string }> {
  const base = `/accounts/${settings.accountId}/access`;
  const organization = await api.request<{ auth_domain: string }>(`${base}/organizations`);
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(organization.auth_domain ?? '')) {
    throw new Error('请先在 Cloudflare 启用 Zero Trust 并设置团队域名，再运行 Deploy。');
  }
  const apps = await api.list<AccessApplication>(`${base}/apps`);
  const matches = apps.filter((app) => app.domain === hostname || app.self_hosted_domains?.includes(hostname));
  if (matches.length > 1) throw new Error('同一入口匹配多个 Access 应用，请先在 Zero Trust 控制台消除冲突。');
  let app = matches[0];
  const policyName = `EdgeSSH ${settings.workerName} administrator`;
  const policy = {
    name: policyName,
    decision: 'allow',
    include: [{ email: { email: settings.adminEmail } }],
  };

  if (!app) {
    if (!settings.adminEmail) throw new Error('首次创建 Access 应用需要 ADMIN_EMAIL，请在 Run workflow 输入管理员邮箱。');
    const providers = await api.list<IdentityProvider>(`${base}/identity_providers`);
    let providerIds = settings.identityProviderIds;
    if (providerIds.length) {
      if (providerIds.some((id) => !providers.some((provider) => provider.id === id))) {
        throw new Error('ACCESS_IDP_IDS 包含不属于当前账户的身份提供程序。');
      }
    } else {
      let otp = providers.find((provider) => provider.type === 'onetimepin');
      if (!otp) {
        otp = await api.request<IdentityProvider>(`${base}/identity_providers`, 'POST', {
          name: 'Email PIN', type: 'onetimepin', config: {},
        });
      }
      providerIds = [otp.id];
    }
    // 登录方式仅是应用创建时的默认值；以后重跑不覆盖控制台添加的 GitHub 等 IdP。
    // 应用和内嵌 Allow 策略一起创建，避免产生可访问但没有授权规则的中间状态。
    app = await api.request<AccessApplication>(`${base}/apps`, 'POST', {
      name: `EdgeSSH ${settings.workerName}`,
      type: 'self_hosted',
      domain: hostname,
      session_duration: '720h',
      allowed_idps: providerIds,
      auto_redirect_to_identity: providerIds.length === 1,
      policies: [{ ...policy, precedence: 1 }],
    });
  } else {
    if (app.type !== 'self_hosted') throw new Error('现有入口不是自托管 Access 应用，停止部署以免覆盖其他用途的配置。');
    const policies = await api.list<AccessPolicy>(`${base}/apps/${app.id}/policies`);
    if (!policies.length) throw new Error('现有 Access 应用没有策略，请先添加明确身份的 Allow 策略。');
    if (policies.some((entry) => entry.decision === 'bypass'
      || (entry.decision === 'allow' && entry.include.some((rule) => {
        const selector = rule as Record<string, unknown>;
        return 'everyone' in selector || 'email_domain' in selector;
      })))) {
      throw new Error('现有 Access 策略包含 Bypass、Everyone 或整域邮箱授权，请先收紧为明确身份。');
    }
    const managed = policies.find((entry) => entry.name === policyName);
    // 只修改脚本拥有的邮箱策略，既有应用的 IdP 和人工策略都不接管。
    if (managed && settings.adminEmail) {
      if (managed.decision !== 'allow' || managed.exclude?.length || managed.require?.length
        || managed.include.length !== 1 || !('email' in (managed.include[0] as object))) {
        throw new Error('自动邮箱策略已被人工修改，请在控制台管理它，或将其改名后重跑以保留人工配置。');
      }
      const email = (managed.include[0] as { email: { email: string } }).email.email;
      if (email !== settings.adminEmail) {
        await api.request(`${base}/apps/${app.id}/policies/${managed.id}`, 'PUT', {
          ...policy, precedence: managed.precedence,
        });
      }
    }
  }
  if (!app.aud) throw new Error('Access 应用没有返回 AUD，停止部署。');
  return { ACCESS_TEAM_DOMAIN: organization.auth_domain, ACCESS_AUD: app.aud };
}
