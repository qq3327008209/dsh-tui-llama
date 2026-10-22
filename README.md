# dsh-tui-local-llama

dsh-tui 的本地推理插件：在终端里 `/model` 选一个本地 GGUF 模型，dsh 就替你拉起
`llama-server.exe`；退出 dsh 服务跟着关停；所有参数都能在 `/settings` 里改，改完
就地热生效或自动重启进程——全程不用碰 shell。

| 标识 | 值 |
|---|---|
| cordis entry id / settings 命名空间 | `dsh-tui-local-llama` |
| LLM provider id | `llama-local` |
| 状态栏 key | `local-llama` |
| 快捷键 | `alt+l` 启停服务 |
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

`npm pack` 产出 `dsh-tui-local-llama-0.1.0.tgz`，里面已经带好编译好的 `dist/`、
`vendor/`、`cordis.patch.yml`、`README`、`LICENSE`，拿到就能用，不需要 Node 构建环境：

```bash
cd ~/.dsh/profiles/dsh-tui
pnpm add ./dsh-tui-local-llama-0.1.0.tgz
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
ls dist/               # 核对 10 个产物齐全——别只看 tsc 的 exit code
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


## 使用

- `/model` —— 列表里出现 `llama-local/<模型名>`。选中即加载，dsh 的 agent 走本地服务。
- `/settings` —— 「Local llama.cpp」区块，28 个字段分 5 组。改完保存即生效（见下节）。
- `alt+l` —— 切换服务启停。状态栏显示 `llama 运行中 · <模型> · 127.0.0.1:8642`。
- 退出 dsh —— 撤 UI 贡献 → 撤事件监听 → 拆模型目录 → 优雅停 llama-server。
  下次启动时会读 `pid.json`，收养或杀掉上次残留的孤儿进程。

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
| `autoStart` | `true` | 应用启动即拉起服务（否则等第一个请求） |
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
