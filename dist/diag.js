/**
 * 真机诊断探针。
 *
 * 为什么需要它：之前所有验证都跑在 test/smoke.mjs 的假 seam 上，从没拿到过
 * 一次真实 dsh 运行的观测。表现是「/model 里没有本地模型」，但到底是
 *   (a) 模块加载失败 → apply() 从未执行
 *   (b) apply() 执行了但 ctx.llm 不可得 → 主动跳过注册
 *   (c) 注册被宿主拒收（抛错）
 * 三种都长得一模一样，只能靠探针区分。
 *
 * 这个文件零外部依赖（只用 node:fs），因为产物不能有任何运行期外部包——
 * 见 ./shims.ts 顶部说明。
 */
import { appendFileSync } from 'node:fs';
const DEFAULT_LOG = 'C:/Users/John Smish/.dsh-tui/local-llama-diag.log';
function logLine(kind, message) {
    try {
        const target = process.env.LOCAL_LLAMA_LOG ?? DEFAULT_LOG;
        appendFileSync(target, `[${new Date().toISOString()}] [${process.pid}] ${kind}: ${message}\n`, 'utf8');
    }
    catch {
        /* 探针绝不能影响主流程 */
    }
}
/**
 * 把 seam 探测包装成带观测的版本。
 *
 * `read()` 原本吞掉异常只留 undefined，等于把「服务不可得」和「异常」
 * 压成同一种表现。这里把两种情况分别记下来。
 *
 * 另：如果 ctx 是可枚举对象，导出它的 key 列表——这是判断「宿主给这个
 * 插件作用域暴露了哪些服务」最直接的证据。
 */
export function read(label, fn) {
    try {
        const value = fn();
        logLine('seam', `${label} = ${value === undefined ? 'undefined' : typeof value}`);
        return value;
    }
    catch (err) {
        logLine('seam-error', `${label} threw: ${describe(err)}`);
        return undefined;
    }
}
export function dumpCtxKeys(ctx, log) {
    let info = `type=${typeof ctx} isNull=${ctx === null}`;
    try {
        if (ctx && typeof ctx === 'object') {
            const keys = Object.keys(ctx);
            info += ` enumerableKeys=${JSON.stringify(keys)}`;
            try {
                const proto = Object.getPrototypeOf(ctx);
                info += ` proto=${proto === null ? 'null' : proto?.constructor?.name ?? 'anon'}`;
            }
            catch {
                /* ignore */
            }
        }
    }
    catch {
        info += ' introspection-threw';
    }
    log('ctx-shape', info);
}
/** 对 ctx 做一次只读探测，逐个尝试访问 seam。用于区分「抛错」和「返回 undefined」。 */
export function probeSeams(ctx, names, log) {
    if (!ctx || typeof ctx !== 'object') {
        log('seam-probe', `ctx 不是对象（${typeof ctx}），跳过探测`);
        return;
    }
    for (const key of names) {
        let outcome;
        try {
            const v = ctx[key];
            outcome = v === undefined ? 'undefined' : typeof v;
        }
        catch (err) {
            outcome = `THREW: ${describe(err)}`;
        }
        log('seam-probe', `${key} -> ${outcome}`);
    }
}
/**
 * 沿 fiber 链向上枚举每层提供/声明了哪些服务。
 *
 * cordis 的 `ctx.get(prop)` 属性陷阱是**逐层向上走** ancestor fiber 的 store 找服务，
 * 找不到才抛 `cannot get property ... without inject`。所以「拿不到」要么是真没有，
 * 要么是被 isolate 切断了。这个函数把两层情况都暴露出来。
 */
export function dumpFiberChain(ctx, log) {
    let fiber = ctx?.fiber;
    let depth = 0;
    try {
        while (fiber && depth < 40) {
            const f = fiber;
            const names = f.store ? Object.getOwnPropertyNames(f.store) : [];
            const syms = f.store ? Object.getOwnPropertySymbols(f.store).map((s) => s.description ?? 'sym') : [];
            log('fiber', `d${depth} name=${String(f.name)} state=${String(f.state)} runtime=${!!f.runtime} ` +
                `inject=${JSON.stringify(Object.keys(f.inject ?? {}))} ` +
                `store=${JSON.stringify(names)} storeSyms=${JSON.stringify(syms)}`);
            fiber = f.parent?.fiber;
            depth++;
        }
    }
    catch (err) {
        log('fiber-error', describe(err));
    }
}
/**
 * 用**不会抛的** `ctx.get(name)` 逐个探测候选服务名。
 * cordis 里 `ctx.get()` 只读本 fiber 的 store，不向上走；属性访问才向上走。
 * 两者结果对比能区分「服务不存在」和「作用域隔离」。
 */
export function probeGet(ctx, names, log) {
    const get = ctx?.get;
    if (typeof get !== 'function') {
        log('get-probe', `ctx.get 不可用（${typeof get}）`);
        return;
    }
    for (const n of names) {
        let outcome;
        try {
            const v = get.call(ctx, n);
            outcome = v === undefined ? 'undefined' : typeof v;
        }
        catch (err) {
            outcome = `THREW: ${describe(err)}`;
        }
        log('get-probe', `${n} -> ${outcome}`);
    }
}
export function describe(err) {
    if (err instanceof Error) {
        const code = err.code;
        return `${err.name}: ${err.message}${code !== undefined ? ` (${String(code)})` : ''}`;
    }
    try {
        return String(err);
    }
    catch {
        return 'unknown';
    }
}
