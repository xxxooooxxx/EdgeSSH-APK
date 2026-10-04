const apiUrl = 'https://api.cloudflare.com/client/v4';

interface ApiResult<T> {
  success: boolean;
  result: T;
  errors?: { code: number }[];
  result_info?: { total_pages?: number };
}

export class CloudflareApiError extends Error {
  readonly codes: number[];

  constructor(message: string, codes: number[]) {
    super(message);
    this.codes = codes;
  }
}

export class CloudflareApi {
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(token: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.fetcher = fetcher;
  }

  private async send<T>(path: string, method: string, body?: unknown): Promise<ApiResult<T>> {
    const response = await this.fetcher(`${apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    // 不输出响应体和请求参数，避免错误日志泄露邮箱、密钥及账户内部信息。
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { errors?: { code: number }[] };
      throw new CloudflareApiError(
        `Cloudflare ${method} ${path.split('?')[0]} 失败（HTTP ${response.status}）。请核对 Token 权限与资源范围。`,
        error.errors?.map((entry) => entry.code) ?? [],
      );
    }
    const payload = await response.json() as ApiResult<T>;
    if (!payload.success) throw new Error(`Cloudflare ${method} 请求未成功，请检查权限及资源配置。`);
    return payload;
  }

  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return (await this.send<T>(path, method, body)).result;
  }

  async list<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const payload = await this.send<T[]>(`${path}?per_page=50&page=${page}`, 'GET');
      items.push(...payload.result);
      if (payload.result_info?.total_pages !== undefined
        ? page >= payload.result_info.total_pages
        : payload.result.length < 50) return items;
    }
  }
}

export async function resolveAccountId(api: CloudflareApi, configured: string): Promise<string> {
  if (configured) return configured;
  const accounts = await api.list<{ id: string }>('/accounts');
  if (accounts.length !== 1) {
    throw new Error('无法唯一确定 Cloudflare 账户。请将 Token 限定到一个账户，或设置 CLOUDFLARE_ACCOUNT_ID。');
  }
  return accounts[0].id;
}
