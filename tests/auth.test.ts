import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessToken } from '../src/accounts/access-token.ts';
import { hasValidWebSocketOrigin } from '../src/http-security.ts';

test('Access JWT can fall back to the browser authorization cookie', async () => {
  const request = new Request('https://edgessh.example.workers.dev/api/auth/me', {
    headers: { Cookie: 'unrelated=value; CF_Authorization=not-a-jwt; another=value' },
  });
  assert.equal(accessToken(request), 'not-a-jwt');
});

test('missing Access header and cookie is reported as unauthenticated', async () => {
  const request = new Request('https://edgessh.example.workers.dev/api/auth/me');
  assert.equal(accessToken(request), null);
});

test('Access assertion header takes precedence over the browser cookie', async () => {
  const request = new Request('https://edgessh.example.workers.dev/api/auth/me', {
    headers: {
      'Cf-Access-Jwt-Assertion': 'header-token',
      Cookie: 'CF_Authorization=cookie-token',
    },
  });
  assert.equal(accessToken(request), 'header-token');
});

test('WebSocket upgrades require an explicit same-origin browser header', () => {
  const url = 'https://ssh.example.com/api/ssh';
  assert.equal(hasValidWebSocketOrigin(new Request(url)), false);
  assert.equal(hasValidWebSocketOrigin(new Request(url, { headers: { Origin: 'https://other.example.com' } })), false);
  assert.equal(hasValidWebSocketOrigin(new Request(url, { headers: { Origin: 'https://ssh.example.com' } })), true);
});
