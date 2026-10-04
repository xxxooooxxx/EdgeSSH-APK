import { test, expect } from '@playwright/test';
import { pathRuntime } from '../../src/forwarding/runtime.ts';

test('pathRuntime rewrites localhost fetch/XHR and isolates prefixed cookies', async ({ page }) => {
  await page.route('**/_forward/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' });
  });
  await page.goto('/_forward/' + 'a'.repeat(64) + '/foo/');
  await page.context().addCookies([
    { name: 'main', value: 'hidden', url: 'http://127.0.0.1:5173/' },
    { name: 'ef_' + 'a'.repeat(64) + '_target', value: 'visible', url: 'http://127.0.0.1:5173/' },
  ]);
  const requests: string[] = [];
  await page.route('**/*', async (route) => {
    requests.push(new URL(route.request().url()).pathname + new URL(route.request().url()).search);
    await route.fulfill({ status: 200, body: '{}' });
  });
  await page.addScriptTag({ content: pathRuntime('/_forward/' + 'a'.repeat(64), 8080) });
  const result = await page.evaluate(async () => {
    await fetch('http://127.0.0.1:8080/api/data');
    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.addEventListener('loadend', () => resolve());
      xhr.open('GET', 'http://127.0.0.1:8080/api/xhr');
      xhr.send();
    });
    return document.cookie;
  });
  await expect.poll(() => requests).toEqual(expect.arrayContaining([
    '/_forward/' + 'a'.repeat(64) + '/api/data',
    '/_forward/' + 'a'.repeat(64) + '/api/xhr',
  ]));
  expect(result).toContain('target=visible');
  expect(result).not.toContain('main=hidden');
});
