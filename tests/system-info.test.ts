import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSystemProbe, SYSTEM_PROBE_COMMAND } from '../src/backend/system-info.ts';

test('system probe command runs uname and reads os-release outside the terminal shell', () => {
  assert.match(SYSTEM_PROBE_COMMAND, /uname -s/);
  assert.match(SYSTEM_PROBE_COMMAND, /uname -m/);
  assert.match(SYSTEM_PROBE_COMMAND, /\/etc\/os-release/);
  assert.doesNotMatch(SYSTEM_PROBE_COMMAND, /[\r\n\0]/);
});

test('parses Ubuntu os-release output and architecture', () => {
  assert.deepEqual(parseSystemProbe(`__EDGESSH_KERNEL__=Linux
__EDGESSH_ARCH__=x86_64
NAME="Ubuntu"
VERSION="24.04.3 LTS (Noble Numbat)"
ID=ubuntu
VERSION_ID="24.04"
PRETTY_NAME="Ubuntu 24.04.3 LTS"`), {
    family: 'linux',
    distribution: 'ubuntu',
    name: 'Ubuntu 24.04.3 LTS',
    version: '24.04',
    architecture: 'x86_64',
  });
});

test('uses kernel information when os-release is unavailable', () => {
  assert.deepEqual(parseSystemProbe('__EDGESSH_KERNEL__=FreeBSD\n__EDGESSH_ARCH__=amd64\n'), {
    family: 'freebsd',
    distribution: '',
    name: 'FreeBSD',
    version: '',
    architecture: 'amd64',
  });
  assert.equal(parseSystemProbe('sh: uname: not found'), null);
});
