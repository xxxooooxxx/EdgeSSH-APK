import assert from 'node:assert/strict';
import test from 'node:test';
import { ForwardingState } from '../src/forwarding/state.ts';
import { parseCapability, previewOrigin } from '../src/forwarding/security.ts';

const origin = 'https://preview.other.test';
const sessionId = 'a'.repeat(64);

function fakeSession(initialReady = true) {
  let ready = initialReady;
  return {
    isForwardReady: () => ready,
    openForward: async () => ({ close: async () => undefined }),
    close: () => { ready = false; },
  };
}

async function prepared() {
  const session = fakeSession();
  const state = new ForwardingState();
  const response = await state.create(session as never, 8080, origin, sessionId);
  const url = (await response.json() as { url: string }).url;
  const capability = parseCapability(new URL(url).hash.slice(1));
  assert.ok(capability);
  return { state, session, launchToken: capability.token };
}

test('trusted grants use the main origin path and do not accept isolated preview tokens', async () => {
  const session = fakeSession();
  const state = new ForwardingState();
  const response = await state.create(session as never, 8080, 'https://main.test', sessionId, 'trusted');
  const body = await response.json() as { url: string };
  assert.equal(body.url, `https://main.test/_forward/${sessionId}/`);
  assert.equal((await state.preview(new Request('https://internal/preview'))).status, 410);
  state.clear();
});

test('launch token is single-use and returns preview token', async () => {
  const { state, session, launchToken } = await prepared();
  try {
    const request = () => new Request('https://internal/preview-launch', {
      method: 'POST', headers: { 'x-preview-origin': origin, 'x-preview-token': launchToken },
    });
    const first = await state.preview(request());
    assert.equal(first.status, 200);
    const body = await first.json() as { token: string };
    assert.match(body.token, /^[a-f0-9-]{36}$/);
    assert.equal((await state.preview(request())).status, 401);
  } finally { state.clear(); }
  assert.equal(session.isForwardReady(), true);
});

test('cleared grant rejects the launch token with 410', async () => {
  const { state, launchToken } = await prepared();
  try {
    state.clear();
    const response = await state.preview(new Request('https://internal/preview-launch', {
      method: 'POST', headers: { 'x-preview-origin': origin, 'x-preview-token': launchToken },
    }));
    assert.equal(response.status, 410);
  } finally { state.clear(); }
});

test('invalid preview token returns 401', async () => {
  const { state } = await prepared();
  try {
    const response = await state.preview(new Request('https://internal/preview', {
      headers: { 'x-preview-origin': origin, 'x-preview-token': 'bad' },
    }));
    assert.equal(response.status, 401);
  } finally { state.clear(); }
});

test('cross-site and missing-origin writes are rejected with 403', async () => {
  const { state, launchToken } = await prepared();
  try {
    const launch = await state.preview(new Request('https://internal/preview-launch', {
      method: 'POST', headers: { 'x-preview-origin': origin, 'x-preview-token': launchToken },
    }));
    const token = (await launch.json() as { token: string }).token;
    const crossSite = await state.preview(new Request('https://internal/preview', {
      method: 'POST', headers: { 'x-preview-origin': origin, 'x-preview-token': token, Origin: 'https://evil.test' },
    }));
    assert.equal(crossSite.status, 403);
    const missingOrigin = await state.preview(new Request('https://internal/preview', {
      method: 'POST', headers: { 'x-preview-origin': origin, 'x-preview-token': token },
    }));
    assert.equal(missingOrigin.status, 403);
  } finally { state.clear(); }
});

test('unready SSH session returns 410', async () => {
  const { state, session, launchToken } = await prepared();
  try {
    session.close();
    const response = await state.preview(new Request('https://internal/preview-launch', {
      method: 'POST', headers: { 'x-preview-origin': origin, 'x-preview-token': launchToken },
    }));
    assert.equal(response.status, 410);
  } finally { state.clear(); }
});

test('stop closes the SSH session', async () => {
  const { state, session } = await prepared();
  state.stop();
  assert.equal(session.isForwardReady(), false);
  state.clear();
});

test('previewOrigin rejects missing, same-parent, and same-account workers.dev domains', () => {
  assert.throws(() => previewOrigin(undefined, 'https://ssh.example.com'));
  assert.throws(() => previewOrigin('https://preview.ssh.example.com', 'https://ssh.example.com'));
  assert.throws(() => previewOrigin('https://preview.account.workers.dev', 'https://ssh.account.workers.dev'));
});

test('previewOrigin allows independent custom and workers.dev domains', () => {
  assert.equal(previewOrigin('preview.other.test', 'https://ssh.example.com'), origin);
  assert.equal(previewOrigin('https://preview.account.workers.dev', 'https://ssh.example.com'),
    'https://preview.account.workers.dev');
});
