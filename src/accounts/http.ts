import { jsonError, secureResponse } from '../http-security.ts';

export class APIError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', 'no-store');
  return secureResponse(Response.json(value, { status, headers: responseHeaders }));
}

export async function readJSON(request: Request, maxBytes = 160 * 1024): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new APIError('请使用 JSON 请求。', 415);
  if (!request.body) throw new APIError('请求内容不能为空。');
  // 流式限制实际大小，不信任可缺省或伪造的 Content-Length。
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new APIError('请求内容过大。', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new APIError('JSON 格式无效。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new APIError('请求格式无效。');
  return body as Record<string, unknown>;
}

export function apiFailure(error: unknown): Response {
  return error instanceof APIError ? jsonError(error.message, error.status) : jsonError('服务暂时不可用，请稍后重试。', 500);
}
