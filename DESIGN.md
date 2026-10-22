# dsh-tui 本地模型插件设计方案

**目标**:在 dsh-tui(终端版,`@deepseek-harness-tui/dsh-tui@0.16.1`)里接入 llama.cpp 本地模型——
选中本地模型时打开 dsh 即拉起 llama-server,关闭 dsh 即关停本地模型,推理参数在 TUI 内可调。

**基线环境**:Windows 11 / i7-12650H(10C16T)/ 15.8GB RAM / RTX 4050 Laptop **6140 MiB VRAM** / node v24.16.0 / pnpm 12.14.0
**llama.cpp**:`D:\llama\llama-server.exe`,`0.7.0-dev (build 11784, commit 493253fe5)`,CUDA 13.4 版
**模型**:`D:\llama\models\qwen3-5-4B-Q4_K_M.gguf`(2.7GB);桌面另有一份同名副本
**当前 active profile**:`~\.dsh\profiles\dsh-tui\`

> ⚠️ 显存别信 Windows 的 `Win32_VideoController.AdapterRAM`(报 4GB)——`llama-server --list-devices`
> 实测报 `CUDA0: NVIDIA GeForce RTX 4050 Laptop GPU (6140 MiB, 5073 MiB free)`。6GB 是真实的。

---

## 0. 一句话结论

本机已经有一份约 3500 行的成熟实现 `dsh-llamacpp-bridge@1.5.0`
(`~\.dsh\profiles\tui\node_modules\dsh-llamacpp-bridge\`),进程管理、模型扫描、
优雅退出、热配置都已踩过坑。**但它面向 `dsh-client-*`(web 端)插槽,装在 `tui` profile,
不是你现在用的 `dsh-tui` 终端版。**

进程管理与 LLM 适配器逻辑可以直接搬,UI 层必须换成 `ctx.tui*` 接缝重写。
推荐**方案 A:移植 bridge 的 host 侧,重写 UI 层**。

---

## 1. 三条已验证的技术通路

### 1.1 模型入口:只能伪装成 `openai-completions`

pi-ai 的协议表是**封闭三值**:

```ts
// dsh-tui/lib/types/dsh-adapter/providerWizard.d.ts:5-8
export declare const PROVIDER_PROTOCOLS: readonly [
    "openai-completions", "openai-responses", "anthropic-messages"
];
```

没有 `ollama` / `llama-cpp` / `lmstudio` / `mlx` / `vllm`。llama-server 内置 OpenAI 兼容端点,
走 `openai-completions` 即可。加分项:pi-ai 的 overflow 检测器已内置 llama.cpp 的错误签名——

```js
// @earendil-works/pi-ai/dist/utils/overflow.js:49
/exceeds the available context size/i, // llama.cpp server
/greater than the context length/i,    // LM Studio
/prompt too long; exceeded (?:max )?context length/i, // Ollama
```

所以 context 溢出会被正确归类,不会当成普通 500。

### 1.2 进程管理:用 `ctx.subprocess`,别裸 `child_process`

`dsh-tui` 的 `cordis.yml` 已挂载 `- id: subprocess, name: '@deepseek-ai/dsh-subprocess-local'`。
`ctx.subprocess` 提供 `spawn()` / `spawnTerminal()` / `spawnJob()`,Handle 有**幂等**的
`terminate()`、`waitForExit(signal)`、`kill(signal)`;terminal 额外有
`signalForeground('SIGINT'|'SIGTERM'|'SIGKILL'|...)` 和 `write(data)`。

Windows 下 `dsh-subprocess-local/lib/runner.js` 用 **Job Object** 做树杀
(`terminateOwnedJob` → `TerminateJobObject`),不需要 pgrep/pgkill。

⚠️ 不要自己 `import { spawn } from 'node:child_process'`:`dsh-tui` 装了
`installChildStderrGuard`,它 monkeypatch `child_process.spawn` 把 stderr 接进日志面板,
而**持有 ESM 命名导入快照的消费者会绕过 patch**——日志就丢了。

### 1.2a. 进程树风险:**已排除**(实测,别再担心)

`D:\llama\llama-server.exe` 只有 9KB,真身在 `llama-server-impl.dll`(9.5MB),
看起来像"启动即退出、把真进程孤儿化"的 shim。**实测不是**:

```
node -e 'spawn("D:/llama/llama-server.exe", [...] )'
[1] spawn pid      = 27376
[3] 18s  listener  = 27376    ← 同一个 PID
[3] 18s  shim alive? = true   ← 没退出
[3] 18s  /health    = {"status":"ok"}
```

9KB 的 exe **本身**就是监听进程,`CreateProcess` → `LoadLibrary(llama-server-impl.dll)`
内嵌运行,全程存活。**所以 `handle.terminate()` 就够了,不需要 `taskkill /T` 或真实 PID 反查。**

之所以之前误判:当时是通过 Git Bash 跑 `./llama-server.exe &`,bash 的进程管理与 Node 的
`spawn()` 语义不同,观测到的父子关系被 shell 污染了。**教训:验证进程行为必须用最终会用的
那个 API(`child_process.spawn` / `ctx.subprocess.spawn`)去测,不能隔着 bash 看。**

### 1.3 设置热改:`ctx.settings` 而不是 `ctx.tuiPluginStorage`

这是个必须避开的坑。`ctx.tuiPluginStorage` 受 grant 门禁:`storage.local.read` /
`storage.local.write` **默认 deny 且每次调用都重查**,256 key × 256KiB,拿来当主配置存储会被堵死。

正路是 dsh 的 settings 服务(`ctx.settings`,底层 `~/.dsh-tui/settings.json`),无 grant 限制:

```ts
const scope = ctx.settings.register(ns, schema, { base });   // 分层: schema 默认 → base → user
scope.get();    // 当前生效值
scope.watch(cb); // 热更新回调 —— 「参数可调」的关键
```

bridge 已经在用这个模式,并且 watch 回调里实现了「传输字段变更即停服」:

```js
// dsh-llamacpp-bridge/dist/host/index.js:136-139
const transportChanged = next.port !== prev.port || next.host !== prev.host
                     || next.executable !== prev.executable;
if (transportChanged) void server.stop().catch(...);
```

### 1.4 模型列表:插件可以注册自己的 LlmAdapter

不必非要走 `llm-pi-ai` 的 YAML 静态表。`ctx.llm` 是 DSH 核心服务(dsh-tui 的 `inject` 里有
`agents`,同类的 `llm`/`tools`/`sessionPersistence` 都是核心服务),可直接:

```ts
ctx.llm.registerAdapter([PROVIDER_ID], adapter);        // 注册路由 + listModels() 动态供给
ctx.llm.registerConfigurableProviders([entry()]);       // 进 /provider 向导
```

bridge 的 `listModels()` 就是扫 GGUF 目录得来,不是写死列表——换模型/加模型都自动出现在 picker 里。

---

## 2. 决定架构形状的硬约束(不可绕过)

| # | 约束 | 出处 | 对设计的影响 |
|---|---|---|---|
| C1 | **没有 `dispose`/`onExit`/`SIGINT` 注册点**。唯一官方清理机制是 `ctx.effect(fn, label?)`,fiber 作用域,activation 卸载时执行 | 全包无 `dispose/destroy/onExit/finalize` 导出;`scenes.d.ts:67-72` 明确「returns the dispose function, caller scopes it with `ctx.effect`」 | llama-server 的关闭**只能**挂在 `ctx.effect` 的 disposer 上 |
| C2 | 宿主独占终止信号。`dieBySignal` 先 `process.removeAllListeners(signal)` 再 `process.kill(pid, signal)`,`BACKSTOP_MS = 7000`、`RERAISE_GRACE_MS = 500` | `dsh-adapter/process-exit.d.ts/.js` | 插件自挂 `process.on('SIGINT')` 会被宿主 500ms 内剔除,**不可靠,不作为主路径** |
| C3 | **无插件级 reload 钩子**。`/reload` 只重读 5 个 pref 文件(`theme/lang/agent-preset/model/working-activity.json`);cordis 根 config 与代码变更走 `/restart` | `dsh-adapter/reload.d.ts` | 「改 profile 即生效」做不到,只能 `/restart`;插件必须做成幂等、可重复 apply |
| C4 | `apply` 里不能 await 长任务,会卡住整个组合;耗时工作必须 detached | `guide/dsh-tui-guide/plugins.md:101-108` | 启动预热写 `void server.ensure(x).catch(...)`,不 await |
| C5 | 首个 TUI 行之后激活的行**不能用 `ctx.root` 能力**(`root.plugin`/`root.effect`/`root.on`),由 guard 强制 | 同上 | 只能用行级 `ctx.effect`,不能用 `ctx.root.effect` |
| C6 | UI seam 必须 `ctx.get('x', false)` 软探测,**绝不写进 `inject`**(issue #183) | `plugin-host.d.ts:25-35` | `tuiPluginHost/tuiSettingsSections/tuiStatus/tuiScenes/tuiShortcuts/tuiToast/tuiPanels` 全软探测 |
| C7 | `ctx.settings` / `ctx.llm` / `ctx.subprocess` 是核心服务,**可以写进 `inject`** | bridge `inject = ['llm','settings','subprocess','webServer']` | 核心服务直接注入,失败即硬错——好事 |
| C8 | `ctx.webServer` 在 dsh-tui 里**几乎肯定不存在**(它是终端应用,无 web server) | dsh-tui 的 `cordis.yml` 无 web 相关行 | bridge 的 SSE 终端监控面板必须整体替换为 `ctx.tuiStatus` / `ctx.tuiScenes` / `ctx.tuiPanels` |
| C9 | 模块形状是**命名导出**:`name` + `apply`(必需),`inject` / `Config` 可选。`apply` 可以是 async | `dsh-adapter/index.d.ts:19,21,280,288` | 不要写 `export default { apply }` |
| C10 | effect ledger 是**观测不是门禁**,`record()` 永不抛错 | `effect-ledger.d.ts:30-32` | 不要依赖它做控制流 |
| C11 | 设置分区 `ns` 必须与 `ctx.settings.register(ns, ...)` 的命名空间**一致**;分区只是展示元数据,存储/校验/分层归 settings 服务 | `settings-sections.d.ts`、`channel-settings.d.ts:214-229` | 同一常量 `SETTINGS_NS` 供两边用 |
| C12 | 快捷键 combo 必须带 `ctrl` 或 `alt`,保留组合注册期直接拒绝 | `shortcuts.d.ts:1-23` | 见 §5.3 选键 |
| C13 | **spawn PID 即监听进程**。`D:\llama\llama-server.exe`(9KB)是 DLL host,不是"启动即退出的 shim"——Node `spawn()` 拿到的 PID 就是 `/health` 响应的进程,18s 后仍存活 | 实测(见 §1.2a) | `handle.terminate()` 单独即可,**不需要** `taskkill /T` / 真实 PID 反查。但 Job Object 仍保留作兜底 |
| C14 | **pi-ai 只透传 2 个采样字段**:`maxTokens` → `max_tokens`、`temperature`。`top_p` / `top_k` / `min_p` / `repeat_penalty` / `seed` / `stop` 全部被丢弃 | `pi-ai/dist/api/openai-completions.js:590-601` | 决定参数分层:采样参数**不能靠请求体**,必须作为 llama-server CLI 启动参数(§6 已按此重写) |
| C15 | **Qwen3 默认开 thinking**:`/v1/chat/completions` 的 `content` 返回**空字符串**,token 全进 `reasoning_content`,且 `finish_reason` 报 `length`——极易误判为"生成失败" | 实测:`fields=role,content,reasoning_content`;加 `chat_template_kwargs:{enable_thinking:false}` 后 `fields=role,content`,`content` 正常 | 必须在请求体里带 `chat_template_kwargs:{enable_thinking:false}`,或在 provider 模型声明里设 `reasoning: true` 让 pi-ai 自动补(它已有 `qwen-chat-template` 分支) |

---

## 3. 架构:3 个模块 + 1 个 bundle patch

```
dsh-tui-local-llama/
├── package.json            "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── cordis.patch.yml        单行 insert(见下)
├── dsh-plugin.json         可选:仅当要走 /plugin install 发现或声明命令贡献
├── tsconfig.json
├── src/
│   ├── index.ts             name + inject + apply()        ← 编排层
│   ├── config.ts            schema + 默认值 + 参数分层标记
│   ├── discover.ts          找 llama-server.exe + .gguf 目录
│   ├── model-store.ts       GGUF 扫描 + fs.watch + 轮询兜底
│   ├── llama-server.ts      进程管理器:状态机 + 健康探测 + 优雅退出
│   ├── adapter.ts           LlmAdapter(registerAdapter 路线)
│   ├── boot-eligibility.ts  读 model.json 判定是否要预热
│   ├── ui-settings.ts       ctx.tuiSettingsSections
│   ├── ui-status.ts         ctx.tuiStatus + ctx.tuiScenes
│   └── ui-commands.ts       ctx.tuiPluginHost.registerCommand
└── README.md
```

`cordis.patch.yml`(bundle 自带行,不是 profile 层):

```yaml
# dsh-llamacpp-bridge 同款写法:一个 entry,loader 以 entry.name 为 specifier import() 本包
- insert:
    - id: dsh-tui-local-llama
      name: dsh-tui-local-llama
      config:
        # entry 层默认值;settings 服务的 user 层永远优先于这里
        executable: D:\llama\llama-server.exe
        modelsDir: D:\llama\models
        port: 8642
        ctxSize: 8192
```

`package.json` 关键段:

```json
{
  "name": "dsh-tui-local-llama",
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js", "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "node": ">=20" },
  "devDependencies": { "typescript": "^5.5.0", "@types/node": "^24" }
}
```

`index.ts` 骨架(形状与 bridge 一致):

```ts
export const name = 'dsh-tui-local-llama';
export const inject = ['llm', 'settings', 'subprocess'];   // 核心服务,可硬注入

export async function apply(ctx: Context, entryConfig: RuntimeConfig<Config>): Promise<void> {
  const report = await discoverEnvironmentSafe(3000);       // C4:超时包裹,不无限等
  const scope  = ctx.settings?.register(SETTINGS_NS, buildSchema(), { base: { ...defaults, ...entryConfig, ...discovered } });
  const cfg    = () => scope?.get() ?? entryValues(entryConfig);

  const store  = new ModelStore(cfg);
  void store.refresh().catch(log);                          // C4:detached
  store.watch();

  const server = new LlamaServerManager({ ctx, cfg, resolve: id => store.get(id) });

  ctx.llm.registerAdapter([PROVIDER_ID], new LlamaAdapter({ cfg, models: () => store.models(), ensure: id => server.ensure(id) }));

  // —— 热更新:参数改完按需停服/重扫(§6) ——
  scope?.watch(() => onSettingsChanged(server, store, cfg));

  // —— 你的硬要求 ①:打开 dsh 就启动 ——
  if (selectedModelIsLocal()) void server.ensure(selectedModelId()).catch(toastError);

  // —— UI:全部软探测(C6) ——
  installTuiUi(ctx, { server, store, cfg });

  // —— 你的硬要求 ②:关闭 dsh 就关闭 ——
  ctx.effect(() => () => { server.dispose(); store.dispose(); }, 'local-llama teardown');
}
```

---

## 4. 启动 / 关闭语义

### 4.1 「打开 dsh 就启动」

判定源是 dsh 自己的持久化选择,不是我们自己存的:

```jsonc
// ~/.dsh-tui/model.json   —— {provider, model} 二元组,不是 ": " 拼接
{ "provider": "my", "model": "sensenova-6.8-flash-lite" }
```

优先级(dsh 官方规则):`/model` 持久化选择 > config 里 provider+model 对 > Harness 默认。
**半 pin(只写 provider 或只写 model)按未设置处理**。

所以插件启动时:

```ts
const sel = readJson<{ provider: string; model: string }>(join(homedir(), '.dsh-tui', 'model.json'));
if (sel && sel.provider === PROVIDER_ID && store.has(sel.model)) {
  void server.ensure(sel.model);   // detached,C4
}
```

同时**保留按需启动兜底**:`adapter.stream()` 里 `ensure(modelId)`,
覆盖「启动时选的是云模型、会话中切到本地」这条路径。两条路径合起来才完整。

### 4.2 「关闭 dsh 就关闭」

`ctx.effect` 的 disposer 是唯一官方钩子,覆盖**用户主动退出、recompose、teardown**三种卸载原因。
但 C2 说明信号路径不可靠(终端被强关 / `kill -9` / 进程被 OOM),所以做**三层保险**:

```ts
// ① 主路径:cordis activation 卸载。C13 实测 spawn PID 即可控,handle.terminate() 就够。
ctx.effect(() => () => { void server.dispose(); store.dispose(); }, 'local-llama teardown');

// ② 同步兜底:自然退出时立即杀,不等 event loop 里的 async dispose
process.on('exit', () => server.killSync());   // 单 PID terminate,不需要 /T 树杀(C13)

// ③ 崩溃恢复:PID 文件 + 启动时孤儿清理
//    写 ~/.dsh-tui/local-llama/pid.json {pid, port, argv, startedAt}
//    apply 一开始:文件存在 && pid 存活 && 不是本进程 → 要么采纳(adopt),要么杀掉
```

**第三层仍是必需的**,理由与 C13 无关:Windows 上直接关终端窗口不走 `ctx.effect`,
也不走 `process.on('exit')`(进程被 `TerminateProcess` 硬杀),那条路径只能靠下次启动时扫 PID 文件。

### 4.3 优雅退出序列(照搬 bridge 的,已被验证)

llama-server 收到 SIGINT 会交互式询问 `do you really want to exit [y/n]?`,直杀会留下半成品状态。
所以用 `spawnTerminal` 拿**真 PTY**,让 Ctrl+C 与键盘输入都成立:

```
Ctrl+C(SIGINT → 前台进程组) → 等提示 → 写 "Y\n" → 等 8s
  → 仍无响应:再发一次 Ctrl+C → 等 → 最后才 terminate()(SIGTERM → graceMs → SIGKILL)
全程不使用 SIGKILL 直杀。
```

spawn 顺序:优先 `subprocess.spawnTerminal({ graceMs })`;不可用时 fallback 到
`spawn()` + `process.kill(pid, 'SIGINT')` + stdin 写 `Y\n`。

---

## 5. UI 层(替换 bridge 的 web 面板)

bridge 的终端监控面板挂在 `ctx.webServer.register()` + SSE 上,C8 说明 dsh-tui 没有这个东西。
替换为三个 TUI 接缝,按**稳定性分级**取舍:

| 接缝 | 稳定性 | 用途 |
|---|---|---|
| `ctx.tuiSettingsSections` | **稳定候选** | `/settings` 里的参数区块 —— 「参数可调」的主战场 |
| `ctx.tuiStatus` | **稳定候选** | 状态栏一行:`● local-llama 37/37 GPU 4.2k ctx 18.3 t/s` |
| `ctx.tuiScenes` | **稳定候选** | 全屏控制台:实时日志 + 启停按钮 + 模型列表 |
| `ctx.tuiShortcuts` | **稳定候选** | 一键启停/重开 |
| `ctx.tuiToast` | 实验性 | 启动/就绪/失败的短通知 |
| `ctx.tuiPanels` | 实验性,且 compact 渲染槽 **TODO 未挂载** | 暂不用 |
| `ctx.tuiPluginHost.registerCommand` | 跟随上游 | `/local` 命令 |

### 5.1 设置区块(`/settings` → 本地模型)

```ts
ctx.tuiSettingsSections?.register({
  ns: SETTINGS_NS,                 // 必须等于 ctx.settings.register 的 ns(C11)
  title: '本地模型（llama.cpp）',
  groups: [
    { id: 'runtime',   title: '运行',   mode: 'page'  },   // mode: 'inline' | 'page'
    { id: 'hardware',  title: '硬件',   mode: 'page'  },
    { id: 'sampling',  title: '采样',   mode: 'inline' },
    { id: 'server',    title: '服务端', mode: 'page'  },
  ],
  fields: [
    { path: ['executable'], kind: 'text',   group: 'runtime',
      label: 'llama-server 可执行文件', hint: '留空则自动发现 ~/llama.cpp/build/' },
    { path: ['modelsDir'],  kind: 'text',   group: 'runtime',
      label: 'GGUF 模型目录', hint: '自动扫描 .gguf,支持 ~ 与拖拽路径' },
    { path: ['strategy'],   kind: 'select', group: 'runtime',
      options: [
        { value: 'router',  label: 'Router（常驻进程，/models/load 热切模型）' },
        { value: 'single',  label: 'Single（一次只装一个，切换需重载）' },
      ] },
    { path: ['ctxSize'],    kind: 'number', group: 'hardware',
      hint: '对应 --ctx-size，改后自动重启服务端', parse: text => {
        const n = Number(text);
        return Number.isInteger(n) && n >= 512 && n <= 131072 ? { kind: 'set', value: n } : undefined;
      } },
    // ...ngl / threads / batch / flashAttn / cacheTypeKV / host / port
    // ...temperature / topP / topK / minP / repeatPenalty / maxTokens / seed
  ],
});
```

要点:
- **字段没有 `default` 也没有内建 `validate`**。默认值走分层(schema → base → user),
  校验**完全由 `parse()` 返回 `undefined` 实现**(返回 `undefined` = 非法草稿,阻止保存)。
- 分区注册返回 `() => void`,喂进 `ctx.effect(() => dispose)`。
- 不要碰宿主保留凭据引用(`DEEPSEEK_*` / `DSH_*`),`vetSectionSecretRefs()` 会拒并 warn。

### 5.2 状态栏 + 全屏控制台

```ts
const view = ctx.tuiStatus?.registerView({
  key: 'local-llama',          // key 惯例用插件命名空间
  maxRows: 1,                  // 1 | 2 | 3,宿主上限 3
  component: ({ React, ui }) => { /* ui.Box / ui.Text / ui.useTerminalSize */ },
});
ctx.effect(() => () => view?.(), 'local-llama status view');
```

⚠️ **状态行没有定时器 API**。必须自备外部 store,组件用
`React.useSyncExternalStore(store.subscribe, store.getSnapshot)` 订阅,
快照要**引用稳定**。`useAnimationFrame` 驱动的 `useAnimationTime` 只在 Panel 里可用。
标量 `set(key, text)` 上限 **200 格**,控制字符被剥离。

### 5.3 快捷键选键

保留清单(注册期拒绝):`ctrl+c ctrl+d ctrl+e ctrl+a ctrl+u ctrl+k ctrl+w ctrl+j
ctrl+left ctrl+right ctrl+return ctrl+shift+return`,加上默认可重映射的
`ctrl+v/alt+v ctrl+r ctrl+g ctrl+o ctrl+t ctrl+a ctrl+p ctrl+e ctrl+l ctrl+q ctrl+k
ctrl+shift+e ctrl+z ctrl+b`(随用户改键动态变化)。

本机空闲的:`alt+l`(本地模型启停)、`ctrl+shift+l`(重开服务端)、`alt+m`(模型列表)。
推荐默认 `alt+l`——短、不撞车、语义直接。
注册必须带 `description`,handler 的拒绝会被捕获并 toast,不会破坏键盘。

### 5.4 命令

```ts
ctx.tuiPluginHost?.registerCommand?.(ctx, {
  name: 'local',
  description: '本地模型状态：/local [on|off|restart|status|models]',
  recordInput: false,
  handler: async ({ agent, rawInput }) => {
    const arg = rawInput.trim().toLowerCase();
    switch (arg) {
      case 'on':      await mgr.ensure(selected()); return { kind: 'success', text: '启动中…' };
      case 'off':     await mgr.stop();              return { kind: 'success', text: '已停止' };
      case 'restart': await mgr.restart();           return { kind: 'success', text: '重启中…' };
      case 'models':  return { kind: 'success', text: store.models().map(m => `· ${m.name}`).join('\n') };
      case '':
      default:        return { kind: 'success', text: describe(mgr.getStatus()) };
    }
  },
});
```

⚠️ `@deepseek-ai/dsh-commands` 的类型**本 profile 未安装**,上面形状是从调用点复原的
(`oauth/index.js:212-221`、`promptDebug.js:103-124`),不是抄的官方签名。
且注册有门禁:`name` 必须绑定到 `manifest.contributes.commands[].id`,
且 `requiresContract(identity, 'commands.dsh/v1alpha1', 'Command')` 必须为真。
**要做 `/local` 命令就必须同时写 `dsh-plugin.json`**,否则建议 v1 先只做快捷键 + 场景 + 状态栏,
命令留到 v2。

---

## 6. 参数分层(「参数可调」的核心设计)

按「改完要不要重启」分三层,直接对齐 llama.cpp 语义:

### L0 —— 每次请求热生效(只用 2 个,已实测确认)

只有 **`temperature`** 和 **`max_tokens`**。

依据 C14:pi-ai 的 `openai-completions` 适配器只把这两个字段写进请求体
(`openai-completions.js:590-601`),其余全丢。实测验证 temperature 真被采纳:

```
服务以 --temp 0（贪心）启动，同一 prompt 连发
  t=2.0 ×4 → "半窗风雨送归人…" / "寒窗听雨夜如墨。" / "残灯照壁听疏雨…" / "半床月色被风吹碎…"  ← 4 种
  t=0.0 ×3 → "雨打芭蕉夜未央。" ×3                                                               ← 完全一致
```

`max_tokens` 由 pi-ai 按 provider 兼容位映射成 `max_tokens` 或 `max_completion_tokens`。

### L1 —— llama-server 重启生效(插件自己 stop→start,实测 2.4s)

**采样参数全部在这一层**,因为 pi-ai 不透传它们,只能靠 CLI 启动参数:

`--temp`(默认 0.80)/ `--top-p`(0.95)/ `--top-k`(40)/ `--min-p`(0.05)/
`--repeat-penalty`(1.00)/ `--seed`(-1)/ `--ignore-eos` / `--logit-bias`

外加运行时类:

`--ctx-size` / `-ngl` / `-t` / `-b` / `--ubatch-size` / `--flash-attn` / `--cache-type-k` /
`--cache-type-v` / `--host` / `--port` / 模型路径 / `-np`(并行 slot 数)

这是 bridge 已经在做的:`watch()` 里判传输字段变更 → `server.stop()`,下一次请求 `ensure()` 自动带新参数拉起。
**这一层才是大多数调参的真实归属**,必须做到「保存即生效」而不是"提示你去重启"。
实测一次完整的 stop→start→ready 循环约 2.4s(2.7GB Q4,6GB 显存全量 offload),用户完全可接受。

> **设计取舍**:用户以为 temperature 是"即时"的,其实它是 L0 即时生效;
> top_p/top_k 是 L1 要重启。UI 上必须把这层区别画清楚(分组 + hint),
> 否则用户改 top_p 发现"没反应"会以为插件坏了。

### 关于 `chat_template_kwargs`(Qwen3 专用,见 C15)

Qwen3 系列默认开启思考,`content` 返回空。两条路:
- **推荐**:provider 模型声明里设 `reasoning: true`,pi-ai 的 `qwen-chat-template` 分支会
  自动补 `chat_template_kwargs:{enable_thinking, preserve_thinking:true}`,还能接 `reasoningEffort`。
- 兜底:适配器 `stream()` 里手动往请求体塞 `chat_template_kwargs:{enable_thinking:false}`。

⚠️ 若 provider 声明没设 `reasoning`,`pi-ai` 不会补,用户会看到空回复 + `finish_reason: length`,
这是最像"插件坏了"的失败形态,必须在适配器里兜住。

### L2 —— dsh 重启生效
provider 静态表里的 `contextWindow` 声明、`streamIdleTimeoutMs`、`retryPolicy`、`api`、`baseURL`。

宿主的 `lib/settings.json` 有一等字段 `"restartRequired": true` 就是干这个的,照用。

### contextWindow 必须如实填

| 声明值 | 后果 |
|---|---|
| < 实际 | 过早触发 compact,浪费上下文余量 |
| > 实际 | pi-ai 靠 provider 错误文本兜底(认识 llama.cpp 的 overflow 签名),但每次多烧一次失败请求 |

本机实测 6140 MiB VRAM 时 8192 上下文 + 全量 GPU offload 跑得很舒服,**默认给 8192**
(声明 `contextWindow: 8192`),需要长文时再手动往上调,上限 262144(模型训练上下文)。
`--ctx-size` 不填时 llama.cpp 会取模型自带值(= 262144),那会直接 OOM,**必须显式指定**。

### 本机默认值(RTX 4050 6GB + 2.7GB Q4 4B,全部实测通过)

```yaml
executable: D:\llama\llama-server.exe
modelsDir:  D:\llama\models
# 注意:开了 --models-dir 后,/v1/models 返回的 model id 是相对路径
#   "models/qwen3-5-4B-Q4_K_M.gguf",不是绝对路径 —— provider 的 model id 要用这个
host: 127.0.0.1
port: 8642            # 不用 8080:本机装了 v2rayN / MuMu / 云析,8080 占用概率高
ctxSize: 8192         # 实测 OK,剩余显存充足
ngl: 999              # 全部层上 GPU(写 -ngl 999 比写具体层数稳,不用猜层数)
threads: 10           # llama.cpp 自己选的 10 也合理;显式写 10 避免波动
batch: 512
flashAttn: true       # --flash-attn on,显著省 KV
cacheTypeK: q8_0      # 配合 flash-attn,KV 减半;默认是 f16
cacheTypeV: q8_0
noUi: true            # b11784 上是 --no-ui(--no-webui 已弃用,会打 deprecation 警告)
apiKey: local         # llama-server 会警告 "no API key is set and CORS allows all origins"
streamIdleTimeoutMs: 600000   # 本地慢推理,默认 300000 不够
startTimeoutMs: 30000         # 实测 2.4s 就 ready;给 30s 覆盖冷缓存/首次映射
```

实测性能参考(4096 ctx,thinking 已关):**47.7 tok/s**;启动到 model loaded **2.4s**。

⚠️ `--no-mmap` 在 b11784 **不存在**(`error: invalid argument`),别带;mmap 是默认开启且想要的。
内存模型参数:`--load-mode {auto,none,mmap,mlock,mmap+mlock,dio}`。

启动前**必须** socket 探测端口,占用则 fail-fast + toast 明确报错,不要盲目重试。

---

## 7. 状态机

```
stopped ──ensure()──▶ starting(spawn) ──▶ probing(HTTP poll) ──▶ loading(模型载入,可能数十秒)
   ▲                                                              │
   │                                                              ▼
   └────────────── dispose()/stop() ◀──────────────────────   ready
                                                                │
                                          error ◀───────────────┘(指数退避重试 N 次 → toast)
```

- 就绪判定:轮询 `GET /v1/models` 与 `/health`,超时 `startTimeoutMs`。
- **router 模式换模型不重启进程**:`POST /models/load` 然后轮询 `GET /v1/models`
  直到目标 loaded。这是 bridge 的两种 strategy 之一,建议默认 router——
  你的 4GB 显存一次只能装一个模型,但换模型不需要冷启动。
- idle 自动停机可选(`idleStopMs`),配合 provider 的
  `retryPolicy.retryableCodes: [TRANSPORT, TIMEOUT]` 实现自愈:
  停机后首个请求 TRANSPORT 失败 → 重试时 `ensure()` 已把服务拉起来 → 第二次成功。

---

## 8. 现有资产复用矩阵

源:`~\.dsh\profiles\tui\node_modules\dsh-llamacpp-bridge\dist\host\`

| 文件 | 行数 | 动作 | 说明 |
|---|---|---|---|
| `llama-server.js` | 666 | **照搬 + 小改** | 状态机、spawnTerminal 优先、优雅退出、`waitHttpReady`、`probeLoaded`、router 热切、`/v1/models` 规整。改:① 日志出口从 `pushLines` 接到 dsh 的 stderr guard / `ctx.logger`;② argv 里加采样参数(`--temp`/`--top-p`/`--top-k`/`--min-p`/`--repeat-penalty`/`--seed`,bridge 原版本没有);③ `--no-webui` → `--no-ui`(b11784 弃用警告);④ 端口冲突先探测再 spawn |
| `adapter.js` | 356 | **照搬 + 小改** | LlmAdapter 实现,`stream()` 里 `ensure()`。改:请求体补 `chat_template_kwargs:{enable_thinking:false}`(C15),否则 Qwen3 系列回空 content |
| `model-store.js` | 384 | **照搬** | GGUF 扫描、mmproj 配对、`fs.watch` + 轮询兜底、目录变更重扫 |
| `discover.js` | 226 | **照搬 + 补候选** | 找 `llama-server.exe` / `llama.exe`(`~/llama.cpp/build/{,bin/,bin/release/}` + PATH)、找 gguf 目录。改:补 `D:\llama`(本机实际的安装位置,release zip 解压式布局,不是 git build 布局)、`Desktop` |
| `config.js` | 86 | **照搬 + 扩展** | schema + `configurableProviderEntry()` + `normalizeStrategy()`。扩展:补 §6 的本机默认值 |
| `log-hub.js` | 61 | **照搬** | 日志环形缓冲 |
| `terminal-routes.js` | 218 | **删除** | 依赖 `ctx.webServer`,C8 判定不可用 |
| `client/bundle.cjs` | 1266 | **删除** | web 端 UI,面向 `dsh-client-*` 插槽 |
| — | 0 | **新写** | `ui-settings.ts` / `ui-status.ts` / `ui-commands.ts` / `boot-eligibility.ts`(约 300~500 行) |

净新增约 400 行,**替换掉 bridge 约 1500 行的 web 专用代码**。

---

## 9. 三条路对比

| | 方案 | 工作量 | 「关 dsh 就关」可靠性 | 评价 |
|---|---|---|---|---|
| **A** | 移植 bridge host 侧 + 重写 TUI UI 层 | 中(净新增 ~400 行,复用 3500 行) | 高(照搬已验证的优雅退出) | ✅ **推荐** |
| B | 最小自研:`llm-pi-ai` YAML provider 行 + 一个生命周期行 | 小(~400 行全写) | 中(进程管理细节要自己踩) | 可接受,但重造轮子 |
| C | 只当普通端点用,llama-server 常驻 | 极小(改 YAML 几行) | ❌ 完全违反你的第二条要求 | 仅做临时验证用 |

**方案 B 的价值**:如果不想引入 3500 行依赖,可以只保留 `llama-server.ts` 一个文件(约 200 行的精简版),
provider 走 `llm-pi-ai` 的 YAML 静态表——这样就没有 `registerAdapter`,UI 层照旧。
**代价**:模型列表写死在 YAML 里,加模型要改配置;contextWindow 只能静态声明。

---

## 10. 落地步骤

```bash
# 1. llama.cpp —— 本机已装好,跳过:
#      D:\llama\llama-server.exe   0.7.0-dev (build 11784, CUDA 13.4)
#      D:\llama\models\qwen3-5-4B-Q4_K_M.gguf   2.7GB
#   若需重装,参考:
#     curl -L -o llama-win.zip https://github.com/ggml-org/llama.cpp/releases/download/<tag>/llama-<tag>-bin-win-cuda-<ver>-x64.zip
#     实测下载速度 ~900KB/s,259MB 约 5 分钟(github.com 间歇性可达,codeload.github.com 稳定)

# 2. 建包骨架(就在 C:\Users\John Smish\Desktop\dsh-tui-llama\)
cd ~/Desktop/dsh-tui-llama
# package.json + cordis.patch.yml + tsconfig.json + src/

# 3. 移植 5 个 host 文件(§8 矩阵)
# 4. 新写 UI 层三个文件
# 5. 编译
npx tsc -p tsconfig.json

# 6. 挂进 dsh-tui profile(自动写 dsh.profile.bundles + patch,不用手改 package.json)
dsh plugin --profile dsh-tui add "$(pwd)"
```

### 验证清单

- [ ] `dsh` 启动后,模型 picker 里出现本地模型(provider = `llama-local`,id = `models/qwen3-5-4B-Q4_K_M.gguf`)
- [ ] 选中本地模型 → 进程管理器拉起 llama-server,状态栏从 `starting` → `ready`(预期 ~2.4s)
- [ ] 能正常对话,tokens/s 约 **47**(4B Q4 + CUDA + thinking 关);**回复非空**(C15,thinking 陷阱)
- [ ] 回复里 `finish_reason` 是 `stop` 而非 `length`——若是 `length` 说明 thinking 又吞了预算
- [ ] `/settings` → 本地模型区块,改 `ctxSize` → 保存 → 服务端自动重启带新参数(~2.4s)
- [ ] 改 `temperature` 保存 → 立即生效无需重启(L0,已验证机制可用)
- [ ] 关掉 dsh 窗口 → `tasklist | findstr llama` 无残留(**这条是硬验收**)
- [ ] 强关终端(`taskkill /IM dsh` 或关窗)→ PID 文件孤儿清理在下次启动生效
- [ ] 端口被占用时 fail-fast,toast 报明确错误
- [ ] `/restart` 后插件可重复 apply,不重复 spawn(幂等)
- [ ] VRAM 占用 < 6140 MiB,`-ngl 999` 生效(`llama-server` 日志有 `offloading layers` 行)
- [ ] `handle.terminate()` 单独能杀掉 llama-server(确认 spawn PID 即可控,不需要树杀)

---

## 11. 尚未验证 / 需要实测的点

1. ~~**pi-ai `openai-completions` 透传哪些采样字段**~~ → **已解决(C14)**:只透传 `maxTokens` + `temperature`,
   其余全丢。L0 只有 2 个参数,其余采样参数一律降级 L1 走 CLI。
2. **`ctx.settings` 服务 id 在 dsh-tui profile 下是否可注入**。bridge 在 `tui` profile 里注入成功了,
   dsh-tui profile 里有 `TuiSettingsService` 实现,但**服务注册名是否同为 `settings` 未核**。
   若不可注入,fallback 到 `ctx.get('settings', false)` 软探测 + 失败时退回 entry config 静态值(功能降级,不崩)。
3. **`ctx.llm.registerAdapter` 在 dsh-tui 下的可用性**。`llm` 是 DSH 核心服务,理论上在;未实测。
   不可用就退回 `llm-pi-ai` YAML provider 路线(方案 B 的 provider 部分)。
4. **`dsh-subprocess-local` 的 Windows PTY 实现质量**——`spawnTerminal` 在 Windows 上是否有真 PTY
   (Windows 没有 POSIX PTY,可能需要 conpty)。若不可用,bridge 已有 fallback 路径
   (`spawn` + `SIGINT` + stdin 写 `Y`),但要先实测 fallback 是否也能拿到 llama.cpp 的退出确认提示。
   ⚠️ 注意:llama-server 用 `--no-ui` 启动后,SIGINT 是否仍会弹 `do you really want to exit [y/n]?`
   交互式确认**未验证**。若不弹,则"写 Y"这步变成多余等待,直接进 `terminate()` 即可——
   落地时先跑一次 `spawnTerminal` + `signalForeground('SIGINT')` 看日志再定。
5. **`dsh-plugin.json` 是否必需**。全 profile 树 Glob 无实例文件,schema 是从 `@dsh-std/manifest` 类型重建的。
   本地路径 bundle 通常不需要它;但 `/plugin install` 发现与 `/local` 命令贡献需要。

### 已排除的风险(实测,别再花时间)

- ~~`D:\llama\llama-server.exe` 是 9KB shim,会退出并孤儿化真进程~~ → **不成立**(C13),spawn PID 即监听进程
- ~~pi-ai 不透传任何采样参数~~ → temperature 确实透传并生效(L0 保留 2 个参数)
- ~~`--no-mmap` 可用~~ → b11784 上该参数**不存在**,报 invalid argument
- ~~RTX 4050 只有 4GB 显存~~ → 实际 6140 MiB,8192 上下文绰绰有余

---

## 附:模块形状权威参考

```ts
// 命名导出,不是 export default { apply }
export const name = 'dsh-tui-local-llama';                    // 必需
export const inject = ['llm', 'settings', 'subprocess'];      // 可选;UI seam 绝不放这里
export const Config = editableConfig(                          // 可选;列出的 key 成为惰性 getter,可被 /settings 热改
  Schema.object({ verbose: Schema.boolean().required(false) }),
  ['verbose'],
);
export function apply(ctx: Context, config: RuntimeConfig<Config>): void { /* ... */ }
// apply 也可返回 Promise<() => void>(仅 dsh-adapter/invariant 用这种形式)
```

纪律清单:
1. `apply` 不 await 长任务(detached + `.catch()`);发现阶段超时包裹
2. UI seam 一律 `ctx.get('x', false)`,失败时功能降级不崩
3. 所有 `register()` / `subscribe()` 的返回值都喂进 `ctx.effect(() => dispose)`
4. 不用 `ctx.root.*`(首个 TUI 行之后被 guard 拒绝)
5. 不自挂 `process.on('SIGINT')`(宿主 500ms 内剔除);退出兜底用 `process.on('exit')` + PID 文件
6. 设置存储用 `ctx.settings`,不用 `ctx.tuiPluginStorage`(grant 默认 deny)
7. 插件必须幂等(无 reload 钩子,`/restart` 会重复 apply)
8. 设置分区 `ns` 与 `ctx.settings.register` 的 ns 同一常量
