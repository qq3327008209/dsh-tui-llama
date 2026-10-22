/**
 * llama-server 输出环形缓冲。终端日志量不小，只保留尾部，避免常驻内存无限增长。
 */
export type LogStream = 'stdout' | 'stderr' | 'terminal' | 'system';

export interface LogEntry {
  stream: LogStream;
  text: string;
  /** 单调递增序号，供增量读取。 */
  seq: number;
}

export class LogHub {
  private readonly cap: number;
  private entries: LogEntry[] = [];
  private tailSeq = 0;
  private seq = 0;

  constructor(cap = 4000) {
    this.cap = cap;
  }

  appendLines(stream: LogStream, lines: string[]): void {
    if (lines.length === 0) return;
    for (const raw of lines) {
      const text = stripAnsi(raw);
      if (!text.trim()) continue;
      this.entries.push({ stream, text: text.slice(0, 2000), seq: ++this.seq });
    }
    if (this.entries.length > this.cap) {
      this.entries = this.entries.slice(-this.cap);
    }
    this.tailSeq = this.entries.length;
  }

  /** 最近 N 行，新行在后。 */
  tail(n = 200): LogEntry[] {
    return this.entries.slice(-n);
  }

  /** 从 offset 起的增量行；nextOffset 由调用方独占推进。 */
  readFrom(offset: number): { text: string; nextOffset: number } {
    const from = Math.max(0, Math.min(offset, this.entries.length));
    const slice = this.entries.slice(from);
    if (slice.length === 0) return { text: '', nextOffset: from };
    return { text: slice.map((e) => e.text).join('\n') + '\n', nextOffset: this.entries.length };
  }

  dispose(): void {
    this.entries = [];
    this.tailSeq = 0;
  }
}

/** 去掉终端输出里的 ANSI 控制序列（颜色、光标、OSC 标题等）。 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '');
}
