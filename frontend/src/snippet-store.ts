import { api } from './cloud-api';
import type { Snippet, SnippetInput } from '../../src/accounts/snippet-data';

export type { Snippet, SnippetInput };

export class SnippetStore extends EventTarget {
  items: Snippet[] = [];
  loaded = false;
  loading = false;
  error = '';
  private pending?: Promise<void>;
  private generation = 0;

  constructor() {
    super();
    window.addEventListener('auth-required', () => this.clear());
  }

  clear(): void {
    this.generation++;
    this.items = []; this.loaded = false; this.loading = false; this.pending = undefined; this.error = '';
    this.notify();
  }

  private notify(): void { this.dispatchEvent(new Event('change')); }

  load(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (this.loaded && !force) return Promise.resolve();
    const generation = this.generation;
    this.loading = true; this.error = ''; this.notify();
    this.pending = (async () => {
      try {
        const { snippets } = await api<{ snippets: Snippet[] }>('/api/snippets');
        // 登出会清空内存，不能让先前尚未结束的请求重新显示私人片段。
        if (generation !== this.generation) return;
        this.items = snippets; this.loaded = true;
      } catch (error) {
        if (generation === this.generation) this.error = error instanceof Error ? error.message : '片段加载失败，请重试。';
      } finally {
        if (generation === this.generation) {
          this.loading = false; this.pending = undefined; this.notify();
        }
      }
    })();
    return this.pending;
  }

  async save(input: SnippetInput, id?: string): Promise<void> {
    await this.pending;
    const generation = this.generation;
    const { snippet } = await api<{ snippet: Snippet }>(id ? `/api/snippets/${id}` : '/api/snippets', id ? 'PUT' : 'POST', input);
    if (generation !== this.generation) return;
    this.items = [snippet, ...this.items.filter((item) => item.id !== snippet.id)];
    this.notify();
  }

  async remove(id: string): Promise<void> {
    await this.pending;
    const generation = this.generation;
    await api(`/api/snippets/${id}`, 'DELETE');
    if (generation !== this.generation) return;
    this.items = this.items.filter((item) => item.id !== id);
    this.notify();
  }
}
