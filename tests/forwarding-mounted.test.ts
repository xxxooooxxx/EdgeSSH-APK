import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mountCookie, mountCSS } from '../src/forwarding/mount.ts';

const root = 'https://preview.example';
const base = '/_forward/64a';

test('mounted proxy rewrites HTML/CSS through real HTMLRewriter and scopes headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'edgessh-mounted-'));
  const entry = join(dir, 'worker.ts');
  const output = join(dir, 'worker.js');
  await writeFile(entry, `
    import { proxyHTTP } from ${JSON.stringify(join(process.cwd(), 'src/forwarding/http.ts'))};
    const encoder = new TextEncoder();
    const html = '<!doctype html><html><head><title>x</title></head><body style="background:url(/bg.png)"><a href="/next">a</a><img src="http://127.0.0.1:8080/i.png"><form action="/go" formaction="/alt"><img srcset="/a.png 1x, data:image/png;base64,AA 2x"></form><style>@import url("/theme.css"); .x{background:url(/x.png)}</style></body></html>';
    class Channel {
      readable = new ReadableStream({ start(c) { c.enqueue(encoder.encode('HTTP/1.1 302 Found\\r\\nContent-Type: text/html\\r\\nContent-Length: '+new TextEncoder().encode(html).length+'\\r\\nSet-Cookie: sid=abc; Path=/; Max-Age=10; Expires=Wed, 21 Oct 2030 07:28:00 GMT\\r\\nSet-Cookie: __Host-edgessh-session=bad; Path=/\\r\\nLocation: ../login\\r\\n\\r\\n'+html)); c.close(); } });
      async write() {} async close() {} abort() {}
    }
    export default { async fetch(request) { return proxyHTTP(new Channel(), request, 8080, '${root}', '${base}'); } };
  `);
  let mf: Miniflare | undefined;
  try {
    await build({ entryPoints: [entry], outfile: output, bundle: true, format: 'esm', platform: 'neutral', sourcemap: false });
    const bundleJS = await (await import('node:fs/promises')).readFile(output, 'utf8');
    mf = new Miniflare({ workers: [{ config: {
      type: 'worker',
      name: 'test',
      compatibilityDate: '2026-07-01',
      manifest: {
        mainModule: 'worker.js',
        modulesRoot: dir,
        modules: { 'worker.js': { type: 'esm', contents: bundleJS } },
      },
    } }] });
    const response = await mf.dispatchFetch(`${root}${base}/dir/page`, {
      redirect: 'manual',
      headers: { 'x-preview-path': '/dir/page' },
    });
    const text = await response.text();
    assert.equal(response.status, 302);
    assert.match(text, /href="\/_forward\/64a\/next"/);
    assert.match(text, /src="https:\/\/preview\.example\/_forward\/64a\/i\.png"/);
    assert.match(text, /action="\/_forward\/64a\/go"/);
    assert.match(text, /formaction="\/_forward\/64a\/alt"/);
    assert.match(text, /srcset="\/_forward\/64a\/a\.png 1x, data:image\/png;base64,AA 2x"/);
    assert.match(text, /style="background:url\(\/_forward\/64a\/bg\.png\)"/);
    assert.equal((text.match(/__edgessh\/runtime\.js/g) ?? []).length, 1);
    assert.equal(response.headers.get('location'), `${root}${base}/login`);
    assert.deepEqual(response.headers.getSetCookie(), [`ef_64a_sid=abc; Path=${base}/; Secure; Max-Age=10`]);
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('mounted CSS and cookie helpers preserve URL semantics', () => {
  assert.equal(mountCSS('@import "/a.css";x{background:url(https://x.test/a)}', 8080, root, base), `@import "${base}/a.css";x{background:url(https://x.test/a)}`);
  assert.match(mountCookie('sid=x; Expires=Wed, 21 Oct 2030 07:28:00 GMT', base, '/dir/page')!, new RegExp(`Path=${base}/dir;`));
  assert.match(mountCookie('sid=x; Max-Age=10; Expires=Wed, 21 Oct 2030 07:28:00 GMT', base)!, /Max-Age=10/);
});
