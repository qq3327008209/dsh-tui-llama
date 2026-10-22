/**
 * 诊断探针。
 *
 * 「/model 里没有本地模型」有两种原因：模块没被加载（apply() 从未执行），
 * 或加载了但注册被宿主拒收。两者在宿主里表现完全一样，只能靠写日志区分。
 *
 * 只用 node: 内置模块，因为产物不能带运行期外部依赖（见 ./shims.ts）。
 * 所有失败都静默，探针绝不影响主流程。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/**
 * 诊断日志位置。默认在用户 home 下，跨机器可用；
 * 环境变量 LOCAL_LLAMA_LOG 可覆盖（绝对或相对路径都接受）。
 */
export function diagLogPath() {
    return process.env.LOCAL_LLAMA_LOG ?? join(homedir(), '.dsh-tui', 'local-llama-diag.log');
}
/** 写一行诊断日志。探针绝不能影响主流程——任何失败都静默。 */
export function logDiag(kind, message) {
    try {
        const target = diagLogPath();
        mkdirSync(dirname(target), { recursive: true });
        appendFileSync(target, `[${new Date().toISOString()}] [${process.pid}] ${kind}: ${message}\n`, 'utf8');
    }
    catch {
        /* 探针绝不能影响主流程 */
    }
}
/**
 * 读一个 seam 并记录结果。
 * 区分「服务不可得」（返回 undefined）和「访问抛异常」——两者压成同一个
 * undefined 就无从排查了。
 */
export function read(label, fn) {
    try {
        const value = fn();
        logDiag('seam', `${label} = ${value === undefined ? 'undefined' : typeof value}`);
        return value;
    }
    catch (err) {
        logDiag('seam-error', `${label} threw: ${describe(err)}`);
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
