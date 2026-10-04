import { SnippetStore, type Snippet } from './snippet-store';

export class SnippetEditor {
  private readonly dialog = document.createElement('dialog');
  private readonly form: HTMLFormElement;
  private editing?: Snippet;
  private busy = false;
  private returnFocus?: HTMLElement;

  constructor(private readonly store: SnippetStore) {
    this.dialog.className = 'snippet-dialog snippet-surface';
    this.dialog.setAttribute('aria-labelledby', 'snippet-editor-title');
    this.dialog.innerHTML = `<form autocomplete="off">
      <header><span class="snippet-symbol" aria-hidden="true">{ }</span><h2 id="snippet-editor-title">新建代码片段</h2></header>
      <label>名称<input name="name" maxlength="80" required placeholder="例如：查看磁盘空间"></label>
      <label>命令<textarea name="command" rows="7" maxlength="8192" required spellcheck="false" placeholder="df -h"></textarea></label>
      <p class="snippet-hint">支持多行命令。使用时先填入命令编辑器，确认后再发送。</p>
      <p class="snippet-editor-error" role="alert" hidden></p>
      <footer><button type="button" data-cancel>取消</button><button type="submit" class="snippet-primary">保存片段</button></footer>
    </form>`;
    document.body.append(this.dialog);
    this.form = this.dialog.querySelector('form')!;
    this.form.addEventListener('submit', (event) => { event.preventDefault(); void this.save(); });
    this.dialog.querySelector('[data-cancel]')!.addEventListener('click', () => this.close());
    this.dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('close', () => this.returnFocus?.focus());
    window.addEventListener('auth-required', () => { this.dialog.close(); this.form.reset(); this.editing = undefined; });
  }

  private field(name: string): HTMLInputElement | HTMLTextAreaElement {
    return this.form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement;
  }

  open(snippet?: Snippet): void {
    this.editing = snippet;
    this.returnFocus = document.activeElement as HTMLElement;
    this.form.reset();
    this.field('name').value = snippet?.name ?? '';
    this.field('command').value = snippet?.command ?? '';
    this.dialog.querySelector('h2')!.textContent = snippet ? '编辑代码片段' : '新建代码片段';
    this.dialog.querySelector<HTMLElement>('.snippet-editor-error')!.hidden = true;
    this.dialog.showModal();
    this.field('name').focus();
  }

  private close(): void {
    if (this.busy) return;
    const changed = this.field('name').value !== (this.editing?.name ?? '') || this.field('command').value !== (this.editing?.command ?? '');
    if (changed && !confirm('放弃尚未保存的片段修改？')) return;
    this.dialog.close();
  }

  private async save(): Promise<void> {
    if (this.busy || !this.form.reportValidity()) return;
    this.busy = true;
    const buttons = this.form.querySelectorAll<HTMLButtonElement>('button');
    buttons.forEach((button) => { button.disabled = true; });
    const error = this.dialog.querySelector<HTMLElement>('.snippet-editor-error')!;
    error.hidden = true;
    try {
      await this.store.save({ name: this.field('name').value, command: this.field('command').value }, this.editing?.id);
      this.dialog.close();
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : '保存失败，请重试。';
      error.hidden = false;
    } finally {
      this.busy = false;
      buttons.forEach((button) => { button.disabled = false; });
    }
  }
}
