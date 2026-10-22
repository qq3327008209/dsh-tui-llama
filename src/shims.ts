/**
 * dsh-llm 运行期 API 的最小本地替身。
 *
 * 为什么不用真包：插件装在 profile 的 node_modules 里，宿主不向那里提升
 * `@deepseek-ai/*`，ESM 解析直接 `ERR_MODULE_NOT_FOUND`，整个模块加载失败 →
 * `apply()` 从不执行。表现为「插件装了但 /model 里什么都没有」，而且编译零报错。
 *
 * 这里复刻的三个符号在 dsh-llm 里都很薄：
 *   - `attributionHeaders()`：只造一个 User-Agent 头。
 *   - `LlmError`：`extends HarnessError extends Error`，构造 `(message, code, options?)`。
 *   - `ToolCallId(id)`：branded string 的类型断言，运行时是恒等函数。
 *
 * 类型仍然从 dsh-llm 取（`import type` 编译期擦除，零运行期成本），
 * 这样 StreamChunk / GenerateOptions 的契约不会漂移。
 */
import type { ToolCallId as ToolCallIdType } from '@deepseek-ai/dsh-llm';

/**
 * @deepseek-ai/dsh-attachment 的图片引用/目标形状（结构复制，避免多一条依赖）。
 * dsh-llm 的 adapter 契约里 `imageRequestTarget(ref): {width,height,maxBytes}`
 * 只读这三个数值字段，本适配器又不接图片（见 adapter.ts 的 UNSUPPORTED_MODALITY），
 * 所以最小结构面足够。
 */
export interface ImageAttachmentRef {
  width: number;
  height: number;
  bytes: number;
}

export interface ImageRequestTarget {
  width: number;
  height: number;
  maxBytes: number;
}

const HARNESS_IDENTITY = {
  product: 'deepseek-harness',
  version: '0.1.0',
  url: 'https://github.com/deepseek-ai/deepseek-harness',
} as const;

/** 每个 provider 请求都应带的身份归因头。头名用小写（HTTP 字段名不区分大小写）。 */
export function attributionHeaders(): Record<string, string> {
  const i = HARNESS_IDENTITY;
  return { 'user-agent': `${i.product}/${i.version} (+${i.url})` };
}

/**
 * 结构对齐 dsh-llm 的 `LlmErrorOptions`（`extends ErrorOptions` 再加四个
 * provider 事实）。`status` 是 HTTP 状态码，别跟 JS Error 的重试语义混淆。
 */
export interface LlmErrorOptions extends ErrorOptions {
  /** 观测到的 HTTP 状态码。 */
  status?: number;
  /** provider 要求的重试等待（ms），正有限数。 */
  providerRetryAfterMs?: number;
  /** provider 侧的不透明请求 id。 */
  requestId?: string;
  /** 需额外卸载的最老图片块数量；仅 `IMAGE_OFFLOAD_REQUIRED` 时使用。 */
  offloadImages?: number;
}

/**
 * 结构对齐 dsh-llm 的 `LlmError`：`message` + 可路由的 `code` + 可序列化的
 * `failure` 快照。宿主 `normalizeLlmFailure()` 只认这两个自有属性，
 * 所以必须都是 own property（不能靠原型继承），这里用类字段赋值保证。
 */
export class LlmError extends Error {
  readonly code: string;

  /** 与这个活 Error 并存的可序列化事实，供终态 finish chunk 携带。 */
  readonly failure: Readonly<{
    message: string;
    code: string;
    status?: number;
    providerRetryAfterMs?: number;
    requestId?: string;
    offloadImages?: number;
  }>;

  constructor(message: string, code: string, options?: LlmErrorOptions) {
    super(message, options);
    this.code = code;
    const { cause: _cause, ...facts } = options ?? {};
    this.failure = Object.freeze({ ...facts, message, code });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** dsh-llm 的 `ToolCallId` 是 branded string，运行时恒等。 */
export function ToolCallId(id: string): ToolCallIdType {
  return id as ToolCallIdType;
}
