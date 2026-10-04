export function countryFlag(code: string): HTMLElement {
  if (!/^[A-Z]{2}$/.test(code)) {
    const unknown = document.createElement('span');
    unknown.textContent = '◉';
    return unknown;
  }
  // Windows 不一定支持国旗 emoji，使用随站点部署的 SVG，避免显示成两个字母。
  const image = document.createElement('img');
  image.src = `/flags/${code.toLowerCase()}.svg`;
  image.alt = code; image.width = 20; image.height = 15;
  image.className = 'country-flag';
  return image;
}

export function countryFlagEmoji(code: string): string {
  // 地球标签按用户习惯使用 emoji；列表继续使用跨平台显示稳定的 SVG 国旗。
  if (!/^[A-Z]{2}$/.test(code)) return '🌐';
  return [...code].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('');
}
