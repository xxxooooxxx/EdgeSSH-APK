import { SSHChannel, type ChannelDataChunk } from '../ssh/channel';
import {
  SSH_MSG_CHANNEL_OPEN_CONFIRMATION, SSH_MSG_CHANNEL_OPEN_FAILURE, SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_WINDOW_ADJUST, SSH_MSG_CHANNEL_EOF, SSH_MSG_CHANNEL_CLOSE,
} from '../types';

interface Transport {
  send(payload: Uint8Array): Promise<void>;
  data(channel: SSHChannel, chunk: ChannelDataChunk): Promise<void>;
  remove(): void;
}

/** 每个 HTTP 请求单独使用 direct-tcpip，避免连接复用带来的响应串线。 */
export class ForwardChannel {
  readonly channel = new SSHChannel();
  readonly readable: ReadableStream<Uint8Array>;
  readonly opened: Promise<void>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private resolveOpen!: () => void;
  private rejectOpen!: (error: Error) => void;
  private wakeWriter?: () => void;
  private failure?: Error;
  private ended = false;
  private timer: ReturnType<typeof setTimeout>;

  constructor(private readonly transport: Transport) {
    this.opened = new Promise((resolve, reject) => { this.resolveOpen = resolve; this.rejectOpen = reject; });
    // 读者未就绪时最多保留 SSH 的接收窗口，不把慢客户端的数据无限堆在 DO 内。
    this.readable = new ReadableStream({
      start: (controller) => { this.controller = controller; },
      pull: () => this.adjustWindow(),
      cancel: () => this.close(),
    }, { highWaterMark: 2 * 1024 * 1024, size: (chunk) => chunk.byteLength });
    this.timer = setTimeout(() => this.abort(new Error('Forwarding channel timed out')), 15_000);
    void this.opened.catch(() => undefined);
  }

  private touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.abort(new Error('Forwarding channel timed out')), 60_000);
  }

  async handle(type: number, payload: Uint8Array): Promise<void> {
    const channel = this.channel;
    if (type === SSH_MSG_CHANNEL_OPEN_CONFIRMATION) {
      channel.handleOpenConfirmation(payload);
      if (this.failure) { await this.sendClose(); return; }
      this.touch(); this.resolveOpen();
    } else if (type === SSH_MSG_CHANNEL_OPEN_FAILURE) {
      channel.handleOpenFailure(payload);
      this.abort(new Error('SSH server rejected port forwarding'));
      this.transport.remove();
    } else if (type === SSH_MSG_CHANNEL_DATA) {
      const data = channel.handleChannelData(payload);
      if (!this.ended) { this.touch(); this.controller.enqueue(data.slice()); await this.adjustWindow(); }
    } else if (type === SSH_MSG_CHANNEL_WINDOW_ADJUST) {
      channel.handleWindowAdjust(payload);
      this.wakeWriter?.(); this.wakeWriter = undefined;
    } else if (type === SSH_MSG_CHANNEL_EOF) {
      channel.handleEof(payload);
      if (!this.ended) { this.ended = true; this.controller.close(); }
    } else if (type === SSH_MSG_CHANNEL_CLOSE) {
      channel.handleClose(payload);
      if (!this.ended) { this.ended = true; this.controller.close(); }
      this.failure ??= new Error('Forwarding channel closed');
      this.rejectOpen(this.failure);
      this.wakeWriter?.(); this.wakeWriter = undefined;
      clearTimeout(this.timer);
      await this.sendClose();
      this.transport.remove();
    }
  }

  async write(data: Uint8Array): Promise<void> {
    await this.opened;
    let offset = 0;
    while (offset < data.length) {
      if (this.failure) throw this.failure;
      const chunk = this.channel.takeChannelDataChunk(data, offset);
      if (!chunk) { await new Promise<void>((resolve) => { this.wakeWriter = resolve; }); continue; }
      await this.transport.data(this.channel, chunk);
      offset += chunk.bytesConsumed;
      this.touch();
    }
  }

  private async adjustWindow(): Promise<void> {
    if (this.ended || this.failure || !this.channel.isOpen() || (this.controller.desiredSize ?? 0) < 1024 * 1024) return;
    const amount = this.channel.takeLocalWindowAdjustment(512 * 1024);
    if (amount) await this.transport.send(this.channel.buildWindowAdjust(amount));
  }

  private async sendClose(): Promise<void> {
    if (this.channel.hasSentClose()) return;
    try { this.channel.getRemoteChannelID(); } catch { return; }
    await this.transport.send(this.channel.buildClose());
  }

  abort(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.timer);
    this.rejectOpen(error);
    this.wakeWriter?.(); this.wakeWriter = undefined;
    if (!this.ended) { this.ended = true; this.controller.error(error); }
    // 保留通道记录以处理迟到的 OPEN_CONFIRMATION，由会话并发上限约束数量。
    void this.sendClose().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.abort(new Error('Forwarding request finished'));
    await this.sendClose();
  }
}
