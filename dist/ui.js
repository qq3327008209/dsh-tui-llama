/**
 * TUI 侧输出：设置区字段树、状态栏文本、参数重启判定。
 *
 * 设置区的宿主类型位于 dsh-tui 的内部路径（lib/types/adapter/ports/…），
 * 不在包 exports 里、无法作为类型依赖引入。这里只声明实际用到的结构形状——
 * 注册时靠结构匹配通过，不产生版本耦合；宿主内部类型改名时插件不受影响。
 */
import { truncateModelName } from './config.js';
/* ---------------- 解析器 ---------------- */
/** 整数：越界夹取而不是拒绝，让用户少改一次。 */
function int(text, min, max) {
    const raw = text.trim();
    if (raw === '')
        return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n))
        return undefined;
    let v = Math.round(n);
    if (min !== undefined)
        v = Math.max(min, v);
    if (max !== undefined)
        v = Math.min(max, v);
    return { kind: 'set', value: v };
}
/** 小数：保留精度，区间夹取。 */
function frac(text, min, max) {
    const raw = text.trim();
    if (raw === '')
        return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n))
        return undefined;
    return { kind: 'set', value: Math.min(max, Math.max(min, n)) };
}
/** 文本：空串是合法值（留空 = 交给自动发现），所以走 set 而非 clear。 */
function str(text) {
    return { kind: 'set', value: text.trim() };
}
const CACHE_OPTIONS = [
    { value: 'auto', label: 'auto' },
    { value: 'f16', label: 'f16' },
    { value: 'q8_0', label: 'q8_0' },
    { value: 'q5_1', label: 'q5_1' },
    { value: 'q4_1', label: 'q4_1' },
    { value: 'q4_0', label: 'q4_0' },
    { value: 'b10', label: 'b10' },
];
/* ---------------- 设置区 ---------------- */
export function buildSettingsSection(ns) {
    return {
        ns,
        title: 'Local llama.cpp',
        descriptions: { zh: '本地 llama.cpp' },
        groups: [
            { id: 'general', title: 'General', descriptions: { zh: '通用' } },
            { id: 'server', title: 'Server', descriptions: { zh: '服务' } },
            { id: 'gpu', title: 'Context & GPU', descriptions: { zh: '上下文与 GPU' } },
            { id: 'sampling', title: 'Sampling', descriptions: { zh: '采样' } },
            { id: 'behavior', title: 'Behavior', descriptions: { zh: '行为' } },
        ],
        fields: [
            /* ---- 通用 ---- */
            {
                path: ['displayName'],
                label: 'Display name',
                descriptions: { zh: '显示名称' },
                hint: '显示在模型选择列表里的名称',
                group: 'general',
                kind: 'text',
                parse: str,
            },
            {
                path: ['executable'],
                label: 'Executable',
                descriptions: { zh: '可执行文件' },
                hint: 'llama-server 路径；留空则自动发现',
                group: 'general',
                kind: 'text',
                placeholder: 'D:\\llama\\llama-server.exe',
                parse: str,
            },
            {
                path: ['modelsDir'],
                label: 'Models dir',
                descriptions: { zh: '模型目录' },
                hint: 'GGUF 模型所在目录；留空则自动发现',
                group: 'general',
                kind: 'text',
                placeholder: 'D:\\llama\\models',
                parse: str,
            },
            {
                path: ['strategy'],
                label: 'Strategy',
                descriptions: { zh: '启动策略' },
                hint: 'single 切换模型需重启进程；router 常驻进程可热切模型',
                group: 'general',
                kind: 'select',
                options: [
                    { value: 'single', label: 'single', descriptions: { zh: '单模型' } },
                    { value: 'router', label: 'router', descriptions: { zh: '常驻路由' } },
                ],
            },
            {
                path: ['autoStart'],
                label: 'Auto start',
                descriptions: { zh: '启动时拉起' },
                hint: '打开 dsh 就启动 llama.cpp；关闭则等第一个请求',
                group: 'general',
                kind: 'boolean',
            },
            {
                path: ['initialModel'],
                label: 'Initial model',
                descriptions: { zh: '初始模型' },
                hint: 'autoStart 时优先加载的模型 id（文件名去扩展名）；留空取目录里第一个',
                group: 'general',
                kind: 'text',
                placeholder: 'qwen3-5-4B-Q4_K_M',
                parse: str,
            },
            {
                path: ['noUi'],
                label: 'No built-in UI',
                descriptions: { zh: '隐藏自带界面' },
                hint: '关掉 llama-server 自己的 web 界面',
                group: 'general',
                kind: 'boolean',
            },
            {
                path: ['debug'],
                label: 'Debug',
                descriptions: { zh: '调试' },
                hint: '记录完整启动命令与更多细节',
                group: 'general',
                kind: 'boolean',
            },
            /* ---- 服务 ---- */
            {
                path: ['host'],
                label: 'Host',
                descriptions: { zh: '监听地址' },
                hint: '127.0.0.1 只本机可达',
                group: 'server',
                kind: 'text',
                placeholder: '127.0.0.1',
                parse: str,
            },
            {
                path: ['port'],
                label: 'Port',
                descriptions: { zh: '端口' },
                hint: '被占用且非本插件进程时会拒绝启动',
                group: 'server',
                kind: 'number',
                parse: (t) => int(t, 1, 65535),
            },
            {
                path: ['apiKey'],
                label: 'API key',
                descriptions: { zh: 'API 密钥' },
                hint: '留空则不校验；设置后请求带 Authorization: Bearer',
                group: 'server',
                kind: 'text',
                parse: str,
            },
            {
                path: ['disableThinking'],
                label: 'Disable thinking',
                descriptions: { zh: '关闭 thinking' },
                hint: 'Qwen3 系列必须关，否则 content 永远为空；每次请求生效，无需重启',
                group: 'server',
                kind: 'boolean',
            },
            /* ---- 上下文与 GPU ---- */
            {
                path: ['ctxSize'],
                label: 'Context size',
                descriptions: { zh: '上下文长度' },
                hint: '0 = 用模型自带值（Qwen3 是 262144，会 OOM，建议显式给）',
                group: 'gpu',
                kind: 'number',
                parse: (t) => int(t, 0, 1 << 20),
            },
            {
                path: ['gpuLayers'],
                label: 'GPU layers',
                descriptions: { zh: 'GPU 层数' },
                hint: '999 = 全部层放 GPU',
                group: 'gpu',
                kind: 'number',
                parse: (t) => int(t, 0, 9999),
            },
            {
                path: ['threads'],
                label: 'Threads',
                descriptions: { zh: '线程数' },
                hint: '主要计算线程数',
                group: 'gpu',
                kind: 'number',
                parse: (t) => int(t, 1, 512),
            },
            {
                path: ['threadsBatch'],
                label: 'Batch threads',
                descriptions: { zh: '批处理线程数' },
                hint: '-1 = 跟随线程数',
                group: 'gpu',
                kind: 'number',
                parse: (t) => int(t, -1, 512),
            },
            {
                path: ['batchSize'],
                label: 'Batch size',
                descriptions: { zh: '批大小' },
                group: 'gpu',
                kind: 'number',
                parse: (t) => int(t, 1, 65536),
            },
            {
                path: ['flashAttn'],
                label: 'Flash attention',
                descriptions: { zh: 'Flash Attention' },
                hint: 'auto = 按 GPU 能力决定',
                group: 'gpu',
                kind: 'select',
                options: [
                    { value: 'auto', label: 'auto' },
                    { value: 'on', label: 'on' },
                    { value: 'off', label: 'off' },
                ],
            },
            {
                path: ['cacheTypeK'],
                label: 'K cache type',
                descriptions: { zh: 'K 缓存量化' },
                group: 'gpu',
                kind: 'select',
                options: CACHE_OPTIONS,
            },
            {
                path: ['cacheTypeV'],
                label: 'V cache type',
                descriptions: { zh: 'V 缓存量化' },
                group: 'gpu',
                kind: 'select',
                options: CACHE_OPTIONS,
            },
            /* ---- 采样 ---- */
            {
                path: ['temperature'],
                label: 'Temperature',
                descriptions: { zh: '温度' },
                hint: '每次请求生效，改完无需重启',
                group: 'sampling',
                kind: 'number',
                parse: (t) => frac(t, 0, 2),
            },
            {
                path: ['topP'],
                label: 'Top P',
                descriptions: { zh: 'Top P' },
                group: 'sampling',
                kind: 'number',
                parse: (t) => frac(t, 0, 1),
            },
            {
                path: ['topK'],
                label: 'Top K',
                descriptions: { zh: 'Top K' },
                hint: '0 = 不限制',
                group: 'sampling',
                kind: 'number',
                parse: (t) => int(t, 0, 100000),
            },
            {
                path: ['minP'],
                label: 'Min P',
                descriptions: { zh: 'Min P' },
                group: 'sampling',
                kind: 'number',
                parse: (t) => frac(t, 0, 1),
            },
            {
                path: ['repeatPenalty'],
                label: 'Repeat penalty',
                descriptions: { zh: '重复惩罚' },
                group: 'sampling',
                kind: 'number',
                parse: (t) => frac(t, 0.5, 2),
            },
            {
                path: ['seed'],
                label: 'Seed',
                descriptions: { zh: '随机种子' },
                hint: '-1 = 每次随机',
                group: 'sampling',
                kind: 'number',
                parse: (t) => int(t, -1, Number.MAX_SAFE_INTEGER),
            },
            /* ---- 行为 ---- */
            {
                path: ['startTimeoutMs'],
                label: 'Start timeout (ms)',
                descriptions: { zh: '启动超时' },
                hint: '等待服务就绪的最长时间',
                group: 'behavior',
                kind: 'number',
                parse: (t) => int(t, 1000, 600_000),
            },
            {
                path: ['idleStopMs'],
                label: 'Idle stop (ms)',
                descriptions: { zh: '空闲停机' },
                hint: '0 = 不自动停止；改此项不需重启',
                group: 'behavior',
                kind: 'number',
                parse: (t) => int(t, 0, 3_600_000),
            },
        ],
    };
}
/* ---------------- 状态栏 ---------------- */
/** 状态栏上限 200 cells，中文按 2 cells 计，这里控制在 ~40 字符内。 */
function clip(text, max) {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
export function describeStatus(s, cfg) {
    if (s.phase === 'running') {
        const bits = ['运行中'];
        if (s.pid !== undefined)
            bits.push(`pid ${s.pid}`);
        if (s.modelId)
            bits.push(truncateModelName(s.modelId, 18));
        if (s.mode === 'router')
            bits.push('router');
        const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
        bits.push(`${host}:${cfg.port}`);
        return `llama ${bits.join(' · ')}`;
    }
    if (s.phase === 'starting')
        return 'llama 启动中…';
    if (s.phase === 'stopping')
        return 'llama 停止中…';
    if (s.phase === 'error')
        return `llama 错误：${clip(s.error ?? '未知', 40)}`;
    return 'llama 未启动（发消息时自动拉起）';
}
/* ---------------- 重启判定 ---------------- */
/**
 * 改了这些就必须重启 llama-server：它们只作为 CLI 启动参数存在，
 * 不在每请求的请求体里。
 *
 * 刻意排除：
 *   temperature / disableThinking —— adapter 每请求写进 body，立即生效
 *   idleStopMs —— 只重置空闲计时器
 *   displayName / debug / autoStart / initialModel —— 不影响已运行进程
 */
const RESTART_KEYS = [
    'executable',
    'modelsDir',
    'host',
    'port',
    'strategy',
    'ctxSize',
    'gpuLayers',
    'threads',
    'threadsBatch',
    'batchSize',
    'flashAttn',
    'cacheTypeK',
    'cacheTypeV',
    'topP',
    'topK',
    'minP',
    'repeatPenalty',
    'seed',
    'apiKey',
    'noUi',
    'startTimeoutMs',
];
export function needsRestart(a, b) {
    return RESTART_KEYS.some((k) => a[k] !== b[k]);
}
