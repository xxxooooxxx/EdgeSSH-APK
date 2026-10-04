import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_SNIPPETS, type Snippet } from '../../src/accounts/snippet-data';
import { connectFiles, fileFixture } from './file-fixture';

async function fixture(page: Page) {
  const files = await fileFixture(page);
  let items: Snippet[] = DEFAULT_SNIPPETS.map((item) => ({ ...item, id: crypto.randomUUID(), updatedAt: Date.now() }));
  await page.route('**/api/snippets**', async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split('/')[3];
    if (request.method() === 'GET') return route.fulfill({ json: { snippets: items } });
    if (request.method() === 'DELETE') {
      items = items.filter((item) => item.id !== id);
      return route.fulfill({ json: { ok: true } });
    }
    const snippet = { ...request.postDataJSON(), id: id ?? crypto.randomUUID(), updatedAt: Date.now() };
    items = [snippet, ...items.filter((item) => item.id !== id)];
    return route.fulfill({ json: { snippet } });
  });
  return files;
}

test('主页片段库支持十条默认命令、搜索、新建、多行编辑、删除及刷新持久化', async ({ page }, testInfo) => {
  await fixture(page);
  await page.locator('#rail-snippets').click();
  const library = page.locator('#snippets-page');
  await expect(library.locator('.snippet-card')).toHaveCount(10);
  await expect(page.locator('#rail-snippets')).toHaveAttribute('aria-current', 'page');
  await library.getByRole('searchbox').fill('磁盘');
  await expect(library.locator('.snippet-card')).toHaveCount(1);
  await library.getByRole('searchbox').fill('');
  await library.getByRole('button', { name: '＋ 新建片段' }).click();
  const dialog = page.getByRole('dialog', { name: '新建代码片段' });
  await dialog.getByLabel('名称').fill('部署检查 <script>');
  await dialog.getByLabel('命令', { exact: true }).fill('echo first\npwd');
  await dialog.getByRole('button', { name: '保存片段' }).click();
  await expect(library.locator('.snippet-card')).toHaveCount(11);
  await library.getByRole('button', { name: '编辑 部署检查 <script>', exact: true }).click();
  await page.getByRole('dialog').getByLabel('命令', { exact: true }).fill('echo second\nls -lah');
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await page.reload();
  await page.locator('#rail-snippets').click();
  await expect(library.locator('.snippet-card').filter({ hasText: '部署检查 <script>' }).locator('pre')).toHaveText('echo second\nls -lah');
  page.once('dialog', (dialog) => dialog.accept());
  await library.getByRole('button', { name: '删除 查看当前目录', exact: true }).click();
  await expect(library.locator('.snippet-card')).toHaveCount(10);
  await library.getByRole('button', { name: '刷新代码片段' }).click();
  await expect(library.getByRole('heading', { name: '查看当前目录', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('snippet-library.png'), fullPage: true });
});

test('终端浮窗折叠、拖动与键盘复位；填入草稿而不执行，编辑与管理页同步', async ({ page }, testInfo) => {
  const files = await fixture(page);
  await connectFiles(page);
  await page.locator('#files-terminal').click();
  const panel = page.locator('#snippet-panel');
  const expand = panel.getByRole('button', { name: '展开代码片段' });
  if (await expand.count()) await expand.click();
  await expect(panel.locator('.snippet-card')).toHaveCount(10);
  await panel.getByRole('button', { name: '使用 查看磁盘空间', exact: true }).click();
  await expect(page.locator('#command-editor-input')).toHaveValue('df -h');
  expect(files.calls.filter((call) => call.type === 'input')).toHaveLength(0);
  await page.locator('#command-editor-send').click();
  await expect.poll(() => files.calls.filter((call) => call.type === 'input').at(-1)?.data).toBe('df -h\r');
  if (await panel.getByRole('button', { name: '收起代码片段' }).count()) await panel.getByRole('button', { name: '收起代码片段' }).click();
  await expect(page.locator('#snippet-panel-body')).toBeHidden();
  const handle = panel.getByRole('button', { name: '移动代码片段窗口' });
  const before = (await panel.boundingBox())!;
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  const after = (await panel.boundingBox())!;
  expect(after.x).toBeLessThan(before.x);
  await page.keyboard.press('Home');
  if (testInfo.project.name === 'desktop') {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x - 100, box.y + 60, { steps: 8 });
    await page.mouse.up();
    expect((await panel.boundingBox())!.x).toBeLessThan(before.x);
  }
  await panel.getByRole('button', { name: '展开代码片段' }).click();
  await panel.getByRole('button', { name: '编辑 查看磁盘空间', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称').fill('磁盘概况');
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await panel.getByRole('button', { name: '管理代码片段', exact: true }).click();
  await expect(page.locator('#snippets-page').getByRole('heading', { name: '磁盘概况', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开 SSH 终端 ↗', exact: true }).click();
  expect(files.calls.filter((call) => call.type === 'connect')).toHaveLength(1);
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('snippet-terminal.png'), fullPage: true });
});

test('加载与保存错误可重试，不丢失草稿；空列表不补回默认命令', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/snippets', (route) => route.fulfill({ status: 500, json: { error: '片段服务暂时不可用' } }));
  await page.locator('#rail-snippets').click();
  const library = page.locator('#snippets-page');
  await expect(library.getByRole('status')).toContainText('片段服务暂时不可用');
  await page.unroute('**/api/snippets');
  await library.getByRole('button', { name: '刷新代码片段' }).click();
  await expect(library.locator('.snippet-card')).toHaveCount(10);
  await library.getByRole('button', { name: '＋ 新建片段' }).click();
  await page.getByRole('dialog').getByLabel('名称').fill('保留草稿');
  await page.getByRole('dialog').getByLabel('命令', { exact: true }).fill('echo safe');
  await page.route('**/api/snippets', (route) => route.fulfill({ status: 500, json: { error: '保存失败，请重试。' } }));
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('保存失败');
  await expect(page.getByRole('dialog').getByLabel('命令', { exact: true })).toHaveValue('echo safe');
  await page.unroute('**/api/snippets');
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.route('**/api/snippets', (route) => route.fulfill({ json: { snippets: [] } }));
  await library.getByRole('button', { name: '刷新代码片段' }).click();
  await expect(library.locator('.snippet-empty')).toContainText('把常用命令留在手边');
  await library.getByRole('button', { name: '刷新代码片段' }).click();
  await expect(library.locator('.snippet-card')).toHaveCount(0);
});

test('多行片段保留换行且不直接发送；取消覆盖保留旧草稿，登出清空片段', async ({ page }) => {
  const files = await fixture(page);
  await page.locator('#rail-snippets').click();
  await page.locator('#snippets-page').getByRole('button', { name: '＋ 新建片段' }).click();
  await page.getByRole('dialog').getByLabel('名称').fill('多行脚本');
  await page.getByRole('dialog').getByLabel('命令', { exact: true }).fill('echo a\n# 注释\necho b');
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await page.getByRole('button', { name: '打开 SSH 终端 ↗', exact: true }).click();
  const panel = page.locator('#snippet-panel');
  if (await panel.getByRole('button', { name: '展开代码片段' }).count()) await panel.getByRole('button', { name: '展开代码片段' }).click();
  await panel.getByRole('button', { name: '使用 多行脚本', exact: true }).click();
  await expect(page.locator('#command-editor-input')).toHaveValue('echo a\n# 注释\necho b');
  if (await panel.getByRole('button', { name: '展开代码片段' }).count()) await panel.getByRole('button', { name: '展开代码片段' }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await panel.getByRole('button', { name: '使用 查看当前目录', exact: true }).click();
  await expect(page.locator('#command-editor-input')).toHaveValue('echo a\n# 注释\necho b');
  expect(files.calls.filter((call) => call.type === 'input')).toHaveLength(0);
  await page.evaluate(() => window.dispatchEvent(new Event('auth-required')));
  await expect(page.locator('#snippet-panel .snippet-card')).toHaveCount(0);
  await expect(page.locator('#snippets-page .snippet-card')).toHaveCount(0);
});

test('浮窗在调整尺寸后仍可触达，并适配浅色及减少动态效果', async ({ page }, testInfo) => {
  await fixture(page);
  await connectFiles(page);
  await page.locator('#files-terminal').click();
  const panel = page.locator('#snippet-panel');
  const initiallyCollapsed = testInfo.project.name === 'mobile';
  if (initiallyCollapsed) await expect(panel.locator('#snippet-panel-body')).toBeHidden();
  else await expect(panel.locator('#snippet-panel-body')).toBeVisible();
  if (initiallyCollapsed) await panel.getByRole('button', { name: '展开代码片段' }).click();
  await panel.getByRole('button', { name: '移动代码片段窗口' }).focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
  await page.setViewportSize({ width: 667, height: 375 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const stage = (await page.locator('#terminal-card').boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(stage.x);
  expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(stage.y);
  expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
  await panel.getByRole('button', { name: '收起代码片段' }).click();
  await expect(panel.locator('#snippet-panel-body')).toBeHidden();
  expect((await panel.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath('snippet-landscape-light.png'), fullPage: true });
});
