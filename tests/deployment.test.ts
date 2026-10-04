import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse, stringify } from 'smol-toml';
import { ensureDatabase } from '../scripts/cloudflare-d1.ts';
import { createDeploymentConfig, createPreviewDeploymentConfig, readDeploymentSettings } from '../scripts/deployment-config.ts';

const templateText = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
const template = parse(templateText);
const env = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'test-token-not-a-real-credential',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
  ACCESS_AUD: 'test-audience',
  DEPLOY_PREVIEW_WORKER: 'true',
};
const settings = readDeploymentSettings(template, env);
const database = { uuid: '00000000-0000-4000-8000-000000000001', name: 'edgessh-accounts' };

function json(result: unknown, success = true): Response {
  return Response.json({ success, result });
}

test('public template contains no account, database ID, custom domain or runtime secrets', () => {
  assert.equal(template.account_id, undefined);
  assert.equal(template.routes, undefined);
  assert.equal(template.workers_dev, true);
  assert.deepEqual(template.d1_databases, [{
    binding: 'DB', database_name: 'edgessh-accounts', migrations_dir: 'migrations',
  }]);
  assert.deepEqual(template.vars, { CONNECT_TIMEOUT_MS: '10000' });
});

test('generated config preserves application bindings and paths without persisting secrets', () => {
  const before = structuredClone(template);
  const config = createDeploymentConfig(template, settings, database);
  assert.equal(config.account_id, env.CLOUDFLARE_ACCOUNT_ID);
  assert.equal(config.name, 'edgessh');
  assert.deepEqual(config.d1_databases, [{
    binding: 'DB', database_name: database.name, database_id: database.uuid, migrations_dir: 'migrations',
  }]);
  for (const key of ['main', 'assets', 'build', 'migrations', 'durable_objects']) {
    assert.deepEqual(config[key], template[key]);
  }
  const serialized = stringify(config);
  for (const value of [env.CLOUDFLARE_API_TOKEN, ...Object.values(settings.secrets)]) {
    assert.equal(serialized.includes(value), false);
  }
  assert.deepEqual(parse(serialized), config);
  assert.deepEqual(template, before);
});

test('main and preview configs use the same preview origin and isolate preview bindings', () => {
  const origin = 'https://edgessh-preview.example.com';
  const main = createDeploymentConfig(template, settings, database, { hostname: 'edgessh.example.com', previewOrigin: origin });
  const preview = createPreviewDeploymentConfig(template, settings, origin);
  assert.equal((main.vars as Record<string, string>).PREVIEW_ORIGIN, origin);
  assert.equal((preview.vars as Record<string, string>).PREVIEW_ORIGIN, origin);
  assert.equal(preview.d1_databases, undefined);
  assert.equal(preview.assets, undefined);
  assert.equal(preview.vars && Object.keys(preview.vars as object).length, 1);
  assert.deepEqual(preview.durable_objects, { bindings: [{ name: 'SSH_SESSIONS', class_name: 'SSHSessionDO', script_name: 'edgessh' }] });
});

test('worker, database and custom domain can be configured for another account', () => {
  const custom = readDeploymentSettings(template, {
    ...env, CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), WORKER_NAME: 'my-ssh', CUSTOM_DOMAIN: 'ssh.example.com',
  });
  assert.equal(custom.databaseName, 'my-ssh-accounts');
  const config = createDeploymentConfig(template, custom, { ...database, name: custom.databaseName });
  assert.equal(config.name, 'my-ssh');
  assert.equal(config.account_id, 'b'.repeat(32));
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, [{ pattern: 'ssh.example.com', custom_domain: true }]);
});

test('explicit database settings and manually configured template values are respected', () => {
  const custom = readDeploymentSettings(template, {
    ...env, WORKER_NAME: 'another-worker', D1_DATABASE_NAME: 'shared-data', D1_DATABASE_ID: database.uuid,
  });
  assert.equal(custom.databaseName, 'shared-data');
  assert.equal(custom.databaseId, database.uuid);
  const manualTemplate = {
    ...template,
    routes: [{ pattern: 'manual.example.com', custom_domain: true }],
    d1_databases: [{ binding: 'DB', database_name: database.name, database_id: database.uuid }],
  };
  const manual = readDeploymentSettings(manualTemplate, env);
  assert.equal(manual.databaseId, database.uuid);
  assert.deepEqual(createDeploymentConfig(manualTemplate, manual, database).routes, manualTemplate.routes);
});

test('missing deployment settings fail before provisioning and do not reveal values', () => {
  assert.throws(() => readDeploymentSettings(template, {}), /CLOUDFLARE_API_TOKEN/);
  const automatic = readDeploymentSettings(template, { CLOUDFLARE_API_TOKEN: 'token', ADMIN_EMAIL: 'Admin@example.com' });
  assert.equal(automatic.accountId, '');
  assert.equal(automatic.adminEmail, 'admin@example.com');
  assert.deepEqual(automatic.secrets, {});
});

test('invalid account, resource, domain and runtime configuration fail validation', () => {
  for (const [name, value] of Object.entries({
    CLOUDFLARE_ACCOUNT_ID: 'wrong-account',
    WORKER_NAME: 'invalid worker name',
    D1_DATABASE_NAME: '../invalid-name',
    D1_DATABASE_ID: 'wrong-database-id',
    CUSTOM_DOMAIN: 'https://ssh.example.com/path',
    ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'),
    ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
    ADMIN_EMAIL: 'everyone',
    ACCESS_IDP_IDS: 'github',
  })) {
    assert.throws(() => readDeploymentSettings(template, { ...env, [name]: value }), new RegExp(name));
  }
  assert.throws(() => readDeploymentSettings(template, { ...env, ENCRYPTION_KEY: `${env.ENCRYPTION_KEY}!` }), /ENCRYPTION_KEY/);
  assert.throws(() => readDeploymentSettings(template, { ...env, ENCRYPTION_KEY: `${env.ENCRYPTION_KEY}==` }), /ENCRYPTION_KEY/);
  assert.throws(
    () => readDeploymentSettings(template, { ...env, CUSTOM_DOMAIN: 'edgessh.example.workers.dev' }),
    /CUSTOM_DOMAIN.*workers\.dev/,
  );
  assert.throws(() => readDeploymentSettings(template, { ...env, PREVIEW_DOMAIN: 'edgessh-preview.workers.dev' }), /PREVIEW_DOMAIN.*workers\.dev/);
  assert.throws(() => readDeploymentSettings(template, { ...env, WORKER_NAME: 'a'.repeat(63) }), /-preview/);
  assert.throws(() => readDeploymentSettings({
    ...template, vars: { ENCRYPTION_KEY: env.ENCRYPTION_KEY },
  }, env), /Secret/);
});

test('preview validation and main-only config follow DEPLOY_PREVIEW_WORKER', () => {
  const disabled = readDeploymentSettings(template, { ...env, DEPLOY_PREVIEW_WORKER: 'false', PREVIEW_DOMAIN: 'not a domain' });
  assert.equal(disabled.deployPreview, false);
  assert.equal(disabled.previewDomain, undefined);
  const config = createDeploymentConfig(template, disabled, database, { hostname: 'edgessh.example.com' });
  assert.equal((config.vars as Record<string, string>).PREVIEW_ORIGIN, undefined);
  const existing = createDeploymentConfig(template, disabled, database, { hostname: 'edgessh.example.com', previewOrigin: 'https://existing.example.com' });
  assert.equal((existing.vars as Record<string, string>).PREVIEW_ORIGIN, 'https://existing.example.com');
  assert.throws(() => readDeploymentSettings(template, { ...env, DEPLOY_PREVIEW_WORKER: 'true', PREVIEW_DOMAIN: 'not a domain' }), /PREVIEW_DOMAIN/);
});

test('database lookup reuses an existing database without any writes', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, 'GET');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
    return json([database]);
  };
  assert.deepEqual(await ensureDatabase(settings, fetcher), database);
  assert.deepEqual(calls, [`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database?per_page=100&page=1`]);
});

test('database lookup searches later pages before creating resources', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(init?.method, 'GET');
    assert.equal(new URL(String(input)).searchParams.get('page'), String(calls));
    return json(calls === 1
      ? Array.from({ length: 100 }, (_, index) => ({ uuid: String(index), name: `other-${index}` }))
      : [database]);
  };
  assert.deepEqual(await ensureDatabase(settings, fetcher), database);
  assert.equal(calls, 2);
});

test('first deployment creates once and subsequent deployment reuses the database', async () => {
  let created = false;
  let writes = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === 'GET') return json(created ? [database] : []);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init.body)), { name: database.name });
    writes++;
    created = true;
    return json(database);
  };
  assert.deepEqual(await ensureDatabase(settings, fetcher), database);
  assert.deepEqual(await ensureDatabase(settings, fetcher), database);
  assert.equal(writes, 1);
});

test('explicit ID is verified within the target account and uses the returned database name', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), `https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/d1/database/${database.uuid}`);
    assert.equal(init?.method, 'GET');
    return json({ ...database, name: 'existing-database' });
  };
  const resolved = await ensureDatabase({ ...settings, databaseId: database.uuid }, fetcher);
  assert.equal(resolved.name, 'existing-database');
  assert.deepEqual(createDeploymentConfig(template, settings, resolved).d1_databases, [{
    binding: 'DB', database_name: 'existing-database', database_id: database.uuid, migrations_dir: 'migrations',
  }]);
});

test('invalid explicit ID or denied API access never falls back to creating an empty database', async () => {
  for (const status of [403, 404, 500]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response('private upstream details', { status });
    };
    await assert.rejects(ensureDatabase({ ...settings, databaseId: database.uuid }, fetcher), (error: Error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.equal(error.message.includes('private upstream details'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('unsuccessful API envelope aborts resource preparation', async () => {
  const fetcher: typeof fetch = async () => json(null, false);
  await assert.rejects(ensureDatabase(settings, fetcher), /未成功/);
});

test('Actions asks for email, keeps Token private and uses the shared deploy entry point', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  for (const name of ['ENCRYPTION_KEY', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']) {
    assert.equal(workflow.includes(`vars.${name}`), false);
  }
  assert.ok(workflow.includes('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}'));
  assert.ok(workflow.includes('inputs.admin_email || secrets.ADMIN_EMAIL || vars.ADMIN_EMAIL'));
  assert.ok(workflow.includes('GH_ADMIN_ID: ${{ vars.GH_ADMIN_ID }}'));
  assert.equal(workflow.includes('secrets.ACCESS_AUD'), false);
  assert.equal(workflow.includes('secrets.ACCESS_TEAM_DOMAIN'), false);
  assert.ok(workflow.includes('CUSTOM_DOMAIN: ${{ secrets.CUSTOM_DOMAIN || vars.CUSTOM_DOMAIN }}'));
  assert.ok(workflow.includes('run: npm run deploy:validate'));
  // Windows 检出可能使用 CRLF，部署命令契约不应依赖本地换行格式。
  assert.match(workflow, /run: npm run deploy\r?\n/);
  assert.equal(workflow.includes('wrangler d1 migrations apply'), false);
});

test('Force Update selects a marked official commit and deploys the same SHA directly', async () => {
  const deploy = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const update = await readFile(new URL('../.github/workflows/force-update.yml', import.meta.url), 'utf8');

  assert.ok(deploy.includes('workflow_call:'));
  assert.ok(deploy.includes('deployment_ref:'));
  assert.ok(deploy.includes("ref: ${{ inputs.deployment_ref || github.sha }}"));

  assert.ok(update.includes('OFFICIAL_REPOSITORY: aozorae/EdgeSSH'));
  assert.ok(update.includes('fetch-depth: 0'));
  assert.ok(update.includes("trailers:key=EdgeSSH-Auto-Update,valueonly,unfold"));
  assert.ok(update.includes('--not "${current_sha}"'));
  assert.ok(update.includes('--force-with-lease="refs/heads/main:${current_sha}"'));
  assert.ok(update.includes('uses: ./.github/workflows/deploy.yml'));
  assert.ok(update.includes('deployment_ref: ${{ needs.update.outputs.target_sha }}'));
  assert.equal(update.includes('npm run deploy'), false);
});
