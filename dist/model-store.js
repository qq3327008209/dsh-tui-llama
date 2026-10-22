/**
 * GGUF 模型目录扫描 + 监听。
 *
 * 模型 id 统一取「文件名去掉扩展名」（如 qwen3-5-4B-Q4_K_M），两个策略共用：
 *   - single：`-m <绝对路径>` 启动，llama.cpp 的请求体 model 字段不校验具体值
 *   - router：`--models-dir` + `POST /models/load {model: "<id>.gguf"}`
 *
 * 不做 mmproj 视觉投影配对。
 */
import { readdirSync, statSync, watch as fsWatch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { expandPath } from './config.js';
/** 轮询兜底间隔。fs.watch 在 Windows 上不覆盖目录内容变化，必须配。 */
const POLL_MS = 30_000;
export class ModelStore {
    dir;
    all = [];
    watchers = [];
    pollTimer;
    scanTimer;
    listeners = new Set();
    scanning = false;
    lastHash = '';
    disposed = false;
    constructor(dir) {
        this.dir = expandPath(dir);
    }
    get directory() {
        return this.dir;
    }
    models() {
        return [...this.all];
    }
    get(id) {
        return this.all.find((m) => m.id === id);
    }
    has(id) {
        return this.all.some((m) => m.id === id);
    }
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    /** 全量扫描。幂等，可并发调用（内部去重）。 */
    async refresh() {
        if (this.scanning)
            return this.all;
        this.scanning = true;
        try {
            const next = await scanGguf(this.dir);
            const hash = next.map((m) => `${m.id}:${m.size}`).join('|');
            if (hash !== this.lastHash) {
                this.lastHash = hash;
                this.all = next;
                this.emit();
            }
            return this.all;
        }
        finally {
            this.scanning = false;
        }
    }
    /** 防抖扫描：目录里批量写文件时不重复扫。 */
    refreshSoon(delayMs = 500) {
        if (this.disposed)
            return;
        if (this.scanTimer)
            clearTimeout(this.scanTimer);
        this.scanTimer = setTimeout(() => {
            void this.refresh().catch(() => undefined);
        }, delayMs);
        this.scanTimer.unref?.();
    }
    /** 建立 fs.watch + 轮询兜底。目录可能尚不存在，失败时静默。 */
    watch() {
        this.disposeWatchers();
        try {
            const w = fsWatch(this.dir, { persistent: false }, () => this.refreshSoon(500));
            w.on('error', () => undefined);
            this.watchers.push(w);
        }
        catch {
            /* 目录不存在时不建 watch，靠轮询 */
        }
        this.pollTimer = setInterval(() => {
            void this.refresh().catch(() => undefined);
        }, POLL_MS);
        this.pollTimer.unref?.();
    }
    /** 换目录并重新建立监听。 */
    reconfigure(dir) {
        this.dir = expandPath(dir);
        this.disposeWatchers();
        this.all = [];
        this.lastHash = '';
        this.watch();
        void this.refresh().catch(() => undefined);
    }
    disposeWatchers() {
        for (const w of this.watchers) {
            try {
                w.close();
            }
            catch { /* 忽略 */ }
        }
        this.watchers = [];
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
            this.scanTimer = undefined;
        }
    }
    dispose() {
        this.disposed = true;
        this.disposeWatchers();
        this.listeners.clear();
        this.all = [];
    }
    emit() {
        for (const fn of [...this.listeners]) {
            try {
                fn();
            }
            catch { /* 单个监听器异常不扩散 */ }
        }
    }
}
async function scanGguf(dir) {
    let entries;
    try {
        entries = readdirSync(dir, 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        if (!entry.toLowerCase().endsWith('.gguf'))
            continue;
        const file = join(dir, entry);
        try {
            const size = statSync(file).size;
            const id = basename(entry, '.gguf');
            out.push({ id, name: id, file, size });
        }
        catch {
            /* 读不到的单个文件跳过 */
        }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}
/** 人类可读的模型大小。 */
export function prettyBytes(n) {
    if (n < 1024 * 1024)
        return `${Math.round(n / 1024)} KB`;
    if (n < 1024 ** 3)
        return `${(n / 1024 ** 2).toFixed(0)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
/** 目录的上级路径，供「返回上层」类 UI 用。 */
export function parentOf(dir) {
    return dirname(dir);
}
