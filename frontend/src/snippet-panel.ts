import { SnippetList } from './snippet-list';
import { SnippetEditor } from './snippet-editor';
import { SnippetStore, type Snippet } from './snippet-store';

export class SnippetPanel {
  readonly root = document.createElement('aside');
  private readonly body: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private position?: { x: number; y: number };

  constructor(private readonly container: HTMLElement, store: SnippetStore, editor: SnippetEditor, use: (snippet: Snippet) => void, openLibrary: () => void) {
    this.root.id = 'snippet-panel';
    this.root.className = 'snippet-panel snippet-surface';
    this.root.setAttribute('aria-label', '代码片段浮窗');
    this.root.innerHTML = `<header class="snippet-panel-heading">
      <button class="snippet-drag" type="button" aria-label="移动代码片段窗口" title="拖动移动，也可用方向键移动、Home 键复位">
        <span class="snippet-symbol" aria-hidden="true">{ }</span><strong>代码片段</strong><span class="snippet-grip" aria-hidden="true">⠿</span>
      </button><button class="snippet-manage" type="button" aria-label="管理代码片段" title="管理代码片段">↗</button>
      <button class="snippet-collapse" type="button" aria-controls="snippet-panel-body"></button>
    </header><div id="snippet-panel-body"><p class="snippet-panel-hint">常用命令，一次保存，随时取用。</p></div>`;
    this.body = this.root.querySelector('#snippet-panel-body')!;
    this.toggle = this.root.querySelector('.snippet-collapse')!;
    this.body.append(new SnippetList(store, editor, { compact: true, use: (snippet) => {
      use(snippet);
      if (matchMedia('(max-width: 700px)').matches) this.setCollapsed(true);
    } }).root);
    container.append(this.root);
    this.toggle.addEventListener('click', () => this.setCollapsed(!this.body.hidden));
    this.root.querySelector('.snippet-manage')!.addEventListener('click', openLibrary);
    this.setCollapsed(matchMedia('(max-width: 700px)').matches);
    this.bindDrag();
    // 终端侧栏、全屏和横竖屏切换都会改变可用空间，保持拖动后的标题栏仍可触达。
    const observer = new ResizeObserver(() => this.constrain());
    observer.observe(container); observer.observe(this.root);
  }

  private setCollapsed(collapsed: boolean): void {
    this.body.hidden = collapsed;
    this.root.classList.toggle('is-collapsed', collapsed);
    this.toggle.textContent = collapsed ? '＋' : '−';
    this.toggle.setAttribute('aria-expanded', String(!collapsed));
    this.toggle.setAttribute('aria-label', collapsed ? '展开代码片段' : '收起代码片段');
    this.toggle.title = collapsed ? '展开代码片段' : '收起代码片段';
    this.constrain();
  }

  private move(x: number, y: number): void {
    this.position = { x, y }; this.constrain();
  }

  private constrain(): void {
    if (!this.position || !this.container.clientWidth) return;
    this.position.x = Math.max(0, Math.min(this.position.x, this.container.clientWidth - this.root.offsetWidth));
    this.position.y = Math.max(0, Math.min(this.position.y, this.container.clientHeight - this.root.offsetHeight));
    this.root.style.left = `${this.position.x}px`; this.root.style.top = `${this.position.y}px`; this.root.style.right = 'auto';
  }

  private bindDrag(): void {
    const handle = this.root.querySelector<HTMLButtonElement>('.snippet-drag')!;
    let drag: { pointer: number; x: number; y: number; left: number; top: number } | undefined;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: this.root.offsetLeft, top: this.root.offsetTop };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointer !== event.pointerId) return;
      const x = event.clientX - drag.x; const y = event.clientY - drag.y;
      if (Math.abs(x) + Math.abs(y) < 4) return;
      this.move(drag.left + x, drag.top + y);
    });
    handle.addEventListener('lostpointercapture', () => { drag = undefined; });
    handle.addEventListener('keydown', (event) => {
      const moves: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
      if (event.key === 'Home') {
        event.preventDefault(); this.position = undefined;
        this.root.style.left = ''; this.root.style.top = ''; this.root.style.right = '';
      } else if (moves[event.key]) {
        event.preventDefault();
        const [x, y] = moves[event.key];
        this.move(this.root.offsetLeft + x, this.root.offsetTop + y);
      }
    });
  }
}
