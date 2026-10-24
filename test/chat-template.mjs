/**
 * chatTemplate（自定义 Jinja 对话模板）接线测试：不启动 llama-server，秒级。
 *
 * 覆盖三件事：
 *   1. 配置层 —— DEFAULTS 默认空串、adopt() 能带上、Config schema 里有 volatile 叶子
 *      （叶子缺失就没有 /settings 面板字段，volatile 缺失整个 entry 没有 namespace）
 *   2. TUI 层 —— 设置区有 ['chatTemplate'] 字段、needsRestart() 认这个键
 *   3. 路径层 —— toNativePath() 把正斜杠盘符路径换成反斜杠
 *      （llama-server 的 --chat-template-file 打不开 `C:/Users/...`）
 *   加一条失败前置：模板文件不存在时在 spawn 之前就报错，不白等就绪超时。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'local-llama-tpl-'));
process.env.LOCAL_LLAMA_DATA_DIR = sandbox;
process.env.LOCAL_LLAMA_PID_FILE = join(sandbox, 'pid.json');
process.env.LOCAL_LLAMA_LOG = join(sandbox, 'diag.log');

const cfg = await import(pathToFileURL(resolve(ROOT, 'dist/config.js')).href);
const ui = await import(pathToFileURL(resolve(ROOT, 'dist/ui.js')).href);

let passed = 0;
function check(label, cond, extra) {
  if (!cond) {
    console.error(`FAIL: ${label}${extra !== undefined ? `  (${JSON.stringify(extra)})` : ''}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok  ${label}`);
}

/* ---- 1. 配置层 ---- */
check('DEFAULTS.chatTemplate 默认空串（= 用 GGUF 自带模板）', cfg.DEFAULTS.chatTemplate === '', cfg.DEFAULTS.chatTemplate);
check('adopt() 缺省回落空串', cfg.adopt({}).chatTemplate === '');
check('adopt() 带上 chatTemplate', cfg.adopt({ chatTemplate: '/tmp/a.jinja' }).chatTemplate === '/tmp/a.jinja');

// Config 必须是真 schemastery 实例：叶子在 refs[dict[name]] 里，volatile/default 在 meta 上。
const json = cfg.Config.toJSON();
const leafUid = json.refs[json.uid].dict.chatTemplate;
const leaf = leafUid !== undefined ? json.refs[leafUid] : undefined;
check('Config schema 里有 chatTemplate 叶子', !!leaf, `uid=${leafUid}`);
check('chatTemplate 叶子标了 volatile', leaf?.meta?.volatile === true, leaf?.meta);
check('chatTemplate 叶子有 default', leaf && 'default' in (leaf.meta ?? {}), leaf?.meta);
check('chatTemplate 顶层不是 required', leaf?.required !== true);

/* ---- 2. TUI 层 ---- */
const section = ui.buildSettingsSection('dsh-tui-local-llama');
const field = section.fields.find((f) => f.path.join('.') === 'chatTemplate');
check('设置区有 chatTemplate 字段', !!field);
check('chatTemplate 归到 general 组', field?.group === 'general', field?.group);
check('chatTemplate 是 text 字段', field?.kind === 'text');
check('chatTemplate 解析空串（留空 = 自带模板）', field?.parse('').value === '', field?.parse(''));
check('chatTemplate 解析时去掉首尾空白', field?.parse('  ~/a.jinja  ').value === '~/a.jinja');
check('needsRestart 认 chatTemplate 变更', ui.needsRestart(cfg.adopt({}), cfg.adopt({ chatTemplate: 'x' })) === true);
check('needsRestart 不因别的键触发', ui.needsRestart(cfg.adopt({ chatTemplate: 'x' }), cfg.adopt({ chatTemplate: 'x', temperature: 1.5 })) === false);

/* ---- 3. 路径层 ---- */
if (process.platform === 'win32') {
  check('toNativePath 换反斜杠', cfg.toNativePath('C:/Users/x/t.jinja') === 'C:\\Users\\x\\t.jinja', cfg.toNativePath('C:/Users/x/t.jinja'));
  check('toNativePath 不动已经是反斜杠的', cfg.toNativePath('C:\\Users\\x\\t.jinja') === 'C:\\Users\\x\\t.jinja');
  check('toNativePath 对纯相对路径也换分隔符', cfg.toNativePath('templates/x.jinja') === 'templates\\x.jinja', cfg.toNativePath('templates/x.jinja'));
  check('expandPath 展开 ~/', cfg.expandPath('~/Downloads/t.jinja').startsWith(process.env.USERPROFILE ?? ''), cfg.expandPath('~/Downloads/t.jinja'));
} else {
  check('非 win32 下 toNativePath 原样返回', cfg.toNativePath('/tmp/a/b.jinja') === '/tmp/a/b.jinja');
}

/* ---- 4. 模板不存在 → spawn 之前报错，不白等就绪超时 ---- */
// 复用 smoke.mjs 的结构面：apply() 只需要 llm / subprocess / logger 三个缝。
const registered = {};
const started = [];
const ctx = {
  logger: { warn() {}, error() {} },
  inject(deps, cb) {
    const child = {};
    for (const d of deps) child[d] = ctx[d];
    cb(child);
    return true;
  },
  llm: {
    registerAdapter(providers, adapter) {
      registered.adapter = adapter;
      return () => {
        registered.adapter = undefined;
      };
    },
    listProviders() {
      return registered.adapter ? [{ id: 'llama-local', name: 'local' }] : [];
    },
  },
  tuiStatus: { set() { return () => undefined; } },
  tuiShortcuts: { register() { return () => undefined; } },
  tuiSettingsSections: { register() { return () => undefined; } },
  on() { return () => undefined; },
  subprocess: {
    get childCount() { return started.length; },
    spawn(spec) {
      started.push(spec.argv.join(' '));
      const child = spawn('node', ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
      return {
        stdin: null,
        collected: { stdout: {}, stderr: {} },
        done: new Promise(() => undefined),
        terminate() { try { child.kill('SIGKILL'); } catch { /* 已退 */ } },
        async waitForExit() { return true; },
      };
    },
    listChildren() { return []; },
  },
};

const mod = await import(pathToFileURL(resolve(ROOT, 'dist/index.js')).href);
// executable 指向一个真实存在的可执行文件，确保流程走到 chatTemplate 那道检查；
// 模型目录里放个 0 字节的 .gguf，让 ensure() 认得出模型 id（不会走到「未知模型」）。
const modelsDir = join(sandbox, 'models');
mkdirSync(modelsDir);
writeFileSync(join(modelsDir, 'fake.gguf'), '');
const dispose = mod.apply(ctx, {
  executable: process.execPath,
  modelsDir,
  chatTemplate: join(modelsDir, '不存在.jinja'),
  host: '127.0.0.1',
  port: 1,
  autoStart: false,
  debug: false,
  startTimeoutMs: 5000,
});

let models = [];
for (let i = 0; i < 60 && models.length === 0; i++) {
  models = await registered.adapter.listModels('llama-local');
  if (models.length === 0) await new Promise((r) => setTimeout(r, 100));
}
check('0 字节 .gguf 也能被列出来（让 ensure() 认得模型）', models.some((m) => m.id === 'fake'), models);

let err = null;
try {
  const call = await registered.adapter.prepareCall('llama-local', 'fake');
  for await (const _ of call.stream({ provider: 'llama-local', model: 'fake', messages: [] })) {
    /* 到不了这里 */
  }
} catch (e) {
  err = e;
}
check('模板不存在时请求报错', !!err);
check('报错信息点名了模板文件', /对话模板不存在/.test(String(err?.message ?? err)), String(err?.message ?? err));
check('报错发生在 spawn 之前', started.length === 0, started);
dispose();

console.log(`\nchat-template PASS（${passed} 项）`);
process.exit(0);
