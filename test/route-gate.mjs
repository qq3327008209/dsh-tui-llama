/**
 * 启动门禁单测：不启动 llama-server，只在临时目录里造 kernel.json / model.json，
 * 验证 readSnapshot 的解析顺序和 RouteGate 的变更通知（含负向二次确认）。
 *
 * 用法：node test/route-gate.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.LOCAL_LLAMA_LOG = join(tmpdir(), 'local-llama-diag-test.log');
const mod = await import(pathToFileURL(join(ROOT, 'dist/route-gate.js')).href);
const { readSnapshot, RouteGate, DSH_BACKEND_ID } = mod;

/* ---------------- 环境隔离 ---------------- */

// 门禁会读这两个全局 env；单测必须清掉，否则会受本机启动方式影响。
const SAVED = { handoff: process.env.DSH_TUI_BACKEND_HANDOFF, backend: process.env.DSH_TUI_BACKEND };
delete process.env.DSH_TUI_BACKEND_HANDOFF;
delete process.env.DSH_TUI_BACKEND;

const dir = mkdtempSync(join(tmpdir(), 'local-llama-gate-'));
const kernel = join(dir, 'kernel.json');
const route = join(dir, 'model.json');
const paths = { kernel, route };

let pass = 0;
let fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} ${extra}`);
  }
};

const writeKernel = (backend) => writeFileSync(kernel, JSON.stringify({ backend }));
const writeRoute = (provider, model) => writeFileSync(route, JSON.stringify({ provider, model }));

try {
  /* ---- 1. 解析优先级 ---- */
  console.log('\n━━━ 1. readSnapshot 解析 ━━━');

  writeKernel('claude');
  writeRoute('llama-local', 'qwen3');
  let s = readSnapshot(paths);
  check('kernel.json 给出 claude', s.backend === 'claude', `got=${s.backend}`);
  check('model.json 给出 llama-local', s.route?.provider === 'llama-local' && s.route?.model === 'qwen3');

  process.env.DSH_TUI_BACKEND = 'codex';
  s = readSnapshot(paths);
  check('DSH_TUI_BACKEND 盖过 kernel.json', s.backend === 'codex', `got=${s.backend}`);

  process.env.DSH_TUI_BACKEND_HANDOFF = 'claude';
  s = readSnapshot(paths);
  check('切换交接 env 盖过 DSH_TUI_BACKEND', s.backend === 'claude', `got=${s.backend}`);
  delete process.env.DSH_TUI_BACKEND_HANDOFF;
  delete process.env.DSH_TUI_BACKEND;

  writeKernel('claude');
  s = readSnapshot(paths);
  check('backend 大小写归一', s.backend === 'claude');
  writeKernel('has:colon');
  s = readSnapshot(paths);
  check('非法 backend 回落到 dsh', s.backend === DSH_BACKEND_ID, `got=${s.backend}`);

  /* ---- 2. model.json 的失败模式 ---- */
  console.log('\n━━━ 2. model.json 异常输入 ━━━');
  writeKernel('dsh');
  writeFileSync(route, '{"provider":"llama-local"}');
  check('缺 model 字段 → 无路由', readSnapshot(paths).route === undefined);
  writeFileSync(route, '{"provider":"","model":"x"}');
  check('空 provider → 无路由', readSnapshot(paths).route === undefined);
  writeFileSync(route, '{"provider":"llama-local","model":"x"');
  check('半写入（截断 JSON）→ 无路由', readSnapshot(paths).route === undefined);
  rmSync(route);
  check('文件不存在 → 无路由', readSnapshot(paths).route === undefined);
  writeRoute('my', 'sensenova');
  check('非本地 provider 能读出来', readSnapshot(paths).route?.provider === 'my');

  /* ---- 3. RouteGate：起 → 停，负向要二次确认 ---- */
  console.log('\n━━━ 3. RouteGate 变更通知 ━━━');

  writeKernel('dsh');
  writeRoute('llama-local', 'qwen3');

  let events = [];
  const wanted = (snap) => snap.backend === DSH_BACKEND_ID && snap.route?.provider === 'llama-local';
  const gate = new RouteGate({ paths, isWanted: wanted, pollMs: 60, confirmMs: 80 });
  check('初始判定为 wanted', gate.isWanted() === true, `snap=${JSON.stringify(gate.get())}`);

  const off = gate.watch((next, prev) => events.push({ backend: `${prev.backend}->${next.backend}`, wanted: wanted(next) }));

  await new Promise((r) => setTimeout(r, 300));
  check('文件未变不产生事件', events.length === 0, `events=${events.length}`);

  // 切走内核：负向变更，要等第二次读才确认。
  writeKernel('claude');
  await new Promise((r) => setTimeout(r, 70));
  check('确认窗口内不通知', events.length === 0, `events=${JSON.stringify(events)}`);
  await new Promise((r) => setTimeout(r, 400));
  check('确认后才通知一次', events.length === 1, `events=${JSON.stringify(events)}`);
  check('通知的是 backend 变更', events[0]?.backend === 'dsh->claude');
  check('通知后判定为 wanted=false', gate.isWanted() === false);

  // 切回：正向变更立即通知，不做二次确认。
  events = [];
  writeKernel('dsh');
  let waited = 0;
  while (events.length === 0 && waited < 1500) {
    await new Promise((r) => setTimeout(r, 40));
    waited += 40;
  }
  check('切回 dsh 内核立即通知', events.length === 1 && waited < 600, `waited=${waited} events=${JSON.stringify(events)}`);
  check('切回后判定为 wanted=true', gate.isWanted() === true);

  /* ---- 4. 半写入的 model.json 不应造成误停 ---- */
  console.log('\n━━━ 4. 半写入不落空 ━━━');
  events = [];
  writeFileSync(route, '{"provider":"llama-local","model":"qw'); // 截断
  await new Promise((r) => setTimeout(r, 70));
  check('确认窗口内不通知', events.length === 0, `events=${JSON.stringify(events)}`);
  await new Promise((r) => setTimeout(r, 400));
  check('确认后才通知', events.length === 1, `events=${JSON.stringify(events)}`);

  // 换模型：同一 provider 内的切换，判定保持 wanted
  events = [];
  writeRoute('llama-local', 'other-model');
  await new Promise((r) => setTimeout(r, 700));
  check('换模型会通知', events.length === 1, `events=${JSON.stringify(events)}`);
  check('换模型后仍是 wanted', gate.isWanted() === true);

  // 换成非本地 provider
  events = [];
  writeRoute('my', 'sensenova');
  await new Promise((r) => setTimeout(r, 700));
  check('切走本地模型会通知', events.length === 1, `events=${JSON.stringify(events)}`);
  check('切走后 wanted=false', gate.isWanted() === false);

  off();
  gate.dispose();

  console.log(`\n★★★ ${fail === 0 ? 'ROUTE-GATE PASS' : 'ROUTE-GATE FAIL'}：${pass} 通过 / ${fail} 失败 ★★★`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  process.env.DSH_TUI_BACKEND_HANDOFF = SAVED.handoff;
  process.env.DSH_TUI_BACKEND = SAVED.backend;
  rmSync(dir, { recursive: true, force: true });
}
