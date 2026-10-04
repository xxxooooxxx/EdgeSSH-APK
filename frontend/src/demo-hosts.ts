import type { CloudHost } from './cloud-api';

const now = Date.now();

export const DEMO_HOSTS: CloudHost[] = [
  {
    id: 'demo-tokyo', name: 'Ubuntu Gateway', group: '生产环境', host: '192.0.2.10', port: 22,
    username: 'deploy', authMethod: 'publickey', initialCommand: '', termType: 'xterm-256color',
    encoding: 'utf-8', fingerprint: 'SHA256:demo', hasCredential: true, updatedAt: now,
    location: { ip: '192.0.2.10', city: '东京', region: 'Tokyo', country: 'Japan', countryCode: 'JP', latitude: 35.6762, longitude: 139.6503 },
    system: { family: 'linux', distribution: 'ubuntu', name: 'Ubuntu', version: '24.04 LTS', architecture: 'x86_64' },
  },
  {
    id: 'demo-singapore', name: 'Debian API', group: '生产环境', host: '198.51.100.24', port: 22,
    username: 'ops', authMethod: 'publickey', initialCommand: '', termType: 'xterm-256color',
    encoding: 'utf-8', fingerprint: 'SHA256:demo', hasCredential: true, updatedAt: now,
    location: { ip: '198.51.100.24', city: '新加坡', country: 'Singapore', countryCode: 'SG', latitude: 1.3521, longitude: 103.8198 },
    system: { family: 'linux', distribution: 'debian', name: 'Debian GNU/Linux', version: '12', architecture: 'aarch64' },
  },
  {
    id: 'demo-mumbai', name: 'Windows Worker', group: '边缘节点', host: '203.0.113.42', port: 2222,
    username: 'admin', authMethod: 'password', initialCommand: '', termType: 'xterm-256color',
    encoding: 'utf-8', fingerprint: 'SHA256:demo', hasCredential: true, updatedAt: now,
    location: { ip: '203.0.113.42', city: '孟买', region: 'Maharashtra', country: 'India', countryCode: 'IN', latitude: 19.076, longitude: 72.8777 },
    system: { family: 'windows', distribution: '', name: 'Windows Server', version: '2025', architecture: 'x86_64' },
  },
  {
    id: 'demo-sydney', name: 'macOS Build', group: '开发测试', host: '192.0.2.86', port: 22,
    username: 'builder', authMethod: 'publickey', initialCommand: '', termType: 'xterm-256color',
    encoding: 'utf-8', fingerprint: 'SHA256:demo', hasCredential: true, updatedAt: now,
    location: { ip: '192.0.2.86', city: '悉尼', region: 'New South Wales', country: 'Australia', countryCode: 'AU', latitude: -33.8688, longitude: 151.2093 },
    system: { family: 'darwin', distribution: '', name: 'macOS', version: '15.6', architecture: 'arm64' },
  },
];

export function demoApiResult(path: string, method: string): unknown | undefined {
  if (method !== 'GET') return undefined;
  if (path === '/api/auth/me') return { account: { username: 'Demo Admin' } };
  if (path === '/api/hosts') return { hosts: DEMO_HOSTS };
  if (path === '/api/forward-rules') return { rules: [] };
  return undefined;
}
