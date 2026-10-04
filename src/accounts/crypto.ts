const encoder = new TextEncoder();

export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export async function digest(value: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const key = unbase64(secret);
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as base64');
  return crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptHost(value: unknown, secret: string, accountId: string, hostId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(`edgessh:v1:${accountId}:${hostId}`),
  }, await encryptionKey(secret), encoder.encode(JSON.stringify(value)));
  // AAD 绑定账户与记录，防止数据库中的密文被挪到另一个账户或主机。
  const bytes = new Uint8Array(ciphertext);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `v1.${base64(iv)}.${btoa(binary)}`;
}

export async function decryptHost<T>(value: string, secret: string, accountId: string, hostId: string): Promise<T> {
  const [version, iv, ciphertext] = value.split('.');
  if (version !== 'v1') throw new Error('Unsupported ciphertext version');
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: unbase64(iv), additionalData: encoder.encode(`edgessh:v1:${accountId}:${hostId}`),
  }, await encryptionKey(secret), unbase64(ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
