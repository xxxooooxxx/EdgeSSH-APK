import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyHTTP, rewriteLocalURL } from '../src/forwarding/http.ts';

class FakeChannel {
  writes: Uint8Array[] = [];
  closed = 0;
  aborted = 0;
  constructor(bytes: Uint8Array) {
    this.readable = new ReadableStream<Uint8Array>({ start: c => { c.enqueue(bytes); c.close(); } });
  }
  readable: ReadableStream<Uint8Array>;
  async write(value: Uint8Array) { this.writes.push(value.slice()); }
  async close() { this.closed++; }
  abort() { this.aborted++; }
}
const bytes = (s: string) => new TextEncoder().encode(s);
const text = async (r: Response) => new TextDecoder().decode(await r.arrayBuffer());
const run = async (wire: string, init: RequestInit = {}, path = '/x') => {
  const channel = new FakeChannel(bytes(wire));
  const request = new Request('https://p.test', { ...init, headers: { ...(init.headers ?? {}), 'x-preview-path': path } });
  const response = await proxyHTTP(channel as never, request, 2222, 'https://p.test');
  return { channel, response };
};

test('proxyHTTP reads content-length and EOF bodies', async () => {
  for (const wire of ['HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello', 'HTTP/1.1 200 OK\r\n\r\nhello']) {
    const { channel, response } = await run(wire);
    assert.equal(await text(response), 'hello'); assert.equal(channel.closed, 1);
  }
});

test('proxyHTTP parses byte-split chunk framing and trailers', async () => {
  const { response } = await run('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n2\r\nbc\r\n0\r\nX-End: yes\r\n\r\n');
  assert.equal(await text(response), 'abc');
});

test('POST preserves exact form body and authorization upstream', async () => {
  const { channel } = await run('HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n', { method: 'POST', body: 'a=1&b=two', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/x-www-form-urlencoded' } });
  const sent = channel.writes.map(value => new TextDecoder().decode(value)).join('');
  assert.match(sent, /authorization: Bearer x/i); assert.ok(sent.includes('a=1&b=two'));
});

test('ambiguous framing and truncated bodies fail and close', async () => {
  await assert.rejects(() => run('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\na'));
  const c = new FakeChannel(bytes('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nno'));
  const response = await proxyHTTP(c as never, new Request('https://p.test', { headers: { 'x-preview-path': '/' } }), 2222, 'https://p.test');
  await assert.rejects(() => response.arrayBuffer());
  assert.equal(c.closed, 1);
});

test('HEAD and 204 responses have no body and cancellation closes channel', async () => {
  const head = await run('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody', { method: 'HEAD' });
  assert.equal(await head.response.text(), ''); assert.equal(head.channel.closed, 1);
  const empty = await run('HTTP/1.1 204 No Content\r\n\r\n'); assert.equal(await empty.response.text(), '');
  const cancel = await run('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello'); await cancel.response.body?.cancel(); assert.equal(cancel.channel.closed, 1);
});

test('URL rewrite preserves relative nested links and fragments', () => {
  assert.equal(rewriteLocalURL('../next#part', 2222, 'https://p.test'), '../next#part');
  assert.equal(rewriteLocalURL('#part', 2222, 'https://p.test'), '#part');
});
