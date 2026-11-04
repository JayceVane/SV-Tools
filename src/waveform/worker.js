'use strict';
// 波形 worker：数据面全部由 Rust（wellen）承担，本文件只保留
// ① 工作区 RTL 方向匹配（roles，纯源码解析、不碰波形）② packed 总线恢复 ③ 消息协议适配。
//
// 历史：VCD 解析与事件存储原先由本文件内的 VcdStore 完成（纯 JS，541 行）。
// 下沉 Rust 后，解析器/存储/查询都由原生模块提供；worker 仍然是线程边界，
// 保证 200 MiB 级解析不阻塞扩展宿主。
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { readSignalRoles } = require('./source-roles');
const { restorePackedBuses } = require('./packed-buses');

let backend = null;      // Rust 侧会话（每个 worker 一个文件）
/** 当前会话的 Rust 句柄；查询用它复用同一次解析，不再重开文件。 */
const handleOf = () => backend?.handle ?? null;
let variables = null;    // 拆分后的逐位变量表（含 packedSource，取值要用）
let displayVariables = null;
/** 稳定变量索引：拆分表 ∪ 合成表。合成会把成员移出 displayVariables，取值仍需反查成员。 */
let indexedVariables = null;
let loading = false;
/** 合成总线表：compose id → 成员 id 列表（LSB→MSB）。逐位 dump 还原总线时由 packed-buses 建立。 */
const composites = new Map();
const options = workerData || {};
const maxFileBytes = options.maxFileBytes || 2 * 1024 * 1024 * 1024;

/**
 * 把逐位声明合成的总线登记进 `composites`，返回稳定的合成 id。
 *
 * wellen 会主动把「同名 + 相邻位号」的逐位声明合并成单个向量（为兼容 ModelSim/Questa），
 * 但本项目的 `restorePackedBuses` 依据 RTL 范围重新排序、并保留 bit mem 与不同作用域别名，
 * 语义比 wellen 的合并更严格。因此仍需在 worker 层做一次合成，查询时按成员拼值。
 *
 * 合成 id 只用**成员集合**（排序后）构造，不含作用域：不同作用域里逐位声明同一 net
 * （VCD 里重复声明同一组符号，Questa 常见）必须得到同一个 id，
 * 否则 `top.data` 与 `top.dut.data` 会被当成两条独立总线（实测别名共享判定失效）。
 */
function composeId(_api, memberIds) {
    // 键只用成员集合（排序）保证跨作用域一致；成员本身仍按传入顺序（MSB→LSB）保存，
    // 拼接顺序不能依赖键的排序结果。
    const key = [...new Set(memberIds)].sort().join('+');
    composites.set(key, memberIds.slice());
    return key;
}

/** 取合成总线的值：按成员顺序（MSB→LSB 已由 packed-buses 排序保证）拼接。 */
async function compositeValue(api, filePath, key, time) {
    // 1) 逐位变量：直接用**自身完整 path**（如 `top.d[3]`）交给 Rust。
    // Rust 的 `values_at` 认 `packed_source`，会回到源向量取整串再按 position 切位；
    // 若在这里剥掉 `[n]` 传基名，Rust 会因多条同基名声明而报「匹配多个候选」（实测）。
    const packed = allVariables().find(variable => variable.id === key)?.packedSource;
    if (packed) {
        const variable = allVariables().find(item => item.id === key);
        const raw = JSON.parse(await api.waveValuesAsync(handleOf(), filePath, variable.path, String(time)));
        return raw.values[variable.path]?.bits ?? null;
    }
    // 2) packed-buses 合成的总线：拼接成员值。
    const members = composites.get(key);
    if (!members) return null;
    // 成员本身可能是「从合并向量拆出的单位变量」或普通信号，统一取值后拼接。
    // 必须 Promise.all：查询已改成异步（避免 terminate 撕裂 Rust 析构），
    // 而 Array#map 的回调不能直接 await。
    const parts = await Promise.all(members.map(async id => {
        const variable = allVariables().find(item => item.id === id);
        if (!variable) return 'x';
        if (variable.packedSource) {
            return (await compositeValue(api, filePath, id, time)) ?? 'x';
        }
        const raw = JSON.parse(await api.waveValuesAsync(handleOf(), filePath, variable.path, String(time)));
        const bits = raw.values[variable.path]?.bits ?? 'x';
        return String(bits).padStart(variable.width, /^[xz]/.test(String(bits)) ? String(bits)[0] : '0');
    }));
    return parts.join('');
}

/**
 * 合成总线的像素桶降采样。
 *
 * 与单信号的 `waveWindow` 语义一致（每桶首末事件 + 密集标记），但「事件」是
 * **任一成员变化后的拼接值**，需要先把成员事件按时刻归并成合成时间轴再切桶。
 */
async function compositeWindow(api, filePath, key, start, end, pixels) {
    const members = composites.get(key) ?? [];
    const changes = [];
    const dense = [];
    if (!members.length) return { id: key, changes, dense };
    const paths = members.map(id => allVariables().find(variable => variable.id === id)?.path).filter(Boolean);
    const widths = paths.map(item => allVariables().find(variable => variable.path === item)?.width ?? 1);
    // 逐成员取窗口内全部跳变，合并成合成时间轴。
    // 必须翻页取全（见 fetchAllChanges），并从 -1 起取以便拿到「≤ start」的起点值。
    const collected = paths.length ? await fetchAllChanges(api, filePath, paths, end) : [];
    const series = collected.map((events, index) => ({ index, events }));
    const merged = new Map();
    series.forEach((entry, index) => {
        for (const event of entry.events) {
            const at = Number(event.t);
            if (!merged.has(at)) merged.set(at, new Map());
            merged.get(at).set(index, event.bits);
        }
    });
    const times = [...merged.keys()].sort((a, b) => a - b);
    // 维护每个成员的当前值，逐时刻拼接。
    const current = paths.map(() => 'x');
    const snapshots = [];
    for (const time of times) {
        for (const [index, bits] of merged.get(time)) current[index] = bits;
        snapshots.push({ t: time, value: current.map((bits, index) => String(bits).padStart(widths[index], /^[xz]/.test(String(bits)) ? String(bits)[0] : '0')).join('') });
    }
    // 起点值：≤ start 的最后一个快照。
    const firstInside = snapshots.findIndex(snapshot => snapshot.t > start);
    const basis = firstInside === -1 ? snapshots.length : firstInside;
    if (basis > 0) changes.push(snapshots[basis - 1]);
    if (end === start || pixels < 1) return { id: key, changes, dense };
    let left = basis;
    const span = end - start;
    for (let bucket = 0; bucket < pixels; bucket++) {
        const boundary = bucket === pixels - 1 ? end : start + (span * (bucket + 1)) / pixels;
        let right = left;
        while (right < snapshots.length && snapshots[right].t <= boundary) right++;
        const count = right - left;
        if (count > 0) {
            changes.push(snapshots[left]);
            if (count > 1) {
                changes.push(snapshots[right - 1]);
                if (count > 2) dense.push({ start: snapshots[left].t, end: snapshots[right - 1].t, count });
            }
        }
        left = right;
    }
    return { id: key, changes, dense };
}

/**
 * 合成总线的边沿查询。
 *
 * 合成值来自成员拼接，Rust 侧没有单条信号可查，因此先铺出合成时间轴
 * （与 `compositeWindow` 同一套归并逻辑），再按方向找「与查询时刻取值不同」的最近事件。
 * 位段投影（bitOffset/bitWidth）在拼接值上做字符串切片，语义与 VcdStore.edge 一致。
 */
async function compositeEdge(api, filePath, params) {
    const { id, time, direction, bitOffset, bitWidth = 1, continuation } = params;
    const key = id;
    const members = composites.get(key) ?? [];
    if (!members.length) return { time: null, value: null };
    const paths = members.map(memberId => allVariables().find(variable => variable.id === memberId)?.path).filter(Boolean);
    const widths = paths.map(item => allVariables().find(variable => variable.path === item)?.width ?? 1);
    // 同 compositeWindow：翻页取全，避免被 Rust 绑定的 10000 上限静默截断。
    const collected = paths.length ? await fetchAllChanges(api, filePath, paths, Number.MAX_SAFE_INTEGER) : [];
    const series = collected.map((events, index) => ({ index, events }));
    const merged = new Map();
    series.forEach((entry, index) => {
        for (const event of entry.events) {
            const at = Number(event.t);
            if (!merged.has(at)) merged.set(at, new Map());
            merged.get(at).set(index, event.bits);
        }
    });
    const times = [...merged.keys()].sort((a, b) => a - b);
    const current = paths.map(() => 'x');
    const snapshots = [];
    for (const at of times) {
        for (const [index, bits] of merged.get(at)) current[index] = bits;
        snapshots.push({ t: at, value: current.map((bits, index) => String(bits).padStart(widths[index], /^[xz]/.test(String(bits)) ? String(bits)[0] : '0')).join('') });
    }
    const project = value => {
        if (bitOffset === undefined || bitOffset === null) return value;
        const end = value.length - bitOffset;
        const start = Math.max(0, end - bitWidth);
        return value.slice(start, Math.max(start, end)).padStart(bitWidth, /^[xz]/i.test(value) ? value[0] : '0');
    };
    // 查询时刻的当前值：≤ time 的最后一个快照。
    let basis = 0;
    for (let index = 0; index < snapshots.length; index++) if (snapshots[index].t <= time) basis = index;
    const initial = project(snapshots.length ? snapshots[basis].value : 'x');
    const next = direction === 'next' || direction === 'forward';
    const from = next ? basis + (Number.isInteger(continuation) ? continuation - basis : 1) : basis - 1;
    const step = next ? 1 : -1;
    for (let index = from; index >= 0 && index < snapshots.length; index += step) {
        const value = project(snapshots[index].value);
        if (value !== initial) return { time: snapshots[index].t, value };
    }
    return { time: null, value: null };
}

/** 当前可见变量表：优先用已按声明表拆分/按 RTL 合回的显示视图。 */
function allVariables() {
    return indexedVariables || displayVariables || variables || [];
}

/** 从 Rust 错误的 `[CODE] message` 前缀还原稳定判定码。 */
function codeOf(error) {
    // Rust 把稳定判定码写在 message 前缀 `[CODE]`，`error.code` 只是 napi 的通用状态
    // （InvalidArg/GenericFailure），不能直接当判定码用。因此优先解析前缀。
    const text = String(error && error.message ? error.message : error);
    const match = /^\[([A-Z_]+)\]\s*/.exec(text);
    if (match) return match[1];
    if (error && error.code && error.code !== 'GenericFailure') return error.code;
    return 'VCD_WORKER';
}


/**
 * 取若干信号在窗口内的**全部**跳变，按 `next` 游标自动翻页。
 *
 * 为什么不能一次给个大 limit：Rust 绑定把 limit 硬截到 10000（`bindings.rs`），
 * 传 1e6/1e7 看似够用，实际会被静默截断且不回传 truncated——合成总线成员的
 * 变化超一万条后，合并时间轴与 dense 计数就全错了。这里显式翻页到 `next === null`。
 *
 * `from = -1` 表示取全历史：调用方需要「≤ 窗口起点」的最后一个事件来确定起点值，
 * 若从 `start - 1` 开始取，长期稳定的成员会取不到起点而退化成 `'x'`，
 * 合成总线在窗口起点出现伪 X。
 */
async function fetchAllChanges(api, filePath, paths, to) {
    const collected = paths.map(() => []);
    let from = -1;
    for (;;) {
        const raw = JSON.parse(await api.waveChangesAsync(handleOf(), filePath, paths.join(','), from, to, 10000));
        raw.series.forEach((entry, index) => collected[index].push(...entry.events));
        // 所有成员都没有下一页时结束；否则用最小的非空 next 继续。
        const nexts = raw.series.map(entry => entry.next).filter(value => value !== null && value !== undefined);
        if (!nexts.length) break;
        // Rust 的 `next` 是内部左开游标（最后一条已返回事件的时刻），可直接复用。
        from = Math.min(...nexts.map(Number));
    }
    return collected;
}

/** 惰性加载原生模块：缺失时给出与插件其它位置一致的诊断文案。 */
function nativeApi() {
    const { createNativeLoader } = require('../native-loader');
    return createNativeLoader().load();
}

/** 让 roles 之后的总线恢复仍能拿到 id：Rust 的 id 是 VarRef 序号，与 JS 侧变量表一致写入。 */
function withRustIds(vars, meta) {
    const byPath = new Map(meta.vars.map(variable => [variable.path, variable]));
    return vars.map(variable => {
        const match = byPath.get(variable.path);
        return match ? { ...variable, id: match.id } : variable;
    });
}

async function open(filePath, sourceContext) {
    if (loading || backend) throw Object.assign(new Error('VCD worker 已在使用'), { code: 'VCD_BUSY' });
    loading = true;
    try {
        const startedAt = Date.now();
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) throw new Error('VCD 路径不是普通文件');
        if (stat.size > maxFileBytes) {
            throw Object.assign(
                new Error('VCD 文件超过 ' + Math.round(maxFileBytes / 1048576) + ' MiB 上限'),
                { code: 'VCD_RESOURCE_LIMIT' }
            );
        }
        const api = nativeApi();
        // 进度只有「阶段」粒度：Rust 侧 `waveOpen` 是一次同步解析，wellen 的
        // 字节级 ProgressCount 只在 viewers 两段式接口上暴露，而那条路径拿不到
        // 可查询的句柄（`simple::Waveform::new` 私有）。写死一个假的 bytesRead
        // 会让进度条匀速爬行到 100%，比没有进度更误导，所以这里只报阶段。
        // 好处是解析实测比原 JS 流式实现快 16–26 倍，loading 阶段通常一瞬间就过。
        const progress = phase => parentPort.postMessage({
            type: 'progress',
            progress: {
                phase,
                bytesRead: phase === 'loading' ? 0 : stat.size,
                fileBytes: stat.size,
                eventCount: backend?.meta?.eventCount || 0,
            },
        });
        progress('loading');
        // Rust 侧一次解析即建立索引；VCD 冷解析实测比原 JS 缓存命中还快，无需落盘缓存。
        //
        // 必须用异步入口：`waveOpen` 是同步 napi 调用，解析期间占满 worker 线程，
        // 此时 worker.terminate()（取消加载）会拆掉 isolate，Rust 析构在已销毁的
        // 上下文里执行，实测稳定段错误。`*Async` 把解析放到 libuv 线程池，
        // 取消时只是丢弃结果。
        //
        // 用 `waveSessionOpenAsync` 拿句柄：后续所有查询都带着 handle 复用这一次解析。
        // 原先每个查询都 `WaveSession::open`，实测 7.1 MiB 文件单次就要 78.8 ms
        // （window/values/edge 各自重解析一遍），句柄化后降到毫秒级。
        const opened = JSON.parse(await api.waveSessionOpenAsync(filePath));
        backend = { api, filePath, handle: opened.handle, meta: opened.meta };
        const meta = opened.meta;
        // 存储预算沿用 JS 版口径（每事件约 12 B）与旧 `VcdStore` 的默认值 512 MiB。
        // Rust 的事件数据由 wellen 管理，但配置了很小 maxStoreBytes 的调用方
        // 仍应得到同样的 VCD_RESOURCE_LIMIT 拒绝。
        //
        // 不能把默认值调小：host 从不传这个选项，判定式是 eventCount*12 > budget，
        // 32 MiB 只够约 279 万次变化——而 CLI 文档宣称支持的 500 MiB 语料有 1463 万事件
        // （约 175 MB），会被直接拒绝，与本轮性能论证的核心工作负载冲突。
        const maxStoreBytes = options.maxStoreBytes || 512 * 1024 * 1024;
        if (meta.eventCount * 12 > maxStoreBytes) {
            throw Object.assign(
                new Error('VCD 事件存储超过 ' + Math.round(maxStoreBytes / 1048576) + ' MiB 预算'),
                { code: 'VCD_RESOURCE_LIMIT' }
            );
        }
        const after = await fs.promises.stat(filePath);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
            throw new Error('VCD读取期间文件已变化，请在仿真结束后重新打开');
        }
        // Rust 变量表补齐 JS 侧渲染需要的字段：changeCount 与 parser 兼容的 headers/scopes。
        // wellen 会把逐位声明合并成向量；用原始声明表拆回逐位变量，
        // 让 restorePackedBuses 能按 RTL 范围重排位序、区分数组元素。
        // Rust 已在 describe 里按 msb/lsb 精确展开逐位 dump；wellen 的合并是声明顺序
        // 贪心、位集合不完整，不能直接当位来源。
        variables = meta.vars.map(variable => ({ ...variable, changeCount: variable.changeCount || 0 }));
        progress('ready');
        let roles = {};
        if (sourceContext) {
            progress('source-roles');
            try { roles = await readSignalRoles(variables, sourceContext); }
            catch (error) { roles.sourceRoleNote = '方向匹配不可用：' + error.message; }
        }
        const annotated = withRustIds(roles.vars || variables, meta);
        const vars = restorePackedBuses(annotated, { compose: ids => composeId(api, ids) });
        displayVariables = vars;
        indexedVariables = [...annotated, ...vars];
        return {
            file: meta.file,
            format: meta.format,
            timescale: meta.timescale,
            endTime: Number(meta.endTime),
            eventCount: meta.eventCount,
            fileBytes: meta.fileBytes,
            vars,
            headers: meta.headers || [],
            // 作用域表必须来自 Rust 的扁平结构（含 type/name/path/parentId）：
            // 前端 buildSignalTree 与 signal-mapping 都按 parentId 校验层级完整性，
            // 只给路径字符串会让两者都判定为「缺少可验证的层级分段」。
            scopes: meta.scopes || [],
            sourceRoleNote: roles.sourceRoleNote,
            sourceRoleRetry: sourceContext?.invalidated === true,
            fileIdentity: { size: stat.size, mtimeMs: stat.mtimeMs },
            parseMs: Date.now() - startedAt,
        };
    } finally {
        loading = false;
    }
}

/** 调用 Rust 查询并把结果整形成 worker 协议要求的形状。 */
async function query(method, params) {
    const { api, filePath, meta } = backend;
    const idOf = name => {
        const variable = allVariables().find(item => item.path === name);
        if (!variable) throw Object.assign(new Error('信号不存在：' + name), { code: 'SIGNAL_NOT_FOUND' });
        return variable.id;
    };
    switch (method) {
        case 'window': {
            // 合成总线（逐位 dump 还原）不走 Rust 的像素桶：成员是独立信号，
            // 桶切分必须按「任一成员变化」重新计算，交给下面单独的合成路径。
            const compositesRequested = params.ids.filter(id => composites.has(id));
            const plainIds = params.ids.filter(id => !composites.has(id));
            const raw = plainIds.length
                ? JSON.parse(await api.waveWindowAsync(handleOf(), filePath, plainIds, params.start, params.end, params.pixels))
                : { series: [] };
            const byId = new Map(raw.series.map(series => [series.id, {
                id: series.id,
                changes: series.changes.map(change => ({ t: Number(change.t), value: change.bits })),
                dense: series.dense.map(bucket => ({ start: Number(bucket.start), end: Number(bucket.end), count: bucket.count }))
            }]));
            // 合成总线：先取所有成员在每个桶边界的值，再按桶生成首末事件。
            for (const id of compositesRequested) {
                byId.set(id, await compositeWindow(api, filePath, id, params.start, params.end, params.pixels));
            }
            return { series: params.ids.map(id => byId.get(id)).filter(Boolean) };
        }
        case 'values': {
            const at = String(params.time);
            const values = Object.create(null);
            const isComputed = id => composites.has(id) || !!allVariables().find(variable => variable.id === id)?.packedSource;
            const plainIds = params.ids.filter(id => !isComputed(id));
                    const paths = plainIds.map(id => allVariables().find(variable => variable.id === id)?.path).filter(Boolean);
            const raw = paths.length ? JSON.parse(await api.waveValuesAsync(handleOf(), filePath, paths.join(','), at)) : { values: {} };
            for (const id of params.ids) {
                if (isComputed(id)) { values[id] = await compositeValue(api, filePath, id, params.time); continue; }
                const variable = allVariables().find(item => item.id === id);
                values[id] = variable ? (raw.values[variable.path]?.bits ?? null) : null;
            }
            return { values };
        }
        case 'edge': {
            // 合成总线（逐位 dump 还原）在 Rust 表里没有对应信号，必须由成员拼出时间轴。
            if (composites.has(params.id)) {
                return await compositeEdge(api, filePath, params);
            }
            // 逐位变量：直接对它自己的完整 path 做边沿查询（Rust 会按 packed_source 切位）。
            const variable = allVariables().find(item => item.id === params.id);
            const target = variable?.path ?? params.id;
            const raw = JSON.parse(await api.waveEdgeAsync(
                handleOf(), filePath, target, params.time, params.direction,
                params.bitOffset ?? null, params.bitWidth ?? null, params.continuation ?? null
            ));
            return { time: raw.time === undefined ? null : Number(raw.time), value: raw.value ?? null, ...(raw.continuation === undefined ? {} : { continuation: raw.continuation }) };
        }
        case 'changes': {
            // 逐个换算路径，未知 id 显式报错：静默 filter 会让 series 与 ids 下标错位，
            // 调用方拿到的 id 就会张冠李戴（比缺行更难排查）。
            const paths = params.ids.map(id => {
                const variable = allVariables().find(item => item.id === id);
                if (!variable) throw Object.assign(new Error('信号不存在：' + id), { code: 'SIGNAL_NOT_FOUND' });
                return variable.path;
            });
            const raw = JSON.parse(await api.waveChangesAsync(handleOf(), filePath, paths.join(','), params.from ?? null, params.to, params.limit ?? 200));
            return {
                series: raw.series.map((series, index) => ({
                    id: params.ids[index],
                    total: series.total,
                    next: series.next === null ? null : Number(series.next),
                    events: series.events.map(event => ({ t: Number(event.t), value: event.bits }))
                }))
            };
        }
        case 'sample': {
            // Rust 的 `wave_sample` 按**名称**解析时钟（与 CLI 同一规则）：必须给完整路径，
            // 给 id 会直接 SIGNAL_NOT_FOUND。面板侧传的是 id，这里换算回路径再交出去。
            const clockName = params.clockPath
                ?? allVariables().find(variable => variable.id === params.clock || variable.path === params.clock)?.path;
            if (!clockName) throw Object.assign(new Error('信号不存在：' + params.clock), { code: 'SIGNAL_NOT_FOUND' });
            const paths = params.ids.map(id => allVariables().find(variable => variable.id === id)?.path).filter(Boolean);
            const raw = JSON.parse(await api.waveSampleAsync(
                handleOf(), filePath, clockName, params.edge ?? 'rise', paths.join(','),
                params.from ?? null, params.to, params.limit ?? 256, params.where ?? null
            ));
            return {
                total: raw.scannedEdges,
                matched: raw.matched,
                next: raw.next === null ? null : Number(raw.next),
                samples: raw.samples.map(sample => ({
                    t: Number(sample.t),
                    values: Object.fromEntries(params.ids.map(id => {
                        const variable = allVariables().find(item => item.id === id);
                        return [id, variable ? (sample.values[variable.path]?.bits ?? null) : null];
                    }))
                }))
            };
        }
        default:
            throw new Error('未知 VCD 请求：' + method);
    }
}

// 优雅关闭握手：session.dispose() 先发这条消息，等 worker 自己退出。
//
// 不能直接 `worker.terminate()`：异步 napi 任务的 compute 跑在 libuv 线程池里，
// 若此刻拆掉 isolate，Rust 侧收尾会踩到已销毁的 V8 上下文——实测概率性段错误
// （exit 139 / 0xC0000005）。
//
// 也不能用 `process.exit(0)`：它是即时终止，不会等 libuv 线程池里的 Rust 任务
// 走完析构。CI（2 核、慢盘）上稳定复现，本机 6 并发却复现不出来——差异就在
// 「任务收尾在 exit 之后才完成」这个窗口。
//
// 正确做法是**关掉消息端口、让事件循环自然退出**：Node 只有在没有待处理句柄/
// 请求时才会退出，而 libuv 线程池里的在途任务本身就是一个待处理请求，因此
// 事件循环会一直转到最后一个 Rust 任务真正结束，isolate 才被销毁。
let pendingRequests = 0;
let closeRequested = false;
const exitIfIdle = () => {
    if (!closeRequested || pendingRequests !== 0) return;
    // 回执让宿主确认握手完成（它随后 await worker 的 exit）。
    try { parentPort.postMessage({ type: 'closed' }); }
    catch { /* 端口已关，说明已经退到尾声 */ }
    // 不再 process.exit：断开端口后事件循环会等所有在途 libuv 任务结束再自然退出。
    try { parentPort.close(); } catch { /* 已关闭 */ }
};

parentPort.on('message', async message => {
    const { requestId, method, params } = message;
    if (method === 'close') {
        closeRequested = true;
        // 释放 Rust 句柄：worker 退不退出都不该让会话继续占着解析结果。
        if (backend?.handle != null) {
            try { backend.api.waveSessionClose(backend.handle); } catch { /* 已释放或模块已卸载 */ }
            backend.handle = null;
        }
        // 让已排队的 microtask/macrotask 先跑完，再把退出判断交给 exitIfIdle。
        setImmediate(exitIfIdle);
        return;
    }
    pendingRequests++;
    try {
        let result;
        if (method === 'open') result = await open(params.filePath, params.sourceContext);
        else if (method === 'roles') {
            if (!backend || loading) throw Object.assign(new Error('VCD 尚未完成加载'), { code: 'VCD_NOT_READY' });
            const roles = await readSignalRoles(variables, params);
            const byPath = new Map(roles.vars.map(signal => [signal.path, signal]));
            const annotated = displayVariables.map(signal => {
                const role = byPath.get(signal.bitPaths?.[0] || signal.path);
                return {
                    ...signal,
                    role: role?.role || 'unknown',
                    roleSource: role?.roleSource,
                    packedBit: signal.bitPaths ? undefined : role?.packedBit
                };
            });
            // 已确认的 dump 结构不随脏源码编辑而拆散；新恢复的 RTL 事实仍可归并其余逐位声明。
            const refreshed = restorePackedBuses(annotated, { compose: ids => composeId(backend.api, ids) });
            const changed = refreshed.length !== displayVariables.length
                || refreshed.some((signal, at) => signal.path !== displayVariables[at].path);
            displayVariables = refreshed;
            result = {
                roles: refreshed.map(signal => ({ path: signal.path, role: signal.role || 'unknown', roleSource: signal.roleSource })),
                ...(changed ? { vars: refreshed } : {}),
                sourceRoleNote: roles.sourceRoleNote,
                sourceRoleRetry: params?.invalidated === true
            };
        } else {
            if (!backend || loading) throw Object.assign(new Error('VCD 尚未完成加载'), { code: 'VCD_NOT_READY' });
            result = await query(method, params);
        }
        parentPort.postMessage({ requestId, result });
    } catch (error) {
        parentPort.postMessage({
            requestId,
            error: { message: error.message, code: codeOf(error), line: error.line, column: error.column }
        });
    } finally {
        pendingRequests--;
        exitIfIdle();
    }
});


