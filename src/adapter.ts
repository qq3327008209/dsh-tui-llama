/**
 * OpenAI 兼容适配器：把 dsh 的 GenerateOptions 翻成 llama.cpp 的
 * `/v1/chat/completions` 请求，SSE 流回译成 StreamChunk。
 *
 * 关键点（实测结论，见 DESIGN.md §6）：
 *   - 每请求只有 temperature / max_tokens 能热生效；top_p / top_k / min_p /
 *     repeat_penalty / seed 都是 llama-server 启动参数，由 llama-server.ts 注入 argv。
 *   - Qwen3 默认开 thinking：整段输出进 reasoning_content，content 为空且
 *     finish_reason=length，看着像「插件坏了」。这里发
 *     `chat_template_kwargs: { enable_thinking: false }` 关掉。
 *   - 本适配器完全绕过 pi-ai：自己 fetch + 自己解 SSE，所以 pi-ai 的字段裁剪
 *     不构成额外限制。
 */
import type {
  ContentBlock,
  GenerateOptions,
  LlmImageRequestPricing,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import {
  attributionHeaders,
  type ImageAttachmentRef,
  type ImageRequestTarget,
  LlmError,
  ToolCallId,
} from './shims.js';
import type { LlamaConfig } from './config.js';
import { llamaHeaders, truncateModelName } from './config.js';
import type { ServerStatus } from './llama-server.js';
import type { ModelInfo } from './model-store.js';

export interface AdapterDeps {
  cfg: () => LlamaConfig;
  status: () => ServerStatus;
  /** 按 id 解析已注册模型。 */
  resolve: (id: string) => ModelInfo | undefined;
  /** 全量模型列表（listModels 用）。 */
  models: () => ModelInfo[];
  /** 请求前保证进程已就绪且模型已加载。 */
  ensure: (modelId?: string) => Promise<void>;
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

/**
 * 刻意不 `extends LlmAdapter`（那是运行期 import）。
 * `registerAdapter` 的校验是纯结构化的（prepareRoutes 只读 providerInfo /
 * providerRetryPolicy，没有 instanceof），所以普通类就能过。
 * 基类提供的默认实现都在下面逐个补上，语义与 dsh-llm 的基类一致。
 */
export class LlamaLocalAdapter {
  constructor(
    private readonly deps: AdapterDeps,
  ) {}

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.deps.cfg().displayName };
  }

  /** 基类默认：返回 undefined 让 core 用通用重试策略。 */
  providerRetryPolicy(_provider: string): undefined {
    return undefined;
  }

  /** 基类默认：不声明图片计费，消费方回退到中性估算。 */
  imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined {
    return undefined;
  }

  /** 基类默认：不缩放，按归一化后的原始尺寸透传。 */
  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const cfg = this.deps.cfg();
    return this.deps.models().map((m) => ({
      provider,
      id: m.id,
      name: truncateModelName(m.name),
      description: cfg.strategy === 'router' ? '热切加载（无需重启服务）' : undefined,
      inputModalities: ['text'],
    }));
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const cfg = this.deps.cfg();
    const ctx = cfg.ctxSize > 0 ? cfg.ctxSize : 8192;
    return {
      provider,
      id: model,
      name: truncateModelName(this.deps.resolve(model)?.name ?? model),
      inputModalities: ['text'],
      context: { contextWindow: ctx },
      defaultMaxTokens: Math.min(8192, Math.floor(ctx / 2)),
    };
  }

  /** 基类默认 prepareCall 的逐字复刻：解析元数据 + 绑定一代流的入口。 */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // P0：任何请求打到 OpenAI 端口之前，先保证所选模型已就绪。
    await this.deps.ensure(options.model);
    const cfg = this.deps.cfg();

    const body: Record<string, unknown> = {
      model: options.model,
      messages: buildWireMessages(options),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options.stop && options.stop.length > 0) body.stop = options.stop;
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    // Qwen3 的 thinking 开关。默认 true：关不掉的话 content 会永远是空字符串。
    if (cfg.disableThinking) body.chat_template_kwargs = { enable_thinking: false };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let res: Response;
    try {
      res = await fetch(`http://${cfg.host}:${cfg.port}/v1/chat/completions`, {
        method: 'POST',
        headers: llamaHeaders(cfg, attributionHeaders()),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new LlmError(
        `llama.cpp 请求失败 (HTTP ${res.status})${text ? `: ${text.slice(0, 300)}` : ''}`,
        pickFailureCode(text, res.status),
        res.status ? { status: res.status } : undefined,
      );
    }

    const emitter = new BlockEmitter();
    let finishReason = 'stop';
    try {
      for await (const json of sseChunks(res.body)) {
        const chunk = json as {
          error?: { message?: string };
          choices?: { delta?: SseDelta; finish_reason?: string | null }[];
          usage?: SseUsage;
        };
        if (chunk.error) {
          throw new LlmError(chunk.error.message ?? 'llama.cpp 错误', pickFailureCode(chunk.error.message ?? '', 0));
        }
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          if (delta.content) emitter.feedText(delta.content);
          if (delta.reasoning_content) emitter.feedReasoning(delta.reasoning_content);
          for (const tc of delta.tool_calls ?? []) emitter.feedTool(tc);
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        if (chunk.usage) emitter.noteUsage(chunk.usage);
        for (const out of emitter.take()) yield out;
      }
    } catch (err) {
      if (options.signal?.aborted || controller.signal.aborted) {
        throw new LlmError('aborted by caller', 'ABORTED');
      }
      throw err;
    }
    for (const out of emitter.finish(finishReason)) yield out;
  }
}

/* ---------------- 请求体组装 ---------------- */

function buildWireMessages(options: GenerateOptions): WireMessage[] {
  const out: WireMessage[] = [];
  if (options.system) out.push({ role: 'system', content: options.system });
  for (const msg of options.messages) out.push(...translateMessage(msg));
  return out;
}

function translateMessage(msg: RequestMessage): WireMessage[] {
  // 工具结果：OpenAI 需要 role=tool + tool_call_id 关联。
  if (msg.role === 'tool') {
    return [
      {
        role: 'tool',
        tool_call_id: String(msg.toolCallId),
        content: (msg.isError ? '[error]\n' : '') + textOf(msg.content),
      },
    ];
  }
  if (msg.role === 'user') {
    rejectImages(msg.content);
    return [{ role: 'user', content: textOf(msg.content) }];
  }
  if (msg.role === 'system' || msg.role === 'developer') {
    const text = textOf(msg.content);
    return text ? [{ role: 'system', content: text }] : [];
  }
  // assistant
  const text = textOf(msg.content);
  const calls = msg.content.filter((c) => c.type === 'tool-call');
  const wire: WireMessage = { role: 'assistant' };
  if (text) wire.content = text;
  if (calls.length > 0) {
    wire.tool_calls = calls.map((c) => ({
      id: String(c.id),
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  return [wire];
}

function rejectImages(blocks: readonly ContentBlock[]): void {
  if (blocks.some((c) => c.type === 'image')) {
    throw new LlmError('本地 llama.cpp 路由只支持纯文本，不接受图片输入', 'UNSUPPORTED_MODALITY');
  }
}

function textOf(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/* ---------------- SSE 解析 ---------------- */

interface SseDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}
interface SseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 行缓冲 SSE：`data: <json>`，`[DONE]` 终止。 */
async function* sseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        yield JSON.parse(payload);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function pickFailureCode(detail: string, status: number): string {
  const d = detail.toLowerCase();
  if (/(context|too many tokens|exceed|token limit|max context)/.test(d)) return 'CONTEXT_WINDOW_EXCEEDED';
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 404) return 'NO_ADAPTER';
  if (status >= 500 || status === 429) return 'RATE_LIMIT';
  return 'REQUEST_FAILED';
}

/* ---------------- 块发射器 ---------------- */

/**
 * 把 SSE delta 聚合为 StreamChunk。
 * 块索引按「首个 delta 到达顺序」单调分配：BlockAssembler 用 index 作 partial
 * 的键，索引重号会把两个块并进同一个 partial（文本互相污染），所以这里不预设
 * text=0 之类的位置，全部由到达顺序决定。llama.cpp 实际是先 reasoning 后 content
 * 再 tool_calls，所以顺序即语义顺序。
 * usage 在 finish 之前发出。
 */
class BlockEmitter {
  private nextIndex = 0;
  private textIdx?: number;
  private textAcc = '';
  private reasonIdx?: number;
  private reasonAcc = '';
  private tools = new Map<number, { block: number; id: string; name: string; args: string }>();
  private usageSent = false;
  private pending: StreamChunk[] = [];

  feedText(delta: string): void {
    if (this.textIdx === undefined) {
      this.textIdx = this.nextIndex++;
      this.push({ type: 'block-start', index: this.textIdx, blockType: 'text' });
    }
    this.textAcc += delta;
    this.push({ type: 'text-delta', index: this.textIdx, text: delta });
  }

  feedReasoning(delta: string): void {
    if (this.reasonIdx === undefined) {
      this.reasonIdx = this.nextIndex++;
      this.push({ type: 'block-start', index: this.reasonIdx, blockType: 'reasoning' });
    }
    this.reasonAcc += delta;
    this.push({ type: 'reasoning-delta', index: this.reasonIdx, text: delta });
  }

  feedTool(tc: NonNullable<SseDelta['tool_calls']>[number]): void {
    const idx = tc.index ?? 0;
    let entry = this.tools.get(idx);
    if (!entry) {
      entry = { block: this.nextIndex++, id: '', name: '', args: '' };
      this.tools.set(idx, entry);
      this.push({ type: 'block-start', index: entry.block, blockType: 'tool-call' });
    }
    if (tc.id) entry.id = String(tc.id);
    if (tc.function?.name) entry.name = tc.function.name;
    const argDelta = tc.function?.arguments ?? '';
    if (argDelta) entry.args += argDelta;
    this.push({
      type: 'tool-call-delta',
      index: entry.block,
      id: ToolCallId(callId(entry.id, entry.block)),
      name: tc.function?.name,
      argumentsDelta: argDelta,
    });
  }

  noteUsage(u: SseUsage): void {
    if (this.usageSent) return;
    this.usageSent = true;
    this.push({
      type: 'usage',
      usage: {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        totalTokens: u.total_tokens ?? undefined,
      },
    });
  }

  take(): StreamChunk[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  finish(reason: string): StreamChunk[] {
    const out: StreamChunk[] = [];
    if (this.textIdx !== undefined) {
      out.push({
        type: 'block-end',
        index: this.textIdx,
        block: { type: 'text', text: this.textAcc },
      });
    }
    if (this.reasonIdx !== undefined) {
      out.push({
        type: 'block-end',
        index: this.reasonIdx,
        block: { type: 'reasoning', text: this.reasonAcc },
      });
    }
    for (const t of [...this.tools.values()].sort((a, b) => a.block - b.block)) {
      out.push({
        type: 'block-end',
        index: t.block,
        block: { type: 'tool-call', id: ToolCallId(callId(t.id, t.block)), name: t.name, arguments: t.args },
      });
    }
    if (!this.usageSent) out.push({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } });

    // thinking 没关掉时的典型形态：0 内容 + finish_reason=length。
    const produced = this.textIdx !== undefined || this.reasonIdx !== undefined || this.tools.size > 0;
    if (!produced) {
      out.push({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message:
              `llama.cpp 没有产出任何内容（finish_reason=${reason}）。` +
              `若模型带 thinking（Qwen3 系列），请在 /settings 里开启「关闭 thinking」。`,
            code: 'EMPTY_RESPONSE',
          },
        },
      });
      return out;
    }
    const finish =
      reason === 'tool_calls'
        ? { kind: 'tool-calls' as const }
        : reason === 'length'
          ? { kind: 'max-tokens' as const }
          : reason === 'abort' || reason === 'cancelled'
            ? { kind: 'aborted' as const, failure: { message: '生成被取消', code: 'ABORTED' } }
            : { kind: 'stop' as const };
    out.push({ type: 'finish', reason: finish });
    return out;
  }

  private push(chunk: StreamChunk): void {
    this.pending.push(chunk);
  }
}

function callId(existing: string, block: number): string {
  return existing || `call_${block}`;
}
