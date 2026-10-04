import type { TomlTable } from 'smol-toml';

export const runtimeSecretNames = ['ENCRYPTION_KEY', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'GH_CLIENT_SECRET'] as const;
export type RuntimeSecrets = Record<(typeof runtimeSecretNames)[number], string>;

export interface DeploymentSettings {
  accountId: string;
  apiToken: string;
  workerName: string;
  databaseName: string;
  databaseId?: string;
  customDomain?: string;
  previewDomain?: string;
  deployPreview?: boolean;
  authProvider: 'cloudflare' | 'github';
  githubClientId?: string;
  githubAdmin?: string;
  githubAdminId?: string;
  adminEmail?: string;
  identityProviderIds: string[];
  secrets: Partial<RuntimeSecrets>;
}

export interface Database {
  uuid: string;
  name: string;
}

export function readDeploymentSettings(
  template: TomlTable,
  env: NodeJS.ProcessEnv,
): DeploymentSettings {
  const authProvider = env.AUTH_PROVIDER?.trim() || 'cloudflare';
  if (authProvider !== 'cloudflare' && authProvider !== 'github') throw new Error('AUTH_PROVIDER 只能是 cloudflare 或 github。');
  const required = ['CLOUDFLARE_API_TOKEN', ...(authProvider === 'github' ? ['GH_CLIENT_ID', 'GH_CLIENT_SECRET'] : [])];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`缺少部署配置：${missing.join(', ')}。请在 GitHub Actions 中配置。`);

  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || '';
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID 必须是 32 位十六进制账户 ID。');
  const workerName = env.WORKER_NAME?.trim() || String(template.name);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) throw new Error('WORKER_NAME 必须是 1–63 位小写字母、数字或连字符，且不能以连字符开头。');
  const deployPreviewValue = env.DEPLOY_PREVIEW_WORKER?.trim().toLowerCase() || 'false';
  if (deployPreviewValue !== 'true' && deployPreviewValue !== 'false') throw new Error('DEPLOY_PREVIEW_WORKER 只能是 true 或 false。');
  const deployPreview = deployPreviewValue === 'true';
  if (deployPreview && `${workerName}-preview`.length > 63) throw new Error('WORKER_NAME 加上 -preview 后不能超过 63 位。');

  const databases = template.d1_databases as TomlTable[] | undefined;
  const database = databases?.find((binding) => binding.binding === 'DB');
  if (!database) throw new Error('wrangler.toml 缺少 DB 数据库绑定。');
  // 改 Worker 名时默认隔离数据库；只有显式指定名称或 ID 才复用另一实例的数据。
  const databaseName = env.D1_DATABASE_NAME?.trim()
    || (workerName === template.name ? String(database.database_name) : `${workerName}-accounts`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(databaseName)) throw new Error('D1_DATABASE_NAME 必须是 1–64 位字母、数字、下划线或连字符，且以字母或数字开头。');
  const databaseId = env.D1_DATABASE_ID?.trim() || (database.database_id as string | undefined);
  if (databaseId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(databaseId)) {
    throw new Error('D1_DATABASE_ID 必须是有效的数据库 UUID。');
  }
  const customDomain = env.CUSTOM_DOMAIN?.trim();
  if (customDomain && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(customDomain)) {
    throw new Error('CUSTOM_DOMAIN 只能填写完整域名，不能包含协议、路径或通配符。');
  }
  if (customDomain?.toLowerCase().endsWith('.workers.dev')) {
    throw new Error('CUSTOM_DOMAIN 不能填写 workers.dev 地址；使用 Worker 自带域名时请删除或留空该配置。');
  }
  const previewDomain = deployPreview ? env.PREVIEW_DOMAIN?.trim() : undefined;
  if (deployPreview && previewDomain && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(previewDomain)) {
    throw new Error('PREVIEW_DOMAIN 只能填写完整域名，不能包含协议、路径或通配符。');
  }
  if (deployPreview && previewDomain?.toLowerCase().endsWith('.workers.dev')) {
    throw new Error('PREVIEW_DOMAIN 不能填写 workers.dev 地址；请使用自定义跨站域名，或留空自动生成预览地址。');
  }

  const adminEmail = authProvider === 'cloudflare' ? env.ADMIN_EMAIL?.trim().toLowerCase() : undefined;
  if (adminEmail && !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(adminEmail)) {
    throw new Error('ADMIN_EMAIL 必须是一个完整的管理员邮箱，不能填写多个邮箱或整个域名。');
  }
  const identityProviderIds = authProvider === 'cloudflare'
    ? [...new Set((env.ACCESS_IDP_IDS || '').split(',').map((id) => id.trim()).filter(Boolean))] : [];
  if (identityProviderIds.some((id) => !/^[a-f0-9-]{36}$/i.test(id))) {
    throw new Error('ACCESS_IDP_IDS 必须是逗号分隔的 Cloudflare 身份提供程序 UUID。');
  }
  const githubClientId = authProvider === 'github' ? env.GH_CLIENT_ID!.trim() : undefined;
  const githubAdmin = authProvider === 'github' ? env.GH_ADMIN?.trim().toLowerCase() || undefined : undefined;
  if (githubAdmin && !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(githubAdmin)) {
    throw new Error('GH_ADMIN 必须是一个 GitHub 用户名。');
  }
  const githubAdminId = authProvider === 'github' ? env.GH_ADMIN_ID?.trim() || undefined : undefined;
  if (githubAdminId && !/^[1-9]\d*$/.test(githubAdminId)) {
    throw new Error('GH_ADMIN_ID 必须是 GitHub 个人账号的数字用户 ID。');
  }
  const selectedSecrets = authProvider === 'github'
    ? ['ENCRYPTION_KEY', 'GH_CLIENT_SECRET'] : ['ENCRYPTION_KEY', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'];
  const secrets = Object.fromEntries(selectedSecrets
    .filter((name) => env[name]?.trim())
    .map((name) => [name, env[name]!.trim()])) as Partial<RuntimeSecrets>;
  if (secrets.ENCRYPTION_KEY) {
    const key = Buffer.from(secrets.ENCRYPTION_KEY, 'base64');
    if (!/^[A-Za-z0-9+/]{43}=?$/.test(secrets.ENCRYPTION_KEY)
      || key.length !== 32
      || key.toString('base64').replace(/=+$/, '') !== secrets.ENCRYPTION_KEY.replace(/=+$/, '')) {
      throw new Error('ENCRYPTION_KEY 必须是 Base64 编码的 32 字节密钥；已有数据时必须继续使用原密钥。');
    }
  }
  if (secrets.ACCESS_TEAM_DOMAIN && !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(secrets.ACCESS_TEAM_DOMAIN)) {
    throw new Error('ACCESS_TEAM_DOMAIN 必须形如 team.cloudflareaccess.com，不包含 https://。');
  }
  if (runtimeSecretNames.some((name) => name in ((template.vars as TomlTable | undefined) ?? {}))) {
    throw new Error('运行时 Secret 不得放在 wrangler.toml 的 vars 中，请使用 Worker Secrets。');
  }

  return {
    accountId, apiToken: env.CLOUDFLARE_API_TOKEN!.trim(), workerName,
    databaseName, databaseId, customDomain, previewDomain, deployPreview, authProvider, githubClientId, githubAdmin, githubAdminId,
    adminEmail, identityProviderIds, secrets,
  };
}

export function createDeploymentConfig(
  template: TomlTable,
  settings: DeploymentSettings,
  database: Database,
  runtime?: { hostname: string; previewOrigin?: string; githubAdminId?: string },
): TomlTable {
  return {
    ...template,
    account_id: settings.accountId,
    name: settings.workerName,
    // 自定义入口启用时关闭备用公网入口，避免绕过对应的 Access 登录页。
    workers_dev: !settings.customDomain,
    preview_urls: false,
    vars: {
      ...template.vars as TomlTable,
      AUTH_PROVIDER: settings.authProvider,
      ...(runtime ? { APP_ORIGIN: `https://${runtime.hostname}` } : {}),
      ...(runtime?.previewOrigin ? { PREVIEW_ORIGIN: runtime.previewOrigin } : {}),
      ...(settings.authProvider === 'github' ? {
        GH_CLIENT_ID: settings.githubClientId!,
        ...(runtime?.githubAdminId ? { GH_ADMIN_ID: runtime.githubAdminId } : {}),
      } : {}),
    },
    ...(settings.customDomain ? { routes: [{ pattern: settings.customDomain, custom_domain: true }] } : {}),
    d1_databases: (template.d1_databases as TomlTable[]).map((binding) => binding.binding === 'DB'
      ? { ...binding, database_name: database.name, database_id: database.uuid }
      : binding),
  };
}

export function createPreviewDeploymentConfig(template: TomlTable, settings: DeploymentSettings, previewOrigin: string): TomlTable {
  const previewTemplate = {
    name: `${settings.workerName}-preview`,
    main: 'src/preview-worker.ts',
    compatibility_date: template.compatibility_date,
    workers_dev: !settings.previewDomain,
    preview_urls: false,
    vars: { PREVIEW_ORIGIN: previewOrigin },
    durable_objects: { bindings: [{ name: 'SSH_SESSIONS', class_name: 'SSHSessionDO', script_name: settings.workerName }] },
    ...(settings.previewDomain ? { routes: [{ pattern: settings.previewDomain, custom_domain: true }] } : {}),
  };
  return previewTemplate as TomlTable;
}
