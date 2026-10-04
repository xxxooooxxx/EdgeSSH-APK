export interface SystemInfo {
  family: 'linux' | 'darwin' | 'freebsd' | 'windows' | 'unknown';
  distribution: string;
  name: string;
  version: string;
  architecture: string;
}

const KERNEL_MARKER = '__EDGESSH_KERNEL__=';
const ARCH_MARKER = '__EDGESSH_ARCH__=';

// 由远端 shell 执行系统命令，标记行负责区分 uname 与 os-release 的同名字段。
export const SYSTEM_PROBE_COMMAND = `LC_ALL=C LANG=C sh -c 'printf "${KERNEL_MARKER}%s\\n" "$(uname -s 2>/dev/null)"; printf "${ARCH_MARKER}%s\\n" "$(uname -m 2>/dev/null)"; if [ -r /etc/os-release ]; then cat /etc/os-release; fi'`;

function osReleaseValue(raw: string): string {
  const value = raw.trim();
  if (value.length < 2 || !['"', "'"].includes(value[0]) || value.at(-1) !== value[0]) return value;
  const unquoted = value.slice(1, -1);
  return value[0] === '"' ? unquoted.replace(/\\(["\\$`])/g, '$1') : unquoted;
}

function clean(value: string | undefined, maxLength: number): string {
  return (value ?? '').replace(/[\0\r\n]/g, ' ').trim().slice(0, maxLength);
}

export function parseSystemProbe(output: string): SystemInfo | null {
  const values = new Map<string, string>();
  let kernel = '';
  let architecture = '';
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(KERNEL_MARKER)) {
      kernel = clean(line.slice(KERNEL_MARKER.length), 32);
      continue;
    }
    if (line.startsWith(ARCH_MARKER)) {
      architecture = clean(line.slice(ARCH_MARKER.length), 32);
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], osReleaseValue(match[2]));
  }

  const normalizedKernel = kernel.toLowerCase();
  const family: SystemInfo['family'] = normalizedKernel === 'linux' ? 'linux'
    : normalizedKernel === 'darwin' ? 'darwin'
      : normalizedKernel === 'freebsd' ? 'freebsd'
        : /^(mingw|msys|cygwin|windows)/.test(normalizedKernel) ? 'windows'
          : kernel ? 'unknown' : values.has('ID') ? 'linux' : 'unknown';
  if (family === 'unknown' && !kernel && !values.has('ID')) return null;

  const distribution = clean(values.get('ID'), 40).toLowerCase();
  const fallbackName = family === 'darwin' ? 'macOS'
    : family === 'freebsd' ? 'FreeBSD'
      : family === 'windows' ? 'Windows'
        : family === 'linux' ? 'Linux' : kernel;
  return {
    family,
    distribution,
    name: clean(values.get('PRETTY_NAME') || values.get('NAME') || fallbackName, 120),
    version: clean(values.get('VERSION_ID') || values.get('VERSION'), 80),
    architecture,
  };
}
