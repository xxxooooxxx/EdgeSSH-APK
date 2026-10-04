import { test, expect } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import { connectFiles, fileFixture } from './file-fixture';

for (const signal of ['error-message', 'close-code', 'reconnect-close-code']) {
  test(`SSH deterministic failure stops automatic reconnect: ${signal}`, async ({ page }) => {
    await fileFixture(page);
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket('**/api/ssh?*', (ws) => {
      sockets.push(ws);
      ws.onMessage((raw) => {
        if (typeof raw !== 'string' || JSON.parse(raw).type !== 'connect') return;
        ws.send(JSON.stringify({ type: 'ready' }));
      });
    });
    await connectFiles(page);
    await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
    if (signal === 'reconnect-close-code') {
      sockets[0].close({ code: 1011, reason: 'Transport interrupted' });
      await expect.poll(() => sockets.length).toBe(2);
      await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
    }
    const active = sockets.at(-1)!;
    if (signal === 'error-message') {
      active.send(JSON.stringify({ type: 'error', message: 'SSH authentication failed', retryable: false }));
    } else {
      active.close({ code: 4001, reason: 'SSH session failed' });
    }
    await expect(page.locator('#files-connect')).toBeEnabled();
    await expect(page.locator('#files-connection-state')).not.toHaveText('SSH 已连接');
    const count = sockets.length;
    // 首次自动重连延迟为 1 秒，跨过该期限核验不再使用失败凭据。
    await page.waitForTimeout(1400);
    expect(sockets.length).toBe(count);
    await page.locator('#files-connect').click();
    await expect.poll(() => sockets.length).toBe(count + 1);
    await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
  });
}
