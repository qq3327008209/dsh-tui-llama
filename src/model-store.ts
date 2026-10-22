/**
 * GGUF 模型目录扫描 + 监听。
 *
 * 模型 id 统一取「文件名去掉扩展名」（如 qwen3-5-4B-Q4_K_M），两个策略共用：
 *   - single：`-m <绝对路径>` 启动，llama.cpp 的请求体 model 字段不校验具体值
 *   - router：`--models-dir` + `POST /models/load {model: "<id>.gguf"}`
 *
 * 不做 mmproj 视觉投影配对。
 */
import { readdirSync, statSync, watch as fsWatch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { expandPath } from './config.js';

export interface ModelInfo {
  /** 文件名去扩展名，作为 dsh 侧的 provider model id。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 绝对路径。 */
  file: string;
  /** 字节数。 */
  size: number;
}

/** 轮询兜底间隔。fs.watch 在 Windows 上不覆盖目录内容变化，必须配。 */
const POLL_MS = 30_000;

export class ModelStore {
  private dir: string;
  private all: ModelInfo[] = [];
  private watchers: ReturnType<typeof fsWatch>[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  private scanning = false;
  private lastHash = '';
  private disposed = false;

  constructor(dir: string) {
    this.dir = expandPath(dir);
  }

  get directory(): string {
    return this.dir;
  }

  models(): ModelInfo[] {
    return [...this.all];
  }

  get(id: string): ModelInfo | undefined {
    return this.all.find((m) => m.id === id);
  }

  has(id: string): boolean {
    return this.all.some((m) => m.id === id);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 全量扫描。幂等，可并发调用（内部去重）。 */
  async refresh(): Promise<ModelInfo[]> {
    if (this.scanning) return this.all;
    this.scanning = true;
    try {
      const next = await scanGguf(this.dir);
      const hash = next.map((m) => `${m.id}:${m.size}`).join('|');
      if (hash !== this.lastHash) {
        this.lastHash = hash;
        this.all = next;
        this.emit();
      }
      return this.all;
    } finally {
      this.scanning = false;
    }
  }

  /** 防抖扫描：目录里批量写文件时不重复扫。 */
  refreshSoon(delayMs = 500): void {
    if (this.disposed) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      void this.refresh().catch(() => undefined);
    }, delayMs);
    this.scanTimer.unref?.();
  }

  /** 建立 fs.watch + 轮询兜底。目录可能尚不存在，失败时静默。 */
  watch(): void {
    this.disposeWatchers();
    try {
      const w = fsWatch(this.dir, { persistent: false }, () => this.refreshSoon(500));
      w.on('error', () => undefined);
      this.watchers.push(w);
    } catch {
      /* 目录不存在时不建 watch，靠轮询 */
    }
    this.pollTimer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, POLL_MS);
    this.pollTimer.unref?.();
  }

  /** 换目录并重新建立监听。 */
  reconfigure(dir: string): void {
    this.dir = expandPath(dir);
    this.disposeWatchers();
    this.all = [];
    this.lastHash = '';
    this.watch();
    void this.refresh().catch(() => undefined);
  }

  private disposeWatchers(): void {
    for (const w of this.watchers) {
      try { w.close(); } catch { /* 忽略 */ }
    }
    this.watchers = [];
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = undefined; }
  }

  dispose(): void {
    this.disposed = true;
    this.disposeWatchers();
    this.listeners.clear();
    this.all = [];
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* 单个监听器异常不扩散 */ }
    }
  }
}

async function scanGguf(dir: string): Promise<ModelInfo[]> {
  let entries: string[];
  try {
    entries = readdirSync(dir, 'utf8');
  } catch {
    return [];
  }
  const out: ModelInfo[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.gguf')) continue;
    const file = join(dir, entry);
    try {
      const size = statSync(file).size;
      const id = basename(entry, '.gguf');
      out.push({ id, name: id, file, size });
    } catch {
      /* 读不到的单个文件跳过 */
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 人类可读的模型大小。 */
export function prettyBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 目录的上级路径，供「返回上层」类 UI 用。 */
export function parentOf(dir: string): string {
  return dirname(dir);
}
