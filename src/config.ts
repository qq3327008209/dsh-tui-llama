/**
 * 插件常量与配置模型。
 *
 * 参数分层（决定 UI 分组与热生效语义，见 DESIGN.md §6）：
 *   L0 每请求热生效 —— dsh 的 GenerateOptions 只带 temperature / maxTokens，
 *      其余采样字段在这个协议里根本不存在，所以它们只能走 L1。
 *   L1 llama-server 重启生效（插件自己 stop→start，实测 ~2.4s）—— 包括全部
 *      采样参数，因为它们只能作为 CLI 启动参数。
 *   L2 dsh 重启生效 —— provider 静态声明类字段。
 */
/**
 * schemastery 走包内 vendor（`#schemastery` → ./vendor/schemastery.js）。
 *
 * 为什么要真 schema：`@deepseek-ai/dsh-settings` 的 `describe()` 用
 * `volatileForm(schema)` 决定一个 entry 会不会产出 settings namespace，而
 * `volatileForm` 内部调 `schema.toJSON()` 和 `new z(json)` —— 纯对象没有
 * `toJSON()` 会直接抛，没有任何 volatile 节点则返回 undefined。没有 namespace
 * 时 TUI 设置屏里 `SettingsForm.save()` 第一行就是 `return false`，面板变成
 * 全空白只读。所以 Config 必须是真 schemastery 实例。
 *
 * 为什么是 vendor 而不是依赖：插件装在 profile 的 node_modules 下，宿主不把
 * @deepseek-ai/* 提升到这里，裸 specifier 解析不到（之前踩过，整个模块加载失败）。
 * vendor 副本经 package.json 的 "imports" 映射解析，pnpm 清理不掉。
 */
import z from '#schemastery';

/**
 * cordis profile entry id（cordis.patch.yml 里的 `id`）。
 * 三个地方必须是同一个字符串：
 *   1. cordis.patch.yml 的 entry id
 *   2. ctx.settings 文档的 namespace（SettingsForms 按 entry id 组织）
 *   3. TUI 设置区的 ns（设置屏按它匹配可用的命名空间）
 */
export const ENTRY_ID = 'dsh-tui-local-llama';
/** provider 路由名。必须与 ctx.llm.registerAdapter([PROVIDER_ID], …) 一致。 */
export const PROVIDER_ID = 'llama-local';
/** settings 命名空间，等于 profile entry id。 */
export const SETTINGS_NS = ENTRY_ID;
/** 终端插件状态栏的 key（ctx.tuiStatus.set 的命名空间惯例）。 */
export const STATUS_KEY = 'local-llama';
/** PID 文件的相对位置（相对用户 home）。第三层关停保险用。 */
export const PID_REL = '.dsh-tui/local-llama/pid.json';
/** terminate() 里 SIGTERM → SIGKILL 的宽限期。 */
export const TERMINATE_GRACE_MS = 8000;
/** 自动发现阶段的总超时，防止 apply() 被卡住。 */
export const DISCOVERY_TIMEOUT_MS = 3000;

export interface LlamaConfig {
  displayName: string;
  /** llama-server 可执行文件。空 = 交给自动发现。 */
  executable: string;
  /** GGUF 模型目录。空 = 交给自动发现。 */
  modelsDir: string;
  host: string;
  port: number;
  /** single = 一次一个模型进程；router = --models-dir 常驻 + /models/load 热切。 */
  strategy: 'single' | 'router';
  /** 0 = llama.cpp 取模型自带值（Qwen3 是 262144，会 OOM，所以默认显式给）。 */
  ctxSize: number;
  /** 999 = 全量 offload，比猜具体层数稳。 */
  gpuLayers: number;
  threads: number;
  threadsBatch: number;
  batchSize: number;
  flashAttn: 'auto' | 'on' | 'off';
  cacheTypeK: string;
  cacheTypeV: string;
  /** L1：只能作 CLI 参数，dsh 的 GenerateOptions 里没有这些字段。 */
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  repeatPenalty: number;
  seed: number;
  /** Qwen3 系列默认开 thinking，会吞光输出并让 content 永远为空。true = 每次请求关。 */
  disableThinking: boolean;
  /** 应用启动时就拉起服务（否则等第一个请求到来）。 */
  autoStart: boolean;
  /** autoStart 时优先加载的模型；空串 = 目录里排序最前的一份。 */
  initialModel: string;
  apiKey: string;
  noUi: boolean;
  startTimeoutMs: number;
  /** 0 = 不自动停机。 */
  idleStopMs: number;
  debug: boolean;
}

/** JS 默认值。与 schema 默认一致，供 entry 层与 base 层合并。 */
export const DEFAULTS: LlamaConfig = {
  displayName: 'Local llama.cpp',
  executable: '',
  modelsDir: '',
  host: '127.0.0.1',
  port: 8642,
  strategy: 'single',
  ctxSize: 8192,
  gpuLayers: 999,
  threads: 10,
  threadsBatch: -1,
  batchSize: 512,
  flashAttn: 'on',
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
  temperature: 0.8,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.0,
  seed: -1,
  disableThinking: true,
  autoStart: true,
  initialModel: '',
  apiKey: 'local',
  noUi: true,
  startTimeoutMs: 30_000,
  idleStopMs: 0,
  debug: false,
};

/**
 * 运行期 schema —— 两个硬约束决定了它的形状：
 *
 * 1. **每个叶子字段必须 `.volatile()`，且外层对象不能 `.volatile()`。**
 *    dsh-settings 的 `volatileForm()` 只会把 volatile 节点投影成可编辑表单；
 *    一个都没标就返回 undefined，整个 entry 不产出 namespace，TUI 设置屏里
 *    这块就是只读空白。反过来顶层对象标了 volatile，cordis 的 resolveConfig
 *    会拒绝：`volatile fields require a fixed object path without an enclosing
 *    volatile field`。所以只有叶子标（与 dsh-agent-default-model 的写法一致）。
 *
 * 2. **每个字段必须 `.default()`，且不加 `.required()`。** `.default()` 让
 *    namespace 的 `value` 带上当前生效值（否则字段全显示空串），也让
 *    resolveConfig 在缺键时有确定结果。加 `.required()` 会在用户没填时抛错，
 *    把整份 entry config 作废 —— 这里字段越界是常态，越界夹取由 `adopt()`
 *    兜底，不交给 schema 校验。
 *
 * 枚举故意写成 `z.string()` 而不是 union：用户在 TUI 里打错一个词不该让
 * 整份配置失效，`adopt()` 的 `normalizeStrategy` / `normalizeFlashAttn`
 * 会把非法值回落。
 *
 * 默认值一律引用 DEFAULTS，避免两份默认值漂移。
 */
export const Config = z
  .object({
    displayName: z.string().default(DEFAULTS.displayName).volatile(),
    executable: z.string().default(DEFAULTS.executable).volatile(),
    modelsDir: z.string().default(DEFAULTS.modelsDir).volatile(),
    host: z.string().default(DEFAULTS.host).volatile(),
    port: z.number().default(DEFAULTS.port).volatile(),
    strategy: z.string().default(DEFAULTS.strategy).volatile(),
    ctxSize: z.number().default(DEFAULTS.ctxSize).volatile(),
    gpuLayers: z.number().default(DEFAULTS.gpuLayers).volatile(),
    threads: z.number().default(DEFAULTS.threads).volatile(),
    threadsBatch: z.number().default(DEFAULTS.threadsBatch).volatile(),
    batchSize: z.number().default(DEFAULTS.batchSize).volatile(),
    flashAttn: z.string().default(DEFAULTS.flashAttn).volatile(),
    cacheTypeK: z.string().default(DEFAULTS.cacheTypeK).volatile(),
    cacheTypeV: z.string().default(DEFAULTS.cacheTypeV).volatile(),
    temperature: z.number().default(DEFAULTS.temperature).volatile(),
    topP: z.number().default(DEFAULTS.topP).volatile(),
    topK: z.number().default(DEFAULTS.topK).volatile(),
    minP: z.number().default(DEFAULTS.minP).volatile(),
    repeatPenalty: z.number().default(DEFAULTS.repeatPenalty).volatile(),
    seed: z.number().default(DEFAULTS.seed).volatile(),
    disableThinking: z.boolean().default(DEFAULTS.disableThinking).volatile(),
    autoStart: z.boolean().default(DEFAULTS.autoStart).volatile(),
    initialModel: z.string().default(DEFAULTS.initialModel).volatile(),
    apiKey: z.string().default(DEFAULTS.apiKey).volatile(),
    noUi: z.boolean().default(DEFAULTS.noUi).volatile(),
    startTimeoutMs: z.number().default(DEFAULTS.startTimeoutMs).volatile(),
    idleStopMs: z.number().default(DEFAULTS.idleStopMs).volatile(),
    debug: z.boolean().default(DEFAULTS.debug).volatile(),
  });

/**
 * 解开 schemastery 的 volatile handle。
 *
 * 标了 `.volatile()` 的字段，`resolveConfig` 不会把默认值原样给出来，而是包成
 * `createVolatile(value)` —— 一个冻结的 `{get(), [write]()}` live handle
 * （schemastery.js:484）。这样 `/settings` 改值后能在不重建对象的前提下原地
 * 更新。JSON.stringify 一个 handle 是 `{}`，直接展开进配置就是灾难。
 *
 * dsh-settings 自己也是这么解的（plainConfig 先 isVolatile 再 .get()）。
 * 判定用 Symbol.for 的全局符号，与 cosmokit 的实现等价。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
function unwrap(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrap);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<PropertyKey, unknown>;
    if (VOLATILE_WRITE in obj && typeof (obj as { get?: () => unknown }).get === 'function') {
      return unwrap((obj as { get: () => unknown }).get());
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, unwrap(v)]));
  }
  return value;
}

/**
 * 把外部来源（entry config / settings 文档）合并成一份可信配置。
 *
 * entry config 可能带 volatile handle（见 unwrap），settings 文档是
 * `plainConfig` 解过包的纯值，两者都走 unwrap 才安全。
 */
export function adopt(entry: Partial<LlamaConfig>, override?: Partial<LlamaConfig>): LlamaConfig {
  const fromEntry = unwrap(entry) as Partial<LlamaConfig>;
  const fromOverride = unwrap(override) as Partial<LlamaConfig>;
  const merged: LlamaConfig = { ...DEFAULTS, ...fromEntry, ...fromOverride };
  merged.strategy = normalizeStrategy(merged.strategy);
  merged.flashAttn = normalizeFlashAttn(merged.flashAttn);
  merged.port = Number.isFinite(merged.port) ? Math.min(65535, Math.max(1, Math.round(merged.port))) : DEFAULTS.port;
  merged.ctxSize = Number.isFinite(merged.ctxSize) ? Math.max(0, Math.round(merged.ctxSize)) : DEFAULTS.ctxSize;
  return merged;
}

export function normalizeStrategy(value: unknown): 'single' | 'router' {
  return value === 'router' || value === 'api' ? 'router' : 'single';
}

export function normalizeFlashAttn(value: unknown): 'auto' | 'on' | 'off' {
  return value === 'on' || value === 'off' ? value : 'auto';
}

/** 展示名超长截断，id 保持完整（不影响选择与调用）。 */
export function truncateModelName(name: string, max = 30): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/**
 * llama.cpp 请求头。设了 `--api-key` 之后**每一个**端点都要这个头，
 * `/v1/models` 探测和 `/v1/chat/completions` 一样——漏一处就永远拿 401。
 * 集中在这一处，避免探测/请求两条路径各写一份再漂移。
 */
export function llamaHeaders(
  cfg: { apiKey: string },
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  return headers;
}

/** 展开 `~` 前缀，Windows 上同时接受正斜杠。 */
export function expandPath(p: string): string {
  if (!p) return p;
  if (p === '~') return process.env.USERPROFILE ?? p;
  if (p.startsWith('~\\') || p.startsWith('~/')) {
    return (process.env.USERPROFILE ?? '') + p.slice(1);
  }
  return p;
}
