const HARNESS_IDENTITY = {
    product: 'deepseek-harness',
    version: '0.1.0',
    url: 'https://github.com/deepseek-ai/deepseek-harness',
};
/** 每个 provider 请求都应带的身份归因头。头名用小写（HTTP 字段名不区分大小写）。 */
export function attributionHeaders() {
    const i = HARNESS_IDENTITY;
    return { 'user-agent': `${i.product}/${i.version} (+${i.url})` };
}
/**
 * 结构对齐 dsh-llm 的 `LlmError`：`message` + 可路由的 `code` + 可序列化的
 * `failure` 快照。宿主 `normalizeLlmFailure()` 只认这两个自有属性，
 * 所以必须都是 own property（不能靠原型继承），这里用类字段赋值保证。
 */
export class LlmError extends Error {
    code;
    /** 与这个活 Error 并存的可序列化事实，供终态 finish chunk 携带。 */
    failure;
    constructor(message, code, options) {
        super(message, options);
        this.code = code;
        const { cause: _cause, ...facts } = options ?? {};
        this.failure = Object.freeze({ ...facts, message, code });
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
/** dsh-llm 的 `ToolCallId` 是 branded string，运行时恒等。 */
export function ToolCallId(id) {
    return id;
}
