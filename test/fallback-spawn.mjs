/**
 * 验证 localSubprocess() 回退实现：宿主没有 subprocess 服务时，
 * 插件用 node:child_process 自己拉 llama-server。
 *
 * 背景：真宿主实测 dsh-tui profile 的 fiber 树里根本没有 subprocess 服务
 * （根 fiber 只提供 dshHomePath/profileContext/launchEnvironment/cmdlineArgs/
 * appExit/appReady，Loader fiber 只有 loader）。而且真宿主在非 TTY 下立刻退出，
 * autoStart 跑不完，所以回退路径只能在这里单独验。
 *
 * 用法：node test/fallback-spawn.mjs
 * 只做一件事：真的 spawn 一次 llama-server，等 /v1/health 就绪，
 * 再从收集到的 stdout 里确认它真的启动成功了。
 */
import { localSubprocess } from '../dist/llama-server.js';

const EXE = process.env.LLAMA_EXE ?? 'D:\\llama\\llama-server.exe';
const MODEL = process.env.LLAMA_MODEL ?? 'D:\\llama\\models\\qwen3-5-4B-Q4_K_M.gguf';
const PORT = Number(process.env.LLAMA_PORT ?? 8651);

const argv = [
  EXE,
  '--host', '127.0.0.1',
  '--port', String(PORT),
  '--ctx-size', '8192',
  '--gpu-layers', '999',
  '--threads', '10',
  '--threads-batch', '-1',
  '--batch-size', '512',
  '--flash-attn', 'on',
  '--cache-type-k', 'q8_0',
  '--cache-type-v', 'q8_0',
  '--temp', '0.8',
  '--top-p', '0.95',
  '--top-k', '40',
  '--min-p', '0.05',
  '--repeat-penalty', '1.0',
  '--seed', '-1',
  '--no-ui',
  '--model', MODEL,
];

const start = Date.now();
const say = (label, ...rest) => console.log(`━━━ ${label}  (+${((Date.now() - start) / 1000).toFixed(1)}s) ━━━`, ...rest);

say('1. localSubprocess().spawn()');
const runtime = localSubprocess();
const handle = runtime.spawn({
  argv,
  cwd: process.cwd(),
  stdio: { stdin: 'pipe', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
  graceMs: 8000,
});
console.log('  handle.keys =', JSON.stringify(Object.keys(handle)));
console.log('  spawnTerminal =', typeof runtime.spawnTerminal, '（undefined 是对的：让管理器走管道模式）');

/* 管理器用 150ms 轮询 LineDrain 读 collected，这里照做 */
const lines = [];
const poll = setInterval(() => {
  const so = handle.collected.stdout?.readFrom(lastSo);
  const se = handle.collected.stderr?.readFrom(lastSe);
  if (so) {
    lastSo = so.nextOffset;
    so.text.split('\n').forEach((l) => l && lines.push(l));
  }
  if (se) {
    lastSe = se.nextOffset;
    se.text.split('\n').forEach((l) => l && lines.push(`[stderr] ${l}`));
  }
}, 150);
let lastSo = 0;
let lastSe = 0;

say('2. 等 /v1/health 就绪');
const deadline = Date.now() + 120_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/health`);
    if (res.ok) {
      ready = true;
      console.log('  /v1/health ->', res.status);
      break;
    }
  } catch {
    /* 还没监听 */
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!ready) {
  console.error('FAIL: 120s 内未就绪。已收集输出（末 40 行）：');
  lines.slice(-40).forEach((l) => console.error('   ', l));
  handle.terminate();
  process.exit(1);
}

say('3. 收集到的输出里应有 model loaded');
const out = lines.join('\n');
const loaded = out.includes('model loaded') || out.toLowerCase().includes('load_model');
console.log('  含 model loaded =', loaded);
console.log('  输出行数 =', lines.length, '，末 5 行：');
lines.slice(-5).forEach((l) => console.log('   ', l));

say('4. terminate() + waitForExit()');
handle.terminate();
const controller = new AbortController();
const guard = setTimeout(() => controller.abort(), 15_000);
const exited = await handle.waitForExit(controller.signal);
clearTimeout(guard);
const outcome = await handle.done;
console.log('  waitForExit =', exited, ' done =', JSON.stringify(outcome));

clearInterval(poll);

const ok = ready && loaded && exited;
console.log('\n★★★', ok ? 'FALLBACK PASS' : 'FALLBACK FAIL', '★★★');
process.exit(ok ? 0 : 1);
