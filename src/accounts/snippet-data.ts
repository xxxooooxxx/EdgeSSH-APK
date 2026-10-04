export interface SnippetInput {
  name: string;
  command: string;
}

export interface Snippet extends SnippetInput {
  id: string;
  updatedAt: number;
}

// 只提供少量查看类命令，不预置会修改系统或需要提权的操作。
export const DEFAULT_SNIPPETS: readonly SnippetInput[] = [
  { name: '查看当前目录', command: 'pwd' },
  { name: '列出文件（含隐藏文件）', command: 'ls -lah' },
  { name: '查看磁盘空间', command: 'df -h' },
  { name: '查看目录大小', command: 'du -sh ./*' },
  { name: '查看内存使用', command: 'free -h' },
  { name: '查看系统负载', command: 'uptime' },
  { name: '查看 CPU 占用最高的进程', command: 'ps aux --sort=-%cpu | head -n 11' },
  { name: '查看监听端口', command: 'ss -tuln' },
  { name: '查看 IP 地址', command: 'ip -brief address' },
  { name: '查看系统与内核', command: 'uname -a' },
];
