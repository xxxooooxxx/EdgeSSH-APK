import test from 'node:test';
import assert from 'node:assert/strict';
import { previewHeaders, rewriteLocalURL, stripHopHeaders, upstreamHeaders } from '../src/forwarding/http.ts';

test('forwarding strips hop-by-hop and internal request headers', () => {
  const request = new Request('https://preview.example/app', { headers: {
    Connection: 'keep-alive, X-Custom-Hop', 'X-Custom-Hop': 'drop',
    Cookie: 'a=1; __Host-edgessh-preview=secret; b=2', 'X-Preview-Path': '/app',
    Origin: 'https://preview.example', Referer: 'https://preview.example/app',
  }});
  const headers = upstreamHeaders(request, 2222, 'https://preview.example');
  assert.equal(headers.has('connection'), true);
  assert.equal(headers.get('host'), '127.0.0.1:2222');
  assert.equal(headers.get('cookie'), 'a=1; b=2');
  assert.equal(headers.has('x-preview-path'), false);
  assert.equal(headers.get('origin'), 'http://127.0.0.1:2222');
}
);

test('preview response preserves safe cookies and rewrites location', () => {
  const source = new Headers();
  source.append('Set-Cookie', 'sid=abc; Domain=internal.test; Secure; Path=/');
  source.append('Set-Cookie', '__Host-edgessh-preview=bad; Path=/');
  source.set('Location', 'http://127.0.0.1:2222/login');
  source.set('Content-Length', '10');
  const result = previewHeaders(source, 2222, 'https://preview.example');
  assert.equal(result.get('location'), 'https://preview.example/login');
  assert.equal(result.get('content-length'), null);
  assert.deepEqual(result.getSetCookie(), ['sid=abc; Path=/; Secure']);
}
);

test('URL rewriting leaves foreign origins unchanged', () => {
  assert.equal(rewriteLocalURL('http://127.0.0.1:2222/a?x=1', 2222, 'https://p.test'), 'https://p.test/a?x=1');
  assert.equal(rewriteLocalURL('http://127.0.0.1:9999/a', 2222, 'https://p.test'), 'http://127.0.0.1:9999/a');
});

test('stripHopHeaders removes declared connection tokens', () => {
  const headers = new Headers({ Connection: 'X-Trace', 'X-Trace': 'drop', Upgrade: 'h2c', KeepAlive: 'x' });
  stripHopHeaders(headers);
  assert.equal(headers.has('x-trace'), false);
  assert.equal(headers.has('upgrade'), false);
  assert.equal(headers.has('keepalive'), true);
});

test('trusted cookies are namespaced and never forward host login cookies', () => {
  const request = new Request('https://main.test/_forward/abc/', { headers: {
    Cookie: 'ef_abc_sid=ok; __Host-edgessh-session=main; CF_Authorization=access; ef_other_no=bad',
  }});
  const headers = upstreamHeaders(request, 8080, 'https://main.test', '/_forward/abc');
  assert.equal(headers.get('cookie'), 'sid=ok');
  const result = previewHeaders(new Headers([
    ['Set-Cookie', 'sid=abc; Path=/; Domain=internal.test'],
    ['Set-Cookie', '__Host-edgessh-session=bad; Path=/'],
  ]), 8080, 'https://main.test', '/_forward/abc');
  assert.deepEqual(result.getSetCookie(), ['ef_abc_sid=abc; Path=/_forward/abc/; Secure; Max-Age=3600']);
});
