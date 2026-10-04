export type TerminalModifierState = Readonly<{ ctrl: boolean; alt: boolean }>;

const KEY_SEQUENCES: Readonly<Record<string, string>> = Object.freeze({
  esc: '\x1b',
  tab: '\x09',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-z': '\x1a',
  'ctrl-l': '\x0c',
});

const ARROW_SEQUENCE = /^\x1b\[([ABCD])$/;

export function applyTerminalModifiers(data: string, modifiers: TerminalModifierState): string {
  if (!modifiers.ctrl && !modifiers.alt) return data;

  const arrow = data.match(ARROW_SEQUENCE);
  if (arrow) {
    const parameter = modifiers.ctrl && modifiers.alt ? 7 : modifiers.ctrl ? 5 : 3;
    return `\x1b[1;${parameter}${arrow[1]}`;
  }

  let output = data;
  if (modifiers.ctrl && output) {
    const first = output[0];
    const upperCode = first.toUpperCase().charCodeAt(0);
    if (upperCode >= 64 && upperCode <= 95) {
      output = String.fromCharCode(upperCode & 31) + output.slice(1);
    } else if (first === '?') {
      output = `\x7f${output.slice(1)}`;
    }
  }
  return modifiers.alt ? `\x1b${output}` : output;
}

interface TerminalToolsOptions {
  send(data: string): void;
  focusTerminal(): void;
  refitTerminal(): void;
  localize(zh: string, en: string): string;
}

export interface TerminalToolsController {
  handleTerminalData(data: string): void;
  setConnected(connected: boolean): void;
  refreshLanguage(): void;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing terminal tools element #${id}`);
  return node as T;
}

function commandPayload(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return '';
  const payload = normalized.replace(/\n/g, '\r');
  return payload.endsWith('\r') ? payload : `${payload}\r`;
}

function currentLine(textarea: HTMLTextAreaElement): string {
  const value = textarea.value.replace(/\r\n?/g, '\n');
  const cursor = textarea.selectionStart;
  const start = value.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
  const end = value.indexOf('\n', cursor);
  return value.slice(start, end < 0 ? value.length : end);
}

export function createTerminalTools(options: TerminalToolsOptions): TerminalToolsController {
  const root = byId<HTMLElement>('terminal-tools');
  const keyScroll = root.querySelector<HTMLElement>('.terminal-key-scroll')!;
  const modifierButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-terminal-modifier]')];
  const keyButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-terminal-key]')];
  const editor = byId<HTMLElement>('command-editor');
  const editorToggle = byId<HTMLButtonElement>('command-editor-toggle');
  const editorClose = byId<HTMLButtonElement>('command-editor-close');
  const textarea = byId<HTMLTextAreaElement>('command-editor-input');
  const clearButton = byId<HTMLButtonElement>('command-editor-clear');
  const insertButton = byId<HTMLButtonElement>('command-editor-insert');
  const sendButton = byId<HTMLButtonElement>('command-editor-send');
  const sendMenuButton = byId<HTMLButtonElement>('command-editor-send-menu');
  const sendOptions = byId<HTMLElement>('command-send-options');
  let connected = false;
  let modifiers = { ctrl: false, alt: false };

  const refreshModifierButtons = () => {
    for (const button of modifierButtons) {
      const modifier = button.dataset.terminalModifier as keyof typeof modifiers;
      button.setAttribute('aria-pressed', String(modifiers[modifier]));
    }
  };

  const resetModifiers = () => {
    modifiers = { ctrl: false, alt: false };
    refreshModifierButtons();
  };

  const handleTerminalData = (data: string) => {
    if (!connected) return;
    options.send(applyTerminalModifiers(data, modifiers));
    resetModifiers();
  };

  const updateActions = () => {
    const hasCommand = textarea.value.trim().length > 0;
    for (const button of keyButtons) button.disabled = !connected;
    for (const button of modifierButtons) button.disabled = !connected;
    insertButton.disabled = !connected || !hasCommand;
    sendButton.disabled = !connected || !hasCommand;
    sendMenuButton.disabled = !connected || !hasCommand;
  };

  const setEditorOpen = (open: boolean) => {
    editor.hidden = !open;
    editorToggle.setAttribute('aria-expanded', String(open));
    editorToggle.setAttribute('aria-label', open
      ? options.localize('收起命令编辑器', 'Collapse command editor')
      : options.localize('展开命令编辑器', 'Expand command editor'));
    if (!open) {
      sendOptions.hidden = true;
      sendMenuButton.setAttribute('aria-expanded', 'false');
    }
    requestAnimationFrame(options.refitTerminal);
  };

  const sendCommand = (value: string) => {
    const payload = commandPayload(value);
    if (!connected || !payload) return;
    resetModifiers();
    options.send(payload);
    options.focusTerminal();
  };

  const setSendMenuOpen = (open: boolean) => {
    sendOptions.hidden = !open;
    sendMenuButton.setAttribute('aria-expanded', String(open));
  };

  keyScroll.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    const modifier = button.dataset.terminalModifier as keyof typeof modifiers | undefined;
    if (modifier) {
      modifiers = { ...modifiers, [modifier]: !modifiers[modifier] };
      refreshModifierButtons();
      options.focusTerminal();
      return;
    }
    const sequence = KEY_SEQUENCES[button.dataset.terminalKey ?? ''];
    if (sequence !== undefined) handleTerminalData(sequence);
    options.focusTerminal();
  });

  editorToggle.addEventListener('click', () => setEditorOpen(editor.hidden));
  editorClose.addEventListener('click', () => {
    setEditorOpen(false);
    editorToggle.focus();
  });
  textarea.addEventListener('input', updateActions);
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendCommand(textarea.value);
    }
  });
  clearButton.addEventListener('click', () => {
    textarea.value = '';
    updateActions();
    textarea.focus();
  });
  insertButton.addEventListener('click', () => {
    const insertion = textarea.value.replace(/\r\n?/g, '\n').split('\n').filter(Boolean).join('; ');
    if (!connected || !insertion) return;
    resetModifiers();
    options.send(insertion);
    options.focusTerminal();
  });
  sendButton.addEventListener('click', () => sendCommand(textarea.value));
  sendMenuButton.addEventListener('click', () => setSendMenuOpen(sendOptions.hidden));
  sendOptions.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-command-send]');
    if (!item) return;
    setSendMenuOpen(false);
    sendCommand(item.dataset.commandSend === 'line' ? currentLine(textarea) : textarea.value);
  });
  document.addEventListener('click', (event) => {
    if (!sendOptions.hidden && !(event.target as HTMLElement).closest('.command-send-group')) setSendMenuOpen(false);
  });

  updateActions();
  refreshModifierButtons();

  return {
    handleTerminalData,
    setConnected(nextConnected) {
      connected = nextConnected;
      if (!connected) resetModifiers();
      updateActions();
    },
    refreshLanguage() {
      setEditorOpen(!editor.hidden);
    },
  };
}
