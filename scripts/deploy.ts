import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';
import { ensureDatabase } from './cloudflare-d1.ts';
import { createDeploymentConfig, createPreviewDeploymentConfig, readDeploymentSettings } from './deployment-config.ts';
import { CloudflareApi, resolveAccountId } from './cloudflare-api.ts';
import { resolveWorkerHostname, resolveWorkersDevSubdomain } from './cloudflare-access.ts';
import { previewOrigin } from '../src/forwarding/security.ts';
import { maskSecrets, prepareEncryptionSecret, readWorkerSecretNames, readWorkerVariable } from './deployment-secrets.ts';
import { prepareAuthentication, requiredAuthSecrets } from './deployment-auth.ts';
import { readWorkspaceState, updateWorkspaceState } from './workspace-state.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const generatedConfig = '.wrangler.generated.toml';
const previewGeneratedConfig = '.wrangler.preview.generated.toml';
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

async function runWrangler(args: string[], input?: string, configPath = generatedConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args, '--config', configPath], {
      cwd: root,
      env: { ...process.env, CI: 'true' },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Wrangler ${args[0]} 失败（退出码 ${code}）。`)));
    if (input !== undefined) {
      child.stdin!.on('error', reject);
      child.stdin!.end(input);
    }
  });
}

async function main(): Promise<void> {
  const template = parse(await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8'));
  const settings = readDeploymentSettings(template, process.env);
  if (process.argv.includes('--validate-only')) {
    console.log('部署配置校验通过。');
    return;
  }

  const api = new CloudflareApi(settings.apiToken);
  settings.accountId = await resolveAccountId(api, settings.accountId);
  process.env.CLOUDFLARE_ACCOUNT_ID = settings.accountId;
  const existingSecrets = await readWorkerSecretNames(api, settings);
  const hostname = settings.customDomain || await resolveWorkerHostname(api, settings);
  let preview = await readWorkerVariable(api, settings, 'PREVIEW_ORIGIN');
  let previewHostname: string | undefined;
  if (settings.deployPreview) {
    previewHostname = settings.previewDomain || `${settings.workerName}-preview.${await resolveWorkersDevSubdomain(api, settings)}.workers.dev`;
    preview = previewOrigin(`https://${previewHostname}`, `https://${hostname}`);
  }
  const database = await ensureDatabase(settings);
  const workspace = await readWorkspaceState(api, settings, database);
  const deployedProvider = workspace.authProvider
    ?? await readWorkerVariable(api, settings, 'AUTH_PROVIDER');
  if (deployedProvider !== undefined && deployedProvider !== 'cloudflare' && deployedProvider !== 'github') {
    throw new Error('已部署的认证方式无效，停止自动覆盖。');
  }
  const deployedGitHubId = workspace.githubAdminId
    ?? (settings.authProvider === 'github'
      ? await readWorkerVariable(api, settings, 'GH_ADMIN_ID')
        // 旧版 Worker 若尚未把管理员 ID 写入 D1，迁移时沿用其原绑定。
        ?? await readWorkerVariable(api, settings, 'GITHUB_ADMIN_ID')
      : undefined);
  if (deployedGitHubId && !/^[1-9]\d*$/.test(deployedGitHubId)) {
    throw new Error('已部署的 GitHub 管理员数字 ID 无效，停止自动覆盖。');
  }
  const authentication = await prepareAuthentication(api, settings, hostname, {
    existingSecrets,
    fixedGithubAdminId: deployedGitHubId,
    previousProvider: deployedProvider,
  });
  const secrets = { ...authentication.secrets, ...await prepareEncryptionSecret(api, settings, database, existingSecrets) };
  maskSecrets(secrets);
  const config = createDeploymentConfig(template, settings, database, {
    hostname, ...(preview ? { previewOrigin: preview } : {}), githubAdminId: authentication.githubAdminId,
  });
  // 临时配置放在仓库根目录，保持 assets、main、migrations_dir 的相对路径语义。
  await writeFile(new URL(`../${generatedConfig}`, import.meta.url), stringify(config), 'utf8');
  console.log(`部署 Worker ${settings.workerName}，使用 D1 ${database.name}（${database.uuid}）。`);
  await runWrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  // Secret 只通过标准输入发送，不写临时文件或命令行参数；首次部署由 Wrangler 创建草稿 Worker。
  if (Object.keys(secrets).length) await runWrangler(['secret', 'bulk'], JSON.stringify(secrets));
  await runWrangler(['deploy']);
  await updateWorkspaceState(api, settings, database, workspace, authentication.githubAdminId);
  // Wrangler 默认保留既有 Secret；部署后再次核对名称，避免把缺少认证的版本当作成功。
  const deployedSecrets = await readWorkerSecretNames(api, settings);
  for (const name of ['ENCRYPTION_KEY', ...requiredAuthSecrets(settings.authProvider)]) {
    if (!deployedSecrets.has(name)) throw new Error(`部署后缺少 Worker Secret：${name}。`);
  }
  // 预览 Worker 只做代理入口和 DO 绑定，不执行迁移、不写入任何 Secret。
  if (settings.deployPreview) {
    const previewConfig = createPreviewDeploymentConfig(template, settings, preview!);
    await writeFile(new URL(`../${previewGeneratedConfig}`, import.meta.url), stringify(previewConfig), 'utf8');
    await runWrangler(['deploy'], undefined, previewGeneratedConfig);
  }
  console.log(`部署完成：https://${hostname}${settings.deployPreview ? `，预览：https://${previewHostname}` : '（仅主 Worker）'}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## EdgeSSH 部署完成\n\n入口：https://${hostname}\n\n${settings.deployPreview ? `预览：https://${previewHostname}\n\n` : ''}登录方式：${settings.authProvider}\n\n`
      + (settings.authProvider === 'github' ? `GitHub OAuth 回调地址：https://${hostname}/auth/callback\n\n` : '')
      + 'D1 已迁移，运行时 Secret 已保存在 Cloudflare。后续部署保留原加密密钥与管理员资料。\n');
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
