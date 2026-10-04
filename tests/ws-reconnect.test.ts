import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketReconnectManager } from '../frontend/src/ws-reconnect.ts';

class MockSocket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  close(code: number) {
    this.readyState = WebSocket.CLOSED;
    const event = new Event('close');
    Object.assign(event, { code, reason: 'test' });
    this.dispatchEvent(event);
  }
}

test('deterministic close never schedules a reconnect', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const manager = new WebSocketReconnectManager({ id: 'SSH', nonRetryableCloseCodes: [4001], onConnect: () => { calls++; return new MockSocket() as any; } });
  const socket = new MockSocket();
  manager.attach(socket as any);
  socket.close(4001);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 0);
});

test('a rejected reconnect clears its state and cannot schedule another attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const replacement = new MockSocket();
  const manager = new WebSocketReconnectManager({ id: 'SSH', delays: [1], nonRetryableCloseCodes: [4001], onConnect: () => { calls++; return replacement as any; } });
  const socket = new MockSocket();
  manager.attach(socket as any);
  socket.close(1011);
  t.mock.timers.tick(1);
  await Promise.resolve();
  replacement.close(4001);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1);
  assert.equal((manager as any).reconnecting, false);
  assert.equal((manager as any).timer, null);
});

test('other channels retain their existing retry policy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const manager = new WebSocketReconnectManager({ id: 'SFTP', delays: [1], onConnect: () => { calls++; return new MockSocket() as any; } });
  const socket = new MockSocket();
  manager.attach(socket as any);
  socket.close(4001);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(calls, 1);
  manager.reset();
});
