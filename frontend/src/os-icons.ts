import {
  siAlmalinux,
  siAlpinelinux,
  siApple,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siKalilinux,
  siLinux,
  siOpensuse,
  siRedhat,
  siRockylinux,
  siUbuntu,
  type SimpleIcon,
} from 'simple-icons/icons';
import type { HostSystemInfo } from './cloud-api';

const DISTRO_ICONS: Record<string, SimpleIcon> = {
  almalinux: siAlmalinux,
  alpine: siAlpinelinux,
  arch: siArchlinux,
  centos: siCentos,
  debian: siDebian,
  fedora: siFedora,
  kali: siKalilinux,
  'opensuse-leap': siOpensuse,
  'opensuse-tumbleweed': siOpensuse,
  opensuse: siOpensuse,
  rhel: siRedhat,
  rocky: siRockylinux,
  ubuntu: siUbuntu,
};
const WINDOWS_ICON = {
  hex: '0078D4',
  path: 'M0 3.45 9.75 2.1v9.4H0V3.45Zm10.83-1.5L24 0v11.5H10.83V1.95ZM0 12.58h9.75v9.32L0 20.55v-7.97Zm10.83 0H24V24l-13.17-1.87v-9.55Z',
};
const TILE_COLORS: Record<string, string> = {
  darwin: '656B73',
  fedora: '3977A8',
  linux: '9A7800',
  opensuse: '4F861C',
  'opensuse-leap': '4F861C',
  'opensuse-tumbleweed': '4F861C',
  rocky: '087E5D',
};

export function systemIcon(system: HostSystemInfo | null, fallback: string): string {
  const brand = system?.family === 'linux' ? DISTRO_ICONS[system.distribution] ?? siLinux
    : system?.family === 'darwin' ? siApple
      : system?.family === 'freebsd' ? siFreebsd
        : system?.family === 'windows' ? WINDOWS_ICON : null;
  if (!brand) return fallback;
  const colorKey = system?.family === 'linux' ? system.distribution || 'linux' : system?.family ?? '';
  const color = TILE_COLORS[colorKey] ?? brand.hex;
  return `<span class="host-os-tile" style="--host-os-color:#${color}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${brand.path}"/></svg></span>`;
}
