export function accessToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  // Access 推荐使用注入请求头；部分浏览器接入只保留同源 Cookie，因此仍以同样的 JWT 校验兼容它。
  const cookie = request.headers.get('Cookie');
  const prefix = 'CF_Authorization=';
  const authorization = cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return authorization?.slice(prefix.length) || null;
}
