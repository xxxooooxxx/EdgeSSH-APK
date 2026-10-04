export const TRUSTED_PREFIX = '/_forward/';
export const RUNTIME_PATH = '/__edgessh/runtime.js';

export function trustedBase(session: string): string { return `${TRUSTED_PREFIX}${session}`; }
export function cookiePrefix(base: string): string { return `ef_${base.split('/').pop()}_`; }

/** 路径映射是兼容处理，不是安全沙箱；主站与可信网站仍然完全同源。 */
export function mountURL(value: string, port: number, origin: string, base = ''): string {
  if (base && value.startsWith('/') && !value.startsWith('//')) {
    const parsed = new URL(value, origin);
    const path = parsed.pathname;
    return `${path === base || path.startsWith(`${base}/`) ? path : `${base}${path}`}${parsed.search}${parsed.hash}`;
  }
  if (!/^https?:\/\//i.test(value) && !value.startsWith('//')) return value;
  try {
    const url = new URL(value, `http://127.0.0.1:${port}`);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && Number(url.port || 80) === port;
    if (local || (base && url.origin === origin)) {
      const path = base && (url.pathname === base || url.pathname.startsWith(`${base}/`)) ? url.pathname : `${base}${url.pathname}`;
      return `${origin}${path}${url.search}${url.hash}`;
    }
  } catch { /* 非 URL 属性原样保留 */ }
  return value;
}

export function mountCSS(css: string, port: number, origin: string, base: string): string {
  return css.replace(/(url\(\s*|@import\s+)(["']?)([^"'()\s;]+)\2/gi,
    (_match, start: string, quote: string, value: string) => `${start}${quote}${mountURL(value, port, origin, base)}${quote}`);
}

export function mountSrcset(value: string, port: number, origin: string, base: string): string {
  let result = '';
  let offset = 0;
  // srcset 的 data URL 自带逗号，不能直接 split(',')，否则会破坏内嵌图片。
  while (offset < value.length) {
    const start = offset;
    while (offset < value.length && /[\s,]/.test(value[offset])) offset++;
    result += value.slice(start, offset);
    const urlStart = offset;
    while (offset < value.length && !/\s/.test(value[offset])) offset++;
    const token = value.slice(urlStart, offset);
    const url = token.replace(/,+$/, '');
    result += mountURL(url, port, origin, base) + token.slice(url.length);
    if (url.length !== token.length) continue;
    const descriptorStart = offset;
    while (offset < value.length && value[offset] !== ',') offset++;
    if (offset < value.length) offset++;
    result += value.slice(descriptorStart, offset);
  }
  return result;
}

export function upstreamCookies(value: string, base: string): string {
  const prefix = cookiePrefix(base);
  return value.split(';').map((part) => part.trim()).filter((part) => part.startsWith(prefix) && part.includes('='))
    .map((part) => part.slice(prefix.length)).join('; ');
}

export function mountCookie(value: string, base: string, requestPath = '/'): string | null {
  const parts = value.split(';');
  const equals = parts[0].indexOf('=');
  if (equals < 1) return null;
  const name = parts[0].slice(0, equals).trim();
  const pathname = new URL(requestPath, 'http://localhost').pathname;
  let path = pathname.slice(0, pathname.lastIndexOf('/')) || '/';
  let maxAge: number | undefined;
  let expiresAt: number | undefined;
  const attrs: string[] = [];
  for (const part of parts.slice(1)) {
    const trimmed = part.trim();
    if (/^path=/i.test(trimmed)) path = trimmed.slice(5);
    else if (/^max-age=/i.test(trimmed)) {
      const seconds = Number(trimmed.slice(8));
      if (Number.isFinite(seconds)) maxAge = Math.floor(seconds);
    } else if (/^expires=/i.test(trimmed)) {
      const expires = Date.parse(trimmed.slice(8));
      if (Number.isFinite(expires)) expiresAt = expires;
    } else if (!/^(domain=|secure$)/i.test(trimmed)) attrs.push(trimmed);
  }
  if (!path.startsWith('/')) path = '/';
  // 按 Cookie 语义让 Max-Age 优先于 Expires，再限制残留 Cookie 最长保留一小时。
  const lifetime = Math.max(0, Math.min(3600, maxAge ?? (expiresAt === undefined ? 3600 : Math.floor((expiresAt - Date.now()) / 1000))));
  // 只转发会话自己的 Cookie；不能让目标网站 Set-Cookie 覆盖主站登录 Cookie。
  return `${cookiePrefix(base)}${name}${parts[0].slice(equals)}; ${attrs.concat(`Path=${base}${path}`, 'Secure', `Max-Age=${lifetime}`).join('; ')}`;
}
