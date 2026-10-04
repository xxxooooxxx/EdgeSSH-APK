import { api, hostCredentials, type CloudHost } from './cloud-api';
import './forward-page.css';

const FORWARD_SESSION_STORAGE_KEY = 'edgessh.forwarding-session';
const FORWARD_RULE_SESSION_KEY = 'edgessh.forwarding-rule';
const FORWARD_RETENTION_MS = 8 * 60 * 1000;

interface ForwardRule {
  id: string;
  name: string;
  hostId: string;
  port: number;
  mode: 'trusted' | 'isolated';
  updatedAt: number;
}

interface ForwardingStatus {
  active: boolean;
  port?: number;
  mode?: 'trusted' | 'isolated';
  expiresAt?: number;
}

/** 转发持有独立 SSH 连接；标准模式与主站同源，不能当作恶意脚本的安全边界。 */
export class ForwardPage {
  readonly root = document.createElement('main');
  private hosts: CloudHost[] = [];
  private socket?: WebSocket;
  private sessionId?: string;
  private generation = 0;
  private restoreGeneration = 0;
  private busy = false;
  private ready = false;
  private popup: Window | null = null;
  private deadline?: ReturnType<typeof setTimeout>;
  private retentionDeadline?: number;
  private retentionTimer?: ReturnType<typeof setTimeout>;
  private readonly select: HTMLSelectElement;
  private readonly port: HTMLInputElement;
  private readonly startButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly openButton: HTMLButtonElement;
  private readonly keyDialog: HTMLDialogElement;
  private readonly ruleDialog: HTMLDialogElement;
  private readonly ruleForm: HTMLFormElement;
  private readonly trust: HTMLInputElement;
  private rules: ForwardRule[] = [];
  private rulesLoading = false;
  private rulesError = '';
  private ruleGeneration = 0;
  private activeMode: 'trusted' | 'isolated' = 'trusted';
  private selectedRuleId?: string;
  private editingRuleId?: string;
  private savingRule = false;
  private previewAvailable = false;
  private pendingKey?: { socket: WebSocket; fingerprint: string };

  constructor() {
    this.root.className = 'forward-page';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="home-section-heading"><div><p class="home-eyebrow">PRIVATE WEB PREVIEW</p>
        <h1 tabindex="-1">端口转发</h1><p>保存常用规则，通过 SSH 打开服务器本机的网站。</p></div>
        <button class="home-button primary forward-new" type="button" data-new-rule>＋ 新建规则</button></header>
      <div class="forward-toolbar"><div class="forward-switch" role="group" aria-label="转发方式" data-active-mode="trusted">
        <button type="button" data-mode="trusted" aria-pressed="true">标准转发</button>
        <button type="button" data-mode="isolated" aria-pressed="false">隔离预览</button></div>
        <p id="forward-mode-help" class="forward-hint"></p></div>
      <section class="forward-library" aria-label="已保存的转发规则">
        <div class="forward-list-heading"><h2>转发规则</h2><span data-rule-count></span></div>
        <p class="forward-hint" data-rule-message role="status"></p>
        <div class="forward-rules" data-rules></div>
      </section>
      <div class="forward-setup" data-preview-setup hidden><strong>尚未启用隔离预览</strong>
        <p>在 GitHub 仓库的 Actions 中运行「部署预览 Worker」工作流。可在 Settings → Secrets and variables → Actions 设置 PREVIEW_DOMAIN；不填则使用默认 workers.dev 地址。预览域名必须与主站跨站。</p>
        <p>部署完成后重新进入此页，再选择「隔离预览」。此模式不会回退到标准转发。</p></div>
      <section class="forward-card" aria-label="转发连接" data-connection hidden>
        <div class="forward-connection-heading"><div><span class="home-eyebrow">SELECTED RULE</span><h2 data-selected-name></h2><p data-selected-target></p></div>
          <span class="forward-badge" data-mode-badge></span></div>
        <aside class="forward-warning" data-trust-warning role="note"><strong>标准转发仅用于可信网站</strong>
          <p>网站与 EdgeSSH 主站同源。恶意脚本可能借用你的登录态调用主机管理或 SSH 接口；不同路径、新窗口和 HttpOnly 都不能隔离它。不要用此模式打开不可信或疑似被入侵的网站。</p></aside>
        <form class="forward-form"><label class="forward-trust"><input name="trusted" type="checkbox" required>我确认该网站及其脚本可信，接受与 SSH 主站同源的风险。</label>
          <div class="forward-actions"><button class="home-button primary" type="submit">连接并打开网站 ↗</button>
            <button class="home-button" type="button" data-stop disabled>停止转发</button></div></form>
        <p class="forward-hint">访问目标固定为所选服务器的 <code>http://127.0.0.1:端口</code>，不是你电脑的本机端口。</p>
        <div class="forward-status"><span data-status role="status" aria-live="polite">未连接 · 请选择主机和网站端口</span>
          <button class="home-button" type="button" data-open hidden>重新打开预览 ↗</button></div>
        <a data-preview-link target="_blank" rel="noopener noreferrer" hidden>弹窗被拦截？点击打开网站 ↗</a>
      </section>
      <dialog class="host-dialog forward-rule-dialog" aria-labelledby="forward-rule-title">
        <form autocomplete="off"><div class="dialog-heading"><div><p class="home-eyebrow">SAVED FORWARD</p><h2 id="forward-rule-title">新建转发规则</h2></div></div>
          <p class="dialog-intro">规则会加密保存在云端。网站仅在你点击连接后打开。</p>
          <div class="forward-rule-fields"><label>规则名称<input name="name" maxlength="80" required placeholder="例如：开发服务"></label>
            <label>目标主机<select name="host" required><option value="">请选择主机</option></select></label>
            <label>网站端口<input name="port" type="number" min="1" max="65535" value="8080" required inputmode="numeric"></label></div>
          <p class="forward-hint">将转发所选主机的 <code>127.0.0.1:端口</code>。连接方式由顶部滑块决定。</p>
          <p class="host-form-error" data-rule-error role="alert" hidden></p>
          <div class="dialog-actions"><button class="home-button" type="button" data-cancel-rule>取消</button><button class="home-button primary" type="submit">保存规则</button></div>
        </form>
      </dialog>
      <dialog class="host-dialog" aria-labelledby="forward-key-heading">
        <h2 id="forward-key-heading">核对 SSH 主机指纹</h2>
        <p data-key-warning></p><p data-key-target></p><pre data-key-fingerprint></pre>
        <p class="forward-hint">请通过可信渠道核对。接受只用于本次连接，不会自动覆盖已保存指纹。</p>
        <div class="dialog-actions"><button class="home-button" type="button" data-key-reject>取消连接</button>
          <button class="home-button primary" type="button" data-key-accept>信任并连接</button></div>
      </dialog>`;
    this.select = this.get('[name="host"]');
    this.port = this.get('[name="port"]');
    this.trust = this.get('[name="trusted"]');
    this.ruleDialog = this.get('.forward-rule-dialog');
    this.ruleForm = this.ruleDialog.querySelector('form')!;
    this.startButton = this.get('[type="submit"]');
    this.stopButton = this.get('[data-stop]');
    this.openButton = this.get('[data-open]');
    this.keyDialog = this.get('[aria-labelledby="forward-key-heading"]');
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.addEventListener('click', () => {
      if (this.busy || this.ready) return;
      this.activeMode = button.dataset.mode as 'trusted' | 'isolated';
      this.selectedRuleId = undefined; this.trust.checked = false; this.render();
    }));
    this.get('[data-new-rule]').addEventListener('click', () => this.openRuleEditor());
    this.get('[data-cancel-rule]').addEventListener('click', () => this.ruleDialog.close());
    this.ruleDialog.addEventListener('cancel', (event) => { if (this.savingRule) event.preventDefault(); });
    this.ruleForm.addEventListener('submit', (event) => { event.preventDefault(); void this.saveRule(); });
    this.trust.addEventListener('change', () => this.render());
    this.get('[data-key-accept]').addEventListener('click', () => {
      const pending = this.pendingKey;
      if (pending?.socket.readyState === WebSocket.OPEN) {
        pending.socket.send(JSON.stringify({ type: 'host_key_decision', fingerprint: pending.fingerprint, accept: true }));
      }
      this.pendingKey = undefined; this.keyDialog.close();
    });
    this.get('[data-key-reject]').addEventListener('click', () => this.stop('已取消：未信任主机指纹。'));
    this.keyDialog.addEventListener('cancel', (event) => { event.preventDefault(); this.stop('已取消：未信任主机指纹。'); });
    this.get('form').addEventListener('submit', (event) => { event.preventDefault(); void this.start(); });
    this.stopButton.addEventListener('click', () => this.stop());
    this.openButton.addEventListener('click', () => {
      this.reservePopup();
      void this.launch(this.generation);
    });
    window.addEventListener('pagehide', () => this.suspend());
    window.addEventListener('auth-required', () => {
      this.ruleGeneration++; this.rules = []; this.rulesError = ''; this.selectedRuleId = undefined;
      this.ruleDialog.close(); this.stop();
    });
  }

  private get<T extends HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private message(text: string, retained = false): void {
    const status = this.get('[data-status]');
    status.textContent = text;
    status.classList.toggle('is-retained', retained);
  }

  setHosts(hosts: CloudHost[]): void {
    this.hosts = hosts;
    const selected = this.select.value;
    this.select.replaceChildren(new Option(hosts.length ? '请选择主机' : '暂无主机，请先在总览添加', ''));
    for (const host of hosts) this.select.add(new Option(`${host.name} · ${host.username}@${host.host}`, host.id));
    this.select.value = hosts.some((host) => host.id === selected) ? selected : '';
    this.render();
  }

  show(): void {
    this.root.hidden = false; this.get('h1').focus();
    void this.loadRules();
    void api<{ previewAvailable: boolean }>('/api/forwarding').then((config) => {
      this.previewAvailable = config.previewAvailable === true; this.render();
    }).catch(() => { this.previewAvailable = false; this.render(); });
    void this.restore(++this.restoreGeneration);
  }
  hide(): void {
    if (this.root.hidden) return;
    this.restoreGeneration++;
    this.suspend();
    this.root.hidden = true;
  }

  private render(): void {
    const isolated = this.activeMode === 'isolated';
    const selected = this.rules.find((rule) => rule.id === this.selectedRuleId);
    const host = this.hosts.find((item) => item.id === selected?.hostId);
    const connection = this.get('[data-connection]');
    connection.hidden = !selected && !this.ready && !this.busy;
    this.get('[data-selected-name]').textContent = selected?.name ?? '当前转发';
    this.get('[data-selected-target]').textContent = selected
      ? `${host?.name ?? '主机已删除'} · ${host?.host ?? '无法连接'} → 127.0.0.1:${selected.port}`
      : `127.0.0.1:${this.port.value}`;
    this.get('[data-new-rule]').toggleAttribute('disabled', this.busy || this.ready || this.rulesLoading);
    const switcher = this.get<HTMLElement>('.forward-switch');
    switcher.dataset.activeMode = this.activeMode;
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.mode === this.activeMode));
      button.disabled = this.busy || this.ready;
    });
    this.trust.disabled = this.busy || this.ready || isolated;
    this.trust.required = !isolated;
    this.get('.forward-trust').hidden = isolated;
    this.get('[data-trust-warning]').hidden = isolated;
    this.get('[data-preview-setup]').hidden = !isolated || this.previewAvailable;
    this.get('[data-mode-badge]').textContent = isolated ? '跨站隔离预览' : '标准路径转发';
    this.get('#forward-mode-help').textContent = isolated
      ? (this.previewAvailable ? '独立 Worker 已启用，网站在另一个站点打开。' : '需要先部署独立预览 Worker；未启用时无法连接。')
      : '通过当前 Worker 打开可信网站；与 EdgeSSH 主站同源。';
    this.startButton.disabled = this.busy || this.ready || !host || (isolated ? !this.previewAvailable : !this.trust.checked);
    this.startButton.textContent = this.busy ? '正在连接…' : '连接并打开网站 ↗';
    this.stopButton.disabled = !this.busy && !this.ready;
    this.openButton.hidden = !this.ready;
    this.openButton.disabled = this.busy;
    this.renderRules();
  }

  private renderRules(): void {
    const list = this.get('[data-rules]');
    list.replaceChildren();
    const rules = this.rules.filter((rule) => rule.mode === this.activeMode);
    this.get('[data-rule-count]').textContent = `${rules.length} 条规则 · 云端加密保存`;
    this.get('[data-rule-message]').textContent = this.rulesLoading ? '正在加载规则…' : this.rulesError;
    if (this.rulesLoading || this.rulesError) return;
    if (!rules.length) {
      const empty = document.createElement('div'); empty.className = 'forward-empty';
      empty.innerHTML = '<strong>这里还没有转发规则</strong><p>点击右上角新建，选择主机并保存网站端口。</p>';
      list.append(empty); return;
    }
    for (const rule of rules) {
      const host = this.hosts.find((item) => item.id === rule.hostId);
      const card = document.createElement('article');
      card.className = `forward-rule${this.selectedRuleId === rule.id ? ' selected' : ''}`;
      const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'forward-rule-select';
      choose.setAttribute('aria-label', `选择规则 ${rule.name}`);
      choose.setAttribute('aria-pressed', String(this.selectedRuleId === rule.id));
      choose.disabled = this.busy || this.ready || !host;
      const symbol = document.createElement('span'); symbol.className = 'forward-rule-symbol'; symbol.textContent = rule.name.slice(0, 1).toUpperCase();
      const copy = document.createElement('span'); copy.className = 'forward-rule-copy';
      const name = document.createElement('strong'); name.textContent = rule.name;
      const target = document.createElement('small'); target.textContent = host
        ? `${host.name} · ${host.host} → 127.0.0.1:${rule.port}` : '主机已删除 · 编辑规则以重新选择主机';
      copy.append(name, target); choose.append(symbol, copy);
      choose.addEventListener('click', () => {
        this.selectedRuleId = rule.id; this.select.value = rule.hostId; this.port.value = String(rule.port);
        this.trust.checked = false; this.message('未连接 · 核对规则后点击连接'); this.render();
        this.get('[data-connection]').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      const actions = document.createElement('div'); actions.className = 'forward-rule-actions';
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '编辑'; edit.setAttribute('aria-label', `编辑规则 ${rule.name}`);
      edit.disabled = this.busy || this.ready; edit.addEventListener('click', () => this.openRuleEditor(rule));
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除'; remove.setAttribute('aria-label', `删除规则 ${rule.name}`);
      remove.disabled = this.busy || this.ready; remove.addEventListener('click', () => void this.removeRule(rule));
      actions.append(edit, remove); card.append(choose, actions); list.append(card);
    }
  }

  private async loadRules(): Promise<void> {
    const generation = ++this.ruleGeneration;
    this.rulesLoading = true; this.rulesError = ''; this.render();
    try {
      const { rules } = await api<{ rules: ForwardRule[] }>('/api/forward-rules');
      if (generation !== this.ruleGeneration) return;
      this.rules = rules;
      if (!this.selectedRuleId && this.sessionId) this.selectedRuleId = localStorage.getItem(FORWARD_RULE_SESSION_KEY) ?? undefined;
    } catch (error) {
      if (generation === this.ruleGeneration) this.rulesError = error instanceof Error ? error.message : '规则加载失败，请重试。';
    } finally {
      if (generation === this.ruleGeneration) { this.rulesLoading = false; this.render(); }
    }
  }

  private openRuleEditor(rule?: ForwardRule): void {
    if (this.busy || this.ready || this.rulesLoading) return;
    this.editingRuleId = rule?.id;
    this.ruleForm.reset();
    this.ruleForm.querySelector<HTMLInputElement>('[name="name"]')!.value = rule?.name ?? '';
    this.select.value = rule?.hostId ?? '';
    this.port.value = String(rule?.port ?? 8080);
    this.get('#forward-rule-title').textContent = rule ? '编辑转发规则' : '新建转发规则';
    this.get('[data-rule-error]').hidden = true;
    this.ruleDialog.showModal();
    this.ruleForm.querySelector<HTMLInputElement>('[name="name"]')!.focus();
  }

  private async saveRule(): Promise<void> {
    if (this.savingRule || !this.ruleForm.reportValidity()) return;
    this.savingRule = true;
    const save = this.ruleForm.querySelector<HTMLButtonElement>('[type="submit"]')!;
    save.disabled = true;
    const error = this.get('[data-rule-error]'); error.hidden = true;
    try {
      const { rule } = await api<{ rule: ForwardRule }>(this.editingRuleId ? `/api/forward-rules/${this.editingRuleId}` : '/api/forward-rules',
        this.editingRuleId ? 'PUT' : 'POST', {
          name: this.ruleForm.querySelector<HTMLInputElement>('[name="name"]')!.value.trim(),
          hostId: this.select.value, port: Number(this.port.value), mode: this.activeMode,
        });
      this.rules = [rule, ...this.rules.filter((item) => item.id !== rule.id)];
      this.selectedRuleId = rule.id;
      this.message('规则已保存 · 核对后点击连接');
      this.ruleDialog.close(); this.render();
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : '规则保存失败，请重试。'; error.hidden = false;
    } finally { this.savingRule = false; save.disabled = false; }
  }

  private async removeRule(rule: ForwardRule): Promise<void> {
    if (!confirm(`删除转发规则「${rule.name}」？`)) return;
    try {
      await api(`/api/forward-rules/${rule.id}`, 'DELETE');
      this.rules = this.rules.filter((item) => item.id !== rule.id);
      if (this.selectedRuleId === rule.id) this.selectedRuleId = undefined;
      this.render();
    } catch (cause) {
      this.rulesError = cause instanceof Error ? cause.message : '删除失败，请重试。'; this.render();
    }
  }

  private reservePopup(): void {
    // 同步占用用户手势；一开始就去掉 opener，不让远端页面访问主站窗口。
    this.popup = window.open('about:blank', '_blank');
    if (this.popup) {
      this.popup.opener = null;
      this.popup.document.title = 'EdgeSSH · 正在连接';
      this.popup.document.body.textContent = '正在建立 SSH 转发。请回到 EdgeSSH 核对首次连接的主机指纹。';
    }
  }

  private async start(): Promise<void> {
    if (this.busy || this.ready) return;
    if (this.activeMode === 'trusted' ? !this.trust.checked : !this.previewAvailable) return;
    const rule = this.rules.find((item) => item.id === this.selectedRuleId && item.mode === this.activeMode);
    if (!rule) return;
    const host = this.hosts.find((item) => item.id === rule.hostId);
    if (!host) { this.message('请先选择一台已保存的主机。'); return; }
    this.select.value = host.id; this.port.value = String(rule.port);
    const port = rule.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const generation = ++this.generation;
    this.reservePopup();
    this.busy = true; this.render(); this.message('正在获取连接授权…');
    this.deadline = setTimeout(() => this.stop('连接超时，请检查主机后重试。'), 60_000);
    try {
      const credentials = await hostCredentials(host.id);
      if (generation !== this.generation) return;
      const ticket = await api<{ ticket: string; sessionId: string }>('/api/session', 'POST', {});
      if (generation !== this.generation) return;
      this.sessionId = ticket.sessionId;
      const url = new URL('/api/ssh', location.origin);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', ticket.ticket); url.searchParams.set('session', ticket.sessionId);
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener('open', () => {
        if (generation !== this.generation) return;
        socket.send(JSON.stringify({
          type: 'connect', mode: 'forward', host: host.host, port: host.port,
          username: host.username, authMethod: host.authMethod, ...credentials,
          ...(host.fingerprint ? { expectedFingerprint: host.fingerprint } : {}),
        }));
        credentials.password = undefined; credentials.privateKey = undefined;
        this.message('正在连接 SSH，首次连接请核对主机指纹…');
      });
      socket.addEventListener('message', (event) => {
        if (generation !== this.generation || typeof event.data !== 'string') return;
        const message = JSON.parse(event.data) as { type: string; trusted?: boolean; fingerprint?: string; expectedFingerprint?: string };
        if (message.type === 'host_key' && !message.trusted) {
          if (!message.fingerprint || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(message.fingerprint)) {
            this.stop('收到无效的主机指纹，请重新连接。'); return;
          }
          // 新窗口可能已取得焦点，原生 confirm 会被浏览器抑制；站内对话框不会默默拒绝首次连接。
          this.pendingKey = { socket, fingerprint: message.fingerprint };
          this.get('[data-key-warning]').textContent = message.expectedFingerprint
            ? `警告：主机指纹已变化！原指纹：${message.expectedFingerprint}` : '首次连接，请通过可信渠道核对主机指纹。';
          this.get('[data-key-target]').textContent = `${host.name} (${host.host})`;
          this.get('[data-key-fingerprint]').textContent = message.fingerprint;
          this.keyDialog.showModal();
        } else if (message.type === 'ready') {
          clearTimeout(this.deadline);
          void this.launch(generation);
        } else if (message.type === 'error') this.stop('SSH 连接失败，请检查凭据、指纹和服务器状态。');
      });
      socket.addEventListener('close', () => { if (generation === this.generation) this.stop('SSH 已断开，预览授权已失效。'); });
      socket.addEventListener('error', () => { if (generation === this.generation) this.stop('SSH 连接失败，请重新连接。'); });
    } catch (error) { if (generation === this.generation) this.stop(error instanceof Error ? error.message : '连接失败。'); }
  }

  private async launch(generation: number): Promise<void> {
    if (!this.sessionId) return;
    this.busy = true; this.render();
    this.get('[data-preview-link]').hidden = true;
    try {
      const { url, expiresAt } = await api<{ url: string; expiresAt: number }>(
        `/api/forwarding?session=${this.sessionId}`, 'POST', {
          port: Number(this.port.value), mode: this.activeMode,
          ...(this.activeMode === 'trusted' ? { trusted: this.trust.checked } : {}),
        });
      if (generation !== this.generation) return;
      this.ready = true;
      this.rememberSession();
      if (!this.socket) this.scheduleRetention(expiresAt);
      const link = this.get<HTMLAnchorElement>('[data-preview-link]');
      link.href = url;
      if (this.popup && !this.popup.closed) this.popup.location.replace(url);
      else link.hidden = false;
      this.popup = null;
      this.message(`已转发 127.0.0.1:${this.port.value} · 授权至 ${new Date(expiresAt).toLocaleTimeString()} · 离开页面后保持 8 分钟`);
    } catch (error) {
      if (generation === this.generation) this.stop(error instanceof Error ? error.message : '创建转发失败。');
    } finally { if (generation === this.generation) { this.busy = false; this.render(); } }
  }

  stop(message = '已停止转发，预览授权已失效。'): void {
    const sessionId = this.sessionId;
    this.generation++;
    this.restoreGeneration++;
    clearTimeout(this.deadline);
    clearTimeout(this.retentionTimer);
    this.retentionTimer = undefined; this.retentionDeadline = undefined;
    this.pendingKey = undefined; this.keyDialog.close();
    this.popup?.close(); this.popup = null;
    this.socket?.close(); this.socket = undefined;
    this.sessionId = undefined; this.busy = false; this.ready = false;
    localStorage.removeItem(FORWARD_SESSION_STORAGE_KEY);
    localStorage.removeItem(FORWARD_RULE_SESSION_KEY);
    if (sessionId) void api(`/api/forwarding?session=${sessionId}`, 'DELETE').catch(() => undefined);
    this.trust.checked = false;
    this.get('[data-preview-link]').hidden = true;
    this.get<HTMLAnchorElement>('[data-preview-link]').removeAttribute('href');
    this.message(message); this.render();
  }

  private suspend(): void {
    if (!this.ready || !this.sessionId) {
      if (this.busy) this.stop();
      return;
    }
    this.generation++;
    clearTimeout(this.deadline);
    this.pendingKey = undefined; this.keyDialog.close();
    this.popup?.close(); this.popup = null;
    this.socket?.close(); this.socket = undefined;
    this.busy = false;
    this.rememberSession();
    this.scheduleRetention(Date.now() + FORWARD_RETENTION_MS);
    this.message(`后台保持 127.0.0.1:${this.port.value} 至 ${new Date(this.retentionDeadline!).toLocaleTimeString()}，重新进入可继续查看或停止。`, true);
    this.render();
  }

  private rememberSession(): void {
    // 这里只保存无权访问 SSH 的 DO 标识；账户校验和 8 分钟期限仍由 Worker 决定。
    if (this.sessionId) {
      localStorage.setItem(FORWARD_SESSION_STORAGE_KEY, this.sessionId);
      if (this.selectedRuleId) localStorage.setItem(FORWARD_RULE_SESSION_KEY, this.selectedRuleId);
    }
  }

  private scheduleRetention(expiresAt: number): void {
    clearTimeout(this.retentionTimer);
    this.retentionDeadline = expiresAt;
    this.retentionTimer = setTimeout(() => this.stop('后台保持 8 分钟已结束，转发已自动停止。'),
      Math.max(0, expiresAt - Date.now()));
  }

  private async restore(generation: number): Promise<void> {
    const sessionId = this.sessionId ?? localStorage.getItem(FORWARD_SESSION_STORAGE_KEY) ?? undefined;
    if (!sessionId || this.socket) return;
    this.busy = true; this.render();
    try {
      const status = await api<ForwardingStatus>(`/api/forwarding?session=${sessionId}`);
      if (generation !== this.restoreGeneration) return;
      if (!status.active || !status.port || !status.mode || !status.expiresAt) {
        localStorage.removeItem(FORWARD_SESSION_STORAGE_KEY);
        if (this.sessionId === sessionId) this.stop('之前保持的转发已结束。');
        else this.message('之前保持的转发已结束。');
        return;
      }
      this.sessionId = sessionId;
      this.port.value = String(status.port);
      this.activeMode = status.mode;
      this.selectedRuleId = localStorage.getItem(FORWARD_RULE_SESSION_KEY) ?? undefined;
      this.trust.checked = status.mode === 'trusted';
      this.ready = true;
      this.scheduleRetention(status.expiresAt);
      this.message(`正在保持 127.0.0.1:${status.port} 至 ${new Date(status.expiresAt).toLocaleTimeString()}，可重新打开预览或立即停止。`, true);
    } catch {
      if (generation !== this.restoreGeneration) return;
      localStorage.removeItem(FORWARD_SESSION_STORAGE_KEY);
      this.sessionId = undefined; this.ready = false;
      this.message('之前保持的转发已结束。');
    } finally {
      if (generation === this.restoreGeneration) { this.busy = false; this.render(); }
    }
  }
}
