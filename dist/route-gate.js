/**
 * 启动门禁：llama-server 到底该不该在跑。
 *
 * 判定 = 当前 dsh-tui 跑的是 dsh 内核 且 /model 里选中的模型属于本地 provider。
 * 两个信号都由宿主写、插件只能读，且都是 ~/.dsh-tui/ 下的纯 JSON：
 *
 *   ~/.dsh-tui/kernel.json  {"backend":"dsh"|"claude"|"codex"|...}
 *   ~/.dsh-tui/model.json   {"provider":"llama-local","model":"qwen3-..."}
 *
 * 两个必须都查。model.json 只有 dsh 内核的 /model 切换会写（宿主里
 * writeModelPref 只出现在 dsh-adapter/channel/model-switch.js），claude / codex
 * 内核各自维护 backends/<id>/prefs.json，从不碰 model.json。所以切到 claude 后
 * model.json 仍留着上次 dsh 会话的 llama-local —— 只看 model.json 会把一个根本没
 * 在跑 dsh agent 的会话误判成「该拉起本地服务」。
 *
 * 只用 node:fs：插件产物不能带运行期外部依赖（见 ./shims.ts）。
 * watchFile 是 stat 轮询，Windows 上不需要 FSWatcher 的目录事件支持。
 */
import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logDiag } from './diag.js';
/** dsh-tui 的数据目录。`LOCAL_LLAMA_DATA_DIR` 只在测试里用来指到临时目录。 */
export function dataDir() {
    return process.env.LOCAL_LLAMA_DATA_DIR ?? join(homedir(), '.dsh-tui');
}
export function defaultPaths() {
    const dir = dataDir();
    return { kernel: join(dir, 'kernel.json'), route: join(dir, 'model.json') };
}
/** dsh-tui 的默认后端 id（kernelPrefs.js 的 DSH_BACKEND_ID）。 */
export const DSH_BACKEND_ID = 'dsh';
/** 后端 id 语法（与宿主 isBackendIdSyntax 的宽松版一致）。 */
const BACKEND_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
function parseBackend(value) {
    if (typeof value !== 'string')
        return undefined;
    const id = value.trim().toLowerCase();
    return BACKEND_RE.test(id) ? id : undefined;
}
/** 与宿主 modelPrefs.parseModelPref 同一套校验：两半都非空才算有效路由。 */
function parseRoute(parsed) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return undefined;
    const { provider, model } = parsed;
    if (typeof provider !== 'string' || provider === '')
        return undefined;
    if (typeof model !== 'string' || model === '')
        return undefined;
    return { provider, model };
}
/**
 * 后端 id 的解析顺序镜像宿主 kernelPrefs.resolveRememberedBackend：
 * 切换交接 env → DSH_TUI_BACKEND → kernel.json 记忆 → 'dsh'。
 *
 * 宿主的 profile Config 行排在这三者之前，但要解 YAML 才能读，插件不碰它 ——
 * profile 里若真钉了 `backend:`，看诊断日志的 `backend=` 值核对。
 */
export function readSnapshot(paths = defaultPaths()) {
    const handoff = parseBackend(process.env.DSH_TUI_BACKEND_HANDOFF);
    const env = parseBackend(process.env.DSH_TUI_BACKEND);
    const memory = parseBackend(readJson(paths.kernel)?.backend);
    return {
        backend: handoff ?? env ?? memory ?? DSH_BACKEND_ID,
        route: parseRoute(readJson(paths.route)),
    };
}
function same(a, b) {
    return (a.backend === b.backend &&
        (a.route?.provider ?? '') === (b.route?.provider ?? '') &&
        (a.route?.model ?? '') === (b.route?.model ?? ''));
}
export function formatRoute(route) {
    return route ? `${route.provider}/${route.model}` : '<none>';
}
/**
 * 观察 kernel.json / model.json，只在判定真的变化时回调。
 *
 * 停的方向做二次确认：宿主写 model.json 用的是 writeFileSync（非原子），
 * 轮询恰好落在半写入窗口里会把 JSON 读成解析失败，进而读成「没选模型」，
 * 直接停服务会白停一次再拉起来。读两次都负向才认。
 * 起的方向不确认 —— 读到空顶多是「不起」，不会误起。
 */
export class RouteGate {
    paths;
    pollMs;
    confirmMs;
    wanted;
    snapshot;
    timer;
    confirming = false;
    watching = false;
    constructor(options) {
        this.paths = options.paths ?? defaultPaths();
        this.pollMs = options.pollMs ?? 2000;
        this.confirmMs = options.confirmMs ?? 900;
        this.wanted = options.isWanted;
        this.snapshot = readSnapshot(this.paths);
    }
    /** 当前判定；返回副本，调用方改不动内部状态。 */
    get() {
        return this.snapshot.route ? { backend: this.snapshot.backend, route: { ...this.snapshot.route } } : { backend: this.snapshot.backend, route: undefined };
    }
    isWanted() {
        return this.wanted(this.snapshot);
    }
    /** 立刻重读一次盘，不等下一次轮询。 */
    refresh() {
        const next = readSnapshot(this.paths);
        if (!same(next, this.snapshot)) {
            this.confirming = false;
            this.snapshot = next;
        }
        return this.get();
    }
    watch(onChange) {
        if (this.watching)
            return () => undefined;
        this.watching = true;
        const tick = () => this.schedule(onChange);
        for (const file of [this.paths.kernel, this.paths.route]) {
            try {
                watchFile(file, { interval: this.pollMs }, tick);
            }
            catch (err) {
                logDiag('route-gate-watch-THREW', `${file}: ${String(err)}`);
            }
        }
        return () => this.dispose();
    }
    dispose() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        for (const file of [this.paths.kernel, this.paths.route]) {
            try {
                unwatchFile(file);
            }
            catch {
                /* 忽略 */
            }
        }
        this.watching = false;
        this.confirming = false;
    }
    schedule(onChange) {
        if (this.timer)
            return;
        // 两个文件各自 stat 到变化时会连发两次，先合并成一拍。
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.check(onChange);
        }, this.confirmMs);
    }
    check(onChange) {
        const next = readSnapshot(this.paths);
        if (same(next, this.snapshot))
            return;
        if (this.wanted(this.snapshot) && !this.wanted(next) && !this.confirming) {
            // 第一次读到负向：可能是半写入的 JSON。等一拍再读一次；
            // confirming 保持 true，下一轮 check 才落进真正的 emit。
            this.confirming = true;
            this.timer = setTimeout(() => {
                this.timer = undefined;
                this.check(onChange);
            }, this.confirmMs);
            return;
        }
        const prev = this.snapshot;
        this.confirming = false;
        this.snapshot = next;
        logDiag('route-gate', `backend ${prev.backend} -> ${next.backend}; route ${formatRoute(prev.route)} -> ${formatRoute(next.route)}; wanted=${this.wanted(next)}`);
        try {
            onChange(next, prev);
        }
        catch (err) {
            logDiag('route-gate-cb-THREW', String(err));
        }
    }
}
