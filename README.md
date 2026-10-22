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

完整设计推导（参数分层、Windows 优雅退出序列、风险排除清单）见 [`DESIGN.md`](./DESIGN.md)。

---

## 前置条件

1. **llama.cpp server 可执行文件**，例如 `D:\llama\llama-server.exe`。
   本机实测版本 `0.7.0-dev (build 11784)`，CUDA 13.4。
2. **至少一个 GGUF 模型**，放在某个目录里，例如 `D:\llama\models\qwen3-5-4B-Q4_K_M.gguf`。
3. **Node.js ≥ 20**、dsh-tui 已安装（插件挂在 `~/.dsh/profiles/dsh-tui/` 下）。

`executable` / `modelsDir` 都留空时插件会自动扫描常见位置（`DISCOVERY_TIMEOUT_MS` 3s 超时），
扫不到才报错。但**显式填最稳**，自动发现只是兜底。

---

## 安装

```bash
# 1. 编译
npx tsc
ls dist/          # 核对 10 个产物齐全——别只看 tsc 的 exit code

# 2. 装进 profile
cd ~/.dsh/profiles/dsh-tui
pnpm add file:"C:/Users/John Smish/Desktop/dsh-tui-llama"
# 并在 dsh.profile.bundles 里显式列出 dsh-tui-local-llama

# 3. 同步产物（关键，见下）
```

### 为什么第 3 步是逐文件拷贝

`npx tsc` 只写源码目录的 `dist`，profile 里那份**不会自动更新**——宿主会报
`1 entry did not activate: ERR_MODULE_NOT_FOUND ...dist\diag.js`。

所以每次编译后都要显式同步。命令里先 `rm -f` 再 `cp` 是因为：首次安装时
profile 的 `dist/*.js` 是逐文件**硬链接**（不是目录级 symlink），直接 `cp`
覆盖同 inode 会报 `same file` 失败；执行过一次 `rm -f && cp` 之后链接就断了，
变成两份独立副本，但 `rm -f` 保留在命令里是幂等且保险的。

```bash
PROFILE=~/.dsh/profiles/dsh-tui/node_modules/dsh-tui-local-llama

for f in adapter config diag discover index llama-server log-hub model-store shims ui; do
  rm -f "$PROFILE/dist/$f.js" && cp "dist/$f.js" "$PROFILE/dist/$f.js"
done
rm -f "$PROFILE/vendor/schemastery.js" "$PROFILE/vendor/cosmokit.js"
cp vendor/schemastery.js vendor/cosmokit.js "$PROFILE/vendor/"
rm -f "$PROFILE/package.json" "$PROFILE/cordis.patch.yml"
cp package.json cordis.patch.yml "$PROFILE/"
```

> 或者跑 `npm run link:host`（`_link.cjs`），它封装了上面这套流程。
> 同步完用 `stat -c %i` 对比两边 inode：不同就是独立副本，下次编译还得再同步。

### 改完照跑的四条验证

```bash
npx tsc && ls dist/
# 产物审计：只允许 ./ 相对路径、#schemastery、node:* 内置模块
grep -hoE "from '([^']+" dist/*.js | sort -u

dsh --profile dsh-tui --help 2>&1 | grep -aE "activate|failed"   # 不能出现激活失败
cat ~/.dsh-tui/local-llama-diag.log                                # 看 register-OK / sections-OK

node test/smoke.mjs          # 宿主 seam 路径：真拉 llama-server 出字
node test/fallback-spawn.mjs # 本地 child_process 回退路径
```

插件在宿主里是非 TTY 场景跑不起来的（dsh-tui 要求 stdout 是 TTY），所以回归测试
**不能靠 TUI 手点**——`test/smoke.mjs` 用假的 `subprocess` seam 直调 `apply(ctx, config)`，
走的是 dsh 内部同一条 `listProviders → listModels → prepareCall → stream` 路径，
从 llama.cpp 出第一个 token 大约 3.5s。

---

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

## 热生效语义

改保存后插件按字段分类处理，这是**实测行为**，不是设计意图：

- **L0 立即生效，不动进程**（7 个）：`temperature`（随请求带）、`disableThinking`
  （随请求带 `chat_template_kwargs`）、`displayName`、`debug`、`autoStart`、
  `initialModel`、`idleStopMs`。
- **L1 重启 llama-server**（21 个，实测约 2.4s）：其余全部——包括所有采样参数。
  原因是 pi-ai 的 `openai-completions` 只透传 `temperature` + `maxTokens` 两个采样字段，
  `top_p` / `top_k` / `min_p` / `repeat_penalty` / `seed` 在请求体里根本不存在，
  所以只能作为 llama-server 的 CLI 启动参数。
- **L2 重启 dsh**：provider 静态声明类字段，本插件目前没有这类字段。

`apply()` 里那条 `settings/document-updated` 监听器是 L1 生效的**唯一路径**
（volatile handle 的原地更新不会触发 cordis 的 entry reload），删不得。
用户在 `/settings` 保存的值落到 `~/.dsh/profiles/dsh-tui/cordis.patch.yml`
（profile 级 overlay），插件自带的 `cordis.patch.yml` 保持出厂默认不动。

> 显存提示：本机 GPU 实际是 **6140 MiB**（`llama-server --list-devices`），
> 不是 Windows WMI 报的 4GB。`ctxSize 8192` 实测吞吐 47.7 tok/s。
> `ctxSize` 翻倍则 KV cache 近似翻倍——OOM 或掉速先怀疑它。

---

## 实现要点

几条反直觉的约束，是这份代码长成现在这样的原因：

1. **`Config` 必须是真 schemastery 实例，每个叶子 `.volatile()`、`.default()`，
   顶层不能 `.volatile()`，也不要 `.required()`。** 缺一条 `/settings` 都会退化：
   一个叶子没标 volatile → 整个 entry 不产出 namespace → `SettingsForm.save()`
   第一行 `return false`，面板全空白只读；顶层标了 volatile → cordis 的
   `resolveConfig` 直接拒绝激活。
2. **volatile 字段的值是个 live handle，不是值本身。** `resolveConfig` 会把默认值包成
   `createVolatile(value)`，`JSON.stringify` 它是 `{}`。`config.ts` 的 `unwrap()`
   用 `Symbol.for('cosmokit.volatile.write')` 递归解开，`adopt()` 对 entry config
   和 settings 文档都过一遍。
3. **产物零运行期外部依赖。** profile 的 `node_modules` 里没有 `@deepseek-ai/*`，
   宿主不把自家包提升给插件包。类型用 `import type`（编译期擦除），运行期符号
   在 `src/shims.ts` 本地复刻，schemastery 走包内 vendor（`#schemastery` →
   `./vendor/schemastery.js`，经 `package.json` 的 `imports` 映射解析，
   pnpm 清理不掉游离的 `node_modules` 目录但清理不掉 `imports`）。
4. **不要顶层 `export const inject = [...]`。** 顶层声明是硬依赖，任何一个服务
   暂不可用就会让整个 entry 激活失败。本插件一律先软探测 seam，探不到才退到
   `ctx.inject([单个服务名], cb)` 的作用域注入——那是「等就绪」，fiber 挂起而不失败。
   注意 `ctx.inject` 的数组是 all-or-nothing，混进一个永不存在的依赖会卡死同批其他依赖，
   所以 `settings` / `tuiSettingsSections` / `llm` 是三次独立调用。
5. **不要 `default export`。** 加载器的 `unwrapExports` 一见 `default` 就把模块
   坍缩成它，`name` / `Config` / `apply` 全丢，插件静默不生效。
6. **注册必须在活的激活上下文里调**，且 disposer 进 `teardown`、不要把注册本身
   包进 `teardown.push(...)` 的闭包里——那种写法让注册只发生在清理阶段，面板永不出现。
7. **进程管理不依赖宿主的 `subprocess` 服务**（本 profile 没有）。
   `llama-server.ts` 里的 `localSubprocess()` 用 `node:child_process.spawn`
   自实现同一个接口作回退：宿主有服务就用宿主，没有就本地拉。
   不实现 `spawnTerminal()`，管理器自动走管道模式，正好配 `--no-ui`。

---

## 已知限制

- `gracefulStop()` 在 disposer 里是 fire-and-forget，dsh 硬退时可能留孤儿；
  靠 `pid.json` 收养/杀掉旧进程兜底。
- Windows 管道模式下 `SIGINT` 对原生 `.exe` 基本无效，`--no-ui` 下也没有确认提示，
  所以优雅退出实际是走完宽限期后靠 `terminate()` 兜底——最坏约 14s，实测 15s 内干净退出。
- `strategy: router` 依赖 llama.cpp 的 `/models/load` 热切接口，本插件只实现了
  `single` 路径的完整验证。
- 模型 provider 的 `api` 只能是 `openai-completions` / `openai-responses` /
  `anthropic-messages` 三选一，本地 llama.cpp 只能伪装成 `openai-completions`。
- 本插件不含也不分发 llama.cpp 二进制或模型权重，那些要你自己装（见下一节）。

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
