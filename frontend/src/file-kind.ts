import type { SFTPEntry } from './file-manager';

export type FileKind = 'folder' | 'archive' | 'document' | 'script' | 'config' | 'link' | 'image' | 'file';

const extensions = new Map<string, FileKind>();
for (const [kind, names] of Object.entries({
  archive: 'zip tar gz tgz bz2 tbz2 xz txz zst tzst 7z rar deb rpm',
  document: 'md markdown txt log rst pdf',
  script: 'sh bash zsh fish py pyw js mjs cjs ts tsx jsx php rb pl lua go rs c h cpp hpp java sql ps1 bat',
  config: 'conf config cfg ini json jsonc yaml yml toml xml env service socket timer properties',
  image: 'png jpg jpeg gif webp svg ico avif',
})) {
  for (const extension of names.split(' ')) extensions.set(extension, kind as FileKind);
}

/** 服务器文件按用途粗分；先识别协议类型，避免把带扩展名的目录或链接误当文件。 */
export function fileKind(entry: Pick<SFTPEntry, 'name' | 'type'>): FileKind {
  if (entry.type === 'directory') return 'folder';
  if (entry.type === 'symlink') return 'link';
  if (entry.type !== 'file') return 'file';
  const name = entry.name.toLowerCase();
  if (/^(dockerfile|makefile|justfile)(\.|$)/.test(name)) return 'script';
  if (/^(\.env|\.bashrc|\.zshrc|\.profile|\.bash_profile|\.gitignore|\.dockerignore|\.npmrc)(\.|$)/.test(name)) return 'config';
  if (/^(readme|license|licence|changelog|authors|notice)(\.|$)/.test(name)) return 'document';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? 'file' : extensions.get(name.slice(dot + 1)) ?? 'file';
}

export const fileKindLabels: Record<FileKind, { zh: string; en: string }> = {
  folder: { zh: '文件夹', en: 'Folder' },
  archive: { zh: '压缩包', en: 'Archive' },
  document: { zh: '文档', en: 'Document' },
  script: { zh: '脚本 / 源码', en: 'Script / source' },
  config: { zh: '配置', en: 'Config' },
  link: { zh: '链接', en: 'Link' },
  image: { zh: '图片', en: 'Image' },
  file: { zh: '文件', en: 'File' },
};

// 同一套 24px 线性图标，不依赖系统字体，也不为少见扩展名引入整套图标库。
export const fileKindPaths: Record<FileKind, string[]> = {
  folder: ['M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M3 9h18'],
  archive: ['M5 3h14v18H5Z', 'M10 3v3h4v3h-4v3h4', 'M10 15h4v3h-4Z'],
  document: ['M14 3H5v18h14V8Z', 'M14 3v5h5', 'M8 12h8M8 16h6'],
  script: ['M14 3H5v18h14V8Z', 'M14 3v5h5', 'm10 12-3 3 3 3m4-6 3 3-3 3'],
  config: ['M14 3H5v18h14V8Z', 'M14 3v5h5', 'M8 12h8M8 17h8M10 10v4m4 1v4'],
  link: ['m10 13 4-4', 'M8 15H6a4 4 0 0 1 0-8h5', 'M16 9h2a4 4 0 0 1 0 8h-5'],
  image: ['M4 3h16v18H4Z', 'm4 17 5-5 4 4 3-3 4 4', 'M15 7h.01'],
  file: ['M14 3H5v18h14V8Z', 'M14 3v5h5'],
};
