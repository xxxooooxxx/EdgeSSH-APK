import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encryptHost, decryptHost, base64 } from '../src/accounts/crypto.ts';

const key = base64(crypto.getRandomValues(new Uint8Array(32)));

test('host credentials round trip, ciphertext never contains plaintext', async () => {
  const input = { password: 'private-password-秘密', privateKey: 'private-key', host: 'server.example' };
  const encrypted = await encryptHost(input, key, 'owner-a', 'host-a');
  assert.deepEqual(await decryptHost(encrypted, key, 'owner-a', 'host-a'), input);
  assert.equal(encrypted.includes(input.password), false);
  assert.equal(encrypted.includes(input.host), false);
  assert.notEqual(await encryptHost(input, key, 'owner-a', 'host-a'), encrypted);
});

test('ciphertext is bound to both Access identity and host id', async () => {
  const encrypted = await encryptHost({ password: 'secret' }, key, 'owner-a', 'host-a');
  await assert.rejects(decryptHost(encrypted, key, 'owner-b', 'host-a'));
  await assert.rejects(decryptHost(encrypted, key, 'owner-a', 'host-b'));
});

test('wrong keys, malformed secrets and tampered ciphertext fail closed', async () => {
  const encrypted = await encryptHost({ password: 'secret' }, key, 'owner', 'host');
  await assert.rejects(decryptHost(encrypted, base64(crypto.getRandomValues(new Uint8Array(32))), 'owner', 'host'));
  await assert.rejects(encryptHost({}, base64(new Uint8Array(16)), 'owner', 'host'));
  const parts = encrypted.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  await assert.rejects(decryptHost(parts.join('.'), key, 'owner', 'host'));
});
