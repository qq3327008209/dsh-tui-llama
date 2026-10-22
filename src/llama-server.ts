/**
 * llama.cpp 进程管理器。
 *
 * argv 构造约定：
 *   - 采样参数（--temp/--top-p/--top-k/--min-p/--repeat-penalty/--seed）只能作为
 *     启动参数，dsh 的 GenerateOptions 里没有这些字段。
 *   - `--no-ui`（`--no-webui` 在较新版本已弃用）。
 *   - `--api-key` 不设会告警 "CORS allows all origins"。
 *   - 启动前探测端口，占用则 fail-fast，不重试。
 *
 * 关停：spawn() 拿到的 PID 就是监听进程，`handle.terminate()` 单点即可，
 * 不需要 taskkill 或反查真实 PID。Job Object 由 dsh-subprocess-local 兜底。
 */
import { readFileSync, unlinkSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawn as cpSpawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect as netConnect } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import type { LlamaConfig } from './config.js';
import { PID_REL, TERMINATE_GRACE_MS, expandPath, llamaHeaders } from './config.js';
import type { ModelInfo } from './model-store.js';
import { LogHub, stripAnsi } from './log-hub.js';

/* ---------------- 句柄形状（与 @deepseek-ai/dsh-subprocess/types 对齐） ---------------- */

interface CollectReader {
  readFrom(fromByte: number): { text: string; nextOffset: number };
}
interface CollectOutputs {
  stdout?: CollectReader;
  stderr?: CollectReader;
}
interface ProcOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}
/** spawn() 模式句柄。 */
interface SubHandle {
  readonly stdin: Writable | undefined;
  readonly collected: CollectOutputs;
  readonly done: Promise<ProcOutcome>;
  terminate(): void;
  waitForExit(signal?: AbortSignal): Promise<boolean>;
}
/** spawnTerminal() 模式句柄。 */
interface TermHandle {
  readonly pid: number;
  readonly output: Readable;
  readonly done: Promise<ProcOutcome>;
  write(data: string): Promise<void>;
  signalForeground(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<number>;
  terminate(): Promise<void>;
}
interface TerminalSpec {
  argv: readonly string[];
  cwd: string;
  rows: number;
  cols: number;
  terminalType: string;
  graceMs: number;
}
interface SubprocessSpec {
  argv: readonly string[];
  cwd: string;
  stdio: {
    stdin: 'ignore' | 'pipe' | { data: string };
    stdout: 'pipe' | 'inherit' | { maxBytes: number };
    stderr: 'pipe' | 'inherit' | { maxBytes: number };
  };
  graceMs: number;
}
/** ctx.subprocess 的最小结构面。 */
export interface SubprocessRuntime {
  spawn(spec: SubprocessSpec): SubHandle;
  spawnTerminal?(spec: TerminalSpec): Promise<TermHandle>;
}
export interface PluginCtx {
  subprocess: SubprocessRuntime | undefined;
  logger?: { warn(msg: unknown): void; error(msg: unknown): void } | undefined;
}

export type ServerPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'error';
export type ServerMode = 'single' | 'router';
export interface ServerStatus {
  phase: ServerPhase;
  modelId?: string;
  pid?: number;
  loaded?: string[];
  error?: string;
  mode?: ServerMode;
  contextLength?: number;
  spawnKind?: 'terminal' | 'collect';
  strategy?: 'single' | 'router';
}

/* ---------------- 本地子进程回退 ---------------- */

/**
 * 用 `node:child_process.spawn` 实现同一个 SubprocessRuntime 接口，
 * 在宿主没有提供 subprocess 服务时兜底。
 *
 * 宿主实现额外做 Job Object 归属，本插件自己负责停进程，少一个 Job Object
 * 是可接受代价。只实现 `spawn()`、不实现 `spawnTerminal()`：`startProcess()`
 * 在 `spawnTerminal` 缺失时走管道模式，那正是想要的（llama-server 配 --no-ui）。
 */
class StreamCollector implements CollectReader {
  private parts: Uint8Array[] = [];
  private total = 0;

  push(chunk: Uint8Array): void {
    this.parts.push(chunk);
    this.total += chunk.length;
  }

  readFrom(fromByte: number): { text: string; nextOffset: number } {
    const start = Math.max(0, Math.min(fromByte, this.total));
    if (start >= this.total) return { text: '', nextOffset: this.total };
    const pieces: Uint8Array[] = [];
    let acc = 0;
    for (const part of this.parts) {
      const end = acc + part.length;
      if (end <= start) {
        acc = end;
        continue;
      }
      pieces.push(part.subarray(Math.max(0, start - acc)));
      acc = end;
    }
    return { text: Buffer.concat(pieces).toString('utf8'), nextOffset: this.total };
  }
}

export function localSubprocess(): SubprocessRuntime {
  return {
    spawn(spec): SubHandle {
      const child = cpSpawn(spec.argv[0] ?? '', [...spec.argv.slice(1)], {
        cwd: spec.cwd,
        stdio: [
          spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
          spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe',
          spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe',
        ],
        env: process.env,
      });

      const stdout = new StreamCollector();
      const stderr = new StreamCollector();
      if (child.stdout) child.stdout.on('data', (c) => stdout.push(c as Buffer));
      if (child.stderr) child.stderr.on('data', (c) => stderr.push(c as Buffer));

      let doneResolve!: (r: ProcOutcome) => void;
      const done = new Promise<ProcOutcome>((r) => {
        doneResolve = r;
      });
      child.on('error', (err) => {
        stderr.push(Buffer.from(`[spawn error] ${err.message}\n`));
      });
      child.on('exit', (code, signal) => doneResolve({ exitCode: code, signal }));

      return {
        stdin: (child.stdin ?? undefined) as Writable | undefined,
        collected: { stdout, stderr },
        done,
        terminate(): void {
          try {
            child.kill('SIGTERM');
          } catch {
            /* 已退出 */
          }
        },
        async waitForExit(signal?: AbortSignal): Promise<boolean> {
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                try {
                  child.kill('SIGKILL');
                } catch {
                  /* 已退出 */
                }
              },
              { once: true },
            );
          }
          await done;
          return true;
        },
      };
    },
  };
}

/* ---------------- 收集模式输出读取器 ---------------- */

/** 把 collect 输出读进日志缓冲：offset 由本管理器独占推进。 */
class LineDrain {
  private buffer = '';
  private offset = 0;
  constructor(
    private readonly reader: CollectReader,
    private readonly onLines: (lines: string[], stream: 'stdout' | 'stderr') => void,
  ) {}

  poll(): void {
    let read: { text: string; nextOffset: number };
    try {
      read = this.reader.readFrom(this.offset);
    } catch {
      return; // 进程已退出的尾部读取失败，忽略
    }
    this.offset = read.nextOffset;
    if (!read.text) return;
    this.buffer += read.text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const flushed = lines.map((l) => stripAnsi(l)).filter((l) => l.trim() !== '');
    if (flushed.length > 0) this.onLines(flushed, 'stdout');
  }
}

/* ---------------- 管理器 ---------------- */

export class LlamaServerManager {
  /** 终端输出总线（状态栏/控制台数据源）。 */
  readonly logs = new LogHub();

  status: ServerStatus = { phase: 'idle', strategy: 'single' };
  private handle?: SubHandle;
  private terminal?: TermHandle;
  private spawnKind: 'terminal' | 'collect' = 'collect';
  private listeners = new Set<(status: ServerStatus, line?: string) => void>();
  private drainTimer?: ReturnType<typeof setInterval>;
  private stdoutDrain?: LineDrain;
  private stderrDrain?: LineDrain;
  private busy?: Promise<unknown>;
  private disposed = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private lastPidFile = '';

  constructor(
    private readonly ctx: PluginCtx,
    private readonly cfg: () => LlamaConfig,
    private readonly resolve: (id: string) => ModelInfo | undefined,
    /** 目录里的模型（排序后）。`ensure()` 无参调用时用它选第一个 —— autoStart 需要。 */
    private readonly list?: () => ModelInfo[],
  ) {}

  /* ---------- 查询 ---------- */

  getStatus(): ServerStatus {
    return { ...this.status, loaded: this.status.loaded ? [...this.status.loaded] : undefined };
  }

  logTail(lines = 200): string[] {
    return this.logs.tail(lines).map((e) => e.text);
  }

  subscribe(fn: (status: ServerStatus, line?: string) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 端口是否已被监听（同步探测，300ms 上限）。 */
  static probePort(host: string, port: number): boolean {
    let socket: ReturnType<typeof netConnect> | undefined;
    let open = false;
    try {
      // `0.0.0.0` 是绑定地址不是连接地址，探测要落到回环上。
      const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      socket = netConnect({ host: target, port });
      socket.on('connect', () => {
        open = true;
      });
      socket.on('error', () => undefined);
      const started = Date.now();
      let last = Date.now();
      // 同步自旋：只在本方法内部短暂阻塞，不阻塞 event loop 之外的调用方。
      while (Date.now() - started < 300 && !open) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        const now = Date.now();
        if (now - last >= 20) last = now;
      }
    } finally {
      try {
        socket?.destroy();
      } catch {
        /* 忽略 */
      }
    }
    return open;
  }

  /* ---------- 生命周期 ---------- */

  /** 串行化所有会改变进程状态的操作。 */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const prev = this.busy ?? Promise.resolve();
    const next = prev.then(op, op);
    this.busy = next.then(() => undefined, () => undefined);
    return next;
  }

  private setStatus(patch: Partial<ServerStatus>, line?: string): void {
    this.status = { ...this.status, ...patch };
    for (const fn of [...this.listeners]) {
      try {
        fn(this.getStatus(), line);
      } catch {
        /* 单个监听器异常不扩散 */
      }
    }
  }

  pushLines(lines: string[]): void {
    if (lines.length === 0) return;
    this.logs.appendLines('system', lines);
    const last = lines[lines.length - 1];
    for (const fn of [...this.listeners]) {
      try {
        fn(this.getStatus(), last);
      } catch {
        /* 忽略 */
      }
    }
  }

  private resetStatus(): void {
    this.setStatus({
      phase: 'idle',
      modelId: undefined,
      pid: undefined,
      loaded: [],
      error: undefined,
      mode: undefined,
      contextLength: undefined,
    });
  }

  /** 停止（幂等）。 */
  stop(): Promise<void> {
    return this.run(() => this.stopInner());
  }

  /**
   * 请求到达 OpenAI 端口前保证「目标模型已就绪」。
   * 未运行 → 启动；运行但模型不匹配 → 先停后启（都在真正发请求之前完成）。
   */
  ensure(modelId?: string): Promise<void> {
    if (modelId && !this.resolve(modelId)) {
      return Promise.reject(new Error(`[local-llama] 未知模型: ${modelId}`));
    }
    this.resetIdleTimer();
    return this.run(async () => {
      const s = this.status;
      if (s.phase === 'running') {
        if (!modelId || s.modelId === modelId) return;
      } else if (s.phase === 'starting') {
        if (!modelId || s.modelId === modelId) await this.waitRunningOrModel(modelId ?? '');
        return;
      }
      if (s.pid !== undefined || this.handle || this.terminal) {
        this.pushLines([`[manager] 切换模型：先停止 ${s.modelId ?? '上一进程'}（pid ${s.pid ?? ''}）`]);
        await this.stopInner();
      }
      const cfg = this.cfg();
      // 无参调用（autoStart / 请求体 model 缺失）时取目录里排序最前的一份。
      const want = modelId ?? this.list?.()[0]?.id;
      if (cfg.strategy === 'router') {
        this.pushLines([`[manager] 启动 router（--models-dir，免重启热切模型）`]);
        await this.spawnRouter();
        await this.waitHttpReady(cfg.startTimeoutMs).then((ok) => {
          if (!ok) throw new Error(`llama.cpp router 未在 ${cfg.startTimeoutMs}ms 内就绪`);
        });
        this.setStatus({ phase: 'running', modelId: want ?? s.modelId });
        if (want) void this.apiLoad(want).catch((err) => this.noteError(err));
      } else {
        const model = want ? this.resolve(want) : undefined;
        if (!model) throw new Error('[local-llama] 模型目录为空，无法启动。请在 /settings 检查 modelsDir');
        this.pushLines([`[manager] 先前模型已停止，开始启动 ${model.id}`]);
        await this.spawnSingle(model);
      }
    });
  }

  /** 启动前处理孤儿：同端口上的残留进程先给它一个就绪窗口，否则杀掉。 */
  private async startup(): Promise<void> {
    const cfg = this.cfg();
    if (LlamaServerManager.probePort(cfg.host, cfg.port)) {
      const stale = this.readPidFile();
      if (stale) {
        this.pushLines([`[manager] 检测到上次的进程 pid ${stale.pid} 仍在监听 :${cfg.port}，等待其就绪…`]);
        if (await this.waitHttpReady(cfg.startTimeoutMs)) {
          this.setStatus({ phase: 'running', pid: stale.pid, mode: 'single' });
          this.pushLines(['[manager] 已采纳仍在运行的旧进程']);
          return;
        }
        this.pushLines([`[manager] 端口被占用且服务不可用，先终止 pid ${stale.pid}`]);
        this.killProcess(stale.pid);
        await new Promise((r) => setTimeout(r, 300));
      } else {
        throw new Error(
          `[local-llama] 端口 ${cfg.port} 已被占用且不是本插件启动的进程（无 pid 记录）。` +
            `请在 /settings 改 port，或先手动结束占用进程。`,
        );
      }
    }
  }

  private killSync(): void {
    const h = this.handle;
    const t = this.terminal;
    try {
      h?.terminate();
    } catch {
      /* 忽略 */
    }
    try {
      void t?.terminate().catch(() => undefined);
    } catch {
      /* 忽略 */
    }
    this.unlinkPidFile();
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.clearDrain();
    const h = this.handle;
    const t = this.terminal;
    this.handle = undefined;
    this.terminal = undefined;
    this.killSync();
    this.listeners.clear();
    this.logs.dispose();
    this.status = { phase: 'idle' };
  }

  private noteError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.pushLines([`[manager] ${msg}`]);
    this.setStatus({ phase: 'error', error: msg });
  }

  private waitRunningOrModel(modelId: string): Promise<void> {
    const start = Date.now();
    const timeout = this.cfg().startTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      const tick = async () => {
        if (this.disposed) return reject(new Error('manager disposed'));
        const s = this.status;
        if (s.phase === 'running' && (!modelId || s.modelId === modelId)) return resolve();
        if (s.phase === 'error') return reject(new Error(s.error ?? 'server failed'));
        if (Date.now() - start > timeout) return reject(new Error(`llama.cpp 启动超时（${timeout}ms）`));
        await new Promise((r) => setTimeout(r, 250));
        void tick();
      };
      void tick();
    });
  }

  /* ---------- argv 组装 ---------- */

  private commonArgs(): string[] {
    const cfg = this.cfg();
    const argv: string[] = ['--host', cfg.host, '--port', String(cfg.port)];
    if (cfg.ctxSize > 0) argv.push('--ctx-size', String(cfg.ctxSize));
    if (cfg.gpuLayers > 0) argv.push('-ngl', String(cfg.gpuLayers));
    if (cfg.threads > 0) argv.push('-t', String(cfg.threads));
    if (cfg.threadsBatch > 0) argv.push('-tb', String(cfg.threadsBatch));
    if (cfg.batchSize > 0) argv.push('-b', String(cfg.batchSize));
    if (cfg.flashAttn !== 'auto') argv.push('--flash-attn', cfg.flashAttn);
    if (cfg.cacheTypeK) argv.push('-ctk', cfg.cacheTypeK);
    if (cfg.cacheTypeV) argv.push('-ctv', cfg.cacheTypeV);
    argv.push('--temp', String(cfg.temperature));
    argv.push('--top-p', String(cfg.topP));
    if (cfg.topK > 0) argv.push('--top-k', String(cfg.topK));
    if (cfg.minP > 0) argv.push('--min-p', String(cfg.minP));
    argv.push('--repeat-penalty', String(cfg.repeatPenalty));
    if (cfg.seed >= 0) argv.push('-s', String(cfg.seed));
    if (cfg.noUi) argv.push('--no-ui');
    if (cfg.apiKey) argv.push('--api-key', cfg.apiKey);
    return argv;
  }

  private async spawnSingle(model: ModelInfo): Promise<void> {
    const cfg = this.cfg();
    const argv = [expandPath(cfg.executable), '-m', model.file, ...this.commonArgs()];
    await this.doSpawn(argv, 'single', model.id, cfg.ctxSize > 0 ? cfg.ctxSize : undefined);
  }

  private async spawnRouter(): Promise<void> {
    const cfg = this.cfg();
    const argv = [
      expandPath(cfg.executable),
      '--models-dir',
      expandPath(cfg.modelsDir),
      '--no-models-autoload',
      ...this.commonArgs(),
    ];
    await this.doSpawn(argv, 'router', undefined, cfg.ctxSize > 0 ? cfg.ctxSize : undefined);
  }

  private async doSpawn(argv: string[], mode: ServerMode, modelId: string | undefined, ctx: number | undefined): Promise<void> {
    const cfg = this.cfg();
    const exe = expandPath(cfg.executable).trim();
    if (!exe) {
      throw new Error('[local-llama] 未配置 llama-server 可执行文件。在 /settings → 本地模型 填 executable（自动发现会给候选）');
    }
    if (!existsSync(exe)) {
      throw new Error(`[local-llama] llama-server 不存在: ${exe}（在 /settings → 本地模型 修改 executable）`);
    }
    if (mode === 'single' && !statSync(exe).isFile()) {
      throw new Error(`[local-llama] executable 不是文件: ${exe}`);
    }

    this.status = { ...this.status, strategy: cfg.strategy };
    this.setStatus({
      phase: 'starting',
      modelId,
      pid: undefined,
      error: undefined,
      loaded: [],
      mode,
      contextLength: ctx,
    });
    this.pushLines([`[manager] starting ${mode === 'router' ? 'llama.cpp router' : `llama.cpp with ${modelId ?? ''}`}`]);
    this.pushLines([`[manager] context: ${ctx ? String(ctx) : 'llama.cpp 默认'}`]);

    await this.startup();
    const spawned = await this.startProcess(argv);
    this.setStatus({ pid: spawned.pid });
    if (spawned.pid !== undefined) this.writePidFile(spawned.pid, cfg.host, cfg.port, modelId);
    if (cfg.debug) this.pushLines([`[manager] exec: ${argv.join(' ')}`]);

    void spawned.done.then(
      (outcome) => {
        this.clearDrain();
        this.handle = undefined;
        this.terminal = undefined;
        this.unlinkPidFile();
        const code = outcome.exitCode ?? `signal:${outcome.signal ?? '?'}`;
        this.pushLines([`[manager] server process exited (${code})`]);
        if (this.status.phase === 'starting' || this.status.phase === 'running') {
          this.setStatus({ phase: 'error', modelId: undefined, pid: undefined, error: `llama.cpp 意外退出 (${code})` });
        }
      },
      (err) => {
        this.pushLines([`[manager] spawn/transport failure: ${String(err)}`]);
        if (this.status.phase === 'starting') this.setStatus({ phase: 'error', error: String(err) });
      },
    );

    const ready = await this.waitHttpReady(cfg.startTimeoutMs);
    if (!ready) {
      await this.stopInner();
      throw new Error(`llama.cpp 未在 ${cfg.startTimeoutMs}ms 内在 http://${cfg.host}:${cfg.port} 就绪`);
    }
    if (!this.handle && !this.terminal) {
      throw new Error('llama.cpp 在启动过程中已退出，请查看上方日志');
    }
    this.setStatus({ phase: 'running' });
    this.pushLines([`[manager] ready on http://${cfg.host}:${cfg.port} (${mode})`]);
  }

  /* ---------- 进程启动（终端优先，管道回退） ---------- */

  private async startProcess(argv: string[]): Promise<{ pid?: number; done: Promise<ProcOutcome> }> {
    const subprocess = this.ctx.subprocess;
    if (!subprocess) {
      throw new Error('[local-llama] 本 profile 未挂载 subprocess 服务，无法拉起 llama-server');
    }

    if (typeof subprocess.spawnTerminal === 'function') {
      try {
        const handle = await subprocess.spawnTerminal({
          argv,
          cwd: process.cwd(),
          rows: 40,
          cols: 120,
          terminalType: 'xterm-256color',
          graceMs: TERMINATE_GRACE_MS,
        });
        this.terminal = handle;
        this.spawnKind = 'terminal';
        this.attachTerminalOutput(handle.output);
        this.pushLines(['[manager] 已分配终端（支持 Ctrl+C / Y 交互退出）']);
        this.setStatus({ spawnKind: 'terminal' });
        return { pid: handle.pid, done: handle.done };
      } catch (err) {
        this.pushLines([`[manager] 终端分配失败，回退管道模式：${String(err)}`]);
      }
    }

    const handle = subprocess.spawn({
      argv,
      cwd: process.cwd(),
      stdio: {
        stdin: 'pipe',
        stdout: { maxBytes: 256 * 1024 },
        stderr: { maxBytes: 256 * 1024 },
      },
      graceMs: TERMINATE_GRACE_MS,
    });
    this.handle = handle;
    this.spawnKind = 'collect';
    this.setStatus({ spawnKind: 'collect' });
    if (handle.collected.stdout) {
      this.stdoutDrain = new LineDrain(handle.collected.stdout, (ls, stream) => this.pushLines(ls.map((l) => `[${stream}] ${l}`)));
    }
    if (handle.collected.stderr) {
      this.stderrDrain = new LineDrain(handle.collected.stderr, (ls, stream) => this.pushLines(ls.map((l) => `[${stream}] ${l}`)));
    }
    this.drainTimer = setInterval(() => {
      this.stdoutDrain?.poll();
      this.stderrDrain?.poll();
    }, 150);
    this.drainTimer.unref?.();
    return { pid: undefined, done: handle.done };
  }

  private attachTerminalOutput(output: Readable): void {
    let buffer = '';
    const onData = (chunk: unknown) => {
      buffer += stripAnsi(String(chunk));
      const parts = buffer.split(/\r\n|\n|\r/);
      buffer = parts.pop() ?? '';
      const lines = parts.filter((l) => l.trim() !== '');
      if (lines.length > 0) this.pushLines(lines);
    };
    const onEnd = () => {
      if (buffer.trim()) this.pushLines([buffer.trim()]);
      buffer = '';
    };
    output.on('data', onData);
    output.on('end', onEnd);
  }

  /* ---------- 优雅退出：Ctrl+C → Y 确认（不走直杀） ---------- */

  private sendCtrlC(): void {
    const term = this.terminal;
    if (term) {
      void term.signalForeground('SIGINT').then(
        (pgid) => this.pushLines([`[manager] 已向终端前台进程组 ${pgid} 发送 SIGINT（= Ctrl+C）`]),
        (err) => this.pushLines([`[manager] 发送 SIGINT 失败：${String(err)}`]),
      );
      return;
    }
    const pid = this.status.pid;
    if (pid && pid > 0) {
      try {
        process.kill(pid, 'SIGINT');
        this.pushLines([`[manager] 已向 pid ${pid} 发送 SIGINT（= Ctrl+C）`]);
      } catch (err) {
        this.pushLines([`[manager] SIGINT 发送失败：${String(err)}`]);
      }
    }
  }

  private writeStdin(text: string): void {
    const term = this.terminal;
    if (term) {
      void term.write(text).catch((err) => this.pushLines([`[manager] 终端写入失败：${String(err)}`]));
      return;
    }
    const stdin = this.handle?.stdin;
    if (stdin) {
      try {
        stdin.write(text);
        return;
      } catch (err) {
        this.pushLines([`[manager] stdin 写入失败：${String(err)}`]);
      }
    }
    this.pushLines(['[manager] 当前进程没有可写 stdin，无法发送 Y']);
  }

  private hasProcess(): boolean {
    return this.handle !== undefined || this.terminal !== undefined;
  }

  private async waitGone(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.hasProcess()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return !this.hasProcess();
  }

  /**
   * 优雅退出：Ctrl+C（SIGINT）→ 等确认提示 → 写 Y 回车 → 等退出；
   * 超时再补一次 Ctrl+C；最后才回退 terminate()（SIGTERM → grace → SIGKILL）。
   * 全程不直杀 SIGKILL。
   */
  gracefulStop(): Promise<{ ok: boolean; steps: string[] }> {
    return this.run(async () => {
      const steps: string[] = [];
      if (!this.hasProcess()) {
        this.pushLines(['[manager] 服务器未运行，无需退出']);
        return { ok: false, steps: ['未运行'] };
      }
      this.setStatus({ phase: 'stopping', error: undefined });
      this.pushLines(['[manager] 优雅退出：先发送 Ctrl+C …']);
      this.sendCtrlC();
      steps.push('已发送 Ctrl+C');
      await new Promise((r) => setTimeout(r, 800));
      if (!this.hasProcess()) {
        steps.push('进程已直接退出（无需 Y）');
        this.resetStatus();
        this.unlinkPidFile();
        return { ok: true, steps };
      }
      this.pushLines(['[manager] 发送 "Y" 确认退出 …']);
      this.writeStdin('Y\n');
      steps.push('已发送 Y 确认');
      if (await this.waitGone(8000)) {
        steps.push('确认后已退出');
        this.resetStatus();
        this.unlinkPidFile();
        return { ok: true, steps };
      }
      this.pushLines(['[manager] 8 秒内未退出，再补一次 Ctrl+C …']);
      this.sendCtrlC();
      steps.push('补发 Ctrl+C');
      if (await this.waitGone(5000)) {
        steps.push('补发后已退出');
        this.resetStatus();
        this.unlinkPidFile();
        return { ok: true, steps };
      }
      this.pushLines(['[manager] 仍无响应，回退 terminate()（SIGTERM → grace → SIGKILL）']);
      steps.push('回退 terminate()');
      await this.stopInner();
      return { ok: true, steps };
    });
  }

  private async stopInner(): Promise<void> {
    const h = this.handle;
    const term = this.terminal;
    this.handle = undefined;
    this.terminal = undefined;
    this.clearDrain();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (term) {
      this.setStatus({ phase: 'stopping', error: undefined });
      try {
        await term.terminate();
      } catch (err) {
        this.pushLines([`[manager] terminal terminate error: ${String(err)}`]);
      }
      this.resetStatus();
      this.unlinkPidFile();
      return;
    }
    if (!h) {
      this.resetStatus();
      this.unlinkPidFile();
      return;
    }
    this.setStatus({ phase: 'stopping', error: undefined });
    try {
      h.terminate();
      await Promise.race([h.done.catch(() => undefined), h.waitForExit().catch(() => false)]);
    } catch (err) {
      this.pushLines([`[manager] stop error: ${String(err)}`]);
    }
    this.resetStatus();
    this.unlinkPidFile();
    this.pushLines(['[manager] server stopped']);
  }

  private clearDrain(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = undefined;
    }
    this.stdoutDrain = undefined;
    this.stderrDrain = undefined;
  }

  /* ---------- idle 自动停机 ---------- */

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const ms = this.cfg().idleStopMs;
    if (!ms || ms <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.disposed) return;
      this.pushLines([`[manager] idle ${ms}ms 无请求，自动停止服务`]);
      void this.stopInner().catch(() => undefined);
    }, ms);
    this.idleTimer.unref?.();
  }

  /* ---------- HTTP ---------- */

  private async http(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<Response> {
    const cfg = this.cfg();
    const res = await fetch(`http://${cfg.host}:${cfg.port}${path}`, {
      method,
      headers: llamaHeaders(cfg),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}`);
    return res;
  }

  private async waitHttpReady(timeoutMs: number): Promise<boolean> {
    const cfg = this.cfg();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.disposed || this.status.phase === 'error') return false;
      try {
        const res = await fetch(`http://${cfg.host}:${cfg.port}/v1/models`, {
          headers: llamaHeaders(cfg),
          signal: AbortSignal.timeout(2000),
        });
        // 200 = 就绪。401 = 已在监听但拒绝了探测：说明进程起来了，
        // 只是 header 不对（老版本 llama.cpp 可能不按 --api-key 校验 /v1/models），
        // 继续等只会耗尽整个超时窗口。
        if (res.ok || res.status === 401) return true;
      } catch {
        /* 尚未监听 */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  private async probeLoaded(): Promise<string[]> {
    try {
      const res = await this.http('GET', '/v1/models', undefined, 2000);
      const body = (await res.json()) as { data?: { id?: string }[] };
      return (body.data ?? []).map((d) => d.id ?? '').filter(Boolean);
    } catch {
      return [];
    }
  }

  /** router 模式动态加载：卸载其它 → POST /models/load → 轮询直到目标 loaded。 */
  async apiLoad(modelId: string): Promise<void> {
    const cfg = this.cfg();
    const model = this.resolve(modelId);
    if (!model) throw new Error(`未知模型: ${modelId}`);
    const fileName = `${model.id}.gguf`;
    this.setStatus({ phase: 'starting', modelId, error: undefined });
    this.pushLines([`[manager] api load ${fileName} …`]);
    try {
      const current = await this.probeLoaded();
      for (const id of current) {
        if (this.matchesModel(id, model.id, fileName)) continue;
        await this.http('POST', '/models/unload', { model: this.fileNameFor(id) }).catch(() => undefined);
      }
      await this.http('POST', '/models/load', { model: fileName });
      const deadline = Date.now() + cfg.startTimeoutMs;
      while (Date.now() < deadline) {
        if (this.disposed) throw new Error('manager disposed');
        const loaded = await this.probeLoaded();
        if (loaded.some((id) => this.matchesModel(id, model.id, fileName))) {
          this.setStatus({ phase: 'running', modelId, loaded });
          this.pushLines([`[manager] model ${model.id} loaded (api)`]);
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`model ${model.id} 未在 ${cfg.startTimeoutMs}ms 内完成加载`);
    } catch (err) {
      this.pushLines([`[manager] api load 失败（${String(err)}），回退单模型启动`]);
      await this.stopInner();
      await this.spawnSingle(model);
    }
  }

  private matchesModel(reported: string, id: string, fileName: string): boolean {
    return reported === id || reported === fileName || reported.endsWith(`/${fileName}`);
  }

  private fileNameFor(reported: string): string {
    const base = reported.split('/').pop() ?? reported;
    return base.endsWith('.gguf') ? base : `${base}.gguf`;
  }

  /* ---------- PID 文件（第三层关停保险） ---------- */

  private pidFilePath(): string {
    return join(homedir(), PID_REL);
  }

  private writePidFile(pid: number, host: string, port: number, modelId?: string): void {
    const path = this.pidFilePath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ pid, host, port, modelId, startedAt: new Date().toISOString() }), 'utf8');
      this.lastPidFile = path;
    } catch (err) {
      this.pushLines([`[manager] pid 文件写入失败：${String(err)}`]);
    }
  }

  private unlinkPidFile(): void {
    try {
      unlinkSync(this.pidFilePath());
    } catch {
      /* 已不存在 */
    }
  }

  private readPidFile(): { pid: number; host: string; port: number } | undefined {
    try {
      const raw = readFileSync(this.pidFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as { pid?: unknown; host?: unknown; port?: unknown };
      if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return undefined;
      return { pid: parsed.pid, host: String(parsed.host ?? 'localhost'), port: parsed.port };
    } catch {
      return undefined;
    }
  }

  private killProcess(pid: number): void {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 进程已不在 */
      }
    }
  }
}
