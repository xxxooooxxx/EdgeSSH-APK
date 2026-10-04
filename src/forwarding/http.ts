import type { ForwardChannel } from './channel.ts';
import { PREVIEW_COOKIE, PREVIEW_PREFIX } from './security.ts';
import { mountURL, mountCookie, mountCSS, mountSrcset, upstreamCookies, RUNTIME_PATH } from './mount.ts';
import { readBoundedText } from './body.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('latin1');
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

export function stripHopHeaders(headers: Headers): void {
  for (const name of (headers.get('Connection') ?? '').split(',')) if (name.trim()) headers.delete(name.trim());
  for (const name of HOP_HEADERS) headers.delete(name);
}

function isInternalCookie(name: string): boolean {
  return name.toLowerCase() === PREVIEW_COOKIE.toLowerCase() || /^cf_authorization$/i.test(name)
    || /^__host-edgessh-session$/i.test(name);
}

export function upstreamHeaders(request: Request, port: number, origin: string, base = ''): Headers {
  const headers = new Headers(request.headers);
  stripHopHeaders(headers);
  const headerNames: string[] = [];
  headers.forEach((_value, name) => headerNames.push(name));
  for (const name of headerNames) {
    if (/^(cf-|x-preview-|x-forwarded-|sec-fetch-)/i.test(name)
      || ['x-account-id', 'forwarded', 'x-real-ip', 'expect'].includes(name)) headers.delete(name);
  }
  headers.set('Host', `127.0.0.1:${port}`);
  headers.set('Connection', 'close');
  // 不压缩便于 HTML 属性中的绝对 localhost 地址重写；二进制响应仍保持原始字节。
  headers.set('Accept-Encoding', 'identity');
  const cookies = base ? upstreamCookies(headers.get('Cookie') ?? '', base) : (headers.get('Cookie') ?? '').split(';').filter((part) => {
    const index = part.indexOf('=');
    return index > 0 && !isInternalCookie(part.slice(0, index).trim());
  }).join(';').trim();
  if (cookies) headers.set('Cookie', cookies); else headers.delete('Cookie');
  if (headers.get('Origin') === origin) headers.set('Origin', `http://127.0.0.1:${port}`);
  const referer = headers.get('Referer');
  if (referer?.startsWith(`${origin}${base}/`)) headers.set('Referer', referer.replace(`${origin}${base}`, `http://127.0.0.1:${port}`));
  else headers.delete('Referer');
  if (base) {
    headers.set('X-Forwarded-Prefix', base);
    headers.set('X-Forwarded-Host', new URL(origin).host);
    headers.set('X-Forwarded-Proto', 'https');
  }
  return headers;
}

export function rewriteLocalURL(value: string, port: number, origin: string): string {
  return mountURL(value, port, origin);
}

export function previewHeaders(source: Headers, port: number, origin: string, base = '', requestPath = '/'): Headers {
  const cookies = source.getSetCookie();
  const headers = new Headers(source);
  stripHopHeaders(headers);
  headers.delete('Set-Cookie');
  for (const cookie of cookies) {
    if (base) {
      const name = cookie.slice(0, cookie.indexOf('=')).trim();
      if (isInternalCookie(name)) continue;
      const scoped = mountCookie(cookie, base, requestPath);
      if (scoped) headers.append('Set-Cookie', scoped);
      continue;
    }
    const parts = cookie.split(';');
    const name = parts[0].split('=')[0].trim();
    if (isInternalCookie(name)) continue;
    const attrs = parts.slice(1).filter((part) => !/^\s*(domain|secure)\s*(=|$)/i.test(part));
    headers.append('Set-Cookie', [parts[0], ...attrs, ' Secure'].join(';'));
  }
  const location = headers.get('Location');
  if (location) {
    // Location 可用 ../ 逃出挂载路径，先以远端请求路径解析，再映射回当前转发。
    const target = base ? new URL(location, `http://127.0.0.1:${port}${requestPath}`).href : location;
    headers.set('Location', mountURL(target, port, origin, base));
  }
  const refresh = headers.get('Refresh');
  if (refresh) headers.delete('Refresh'); // 不接受无法可靠解析的自动导航头，普通 Location 保留。
  for (const name of ['clear-site-data', 'service-worker-allowed', 'alt-svc', 'report-to', 'nel',
    'access-control-allow-origin', 'access-control-allow-credentials', 'content-length']) headers.delete(name);
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  // 叠加而不是覆盖网站自己的 CSP；禁止持久化 Service Worker 污染后续预览。
  headers.append('Content-Security-Policy', "worker-src 'none'; frame-ancestors 'none'; object-src 'none'");
  return headers;
}

/** 增量 HTTP/1.1 帧解析；响应体不整体缓存，下载和 SSE 能沿 SSH 窗口反压。 */
class HTTPReader {
  private buffer = new Uint8Array(0);
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) { this.reader = reader; }
  private async fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done) return false;
    const merged = new Uint8Array(this.buffer.length + value.length);
    merged.set(this.buffer); merged.set(value, this.buffer.length); this.buffer = merged;
    return true;
  }
  async line(limit = MAX_HEADER_BYTES): Promise<string> {
    while (true) {
      for (let index = 0; index + 1 < this.buffer.length; index++) {
        if (this.buffer[index] === 13 && this.buffer[index + 1] === 10) {
          if (index > limit) throw new Error('HTTP line too long');
          const line = decoder.decode(this.buffer.subarray(0, index));
          this.buffer = this.buffer.slice(index + 2);
          return line;
        }
      }
      if (this.buffer.length > limit + 1 || !await this.fill()) throw new Error('Invalid HTTP headers');
    }
  }
  async bytes(max: number): Promise<Uint8Array | null> {
    if (!this.buffer.length && !await this.fill()) return null;
    const chunk = this.buffer.subarray(0, max);
    this.buffer = this.buffer.slice(chunk.length);
    return chunk;
  }
  async headers(): Promise<{ status: number; headers: Headers }> {
    let total = 0;
    const statusLine = await this.line();
    const match = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: .*)?$/.exec(statusLine);
    if (!match) throw new Error('Invalid HTTP status');
    const headers = new Headers();
    while (true) {
      const line = await this.line(MAX_HEADER_BYTES - total);
      total += line.length + 2;
      if (total > MAX_HEADER_BYTES) throw new Error('HTTP headers too large');
      if (!line) break;
      const colon = line.indexOf(':');
      if (colon < 1 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(line.slice(0, colon))) throw new Error('Invalid HTTP header');
      headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    return { status: Number(match[1]), headers };
  }
}

async function sendRequest(channel: ForwardChannel, request: Request, path: string, port: number, origin: string, base: string): Promise<void> {
  const headers = upstreamHeaders(request, port, origin, base);
  const length = headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_UPLOAD_BYTES)) throw new Error('Upload is too large');
  const chunked = request.body !== null && length === null;
  if (chunked) headers.set('Transfer-Encoding', 'chunked');
  let head = `${request.method} ${path} HTTP/1.1\r\n`;
  headers.forEach((value, name) => { head += `${name}: ${value}\r\n`; });
  await channel.write(encoder.encode(`${head}\r\n`));
  if (!request.body) return;
  const reader = request.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_UPLOAD_BYTES || (length !== null && bytes > Number(length))) throw new Error('Upload is too large');
      if (!value.length) continue;
      if (chunked) await channel.write(encoder.encode(`${value.length.toString(16)}\r\n`));
      await channel.write(value);
      if (chunked) await channel.write(encoder.encode('\r\n'));
    }
    if (length !== null && bytes !== Number(length)) throw new Error('Invalid upload length');
    if (chunked) await channel.write(encoder.encode('0\r\n\r\n'));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function proxyHTTP(channel: ForwardChannel, request: Request, port: number, origin: string, base = ''): Promise<Response> {
  const path = request.headers.get('x-preview-path') ?? '/';
  if (!path.startsWith('/') || /[\s\0]/.test(path) || path.startsWith(PREVIEW_PREFIX)) {
    await channel.close();
    throw new Error('Invalid request path');
  }
  const reader = channel.readable.getReader();
  const parser = new HTTPReader(reader);
  const abort = () => channel.abort(new Error('Preview request cancelled'));
  request.signal.addEventListener('abort', abort, { once: true });
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    request.signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await channel.close();
  };
  const sending = sendRequest(channel, request, path, port, origin, base);
  void sending.catch(() => channel.abort(new Error('Unable to send HTTP request')));
  try {
    let parsed = await parser.headers();
    for (let count = 0; parsed.status < 200 && parsed.status !== 101 && count < 4; count++) parsed = await parser.headers();
    if (parsed.status < 200) throw new Error('HTTP upgrades are not supported');
    const { status, headers: source } = parsed;
    const headers = previewHeaders(source, port, origin, base, path);
    if (request.method === 'HEAD' || [204, 205, 304].includes(status)) {
      await finish();
      return new Response(null, { status, headers });
    }
    const transfer = source.get('Transfer-Encoding');
    const length = source.get('Content-Length');
    if (transfer && (transfer.toLowerCase() !== 'chunked' || length !== null)) throw new Error('Unsupported HTTP framing');
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new Error('Invalid HTTP content length');
    let remaining = length === null ? null : Number(length);
    let chunkRemaining = 0;
    let chunkCRLF = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (transfer) {
            if (chunkRemaining === 0) {
              if (chunkCRLF && await parser.line(0) !== '') throw new Error('Invalid chunk separator');
              const line = await parser.line(1024);
              if (!/^[a-fA-F0-9]+(?:;[^\r\n]*)?$/.test(line)) throw new Error('Invalid HTTP chunk');
              chunkRemaining = Number.parseInt(line.split(';')[0], 16);
              if (!Number.isSafeInteger(chunkRemaining)) throw new Error('Invalid HTTP chunk size');
              if (chunkRemaining === 0) {
                let trailerBytes = 0;
                while (true) {
                  const trailer = await parser.line(MAX_HEADER_BYTES - trailerBytes);
                  trailerBytes += trailer.length + 2;
                  if (!trailer) break;
                  if (trailerBytes > MAX_HEADER_BYTES) throw new Error('HTTP trailers too large');
                }
                controller.close(); await finish(); return;
              }
              chunkCRLF = true;
            }
            const chunk = await parser.bytes(chunkRemaining);
            if (!chunk) throw new Error('Truncated chunked response');
            chunkRemaining -= chunk.length;
            controller.enqueue(chunk);
          } else {
            if (remaining === 0) { controller.close(); await finish(); return; }
            const chunk = await parser.bytes(remaining ?? 64 * 1024);
            if (!chunk) {
              if (remaining !== null) throw new Error('Truncated HTTP response');
              controller.close(); await finish(); return;
            }
            if (remaining !== null) remaining -= chunk.length;
            controller.enqueue(chunk);
          }
        } catch (error) { controller.error(error); await finish(); }
      },
      cancel: finish,
    });
    let response = new Response(body, { status, headers, encodeBody: 'manual' });
    if (source.get('Content-Type')?.toLowerCase().includes('text/html') && !source.has('Content-Encoding')) {
      const rewriter = new HTMLRewriter().on('*', {
        element(element) {
          for (const name of ['href', 'src', 'action', 'formaction', 'poster']) {
            const value = element.getAttribute(name);
            if (value) element.setAttribute(name, mountURL(value, port, origin, base));
          }
          if (base) {
            const style = element.getAttribute('style');
            if (style) element.setAttribute('style', mountCSS(style, port, origin, base));
            const srcset = element.getAttribute('srcset');
            if (srcset) element.setAttribute('srcset', mountSrcset(srcset, port, origin, base));
          }
        },
      });
      // 只有可信同源模式注入兼容脚本；隔离模式保持原站页面，不扩大其权限。
      if (base) rewriter.on('head', { element: (element) => {
        element.prepend(`<script src="${base}${RUNTIME_PATH}"></script>`, { html: true });
      } });
      response = rewriter.transform(response);
    } else if (base && source.get('Content-Type')?.toLowerCase().includes('text/css') && !source.has('Content-Encoding')) {
      const css = await readBoundedText(response, 2 * 1024 * 1024);
      response = new Response(mountCSS(css, port, origin, base), { status, headers });
    }
    return response;
  } catch (error) { await finish(); throw error; }
}
