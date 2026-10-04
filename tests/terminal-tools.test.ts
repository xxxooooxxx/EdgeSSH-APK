import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTerminalModifiers } from '../frontend/src/terminal-tools.ts';

test('terminal modifiers convert printable input into Ctrl and Alt sequences', () => {
  assert.equal(applyTerminalModifiers('c', { ctrl: true, alt: false }), '\x03');
  assert.equal(applyTerminalModifiers('x', { ctrl: false, alt: true }), '\x1bx');
  assert.equal(applyTerminalModifiers('z', { ctrl: true, alt: true }), '\x1b\x1a');
});

test('terminal modifiers use xterm modifier parameters for arrow keys', () => {
  assert.equal(applyTerminalModifiers('\x1b[A', { ctrl: true, alt: false }), '\x1b[1;5A');
  assert.equal(applyTerminalModifiers('\x1b[D', { ctrl: false, alt: true }), '\x1b[1;3D');
  assert.equal(applyTerminalModifiers('\x1b[C', { ctrl: true, alt: true }), '\x1b[1;7C');
});

test('terminal input is unchanged when no modifier is active', () => {
  assert.equal(applyTerminalModifiers('npm run build', { ctrl: false, alt: false }), 'npm run build');
});
