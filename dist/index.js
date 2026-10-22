import { describe as describeDiag, dumpFiberChain, logDiag as diagLog, probeGet, probeSeams, read as probeRead, } from './diag.js';
import { LlamaLocalAdapter } from './adapter.js';
import { adopt, Config, DISCOVERY_TIMEOUT_MS, ENTRY_ID, PROVIDER_ID, SETTINGS_NS, STATUS_KEY, } from './config.js';
import { bestExecutable, bestModelsDir, discoverEnvironmentSafe } from './discover.js';
import { LlamaServerManager, localSubprocess } from './llama-server.js';
import { DSH_BACKEND_ID, formatRoute, RouteGate } from './route-gate.js';
import { ModelStore } from './model-store.js';
import { buildSettingsSection, describeStatus, needsRestart } from './ui.js';
/* ---------------- 导出面 ---------------- */
export const name = ENTRY_ID;
/*
 * 导出 Config 是 /settings 能不能编辑的关键，不是可选项。
 *
 * dsh-settings 的 describe() 对每个 entry 调 volatileForm(Config)：标了
 * volatile 才会投影出表单、才会产出 namespace。没有 namespace 时
 * SettingsForm.save() 直接 return false，设置面板全空白且只读。
 * 为什么 schemastery 必须走包内 vendor（而不是依赖）见 ./config.ts 顶部说明。
 */
export { Config };
/* 诊断日志路径见 ./diag.ts 的 diagLogPath()：默认 ~/.dsh-tui/local-llama-diag.log，
 * 可用 LOCAL_LLAMA_LOG 覆盖。 */
function safeJson(v) {
    try {
        return JSON.stringify(v)?.slice(0, 300) ?? 'undefined';
    }
    catch {
        return '<unserializable>';
    }
}
diagLog('module-load', `name=${name} apply=${typeof apply} default=<none by design> node=${process.version}`);
/**
 * 读一个 seam。cordis 的 ctx 是代理，访问不存在的属性可能抛异常而不是
 * 返回 undefined，所以每次读都包一层。
 */
function read(fn) {
    try {
        return fn();
    }
    catch {
        return undefined;
    }
}
/** 订阅一个 cordis 事件，宽松绕过 Events 联合类型的字面量约束。 */
function onEvent(ctx, topic, listener) {
    const on = read(() => ctx.on);
    if (!on)
        return undefined;
    try {
        const result = on.call(ctx, topic, listener);
        return typeof result === 'function' ? result : undefined;
    }
    catch {
        return undefined;
    }
}
/* ---------------- 入口 ---------------- */
export function apply(ctx, entry) {
    /** 逆序执行的清理列表：先 push 的最后执行。 */
    const teardown = [];
    /* ---- 0. 软探测所有 seam ---- */
    diagLog('apply-start', `ctx.keys=${JSON.stringify(Object.keys(ctx))}`);
    probeSeams(ctx, ['settings', 'llm', 'subprocess', 'tuiStatus', 'tuiShortcuts', 'tuiSettingsSections', 'logger', 'effect', 'get', 'inject'], diagLog);
    probeGet(ctx, ['llm', 'settings', 'subprocess', 'tuiStatus', 'tuiShortcuts', 'tuiSettingsSections', 'credentials', 'fs', 'attachments'], diagLog);
    dumpFiberChain(ctx, diagLog);
    let settings = probeRead('settings', () => ctx.settings);
    const llm = probeRead('llm', () => ctx.llm);
    const subprocess = probeRead('subprocess', () => ctx.subprocess);
    const hostStatus = probeRead('tuiStatus', () => ctx.tuiStatus);
    const hostShortcuts = probeRead('tuiShortcuts', () => ctx.tuiShortcuts);
    const hostSections = probeRead('tuiSettingsSections', () => ctx.tuiSettingsSections);
    const logger = probeRead('logger', () => ctx.logger);
    const warn = (message, detail) => {
        diagLog('warn', `${message}${detail !== undefined ? ` | ${safeJson(detail)}` : ''}`);
        try {
            logger?.warn(`[local-llama] ${message}`);
        }
        catch {
            try {
                console.warn(`[local-llama] ${message}`, detail);
            }
            catch {
                /* 无输出通道 */
            }
        }
    };
    diagLog('seams-ready', `settings=${!!settings} llm=${!!llm} subprocess=${!!subprocess} status=${!!hostStatus} shortcuts=${!!hostShortcuts} sections=${!!hostSections}`);
    /**
     * 作用域注入：服务就绪时回调，未就绪则挂起等待（fiber 保持 PENDING，
     * 不会让插件整体激活失败）。
     *
     * 关键约束：**一次只注入一个服务名**。ctx.inject 是 all-or-nothing ——
     * 同一个数组里混进一个永不存在的依赖，会把同批其他依赖一起卡死。
     * 所以 settings / tuiSettingsSections / llm 必须三次独立调用。
     *
     * 另：回调里能安全调 requirePluginCaller 类的宿主 API。宿主只查
     * fiber.state ∈ {LOADING, ACTIVE} + activationStorage token，
     * inject 回调正好在这两者里面（plugin.js:1788 自己就这么用）。
     */
    const injectFn = ctx.inject;
    function awaitService(serviceName, cb) {
        if (typeof injectFn !== 'function') {
            diagLog('inject-unavailable', `${serviceName}: ctx.inject=${typeof injectFn}`);
            return;
        }
        try {
            const child = injectFn.call(ctx, [serviceName], (c) => {
                const value = c[serviceName];
                diagLog('inject-fired', `${serviceName}: value=${value === undefined ? 'undefined' : typeof value}`);
                try {
                    cb(c);
                }
                catch (err) {
                    diagLog('inject-cb-THREW', `${serviceName}: ${describeDiag(err)}`);
                    warn(`注入回调失败：${serviceName}`);
                }
            });
            diagLog('inject-returned', `${serviceName} -> ${typeof child}`);
        }
        catch (err) {
            diagLog('inject-THREW', `${serviceName}: ${describeDiag(err)}`);
        }
    }
    /* ---- 1. 配置三层：schema 默认 → entry config → settings 文档 ---- */
    const entryConfig = adopt(entry);
    // 观测：区分「schema 校验失败」和「volatile handle 没解开」。
    // 没解开时 JSON.stringify(entry.port) 是 {} 而不是 8642。
    diagLog('entry-config', `port=${entryConfig.port} ctxSize=${entryConfig.ctxSize} exe=${entryConfig.executable} displayName=${entryConfig.displayName}`);
    diagLog('entry-raw-shape', safeJson({ port: entry.port, displayType: typeof entry.displayName, disp: entry.displayName }));
    const cfg = { current: entryConfig, prev: entryConfig };
    /** 用 settings 文档覆盖 entry config。返回是否读到本插件的命名空间。 */
    const applySettingsDoc = () => {
        const service = settings;
        if (!service)
            return false;
        const docs = read(() => service.describe({ redactSecrets: false }));
        if (!Array.isArray(docs))
            return false;
        const hit = docs.find((d) => typeof d === 'object' && d !== null && String(d.ns) === SETTINGS_NS);
        if (!hit)
            return false;
        cfg.prev = cfg.current;
        cfg.current = adopt(entry, hit.value);
        return true;
    };
    applySettingsDoc();
    /* ---- 2. 模型目录 + 进程管理器 ---- */
    const store = new ModelStore(cfg.current.modelsDir);
    /* 本 profile 没有 subprocess 服务，回退到本地 child_process 实现（见 llama-server.ts）。
       每次读都是同一个实例，避免每次 new 一个。 */
    let localSpawn;
    const spawnRuntime = subprocess ??
        (() => {
            if (!localSpawn) {
                localSpawn = localSubprocess();
                diagLog('subprocess-fallback', '宿主无 subprocess 服务，改用 node:child_process 回退实现');
            }
            return localSpawn;
        })();
    const manager = new LlamaServerManager({
        get subprocess() {
            return spawnRuntime;
        },
        logger,
    }, () => cfg.current, (id) => store.get(id), () => store.models());
    /* ---- 2b. 启动门禁 ----
       llama-server 只在「dsh 内核 + 选中的模型是本地 provider」同时成立时拉起；
       两个信号都成立时自动拉起，任一失效就停掉。谓词与 index 之外的读法
       （route-gate.ts 头部的注释）保持一处定义，避免两处漂移。 */
    const routeGate = new RouteGate({
        isWanted: (snap) => snap.backend === DSH_BACKEND_ID && snap.route?.provider === PROVIDER_ID,
    });
    diagLog('gate-init', `backend=${routeGate.get().backend} route=${formatRoute(routeGate.get().route)} wanted=${routeGate.isWanted()}`);
    /** 按门禁判定收敛到正确状态。正向上 ensure（缺模型名时回落 initialModel），负向上清孤儿。 */
    const reconcile = (reason) => {
        const snap = routeGate.get();
        const wanted = cfg.current.autoStart && routeGate.isWanted();
        diagLog('gate', `${reason}: backend=${snap.backend} route=${formatRoute(snap.route)} autoStart=${cfg.current.autoStart} wanted=${wanted}`);
        if (wanted) {
            void manager
                .ensure(snap.route?.model || cfg.current.initialModel || undefined)
                .catch((err) => warn(`自动启动失败：${describeError(err)}`));
            return;
        }
        // 负向：先停掉自己拉起的进程，再清上次会话残留的孤儿（只按 pid 记录杀，
        // 端口被无关进程占了不碰）。
        void manager
            .stop()
            .catch(() => undefined)
            .then(() => manager.reapStale())
            .catch(() => undefined);
    };
    const offRouteGate = routeGate.watch(() => {
        reconcile('route-changed');
        publishStatus();
    });
    teardown.push(() => offRouteGate());
    /** 第一个入列 → 逆序时最后执行：先撤掉所有订阅，再停服务。 */
    teardown.push(() => {
        void manager
            .gracefulStop()
            .catch(() => undefined)
            .finally(() => manager.dispose());
    });
    /* ---- 3. 状态栏 ---- */
    let statusDispose;
    const publishStatus = () => {
        if (!hostStatus)
            return;
        try {
            statusDispose = hostStatus.set(STATUS_KEY, describeStatus(manager.getStatus(), cfg.current), ctx);
        }
        catch {
            /* 状态栏拒收（超长/非法字符）不致命 */
        }
    };
    const offSubscribe = read(() => manager.subscribe(() => publishStatus()));
    if (offSubscribe)
        teardown.push(() => offSubscribe());
    publishStatus();
    teardown.push(() => {
        try {
            statusDispose?.();
        }
        catch {
            /* 忽略 */
        }
    });
    /* ---- 4. settings 文档变更 → 热生效或重启 ---- */
    const offSettings = onEvent(ctx, 'settings/document-updated', (ns) => {
        if (String(ns) !== SETTINGS_NS)
            return;
        const prev = cfg.current;
        applySettingsDoc();
        const next = cfg.current;
        if (next.modelsDir !== prev.modelsDir)
            store.reconfigure(next.modelsDir);
        if (needsRestart(prev, next)) {
            warn(`参数变更，重启 llama.cpp：${RESTART_WHAT(prev, next).join('、')}`);
            void manager
                .stop()
                .catch(() => undefined)
                .then(() => {
                // 改完参数立刻按门禁收敛，不用等下一个请求。
                reconcile('settings');
            })
                .catch((err) => warn(`重启失败：${describeError(err)}`));
        }
        else if (prev.autoStart !== next.autoStart || prev.initialModel !== next.initialModel) {
            // 门禁的输入变了：不改启动参数，但要重新判定该不该在跑。
            reconcile('settings');
            publishStatus();
        }
        else {
            publishStatus();
        }
    });
    if (offSettings)
        teardown.push(() => offSettings());
    /* ---- 5. 设置区字段树 ----
       register 必须在**活的激活上下文里**调（宿主 register() 走
       requirePluginCaller → assertLiveContext，fiber.state 必须是 LOADING/ACTIVE）。
       apply() 同步体本身满足这个条件；服务不在当前 fiber 上时，退到
       ctx.inject 的回调里注册 —— 那个回调同样在激活上下文里。
       注意：disposer 必须进 teardown，不要包进 teardown.push 的闭包里注册
       （那种写法让注册只发生在清理阶段，面板就永远不出现）。 */
    const registerSettingsSections = (runtime) => {
        try {
            const section = buildSettingsSection(SETTINGS_NS);
            const off = runtime.register(section);
            diagLog('sections-OK', `ns=${section.ns} title=${section.title} fields=${section.fields.length}`);
            if (off)
                teardown.push(() => off());
        }
        catch (err) {
            diagLog('sections-THREW', describeDiag(err));
            warn(`设置区注册失败：${describeError(err)}`);
        }
    };
    if (hostSections) {
        registerSettingsSections(hostSections);
    }
    else {
        awaitService('tuiSettingsSections', (c) => {
            const runtime = c.tuiSettingsSections;
            if (runtime)
                registerSettingsSections(runtime);
        });
    }
    /* ---- 5b. settings 服务：把持久化文档接回来 ----
       宿主 settings 服务不接受插件命名空间注册，namespace 来自插件自己的
       Config schema（describe() 里 volatileForm(schema) 投影）。这里只做
       读：服务就绪后立刻重放一次 applySettingsDoc()，并记下它提供的
       namespace 列表 —— 有没有我们自己的 ns 决定了面板是「可编辑」
       还是「unavailable 只读」。 */
    if (settings) {
        applySettingsDoc();
    }
    else {
        awaitService('settings', (c) => {
            const service = c.settings;
            if (!service)
                return;
            settings = service;
            const docs = read(() => service.describe({ redactSecrets: false }));
            const namespaces = Array.isArray(docs)
                ? docs.map((d) => String(d?.ns ?? '<none>')).join(',')
                : '<not-an-array>';
            diagLog('settings-ns', `${namespaces}`);
            diagLog('settings-own-ns', `has=${namespaces.split(',').includes(SETTINGS_NS)}`);
            if (applySettingsDoc()) {
                // namespace view 的 value 是 plainConfig 解过 volatile handle 的有效值；
                // 字段全空白说明投影没带上默认值，那样 TUI 里就是可读但不可信的。
                diagLog('settings-applied', safeJson({
                    ns: SETTINGS_NS,
                    port: cfg.current.port,
                    ctxSize: cfg.current.ctxSize,
                    gpuLayers: cfg.current.gpuLayers,
                    strategy: cfg.current.strategy,
                    disableThinking: cfg.current.disableThinking,
                    autoStart: cfg.current.autoStart,
                    modelsDir: cfg.current.modelsDir,
                }));
                publishStatus();
            }
        });
    }
    /* ---- 6. 快捷键：alt+l 切换服务 ---- */
    if (hostShortcuts) {
        try {
            const off = hostShortcuts.register('alt+l', {
                description: 'Toggle local llama.cpp server',
                handler: async () => {
                    const phase = manager.getStatus().phase;
                    if (phase === 'running' || phase === 'starting')
                        await manager.stop();
                    else
                        await manager.ensure(cfg.current.initialModel || undefined);
                    publishStatus();
                },
            }, ctx);
            if (off)
                teardown.push(() => off());
        }
        catch (err) {
            warn(`快捷键注册失败：${describeError(err)}`);
        }
    }
    /* ---- 7. LLM 适配层 ---- */
    const adapter = new LlamaLocalAdapter({
        cfg: () => cfg.current,
        status: () => manager.getStatus(),
        resolve: (id) => store.get(id),
        models: () => store.models(),
        ensure: (modelId) => manager.ensure(modelId),
    });
    const tryRegister = (runtime) => {
        try {
            const off = runtime.registerAdapter([PROVIDER_ID], adapter);
            diagLog('register-OK', `provider=${PROVIDER_ID} disposer=${typeof off}`);
            if (typeof off === 'function') {
                teardown.push(() => {
                    try {
                        off();
                    }
                    catch {
                        /* 忽略 */
                    }
                });
            }
            // 记录 registration 对象的形状（官方写法用 registration.replace()），
            // 以及它暴露了哪些方法，便于确认注册真的挂进了 runtime。
            diagLog('registration-shape', safeJson(Object.keys(off)));
        }
        catch (err) {
            diagLog('register-THREW', describeDiag(err));
            warn(`provider 注册失败（名字可能已被占用）：${describeError(err)}`);
        }
    };
    if (llm) {
        tryRegister(llm);
    }
    else {
        /* 服务不在当前 fiber 上。用 cordis 官方的 scoped inject（dsh-llm-deepseek
           内部即用 `ctx.inject([...], cb)`）：llm 就绪时才回调；服务不存在时
           fiber 保持 PENDING，不会让插件整体激活失败。 */
        diagLog('register-deferred', '当前 fiber 拿不到 llm，改用 ctx.inject 等待就绪');
        awaitService('llm', (c) => tryRegister(c.llm));
    }
    /* ---- 8. 扫描模型目录 + 自动发现 + autoStart ---- */
    teardown.push(() => store.dispose());
    void store
        .refresh()
        .catch((err) => {
        diagLog('store-refresh1-THREW', describeDiag(err));
    })
        .then(() => {
        diagLog('store-refresh1', `dir=${store.directory} models=${store.models().length}`);
        store.watch();
        return discoverEnvironmentSafe(DISCOVERY_TIMEOUT_MS);
    })
        .then((report) => {
        // 用户没填路径时才用发现结果；用户保存的值永远优先。
        const exe = bestExecutable(cfg.current.executable, report);
        const dir = bestModelsDir(cfg.current.modelsDir, report);
        diagLog('discover', `exe=${exe} dir=${dir}`);
        if (exe !== cfg.current.executable || dir !== cfg.current.modelsDir) {
            cfg.current = { ...cfg.current, executable: exe, modelsDir: dir };
        }
        if (dir && dir !== store.directory)
            store.reconfigure(dir);
        return store.refresh();
    })
        .then(() => {
        diagLog('store-refresh2', `dir=${store.directory} models=${store.models().map((m) => m.id).join(',') || '<none>'}`);
        publishStatus();
        reconcile('boot');
    })
        .catch((err) => warn(`环境准备失败：${describeError(err)}`));
    return () => {
        for (const fn of [...teardown].reverse()) {
            try {
                fn();
            }
            catch {
                /* 单个清理失败不阻塞后续 */
            }
        }
    };
}
/* ---------------- 小工具 ---------------- */
function describeError(err) {
    if (err instanceof Error)
        return err.message;
    try {
        return String(err);
    }
    catch {
        return '未知错误';
    }
}
/** 列出真正变化的重启字段，写进日志方便定位。 */
function RESTART_WHAT(a, b) {
    return Object.keys(b).filter((k) => a[k] !== b[k]);
}
