import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// 与 Worker 构建一样解析扩展名省略的导入，在内存中测试真实会话代码。
const result = await build({
  stdin: {
    contents: "export * from './src/backend/session.ts'; export { SSHPacketBuilder } from './src/ssh/packet.ts';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false,
});
const { SSHSession, SSHAuthDefectError, SSHPacketBuilder } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

function fixture(authMethod = 'password', mode?: string) {
  const messages: any[] = [];
  const closes: number[] = [];
  let tcpClosed = false;
  const ws = { readyState: WebSocket.OPEN, send: (raw: string) => messages.push(JSON.parse(raw)), close: (code: number) => closes.push(code) };
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const socket = {
    readable: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
    close() { tcpClosed = true; },
  };
  const config = { host: '192.0.2.10', port: 22, username: 'root', authMethod, password: 'test-only', privateKey: 'test-only', mode };
  const session = new SSHSession(ws, socket, config);
  session.phase = 'auth';
  session.authRequestSent = true;
  return { session, config, messages, closes, push: (data: Uint8Array) => controller!.enqueue(data), tcpClosed: () => tcpClosed };
}

function authFailure(methods: string) {
  const value = new TextEncoder().encode(methods);
  const payload = new Uint8Array(value.length + 6);
  payload[0] = 51;
  new DataView(payload.buffer).setUint32(1, value.length);
  payload.set(value, 5);
  return payload;
}

for (const authMethod of ['password', 'publickey']) {
  for (const mode of [undefined, 'forward']) {
    test(`async ${authMethod} rejection stops retries in ${mode ?? 'terminal'} mode`, async () => {
      const f = fixture(authMethod, mode);
      f.push(await SSHPacketBuilder.build(authFailure('publickey,password'), 8, null, 0));
      await f.session.readLoop();
      assert.deepEqual(f.closes, [4001]);
      assert.equal(f.messages.at(-1).retryable, false);
      assert.equal(f.messages.at(-1).message, 'SSH authentication failed');
      assert.equal(f.tcpClosed(), true);
      assert.equal(f.config.password, undefined);
      assert.equal(f.config.privateKey, undefined);
    });
  }
}

test('password authentication still falls back to keyboard-interactive before stopping', async () => {
  const f = fixture();
  const sent: Uint8Array[] = [];
  f.session.sendEncrypted = async (payload: Uint8Array) => { sent.push(payload); };
  await f.session.handleAuth(51, authFailure('keyboard-interactive'));
  assert.equal(f.session.passwordAuthMethod, 'keyboard-interactive');
  assert.equal(sent.length, 1);
  assert.equal(f.config.password, 'test-only');
  await assert.rejects(f.session.handleAuth(51, authFailure('keyboard-interactive')), SSHAuthDefectError);
});

test('host trust failures stop retries but transport failures keep their existing policy', () => {
  for (const message of ['Host key was not accepted', 'SSH host key signature verification failed']) {
    const f = fixture();
    f.session.fail(new SSHAuthDefectError(message), 'read_error');
    assert.equal(f.messages[0].retryable, false);
    assert.deepEqual(f.closes, [4001]);
  }
  const f = fixture();
  f.session.fail(new Error('Transport interrupted'), 'read_error');
  assert.equal(f.messages[0].retryable, undefined);
  assert.deepEqual(f.closes, [1011]);
});
