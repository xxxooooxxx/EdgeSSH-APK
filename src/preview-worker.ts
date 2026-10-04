import { parseCapability, PREVIEW_COOKIE, PREVIEW_PREFIX, previewError, readPreviewCookie } from './forwarding/security';
import { readBoundedText } from './forwarding/body';

interface PreviewEnv {
  SSH_SESSIONS: DurableObjectNamespace;
  PREVIEW_ORIGIN: string;
}

export default {
  async fetch(request: Request, env: PreviewEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'https:' || url.origin !== env.PREVIEW_ORIGIN) return previewError('Preview origin is not allowed', 403);
      if (request.headers.has('Service-Worker')) return previewError('Service workers are disabled in previews', 403);
      if (url.pathname === `${PREVIEW_PREFIX}start`) {
        if (request.method !== 'GET') return previewError('Method not allowed', 405);
        const nonce = crypto.randomUUID();
        // 凭证只在 fragment 中交接，不进入访问日志、Referer 或远端网站。
        return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EdgeSSH 隔离预览</title><p id="status">正在打开隔离预览…</p><script nonce="${nonce}">
const key=location.hash.slice(1);history.replaceState(null,'',location.pathname);
fetch('${PREVIEW_PREFIX}launch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})})
.then(async r=>{if(!r.ok)throw new Error('预览链接已失效，请回到 EdgeSSH 重新打开。');location.replace('/');})
.catch(e=>document.getElementById('status').textContent=e.message);
</script></html>`, { headers: {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin',
          'Clear-Site-Data': '"cache", "cookies", "storage"',
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
        } });
      }
      if (url.pathname === `${PREVIEW_PREFIX}launch`) {
        if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin
          || !request.headers.get('Content-Type')?.startsWith('application/json')) return previewError('Launch origin is not allowed', 403);
        let text: string;
        try { text = await readBoundedText(request, 256); }
        catch { return previewError('Invalid launch ticket', 400); }
        const cap = parseCapability((JSON.parse(text) as { key: string }).key);
        if (!cap) return previewError('Invalid launch ticket', 401);
        const response = await env.SSH_SESSIONS.get(env.SSH_SESSIONS.idFromString(cap.session)).fetch(new Request('https://session.internal/preview-launch', {
          method: 'POST', headers: { 'x-preview-token': cap.token, 'x-preview-origin': url.origin },
        }));
        if (!response.ok) return response;
        const { token, maxAge } = await response.json<{ token: string; maxAge: number }>();
        return Response.json({ ok: true }, { headers: {
          'Cache-Control': 'no-store',
          'Set-Cookie': `${PREVIEW_COOKIE}=${cap.session}.${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
        } });
      }
      if (url.pathname.startsWith(PREVIEW_PREFIX)) return previewError('Not found', 404);
      const cap = parseCapability(readPreviewCookie(request.headers));
      if (!cap) return previewError('请从 EdgeSSH 端口转发页面打开预览。', 401);
      // 不将浏览器提供的内部头当作授权；只使用 HttpOnly Cookie 中的有限能力。
      const headers = new Headers(request.headers);
      const headerNames: string[] = [];
      headers.forEach((_value, name) => headerNames.push(name));
      for (const name of headerNames) if (name.startsWith('x-preview-') || name === 'x-account-id') headers.delete(name);
      headers.set('x-preview-token', cap.token);
      headers.set('x-preview-origin', url.origin);
      headers.set('x-preview-path', url.pathname + url.search);
      return await env.SSH_SESSIONS.get(env.SSH_SESSIONS.idFromString(cap.session)).fetch(new Request('https://session.internal/preview-http', {
        method: request.method, headers, body: request.body, redirect: 'manual', signal: request.signal,
      }));
    } catch { return previewError('预览请求失败，请重新连接。', 502); }
  },
};
