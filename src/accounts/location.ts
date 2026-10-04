import { isPrivateAddress, resolvePublicAddresses } from '../backend/security.ts';

export interface HostLocation {
  ip: string;
  city: string;
  region: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
}

function createLocation(address: string, city: unknown, region: unknown, country: unknown, countryCode: unknown,
  latitude: unknown, longitude: unknown): HostLocation | null {
  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const code = String(countryCode ?? '').toUpperCase();
  return {
    ip: address, city: String(city ?? '').slice(0, 100), region: String(region ?? '').slice(0, 100),
    country: String(country ?? '').slice(0, 100), countryCode: /^[A-Z]{2}$/.test(code) ? code : '',
    latitude: lat, longitude: lon,
  };
}

async function locateAddress(address: string): Promise<HostLocation | null> {
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(address)}?fields=success,country,country_code,region,city,latitude,longitude`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const data = await response.json<{
        success: boolean; city: string; region: string; country: string; country_code: string; latitude: number; longitude: number;
      }>();
      if (data.success) {
        const location = createLocation(address, data.city, data.region, data.country, data.country_code, data.latitude, data.longitude);
        if (location) return location;
      }
    }
  } catch {
    // ipwho.is 在 Cloudflare 共享出口上可能超时或被限流，继续使用备用数据源。
  }
  try {
    const response = await fetch(`https://get.geojs.io/v1/ip/geo/${encodeURIComponent(address)}.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const data = await response.json<{
      city?: string; region?: string; country?: string; country_code?: string; latitude?: string | number; longitude?: string | number;
    }>();
    return createLocation(address, data.city, data.region, data.country, data.country_code, data.latitude, data.longitude);
  } catch {
    return null;
  }
}

export async function locateHost(host: string): Promise<HostLocation | null> {
  try {
    if (isPrivateAddress(host)) return null;
    // 定位只把解析结果传给固定服务，因此允许 A/AAAA 某一类查询失败；SSH 连接仍使用严格公网校验。
    const addresses = [...new Set((await resolvePublicAddresses(host, 'best-effort'))
      .filter((address) => !isPrivateAddress(address)).map((address) => address.toLowerCase()))].slice(0, 16);
    // 只向固定服务查询已验证的公网 IP，不访问用户指定的 HTTP 地址，避免 SSRF。
    // 定位是近似数据，不代表 SSH 在线或真实机房位置；失败不能阻断保存。
    for (const address of addresses) {
      const location = await locateAddress(address);
      if (location) return location;
    }
    return null;
  } catch { return null; }
}
