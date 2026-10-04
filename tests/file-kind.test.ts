import assert from 'node:assert/strict';
import test from 'node:test';
import { fileKind, fileKindPaths } from '../frontend/src/file-kind.ts';

test('文件夹和链接优先使用协议类型，不受扩展名影响', () => {
  assert.equal(fileKind({ name: 'backup.zip', type: 'directory' }), 'folder');
  assert.equal(fileKind({ name: 'app.sh', type: 'symlink' }), 'link');
  assert.equal(fileKind({ name: 'app.sh', type: 'other' }), 'file');
});

test('常用服务器文件按用途粗分，未知扩展名使用通用图标', () => {
  const cases = {
    'BACKUP.TAR.GZ': 'archive', 'package.deb': 'archive', 'archive.7z': 'archive',
    'README': 'document', 'LICENSE': 'document', 'access.log': 'document',
    'deploy.sh': 'script', 'main.py': 'script', 'Dockerfile.prod': 'script', Makefile: 'script',
    '.env.production': 'config', '.bashrc': 'config', 'sshd_config.conf': 'config',
    'compose.yaml': 'config', 'app.service': 'config', 'icon.svg': 'image',
    'data.bin': 'file', 'notes.docx': 'file', 'no-extension': 'file',
    tar: 'file', constructor: 'file', '__proto__.unknown': 'file',
  };
  for (const [name, kind] of Object.entries(cases)) {
    assert.equal(fileKind({ name, type: 'file' }), kind, name);
  }
});

test('每种类型都提供非空 SVG 路径', () => {
  for (const paths of Object.values(fileKindPaths)) {
    assert.ok(paths.length > 0);
    assert.ok(paths.every((path) => path.startsWith('M') || path.startsWith('m')));
  }
});
