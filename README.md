# dsh-tui-local-llama

dsh-tui 的本地推理插件：在终端里 `/model` 选一个本地 GGUF 模型，dsh 就替你拉起
`llama-server.exe`；退出 dsh 服务跟着关停；所有参数都能在 `/settings` 里改，改完
就地热生效或自动重启进程——全程不用碰 shell。

服务只在**用 dsh 内核、且当前选中的模型是本地模型**时才被拉起；两个条件任一失效
就停掉。在 claude / codex 内核下不会占着显存空跑。

| 标识 | 值 |
|---|---|
| cordis entry id / settings 命名空间 | `dsh-tui-local-llama` |
| LLM provider id | `llama-local` |
| 状态栏 key | `local-llama` |
| 快捷键 | `alt+l` 启停服务 |
| 启动门禁 | `kernel.json` 的 `backend` + `model.json` 的 `provider`，见下节 |
| PID 文件 | `~/.dsh-tui/local-llama/pid.json` |
| 诊断日志 | `~/.dsh-tui/local-llama-diag.log`（可用 `LOCAL_LLAMA_LOG` 覆盖） |


---

## 前置条件

1. **llama.cpp server 可执行文件**，例如 `~/llama/llama-server.exe`。
   从 llama.cpp 的 release zip 解压即可，或 `git clone` 后 `cmake --build` 自己编。
2. **至少一个 GGUF 模型**，例如 `~/llama/models/qwen3-5-4B-Q4_K_M.gguf`。
3. **Node.js ≥ 20**，以及一个装过 `@deepseek-harness-tui/dsh-tui` 的 dsh profile
   （本插件挂在 `~/.dsh/profiles/dsh-tui/` 下）。

路径在本仓库里**全部是相对的**：`~` 表示用户 home（插件运行时会展开），
文档里的 `~/llama/...` 只是示例布局，你把 llama.cpp 放哪都行。

`executable` / `modelsDir` 都留空时插件会自动扫描常见位置（`DISCOVERY_TIMEOUT_MS` 3s 超时），
扫不到才报错。但**显式填最稳**，自动发现只是兜底。

---

## 安装

本插件是一个普通的 cordis 插件包，装进你的 dsh-tui profile 即可。三种方式按场合选。

### 方式 A：装打包好的 tarball（推荐给使用者）

`npm pack` 产出 `dsh-tui-local-llama-0.2.0.tgz`，里面已经带好编译好的 `dist/`、
`vendor/`、`cordis.patch.yml`、`README`、`LICENSE`，拿到就能用，不需要 Node 构建环境：

```bash
cd ~/.dsh/profiles/dsh-tui
pnpm add ./dsh-tui-local-llama-0.2.0.tgz
```

不想自己找 tarball，直接从 git tag 装，效果一样（tarball 也提交进了仓库）：

```bash
cd ~/.dsh/profiles/dsh-tui
pnpm add github:qq3327008209/dsh-tui-llama@v0.2.0
```

### 方式 B：直接指向源码目录（开发时用）

```bash
cd ~/.dsh/profiles/dsh-tui
pnpm add file:../dsh-tui-llama          # 换成你 clone / 解压出来的目录
```

> 注意：这种方式**每次改完源码都要手动同步产物**，见下节「同步产物」。
> 想一劳永逸就用方式 A。

### 方式 C：从源码构建并打包

```bash
npm install            # 只装 typescript / @types/node（devDependencies）

# tsc 需要解析宿主自带的 @deepseek-ai/* 类型，先把它们链进本仓库的 node_modules
DSH_HOST_MODULES="$HOME/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai" \
  npm run link:host

npm run build          # = tsc
ls dist/               # 核对 11 个产物齐全——别只看 tsc 的 exit code
npm pack               # 产出 tarball，再走方式 A 安装
```

`DSH_HOST_MODULES` 指向 dsh 自带的 `@deepseek-ai` 包根目录，取决于你把 dsh 装在哪，
所以它由环境变量传入而不写死在脚本里。`npm run link:host`（`_link.cjs`）**只做
TypeScript 类型解析用**，运行期完全不需要；产物本身零外部运行期依赖。

装完（A / B / C 都一样）要在 profile 的 `dsh.profile.bundles` 里显式列出
`dsh-tui-local-llama`，否则宿主不会加载它。

### 配置路径

装好后进 TUI，`/settings` → 「Local llama.cpp」，填两件事就能用：

- **Executable** —— llama-server 路径，例如 `~/llama/llama-server.exe`
- **Models dir** —— GGUF 模型目录，例如 `~/llama/models`

`~` 会被插件展开成用户 home。

**都留空也行**：插件会扫 `~/llama`、`~/llama.cpp`（含 `build/`、`build/bin/`、
`build/bin/release/`）、`~/Desktop`，以及 `PATH` 里的每个目录（`DISCOVERY_TIMEOUT_MS`
默认 3s 超时）。要加别的位置用环境变量：

```bash
export LOCAL_LLAMA_EXE_DIR="$HOME/llama:$HOME/opt/llama.cpp"
export LOCAL_LLAMA_MODELS_DIR="$HOME/llama/models:$HOME/models"
```

也可以写进 `cordis.patch.yml` 的 `config.executable` / `config.modelsDir`——插件自带的
这份故意留空（见文件内注释），就是为了不写死任何机器路径。用户在 `/settings` 保存的值
走 profile 级 overlay，插件出厂配置不受影响。

### 环境变量

| 变量 | 作用 |
|---|---|
| `LOCAL_LLAMA_EXE_DIR` | 额外的可执行文件搜索目录，逗号分隔，逐个展开 `~` |
| `LOCAL_LLAMA_MODELS_DIR` | 额外的模型搜索目录，逗号分隔 |
| `LOCAL_LLAMA_LOG` | 诊断日志路径，默认 `~/.dsh-tui/local-llama-diag.log` |
| `LOCAL_LLAMA_DATA_DIR` | 覆盖 `~/.dsh-tui`，测试门禁时用 |
| `LOCAL_LLAMA_PID_FILE` | 覆盖 pid 文件路径，测试用 —— 门禁判成「不该跑」时会按 pid 记录杀进程 |


## 使用

- `/model` —— 列表里出现 `llama-local/<模型名>`。选中即加载，dsh 的 agent 走本地服务。
- `/settings` —— 「Local llama.cpp」区块，28 个字段分 5 组。改完保存即生效（见下节）。
- `alt+l` —— 切换服务启停。状态栏显示 `llama 运行中 · <模型> · 127.0.0.1:8642`。
- 退出 dsh —— 撤 UI 贡献 → 撤事件监听 → 拆模型目录 → 优雅停 llama-server。
  下次启动时会读 `pid.json`，收养或杀掉上次残留的孤儿进程。

---

## 启动门禁：什么情况下会拉起 llama-server

服务的启动时机**不是**「打开 dsh 就拉」，而是两个条件同时成立：

1. **当前 dsh-tui 跑的是 dsh 内核** —— 读 `~/.dsh-tui/kernel.json` 的 `backend` 字段，
   必须是 `dsh`（不是 `claude` / `codex`）。
2. **当前选中的模型是本地模型** —— 读 `~/.dsh-tui/model.json` 的 `provider` 字段，
   必须是 `llama-local`。

两个文件都是 dsh-tui 自己写的，本插件只读。任一条件不成立就不拉起；条件由成立
变成不成立时会主动停掉已在跑的服务。

为什么两个都要查：`model.json` 只有 dsh 内核的 `/model` 切换会写（宿主里
`writeModelPref` 只出现在 `dsh-adapter/channel/model-switch.js`），claude / codex
内核各自维护 `backends/<id>/prefs.json`，从不碰它。所以切到 claude 之后
`model.json` 还留着上次 dsh 会话的 `llama-local` —— 只看 `model.json` 会把一个
根本没在跑 dsh agent 的会话误判成该拉起服务。

内核解析顺序与宿主一致：`DSH_TUI_BACKEND_HANDOFF` → `DSH_TUI_BACKEND` →
`kernel.json` → 默认 `dsh`。宿主写在 profile Config 行里的 `backend:` 排在这三者
之前，但要解 YAML 才能读，插件不读它 —— profile 里若真钉了 `backend:`，看诊断日志
的 `backend=` 值核对。

负向变更（该跑 → 不该跑）会**连读两次确认**才停：宿主写 `model.json` 用的是非原子
`writeFileSync`，轮询恰好落在半写入窗口里会把 JSON 读成解析失败、读成「没选模型」，
直接停会白停一次再拉起来。正向变更（不该跑 → 该跑）立即生效。

两点边界：

- `model.json` **不存在**（从未用过 `/model`）时判为「不该跑」，不会自动拉起。
  但服务仍会在**第一个本地模型的请求到来时**按需启动 —— adapter 每次请求都会
  `ensure()`，这条兜底与门禁无关。
- `alt+l` 是手动开关，门禁不干预它；但之后若内核或模型发生切换，门禁仍会重新收敛。

---

## 配置项

默认值见 `src/config.ts` 的 `DEFAULTS`。`executable` / `modelsDir` 默认空串，交给自动发现。

### General 通用

| 字段 | 默认 | 说明 |
|---|---|---|
| `displayName` | `Local llama.cpp` | `/model` 列表里的展示名 |
| `executable` | `""` | llama-server 路径。空 = 自动发现 |
| `modelsDir` | `""` | GGUF 目录。空 = 自动发现 |
| `strategy` | `single` | `single` 一次一个模型进程；`router` 常驻 `--models-dir` + `/models/load` 热切 |
| `autoStart` | `true` | 门禁通过时自动拉起服务，否则等第一个请求。门禁见「启动门禁」节 |
| `initialModel` | `""` | `autoStart` 时优先加载的模型；空 = 目录里排序最前的一份 |
| `noUi` | `true` | llama-server 的 `--no-ui`（`--no-webui` 已弃用） |
| `debug` | `false` | 打开诊断探针输出 |

### Server 服务

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `8642` | 监听端口，夹取到 [1, 65535] |
| `apiKey` | `local` | 设了之后**每个端点都要** `Authorization: Bearer`，含 `/v1/models` 探测 |
| `disableThinking` | `true` | Qwen3 默认开 thinking，不关的话整段输出进 `reasoning_content`、`content` 永远空 |

### Context & GPU 上下文与 GPU

| 字段 | 默认 | 说明 |
|---|---|---|
| `ctxSize` | `8192` | `0` = 取模型自带值（Qwen3 是 262144，会 OOM，所以默认显式给） |
| `gpuLayers` | `999` | 全量 offload，比猜具体层数稳 |
| `threads` | `10` | 主线程数 |
| `threadsBatch` | `-1` | 批量线程数，`-1` = 同 `threads` |
| `batchSize` | `512` | 批大小 |
| `flashAttn` | `on` | `auto` / `on` / `off` |
| `cacheTypeK` | `q8_0` | KV 缓存量化：`auto` `f16` `q8_0` `q5_1` `q4_1` `q4_0` `b10` |
| `cacheTypeV` | `q8_0` | 同上 |

### Sampling 采样

| 字段 | 默认 |
|---|---|
| `temperature` | `0.8` |
| `topP` | `0.95` |
| `topK` | `40` |
| `minP` | `0.05` |
| `repeatPenalty` | `1.0` |
| `seed` | `-1` |

### Behavior 行为

| 字段 | 默认 | 说明 |
|---|---|---|
| `startTimeoutMs` | `30000` | 等待 `/v1/health` 就绪的超时 |
| `idleStopMs` | `0` | `0` = 不自动停机 |

---



## 验证

```bash
npm run build
npm test          # = route-gate + fallback-spawn + smoke，三条串行
```

三条各验一件事：

- `test/route-gate.mjs` —— 启动门禁。临时目录里造 `kernel.json` / `model.json`，
  验解析优先级、半写入 JSON、正负向变更通知。不启动 llama-server，秒级跑完。
- `test/fallback-spawn.mjs` —— 本地 `child_process` 回退实现。真 spawn 一次
  llama-server，等 `/v1/health` 就绪再确认模型真的加载了。
- `test/smoke.mjs` —— 端到端。假 seam 直接调 `apply()`，走
  `listProviders → listModels → prepareCall → stream` 一整条 dsh 内部路径，
  最后确认 disposer 把进程真停干净、且 boot 门禁判定确实执行过。

两条需要 llama-server 的测试用默认端口 `8651` / `8642`，被占了就换：

```bash
LOCAL_LLAMA_EXE_DIR="$HOME/llama" LOCAL_LLAMA_MODELS_DIR="$HOME/llama/models" \
  LLAMA_PORT=8652 node test/smoke.mjs
```

测试进程会把门禁数据和 pid 记录隔离到临时目录（`LOCAL_LLAMA_DATA_DIR` /
`LOCAL_LLAMA_PID_FILE`），不会读到 `~/.dsh-tui` 里的真文件，也不会杀掉你手动起的
llama-server。

## 许可证

本插件采用 **MIT License**，见 [`LICENSE`](./LICENSE)。

### 第三方致谢

| 组件 | 版本 | 协议 | 来源与用途 |
|---|---|---|---|
| `@deepseek-ai/schemastery` | 3.18.5 | MIT | vendored → `vendor/schemastery.js`，`/settings` 表单投影必需 |
| `@deepseek-ai/cosmokit` | 1.8.6 | MIT | vendored → `vendor/cosmokit.js`，上一项的唯一 import |
| llama.cpp (`llama-server`) | 自行安装 | MIT | 被本插件拉起的外部进程，**不分发**，需自行获取 |
| `@deepseek-ai/dsh-*`（cordis / dsh-tui / dsh-llm / dsh-settings） | 宿主提供 | 见各自仓库 | 仅 `import type` 引用，编译期擦除，不进产物 |

两个 vendored 文件都是上游产物的原样拷贝（`schemastery.js` 仅改了一行 import），
**完整的 MIT 版权与授权声明就写在各自文件头部**——MIT 要求版权声明随副本一起分发，
所以许可全文放在文件里而不是只留在文档中。请勿删除那些头部的许可文本。

- `vendor/schemastery.js` — Copyright (c) 2021-present Shigma
- `vendor/cosmokit.js` — Copyright (c) 2021-present Shigma
