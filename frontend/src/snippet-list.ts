import { SnippetStore, type Snippet } from './snippet-store';
import { SnippetEditor } from './snippet-editor';

interface SnippetListOptions {
  compact?: boolean;
  use?(snippet: Snippet): void;
}

export class SnippetList {
  readonly root = document.createElement('div');
  private readonly search: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;

  constructor(private readonly store: SnippetStore, private readonly editor: SnippetEditor, private readonly options: SnippetListOptions = {}) {
    this.root.className = `snippet-library${options.compact ? ' compact' : ''}`;
    this.root.innerHTML = `<div class="snippet-toolbar">
      <label class="snippet-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="搜索代码片段" placeholder="搜索名称或命令"></label>
      <button type="button" class="snippet-primary" data-new>＋ 新建片段</button>
      <button type="button" data-refresh aria-label="刷新代码片段" title="刷新代码片段">↻</button>
    </div><p class="snippet-status" role="status"></p><div class="snippet-list"></div>`;
    this.search = this.root.querySelector('input')!;
    this.list = this.root.querySelector('.snippet-list')!;
    this.status = this.root.querySelector('.snippet-status')!;
    this.search.addEventListener('input', () => this.render());
    this.root.querySelector('[data-new]')!.addEventListener('click', () => editor.open());
    this.root.querySelector('[data-refresh]')!.addEventListener('click', () => void store.load(true));
    store.addEventListener('change', () => this.render());
    this.render();
  }

  private action(label: string, title: string, callback: (button: HTMLButtonElement) => void): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = label; button.title = title; button.setAttribute('aria-label', title);
    button.addEventListener('click', () => callback(button));
    return button;
  }

  private render(): void {
    const query = this.search.value.trim().toLowerCase();
    const items = this.store.items.filter((item) => `${item.name}\n${item.command}`.toLowerCase().includes(query));
    this.status.textContent = this.store.loading ? '正在加载片段…' : this.store.error || `${items.length} 条片段 · 云端加密保存`;
    this.root.querySelector<HTMLButtonElement>('[data-new]')!.disabled = !this.store.loaded;
    this.root.querySelector<HTMLButtonElement>('[data-refresh]')!.disabled = this.store.loading;
    this.list.replaceChildren();
    if (!items.length && this.store.loaded) {
      const empty = document.createElement('div'); empty.className = 'snippet-empty';
      empty.innerHTML = '<span class="snippet-symbol" aria-hidden="true">{ }</span><strong></strong><p></p>';
      empty.querySelector('strong')!.textContent = query ? '没有匹配的片段' : '把常用命令留在手边';
      empty.querySelector('p')!.textContent = query ? '试试其他名称或命令。' : '新建一个片段，下次连接时直接使用。';
      this.list.append(empty);
    }
    for (const snippet of items) {
      const row = document.createElement('article'); row.className = 'snippet-card';
      const name = document.createElement('h3'); name.textContent = snippet.name;
      const command = document.createElement('pre'); command.textContent = snippet.command;
      command.title = snippet.command;
      const actions = document.createElement('div'); actions.className = 'snippet-actions';
      if (this.options.use) {
        const use = this.action('填入编辑器', `使用 ${snippet.name}`, () => this.options.use!(snippet));
        use.className = 'snippet-use'; actions.append(use);
      }
      actions.append(this.action('复制', `复制 ${snippet.name}`, async () => {
        try { await navigator.clipboard.writeText(snippet.command); this.status.textContent = '命令已复制。'; }
        catch { this.status.textContent = '无法访问剪贴板，请选中命令手动复制。'; }
      }));
      actions.append(this.action('编辑', `编辑 ${snippet.name}`, () => this.editor.open(snippet)));
      const remove = this.action('删除', `删除 ${snippet.name}`, async (button) => {
        if (!confirm(`删除片段「${snippet.name}」？删除后不会自动恢复。`)) return;
        button.disabled = true;
        try { await this.store.remove(snippet.id); }
        catch (error) { this.status.textContent = error instanceof Error ? error.message : '删除失败，请重试。'; button.disabled = false; }
      });
      remove.className = 'snippet-delete'; actions.append(remove);
      row.append(name, command, actions); this.list.append(row);
    }
  }
}
