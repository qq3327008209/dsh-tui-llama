/**
 * 端到端烟测：不启动 dsh / TUI，直接调 dist/index.js 的 apply()。
 *
 * 用一个 node child_process 写的假 subprocess seam 真的拉起 llama-server.exe，
 * 然后走 adapter.listModels() + adapter.stream() —— 即 dsh 内部
 * listProviders()/listModels()/prepareCall().stream() 的同一条路径。
 *
 * 用法：node test/smoke.mjs
 * 验证三件事：
 *   1. apply() 不抛，provider 注册成功
 *   2. listModels() 能列出 GGUF
 *   3. stream() 真的从本地 llama.cpp 流出内容
 *   4. disposer 调用后进程真的退出
 */
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(pathToFileURL(resolve(ROOT, 'dist/index.js')).href);

/* ---------------- 假 subprocess seam（对齐 llama-server.ts 的结构面） ---------------- */

class Collector {
  constructor() {
    this.buf = '';
    this.closed = false;
  }
  push(chunk) {
    this.buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  }
  end() {
    this.closed = true;
  }
  readFrom(fromByte) {
    const n = Math.max(0, fromByte);
    const text = this.buf.slice(n);
    return { text, nextOffset: this.buf.length };
  }
}

function makeSubprocess() {
  const children = new Map();
  const spawned = []; // { argv, stderrText } —— 失败时用来诊断
  return {
    get childCount() {
      return children.size;
    },
    spawn(spec) {
      const cmd = spec.argv[0];
      const args = spec.argv.slice(1);
      const child = spawn(cmd, args, {
        cwd: spec.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      const stdout = new Collector();
      const stderr = new Collector();
      const record = { argv: spec.argv.join(' '), stderr: () => stderr.buf };
      spawned.push(record);
      let doneRes;
      const done = new Promise((r) => (doneRes = r));
      child.stdout.on('data', (d) => stdout.push(d));
      child.stderr.on('data', (d) => stderr.push(d));
      child.stdout.on('close', () => stdout.end());
      child.stderr.on('close', () => stderr.end());
      child.on('error', (err) => {
        stderr.push(`\n[spawn error] ${err.message}\n`);
      });
      child.on('exit', (exitCode, signal) => {
        stdout.end();
        stderr.end();
        doneRes({ exitCode, signal });
      });
      children.set(cmd, child);
      return {
        stdin: child.stdin,
        collected: { stdout, stderr },
        done,
        terminate() {
          try {
            child.kill('SIGTERM');
          } catch {
            /* 已退出 */
          }
        },
        async waitForExit(signal) {
          if (signal) signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
          await done;
          return true;
        },
      };
    },
    listChildren() {
      return [...children.values()].map((c) => ({ pid: c.pid, exited: c.exitCode !== null || c.signalCode !== null }));
    },
    spawned,
  };
}

/* ---------------- 假 ctx ---------------- */

const subprocess = makeSubprocess();
const logLines = [];
const logger = {
  warn: (msg) => logLines.push(`warn  ${typeof msg === 'string' ? msg : safe(msg)}`),
  error: (msg) => logLines.push(`error ${typeof msg === 'string' ? msg : safe(msg)}`),
};

let registered = null;
let sections = [];
let shortcuts = [];
let statuses = [];
const listeners = {};

const ctx = {
  subprocess,
  logger,
  settings: undefined,
  llm: {
    registerAdapter(providers, adapter) {
      registered = { providers, adapter };
      return () => {
        registered = null;
      };
    },
    listProviders() {
      return registered ? [{ id: registered.providers[0], name: 'local' }] : [];
    },
  },
  tuiStatus: {
    set(key, text, identity) {
      statuses.push({ key, text });
      return () => undefined;
    },
  },
  tuiShortcuts: {
    register(combo, options) {
      shortcuts.push({ combo, ...options });
      return () => undefined;
    },
  },
  tuiSettingsSections: {
    register(section) {
      sections.push(section);
      return () => undefined;
    },
  },
  on(topic, listener) {
    (listeners[topic] ??= []).push(listener);
    return () => {
      listeners[topic] = (listeners[topic] || []).filter((l) => l !== listener);
    };
  },
};

function safe(v) {
  try {
    return JSON.stringify(v)?.slice(0, 400);
  } catch {
    return String(v).slice(0, 400);
  }
}

/* ---------------- 跑 ---------------- */

const started = Date.now();
const step = (label) => console.log(`\n━━━ ${label}  (+${((Date.now() - started) / 1000).toFixed(1)}s) ━━━`);

step('1. apply()');
const entryConfig = {
  executable: 'D:\\llama\\llama-server.exe',
  modelsDir: 'D:\\llama\\models',
  host: '127.0.0.1',
  port: 8642,
  ctxSize: 8192,
  gpuLayers: 999,
  autoStart: false, // 我们手动触发，先看 listModels
  debug: true,
  startTimeoutMs: 90_000, // 本机实测 2s 就绪，给足余量避免误判
};

/** 失败时把 llama-server 的 argv + stderr 打出来，定位"为什么没就绪"。 */
function dumpSpawned() {
  for (const s of subprocess.spawned) {
    console.log('\n── argv ──');
    console.log(s.argv);
    const err = s.stderr();
    console.log('── stderr（末 30 行）──');
    console.log(err.trim().split('\n').slice(-30).join('\n'));
  }
}
const dispose = mod.apply(ctx, entryConfig);
console.log('name      =', mod.name);
console.log('Config    =', typeof mod.Config, '(undefined 是对的：不导出，见 index.ts 注释)');
console.log('provider  =', registered?.providers);
console.log('sections  =', sections.map((s) => `${s.ns}  组=${(s.groups ?? []).map((g) => g.id).join(',')}  字段=${s.fields?.length ?? 0}`));
console.log('shortcuts =', shortcuts.map((s) => s.combo));
if (!registered) {
  console.error('FAIL: provider 没注册上。日志：');
  logLines.forEach((l) => console.error('  ', l));
  process.exit(1);
}
if (sections.length === 0) {
  console.error('FAIL: 设置区没注册 —— /settings 里不会有本地模型面板');
  logLines.forEach((l) => console.error('  ', l));
  process.exit(1);
}
if (shortcuts.length === 0) {
  console.error('FAIL: 快捷键没注册 —— alt+l 不会生效');
  logLines.forEach((l) => console.error('  ', l));
  process.exit(1);
}
const adapter = registered.adapter;

step('2. listModels()（/model 选择器的数据源）');
// apply() 是异步扫描目录的，等它落地
let models = [];
for (let i = 0; i < 60 && models.length === 0; i++) {
  models = await adapter.listModels('llama-local');
  if (models.length === 0) await new Promise((r) => setTimeout(r, 250));
}
console.log(models.map((m) => `${m.provider}/${m.id}  ${m.name}`).join('\n'));
if (models.length === 0) {
  console.error('FAIL: 模型列表为空 —— /model 里不会出现任何条目');
  logLines.forEach((l) => console.error('  ', l));
  process.exit(1);
}

step('3. resolveModel()');
const resolved = await adapter.resolveModel('llama-local', models[0].id);
console.log(JSON.stringify(resolved, null, 2));

step('4. stream() —— 真拉起 llama-server 并请求');
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 180_000);
let textOut = '';
let reasonOut = '';
let blocks = 0;
let finish = null;
let usage = null;
try {
  const call = await adapter.prepareCall('llama-local', models[0].id, controller.signal);
  for await (const chunk of call.stream({
    provider: 'llama-local',
    model: models[0].id,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '用一句话回答：127 乘以 43 等于多少？只回答数字和一句解释。' },
        ],
        source: { kind: 'user' },
      },
    ],
    temperature: 0.3,
    maxTokens: 128,
    signal: controller.signal,
  })) {
    if (chunk.type === 'block-start') blocks++;
    else if (chunk.type === 'text-delta') {
      textOut += chunk.text;
      process.stdout.write(chunk.text);
    } else if (chunk.type === 'reasoning-delta') reasonOut += chunk.text;
    else if (chunk.type === 'usage') usage = chunk.usage;
    else if (chunk.type === 'finish') finish = chunk.reason;
  }
  process.stdout.write('\n');
  console.log('\n── 结果 ──');
  console.log('text blocks     =', blocks);
  console.log('text            =', JSON.stringify(textOut.slice(0, 500)));
  console.log('reasoning       =', reasonOut.length, 'chars');
  console.log('usage           =', JSON.stringify(usage));
  console.log('finish          =', JSON.stringify(finish));
} catch (err) {
  dumpSpawned();
  console.error(`FAIL: stream 抛错：${err && err.stack ? err.stack : String(err)}`);
  process.exit(1);
} finally {
  clearTimeout(timeout);
}

step('5. 关停：调用 disposer');
console.log('spawn 过的进程 =', JSON.stringify(subprocess.listChildren()));
dispose();
// gracefulStop 最坏路径：800ms + 8s + 5s + terminate grace 8s ≈ 22s
// （--no-ui 下没有交互提示，Ctrl+C/Y 那几步基本都会走空，最后靠 terminate 兜底）
for (let i = 1; i <= 25; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const cur = subprocess.listChildren();
  if (cur.every((c) => c.exited)) {
    console.log(`disposer 后 ${i}s 全部退出`);
    break;
  }
  if (i === 25) console.log('disposer 后 25s 仍未全退：', JSON.stringify(cur));
}
const after = subprocess.listChildren();
console.log('disposer 后     =', JSON.stringify(after));
console.log(after.every((c) => c.exited) ? 'OK 进程全部退出' : 'WARN 仍有进程未退出');

step('6. 期间状态栏文本');
statuses.slice(-5).forEach((s) => console.log(' ', s.text));

step('7. 日志');
logLines.slice(-15).forEach((l) => console.log(' ', l));

const ok = models.length > 0 && textOut.trim().length > 0 && after.every((c) => c.exited);
console.log('\n★★★', ok ? 'SMOKE PASS' : 'SMOKE FAIL', '★★★');
process.exit(ok ? 0 : 1);
