import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateHost } from '../src/accounts/location.ts';

function jsonResponse(url: string, value: unknown, status = 200, contentType = 'application/json'): Response {
  const response = new Response(JSON.stringify(value), { status, headers: { 'Content-Type': contentType } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

test('location lookup falls back when ipwho is rate limited and one DNS family fails', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const attempts: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    const target = new URL(url);
    if (target.hostname === 'cloudflare-dns.com' && target.searchParams.get('type') === 'A') {
      return jsonResponse(url, { Status: 0, Answer: [{ type: 1, data: '8.8.8.8' }] }, 200, 'application/dns-json');
    }
    if (target.hostname === 'cloudflare-dns.com' && target.searchParams.get('type') === 'AAAA') return new Response(null, { status: 503 });
    attempts.push(url);
    if (target.hostname === 'ipwho.is') return jsonResponse(url, { success: false, message: 'Rate limit exceeded' }, 429);
    return jsonResponse(url, {
      city: 'Mountain View', region: 'California', country: 'United States', country_code: 'us', latitude: '37.386', longitude: '-122.0838',
    });
  };

  assert.deepEqual(await locateHost('example.com'), {
    ip: '8.8.8.8', city: 'Mountain View', region: 'California', country: 'United States',
    countryCode: 'US', latitude: 37.386, longitude: -122.0838,
  });
  assert.equal(attempts.length, 2);
});

test('private targets never reach the location service', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('unexpected request'); };

  assert.equal(await locateHost('127.0.0.1'), null);
  assert.equal(called, false);
});
