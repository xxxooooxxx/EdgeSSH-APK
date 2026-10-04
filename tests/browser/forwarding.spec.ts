import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

const host = {
  id: 'alpha', name: 'Tokyo production', host: '192.0.2.10', port: 22, username: 'root',
  group: '测试主机', authMethod: 'password', initialCommand: '', termType: 'xterm-256color',
  encoding: 'utf-8', fingerprint: `SHA256:${'A'.repeat(43)}`, location: null, system: null,
  hasCredential: true, updatedAt: Date.now(),
};

const sessionId = 'a'.repeat(64);
const trustedURL = `http://127.0.0.1:5173/_forward/${sessionId}/`;
const rule = { id: 'rule-trusted', name: '开发服务', hostId: 'alpha', port: 8080, mode: 'trusted', updatedAt: Date.now() };
const isolatedRule = { ...rule, id: 'rule-isolated', name: '隔离服务', mode: 'isolated' };

async function forwardingFixture(page: Page, previewAvailable = true, noHosts = false) {
  const calls: Array<Record<string, unknown>> = [];
  const sockets: WebSocketRoute[] = [];
  const closed: boolean[] = [];
  let active = false;
  let retainedExpiresAt = 0;
  let rules = [rule, isolatedRule];
  await page.route('**/api/**', async (route) => {
    const requestURL = new URL(route.request().url());
    const path = requestURL.pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    if (path === '/api/hosts') return route.fulfill({ json: { hosts: noHosts ? [] : [host] } });
    if (path === '/api/forward-rules' && route.request().method() === 'GET') return route.fulfill({ json: { rules } });
    if (path === '/api/forward-rules' && route.request().method() === 'POST') {
      const saved = { ...route.request().postDataJSON(), id: 'created-rule', updatedAt: Date.now() };
      rules = [saved, ...rules]; return route.fulfill({ status: 201, json: { rule: saved } });
    }
    if (path.startsWith('/api/forward-rules/')) {
      const id = path.slice('/api/forward-rules/'.length);
      if (route.request().method() === 'DELETE') {
        rules = rules.filter((item) => item.id !== id); return route.fulfill({ json: { ok: true } });
      }
      const saved = { ...route.request().postDataJSON(), id, updatedAt: Date.now() };
      rules = [saved, ...rules.filter((item) => item.id !== id)]; return route.fulfill({ json: { rule: saved } });
    }
    if (path.endsWith('/credentials')) return route.fulfill({ json: { password: 'test-only-password' } });
    if (path === '/api/session') return route.fulfill({ json: { ticket: 'test-ticket', sessionId } });
    if (path === '/api/forwarding' && route.request().method() === 'GET') {
      if (requestURL.searchParams.has('session')) {
        return route.fulfill({ json: active
          ? { active: true, port: 8080, mode: 'trusted', expiresAt: retainedExpiresAt || Date.now() + 480000 }
          : { active: false } });
      }
      return route.fulfill({ json: { previewAvailable } });
    }
    if (path === '/api/forwarding' && route.request().method() === 'POST') {
      calls.push({ type: 'forwarding', body: route.request().postDataJSON() });
      active = true;
      const mode = route.request().postDataJSON().mode;
      return route.fulfill({ json: { url: mode === 'isolated' ? 'https://isolated.example.net/start#xxx' : trustedURL, expiresAt: Date.now() + 3600000 } });
    }
    if (path === '/api/forwarding' && route.request().method() === 'DELETE') {
      active = false; calls.push({ type: 'delete' });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket('**/api/ssh?*', (ws) => {
    sockets.push(ws);
    const index = sockets.length - 1;
    closed[index] = false;
    ws.onClose(() => { closed[index] = true; retainedExpiresAt = Date.now() + 480000; void ws.close(); });
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      calls.push(message);
      if (message.type === 'connect') ws.send(JSON.stringify({ type: 'ready' }));
    });
  });
  await page.goto('/');
  await page.locator('#rail-forward').click();
  return { calls, sockets, closed };
}

async function startForward(page: Page) {
  await page.getByRole('button', { name: '选择规则 开发服务' }).click();
  await page.locator('.forward-page input[name="trusted"]').check();
  await page.locator('.forward-card button[type="submit"]').click();
}

async function chooseForwardMode(page: Page, mode: 'trusted' | 'isolated') {
  await page.locator(`.forward-switch [data-mode="${mode}"]`).click();
}

test('默认标准模式显示风险警告，隔离模式未配置时仍禁用连接', async ({ page }, testInfo) => {
  await forwardingFixture(page, false);
  await expect(page.locator('.forward-switch [data-mode="trusted"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '选择规则 开发服务' }).click();
  await expect(page.locator('[data-trust-warning]')).toBeVisible();
  await expect(page.locator('.forward-card button[type="submit"]')).toBeDisabled();
  await page.evaluate(() => { window.scrollTo(0, 0); document.body.scrollTo(0, 0); });
  await page.screenshot({ path: testInfo.outputPath('trusted-mode.png'), fullPage: true });
  await page.locator('.forward-page input[name="trusted"]').check();
  await expect(page.locator('.forward-card button[type="submit"]')).toBeEnabled();
  await chooseForwardMode(page, 'isolated');
  await page.getByRole('button', { name: '选择规则 隔离服务' }).click();
  await expect(page.locator('[data-preview-setup]')).toBeVisible();
  await expect(page.locator('.forward-card button[type="submit"]')).toBeDisabled();
  await page.evaluate(() => { window.scrollTo(0, 0); document.body.scrollTo(0, 0); });
  await page.screenshot({ path: testInfo.outputPath('isolated-setup.png'), fullPage: true });
  await chooseForwardMode(page, 'trusted');
  await page.getByRole('button', { name: '选择规则 开发服务' }).click();
  await expect(page.locator('.forward-page input[name="trusted"]')).not.toBeChecked();
  await expect(page.locator('.forward-card button[type="submit"]')).toBeDisabled();
});

test('已启用隔离预览无需信任勾选，提交隔离请求并在停止后解锁模式', async ({ page }) => {
  const { calls } = await forwardingFixture(page, true);
  await chooseForwardMode(page, 'isolated');
  await page.getByRole('button', { name: '选择规则 隔离服务' }).click();
  await expect(page.locator('.forward-page input[name="trusted"]')).toBeHidden();
  await expect(page.locator('.forward-card button[type="submit"]')).toBeEnabled();
  await page.locator('.forward-card button[type="submit"]').click();
  await expect.poll(() => calls.find((call) => call.type === 'forwarding')?.body).toEqual({ port: 8080, mode: 'isolated' });
  await expect(page.locator('[data-preview-link]')).toHaveAttribute('href', 'https://isolated.example.net/start#xxx');
  await expect(page.locator('.forward-switch [data-mode="trusted"]')).toBeDisabled();
  await page.locator('[data-stop]').click();
  await expect(page.locator('.forward-switch [data-mode="trusted"]')).toBeEnabled();
});

test('切换转发方式会清空之前的信任确认', async ({ page }) => {
  await forwardingFixture(page, true);
  await page.getByRole('button', { name: '选择规则 开发服务' }).click();
  await page.locator('.forward-page input[name="trusted"]').check();
  await expect(page.locator('.forward-page input[name="trusted"]')).toBeChecked();
  await chooseForwardMode(page, 'isolated');
  await chooseForwardMode(page, 'trusted');
  await expect(page.locator('.forward-page input[name="trusted"]')).not.toBeChecked();
  await page.getByRole('button', { name: '选择规则 开发服务' }).click();
  await expect(page.locator('.forward-card button[type="submit"]')).toBeDisabled();
});

test('新建、编辑、删除云端转发规则，连接使用所选主机与端口', async ({ page }) => {
  const { calls } = await forwardingFixture(page);
  await page.getByRole('button', { name: '＋ 新建规则' }).click();
  const editor = page.locator('.forward-rule-dialog');
  await editor.locator('[name="name"]').fill('测试网站');
  await editor.locator('[name="host"]').selectOption('alpha');
  await editor.locator('[name="port"]').fill('3000');
  await editor.locator('[type="submit"]').click();
  await expect(page.getByRole('button', { name: '选择规则 测试网站' })).toBeVisible();
  await page.getByRole('button', { name: '编辑规则 测试网站' }).click();
  await editor.locator('[name="name"]').fill('内部网站');
  await editor.locator('[type="submit"]').click();
  await expect(page.getByRole('button', { name: '选择规则 内部网站' })).toBeVisible();
  await page.getByRole('button', { name: '选择规则 内部网站' }).click();
  await page.locator('[name="trusted"]').check();
  await page.locator('.forward-card [type="submit"]').click();
  await expect.poll(() => calls.find((call) => call.type === 'forwarding')?.body).toEqual({ port: 3000, mode: 'trusted', trusted: true });
  await page.locator('[data-stop]').click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '删除规则 内部网站' }).click();
  await expect(page.getByRole('button', { name: '选择规则 内部网站' })).toHaveCount(0);
});

test('连接转发发送 forward 协议并提供弹窗拦截回退链接，停止后解锁主机', async ({ page }, testInfo) => {
  const { calls } = await forwardingFixture(page);
  await page.evaluate(() => { window.open = () => null; });
  await startForward(page);
  await expect.poll(() => calls.find((call) => call.type === 'connect')?.mode).toBe('forward');
  await expect.poll(() => calls.find((call) => call.type === 'forwarding')?.body).toEqual({ port: 8080, mode: 'trusted', trusted: true });
  await expect.poll(() => page.locator('a[data-preview-link]').getAttribute('href')).toBe(trustedURL);
  await expect(page.locator('a[data-preview-link]')).toBeVisible();
  await expect(page.locator('a[data-preview-link]')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('a[data-preview-link]')).toHaveAttribute('target', '_blank');
  await page.locator('[data-stop]').click();
  await expect(page.locator('a[data-preview-link]')).toBeHidden();
  await expect(page.getByRole('button', { name: '选择规则 开发服务' })).toBeEnabled();
  await page.evaluate(() => { window.scrollTo(0, 0); document.body.scrollTo(0, 0); });
  await page.screenshot({ path: testInfo.outputPath('forwarding-desktop.png'), fullPage: true });
});

test('离开转发页后保持 8 分钟，返回页面可查看并手动停止', async ({ page }) => {
  const { calls, sockets, closed } = await forwardingFixture(page);
  await startForward(page);
  await expect.poll(() => sockets.length).toBe(1);
  await expect(page.locator('[data-open]')).toBeVisible();
  await page.locator('#rail-overview').click();
  await expect.poll(() => closed[0]).toBe(true);
  await page.locator('#rail-forward').click();
  const retainedStatus = page.locator('[data-status]');
  await expect(retainedStatus).toContainText('正在保持 127.0.0.1:8080');
  await expect(retainedStatus).toHaveClass(/is-retained/);
  await expect(retainedStatus).toHaveCSS('font-weight', '700');
  await expect(retainedStatus).toHaveCSS('border-left-style', 'solid');
  await expect(page.locator('[data-stop]')).toBeEnabled();
  await page.locator('[data-stop]').click();
  await expect(page.locator('[data-stop]')).toBeDisabled();
  await expect.poll(() => calls.some((call) => call.type === 'delete')).toBe(true);
});

test('刷新后可从短期会话句柄恢复正在保持的转发', async ({ page }) => {
  const { sockets } = await forwardingFixture(page);
  await startForward(page);
  await expect.poll(() => sockets.length).toBe(1);
  await expect(page.locator('[data-open]')).toBeVisible();
  await page.reload();
  await page.locator('#rail-forward').click();
  await expect(page.locator('[data-status]')).toContainText('正在保持 127.0.0.1:8080');
  await expect(page.locator('.forward-page [data-selected-target]')).toContainText('127.0.0.1:8080');
  await expect(page.locator('.forward-switch [data-mode="trusted"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-stop]').click();
});

test('空主机禁用连接按钮且桌面与 375px 手机布局没有横向溢出', async ({ page }, testInfo) => {
  await forwardingFixture(page, false, true);
  await expect(page.locator('.forward-page')).toBeVisible();
  await expect(page.locator('.forward-page h1')).toHaveText('端口转发');
  await expect(page.locator('.forward-switch [data-mode="trusted"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '选择规则 开发服务' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { window.scrollTo(0, 0); document.body.scrollTo(0, 0); });
  await page.screenshot({ path: testInfo.outputPath('forwarding-mobile.png'), fullPage: true });
});
