'use strict';
/** M4 波形查询服务：VCD/FST 会话、信号/取值/跳变/沿/采样/差异查询。
 * 时间输出一律整数 tick 字符串（JSON 内不出现浮点时标），物理换算并列展示；原始位值与 X/Z 原样保留。 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { nativeApi, call } = require('../waveform/rust-backend');
const model = require('../waveform/model');
const rowLayout = require('../waveform/row-layout');
const { readSignalRoles } = require('../waveform/source-roles');
const { isExcludedSourcePath } = require('../workspace/source-policy');
const { createWaveImage } = require('../waveform/node-export');
const { createContainedDirectories, cleanupDirectories } = require('../design/scaffold-paths');
const { rasterizeSvg, DEFAULT_SCALE } = require('../graphics/rasterize');
const layoutState = require('../waveform/layout-state');
const { assertExportTarget } = require('../workspace/export-target');
const { readOptions, hash } = require('./context');
const { result, fail } = require('./protocol');

const MAX_VCD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SIGNALS_OUTPUT = 2000;
const MAX_RTL_FILES = 512;

const UNITS = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 };
/** @returns {number} 秒/tick；timescale 缺失或非法时为 0（此时不接受物理单位输入）。 */
function secondsPerTick(timescale) {
    const match = /^(\d+(?:\.\d+)?)\s*(s|ms|us|ns|ps|fs)$/i.exec(String(timescale || '').trim());
    if (!match) return 0;
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 ? value * UNITS[match[2].toLowerCase()] : 0;
}
function parseTick(trace, text, label) {
    const tick = model.parseTime(String(text), secondsPerTick(trace.meta.timescale));
    if (tick === null) fail('INVALID_ARGUMENT', label + ' 时间格式无效：' + text + '（裸整数 ticks，或带 s/ms/us/ns/ps/fs 单位；物理单位要求 VCD 声明 timescale）');
    return tick;
}
const tickString = tick => String(Math.round(tick));

/** 信号名 → 唯一 id：完整路径 > 唯一后缀/短名 > 唯一包含匹配；alias 共享同一 id 不算歧义，未命中与多 id 歧义都给出候选。 */
function resolveIds(vars, names) {
    const ids = [];
    for (const name of names) {
        const exact = vars.filter(variable => variable.path === name);
        const loose = vars.filter(variable => variable.path.endsWith('.' + name) || variable.name === name);
        // 唯一性按 id 判定：同一 net 的多个变量声明（alias）解析到同一 id。
        const uniqueIds = list => [...new Set(list.map(variable => variable.id))];
        let picked = uniqueIds(exact).length === 1 ? uniqueIds(exact) : uniqueIds(loose).length === 1 ? uniqueIds(loose) : [];
        if (!picked.length && !exact.length && !loose.length) picked = uniqueIds(vars.filter(variable => variable.path.toLowerCase().includes(name.toLowerCase())));
        if (picked.length !== 1) fail('SIGNAL_NOT_FOUND',
            picked.length > 1 ? '信号名匹配多个候选，请使用完整层级路径：' + name : '信号不存在：' + name,
            { name, candidates: [...new Set([...exact, ...loose])].slice(0, 20).map(variable => variable.path) });
        ids.push(picked[0]);
    }
    return [...new Set(ids)];
}
/** id → 展示名：用 vars 中第一个引用该 id 的路径，alias 不产生第二行输出。 */
function displayPaths(meta) {
    const names = new Map();
    for (const variable of meta.vars) if (!names.has(variable.id)) names.set(variable.id, variable);
    return names;
}
function requireSignals(trace, input) {
    const names = String(input.signals || '').split(',').map(name => name.trim()).filter(Boolean);
    if (!names.length) fail('INVALID_ARGUMENT', '需要 --signals <信号1,信号2...>');
    const ids = resolveIds(trace.meta.vars, names);
    if (!ids.length) fail('SIGNAL_NOT_FOUND', '未找到任何信号');
    return ids;
}

/** 单次操作持有独立句柄；成功、失败及并发调用均在自身 finally 中释放。 */
function ownedQuery(operation) {
    return async input => {
        const trace = await openTrace(input);
        try { return await operation(trace, input); }
        finally { trace.close(); }
    };
}

/** 打开 VCD：Rust 一次解析建立索引，不再落盘缓存。
 *
 * 历史：这里曾按「绝对路径哈希 + size/mtime」落 `index.bin` 快照，命中时零拷贝加载。
 * 实测 Rust（wellen）冷解析反而比 JS 快照命中更快（500 MiB：353 ms vs 5663 ms），
 * 缓存既占磁盘又让「文件改了但 mtime 没变」这类情况多一条出错路径，故整体删除。
 */
async function openTrace(input) {
    const { options } = await readOptions(input);
    if (!input.file) fail('FILE_REQUIRED', 'wave 命令需要 --file <vcd>');
    const file = path.resolve(options.workspace, input.file);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) fail('SOURCE_NOT_FOUND', 'VCD 文件不存在：' + input.file, { file });
    if (stat.size > MAX_VCD_BYTES) fail('SOURCE_LIMIT', 'VCD 文件超过 2048MiB 上限', { file, size: stat.size });
    const startedAt = Date.now();
    let meta, handle = null;
    try {
        const opened = call(() => nativeApi().waveSessionOpen(file));
        handle = opened.handle;
        meta = opened.meta;
    } catch (error) {
        // Rust 的错误码与 CLI 码同名，直接透传：`WAVE_FORMAT_UNSUPPORTED` 在
        // docs/CLI.md 里是独立条目（格式不支持），不能再折叠回 `VCD_PARSE`（语法损坏）——
        // 两者的处置不同（换格式 vs 重新仿真），折叠后调用方无法分派。
        fail(error.code || 'VCD_PARSE', error.message, { file });
    }
    const close = () => {
        if (handle === null) return;
        const owned = handle;
        handle = null;
        nativeApi().waveSessionClose(owned);
    };
    try {
        const after = await fs.stat(file);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
            fail('SOURCE_CHANGED', 'VCD 读取期间文件已变化，请在仿真结束后重试', { file });
        }
    } catch (error) {
        close();
        throw error;
    }
    // CLI 协定的 meta 形状：与旧 JS 版一致（endTime 仍是整数 tick）。
    const normalized = {
        ...meta,
        endTime: Number(meta.endTime),
        eventCount: Number(meta.eventCount),
        fileBytes: Number(meta.fileBytes),
        // source-roles 需要 vars；direction 标注在导出/查询输出里按需补。
        vars: meta.vars,
    };
    return {
        options, file, handle, close, sourceStat: stat, meta: normalized,
        stats: { cached: false, parseMs: Date.now() - startedAt, loadMs: Date.now() - startedAt,
            fileBytes: stat.size, eventCount: normalized.eventCount },
    };
}

// ---------------------------------------------------------------------------
// Rust 查询适配
//
// 三个查询方法（values/changes/sample）原来直接调 `VcdStore`，现在转发到 napi。
// 统一约定：
// - 输入是信号 **id**（`resolveIds` 的产物），这里翻译成 Rust 的 path；
// - 输出保持 CLI 协定（`bits` 字段 → 调用方的 `value`，时间是 Number）。
// ---------------------------------------------------------------------------

/** id → Rust 查询用的路径。逐位展开项的 path 已含 `[n]`，Rust 会按 packedSource 切位。 */
function pathOf(trace, id) {
    const variable = trace.meta.vars.find(item => item.id === id);
    if (!variable) fail('SIGNAL_NOT_FOUND', '信号不存在：' + id);
    return variable.path;
}

/** @returns {Record<string, string|null>} id → 原始位串。 */
function storeValues(trace, ids, time) {
    const paths = ids.map(id => pathOf(trace, id));
    const raw = call(() => nativeApi().waveValues(trace.handle, null, paths.join(','), String(time)));
    const byPath = new Map(Object.entries(raw.values || {}));
    const out = {};
    for (const id of ids) {
        const path = pathOf(trace, id);
        const entry = byPath.get(path);
        out[id] = entry ? entry.bits ?? null : null;
    }
    return out;
}

/** @returns {{series: Array<{id:string,total:number,next:number|null,events:Array<{t:number,value:string}>}>}} */
function storeChanges(trace, { ids, from, to, limit }) {
    const paths = ids.map(id => pathOf(trace, id));
    const raw = call(() => nativeApi().waveChanges(trace.handle, null, paths.join(','), from ?? null, to, limit));
    return {
        series: raw.series.map((series, index) => ({
            id: ids[index],
            total: series.total,
            next: series.next === null ? null : Number(series.next),
            events: series.events.map(event => ({ t: Number(event.t), value: event.bits })),
        })),
    };
}

/** CLI 侧 RTL 发现：只读路径集合，交给 source-roles 做有界解析；失败仅降级方向标注。 */
async function collectRtl(workspace) {
    const files = [];
    let truncated = false;
    const walk = async directoryPath => {
        if (files.length >= MAX_RTL_FILES) { truncated = true; return; }
        const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const full = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                await walk(full);
            } else if (/\.(sv|v|svh|vh)$/i.test(entry.name) && !isExcludedSourcePath(full)) {
                if (files.length >= MAX_RTL_FILES) { truncated = true; return; }
                files.push(full);
            }
        }
    };
    await walk(workspace);
    return { roots: [workspace], files, ...(truncated ? { truncated: true } : {}) };
}

async function signals(trace, input) {
    let vars = trace.meta.vars;
    const needle = String(input.query || '').toLowerCase().trim();
    if (needle) vars = vars.filter(variable => (variable.path + (variable.range || '')).toLowerCase().includes(needle));
    if (input.scope) vars = vars.filter(variable => variable.scopePath === input.scope || variable.scopePath.startsWith(input.scope + '.'));
    if (input.minWidth !== undefined || input.maxWidth !== undefined) {
        vars = vars.filter(variable => (!input.minWidth || variable.width >= Number(input.minWidth)) && (!input.maxWidth || variable.width <= Number(input.maxWidth)));
    }
    let note = null;
    if (input.role) {
        const context = await collectRtl(trace.options.workspace);
        const roles = await readSignalRoles(vars, context);
        vars = roles.vars.filter(variable => variable.role === input.role);
        note = roles.sourceRoleNote;
    }
    const limit = input.limit || 200;
    const truncated = vars.length > limit;
    return result('wave.signals', {
        file: trace.file, timescale: trace.meta.timescale || null, endTime: tickString(trace.meta.endTime),
        eventCount: trace.meta.eventCount, total: vars.length, truncated,
        ...(note ? { sourceRoleNote: note } : {}),
        signals: vars.slice(0, Math.min(limit, MAX_SIGNALS_OUTPUT)).map(variable => ({
            path: variable.path, name: variable.name, scope: variable.scopePath, width: variable.width,
            type: variable.type || 'wire', ...(variable.range ? { range: variable.range } : {}), changes: variable.changeCount
        })),
        stats: trace.stats
    });
}

function decodedValue(raw, variable) {
    if (raw === null || raw === undefined) return null;
    const entry = { bits: raw, width: variable.width, type: variable.type || 'wire' };
    const bits = model.binaryValue(raw, variable.width);
    if (bits && variable.width <= 64 && !/[xz]/.test(bits)) entry.value = model.formatValue(raw, variable, 'hex');
    else if (bits) entry.hex = model.formatValue(raw, variable, 'hex');
    // 有符号补码解释：仅整数类、宽度 2..=64 且不含 X/Z（形态参考 pywellen format_as_signed）。
    if (bits && variable.width >= 2 && variable.width <= 64 && !/[xz]/.test(bits)
        && !['real', 'realtime', 'string', 'event', 'time'].includes((variable.type || '').toLowerCase())) {
        const magnitude = BigInt('0b' + bits);
        entry.signed = String(bits.startsWith('1') ? magnitude - (1n << BigInt(variable.width)) : magnitude);
    }
    return entry;
}

async function values(trace, input) {
    if (input.at === undefined) fail('INVALID_ARGUMENT', 'wave values 需要 --at <ticks|时间>');
    const at = parseTick(trace, input.at, '--at');
    if (at > trace.meta.endTime) fail('INVALID_ARGUMENT', '--at 超出 VCD 记录范围', { at: tickString(at), endTime: tickString(trace.meta.endTime) });
    const ids = requireSignals(trace, input);
    const names = displayPaths(trace.meta);
    const found = storeValues(trace, ids, at);
    const out = {};
    for (const id of ids) out[names.get(id).path] = decodedValue(found[id], names.get(id));
    return result('wave.values', {
        file: trace.file, at: tickString(at), timescale: trace.meta.timescale || null,
        timeText: model.formatTime(at, secondsPerTick(trace.meta.timescale)),
        values: out, stats: trace.stats
    });
}

async function changes(trace, input) {
    const to = parseTick(trace, input.to ?? trace.meta.endTime, '--to');
    const from = input.from === undefined ? -1 : parseTick(trace, input.from, '--from') - 1;
    if (from >= to) fail('INVALID_ARGUMENT', '--from 必须早于 --to');
    const ids = requireSignals(trace, input);
    const names = displayPaths(trace.meta);
    // Rust/worker 的 `next` 是内部左开游标（最后一条已返回事件的时刻），可直接回传；
    // 返回给调用方的 `next` 才是对外 `--from`（闭区间下界），在收尾处 +1。
    const response = storeChanges(trace, { ids, from, to, limit: Math.min(input.limit || 200, 10000) });
    return result('wave.changes', {
        file: trace.file, from: tickString(from + 1), to: tickString(to), timescale: trace.meta.timescale || null,
        series: response.series.map(series => {
            const variable = names.get(series.id);
            return { path: variable.path, width: variable.width, total: series.total,
                // Rust 的 next 是「最后一条已返回事件的时刻」（内部左开游标），
                // 对外契约 `--from` 是闭区间下界，所以展示时 +1。
                next: series.next === null ? null : tickString(series.next + 1),
                events: series.events.map(event => ({ t: tickString(event.t), bits: event.value })) };
        }),
        stats: trace.stats
    });
}


/** 波形 SHA-256 只证明文件身份；不推断它由当前 RTL 或某次仿真生成。 */
async function waveformEvidence(trace) {
    const same = stat => ['dev','ino','size','mtimeMs','ctimeMs'].every(key => stat[key] === trace.sourceStat[key]);
    if (!same(await fs.stat(trace.file))) fail('SOURCE_CHANGED','诊断期间波形文件已变化');
    const digest=createHash('sha256'); let bytes=0;
    for await (const chunk of createReadStream(trace.file)) {
        bytes+=chunk.length;
        if (bytes>MAX_VCD_BYTES) fail('SOURCE_CHANGED','诊断期间波形超出输入预算');
        digest.update(chunk);
    }
    if (!same(await fs.stat(trace.file)) || bytes!==trace.sourceStat.size) fail('SOURCE_CHANGED','诊断期间波形文件已变化');
    return { waveformSha256:digest.digest('hex'), fileBytes:bytes, sourceBinding:'unverified', toolVersion:require('../../package.json').version };
}

/** 检查记录中的同刻多次变化；序号不代表 delta cycle，命中不自动判为 RTL 缺陷。 */
async function glitches(trace,input) {
    const ids=requireSignals(trace,input);
    const from=parseTick(trace,input.from??0,'--from'),to=parseTick(trace,input.to??trace.meta.endTime,'--to');
    const limit=input.limit??100,maxValues=input.maxValues??32;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from>to || to>trace.meta.endTime
        || !Number.isSafeInteger(limit) || limit<1 || limit>1000 || !Number.isSafeInteger(maxValues) || maxValues<1 || maxValues>256) {
        fail('INVALID_ARGUMENT','无效的诊断范围/预算：limit 1..1000，max-values 1..256，时间必须是安全整数 tick');
    }
    const raw=call(()=>nativeApi().waveGlitches(trace.handle,ids,from,to,limit,maxValues));
    const complete=raw.series.every(series=>series.complete);
    const evidence=await waveformEvidence(trace);
    return result('wave.glitches',{
        file:trace.file,format:trace.meta.format,timescale:trace.meta.timescale||null,from:tickString(from),to:tickString(to),
        complete,truncated:!complete,matched:raw.series.reduce((sum,series)=>sum+series.matched,0),matchedIsExact:complete,
        series:raw.series,evidence,
        semantics:{scope:'recorded-same-timestamp-transitions',recordIndex:'per-signal-record-order',schedulerDeltaIndices:false,
            crossSignalOrdering:false,physicalPulseWidths:false,recordingCompleteness:'unknown',absenceProvesNoGlitches:false,acceptance:false},
        stats:trace.stats
    });
}

/** 窗口统计：事件数/终值跳变数/首末跳变/X·Z；稳定值口径，供错误窗口分诊"谁最活跃"。 */
async function stats(trace, input) {
    const ids = requireSignals(trace, input);
    const from = parseTick(trace, input.from ?? 0, '--from'), to = parseTick(trace, input.to ?? trace.meta.endTime, '--to');
    if (from > to || to > trace.meta.endTime) fail('INVALID_ARGUMENT', '无效的统计窗口：--from 必须 ≤ --to 且不超出记录范围');
    const raw = call(() => nativeApi().waveStats(trace.handle, ids, from, to));
    const complete = raw.series.every(series => series.complete);
    return result('wave.stats', {
        file: trace.file, format: trace.meta.format, timescale: trace.meta.timescale || null,
        from: tickString(from), to: tickString(to), complete, truncated: !complete,
        series: raw.series, stats: trace.stats
    });
}

/** 合并时间线：多信号终值跳变按时间戳归组，同刻多信号变化同组；分页不拆组、不重叠。 */
async function timeline(trace, input) {
    const ids = requireSignals(trace, input);
    const from = parseTick(trace, input.from ?? 0, '--from'), to = parseTick(trace, input.to ?? trace.meta.endTime, '--to');
    const limit = input.limit ?? 1000;
    if (from > to || to > trace.meta.endTime || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
        fail('INVALID_ARGUMENT', '无效的时间线窗口/预算：limit 1..2000，--from ≤ --to 且不超出记录范围');
    const raw = call(() => nativeApi().waveTimeline(trace.handle, ids, from, to, limit));
    return result('wave.timeline', {
        file: trace.file, format: trace.meta.format, timescale: trace.meta.timescale || null,
        from: tickString(from), to: tickString(to), limit,
        complete: raw.complete, truncated: !raw.complete,
        // next 是首个未返回组的时刻，直接作为下一页闭区间 --from。
        next: raw.next || null, stopReason: raw.stopReason || null,
        groups: raw.groups, stats: trace.stats
    });
}

/** 沿/X/Z 搜索：交由 Rust 处理（含位级投影与分页续查）。 */
async function edges(trace, input) {
    const kind = input.kind || 'any';
    if (!['any', 'rise', 'fall', 'x', 'z'].includes(kind)) fail('INVALID_ARGUMENT', '--kind 必须为 any|rise|fall|x|z');
    if (input.signal === undefined) fail('INVALID_ARGUMENT', 'wave edges 需要 --signal <信号>');
    const ids = resolveIds(trace.meta.vars, [input.signal]);
    const names = displayPaths(trace.meta);
    const variable = names.get(ids[0]);
    const bitOffset = input.bit === undefined ? null : Number(input.bit);
    if (bitOffset !== null && (!Number.isSafeInteger(bitOffset) || bitOffset < 0 || bitOffset >= variable.width)) fail('INVALID_ARGUMENT', '--bit 超出信号位宽', { width: variable.width });
    if ((kind === 'rise' || kind === 'fall') && variable.width !== 1 && bitOffset === null) fail('INVALID_ARGUMENT', '向量信号的 rise/fall 需要 --bit <位下标>（LSB 起 0）', { width: variable.width });
    const to = parseTick(trace, input.to ?? trace.meta.endTime, '--to');
    const from = input.from === undefined ? -1 : parseTick(trace, input.from, '--from') - 1;
    if (from >= to) fail('INVALID_ARGUMENT', '--from 必须早于 --to');
    const limit = Math.min(input.limit || 100, 10000);
    // 直接调 Rust：from/to 的 from-to 位串由 Rust 压成 VCD 短写，
    // 与旧 JS 契约（保留 VCD 原文形态）一致；位投影与分页续查也在同一处完成。
    const raw = call(() => nativeApi().waveEdges(
        trace.handle, null, variable.path, kind, bitOffset, from, to, limit));
    return result('wave.edges', {
        file: trace.file, signal: variable.path, ...(bitOffset !== null ? { bit: bitOffset } : {}), kind,
        from: tickString(Number(raw.from)), to: tickString(Number(raw.to)), timescale: trace.meta.timescale || null,
        // Rust 的 next 是内部左开游标（最后一条已返回事件的时刻）；对外 `--from`
        // 是闭区间下界，所以展示时 +1，与 `wave changes` 保持一致。
        matched: raw.matched, truncated: raw.truncated, next: raw.next === null ? null : tickString(Number(raw.next) + 1),
        events: raw.events.map(event => ({ t: tickString(Number(event.t)), from: event.from, to: event.to })),
        stats: trace.stats
    });
}

async function sample(trace, input) {
    if (input.clock === undefined) fail('INVALID_ARGUMENT', 'wave sample 需要 --clock <信号>');
    const clockEdge = input.clockEdge || 'rise';
    if (!['rise', 'fall', 'both'].includes(clockEdge)) fail('INVALID_ARGUMENT', '--clock-edge 必须为 rise|fall|both');
    const clockIds = resolveIds(trace.meta.vars, [input.clock]);
    const ids = requireSignals(trace, input);
    const names = displayPaths(trace.meta);
    const to = parseTick(trace, input.to ?? trace.meta.endTime, '--to');
    const from = input.from === undefined ? -1 : parseTick(trace, input.from, '--from') - 1;
    if (from >= to) fail('INVALID_ARGUMENT', '--from 必须早于 --to');
    const conditions = input.where || [];
    const limit = Math.min(input.limit || (conditions.length ? 50 : 256), 4096);
    // 条件信号由 Rust 按需加载，与输出列无关；同一实现负责条件、采样及分页。
    const raw = call(() => nativeApi().waveSample(trace.handle, null, pathOf(trace, clockIds[0]),
        clockEdge, ids.map(id => pathOf(trace, id)).join(','), from, to, limit, conditions));
    return result('wave.sample', {
        file: trace.file, clock: names.get(clockIds[0]).path, clockEdge, from: tickString(from + 1), to: tickString(to),
        timescale: trace.meta.timescale || null, ...(conditions.length ? { where: conditions } : {}),
        scannedEdges: raw.scannedEdges, matched: raw.matched, truncated: raw.next !== null,
        next: raw.next === null ? null : tickString(Number(raw.next) + 1),
        samples: raw.samples.map(point => ({ t: point.t, values: Object.fromEntries(ids.map(id => {
            const variable = names.get(id);
            return [variable.path, decodedValue(point.values[pathOf(trace, id)]?.bits ?? null, variable)];
        })) })),
        stats: trace.stats
    });
}

/** 双 VCD 同名信号差异：Rust（wellen）双指针逐对比较，输出与 CLI 协定一致。 */
async function diff(traceA, input) {
    if (input.against === undefined) fail('INVALID_ARGUMENT', 'wave diff 需要 --against <vcd>');
    const traceB = await openTrace({ ...input, file: input.against });
    try {
        const end = Math.min(traceA.meta.endTime, traceB.meta.endTime);
        const to = input.to === undefined ? end : parseTick(traceA, input.to, '--to');
        const from = input.from === undefined ? 0 : parseTick(traceA, input.from, '--from');
        if (from >= to) fail('INVALID_ARGUMENT', '--from 必须早于 --to');
        const signals = input.signals === undefined
            ? null
            : String(input.signals).split(',').map(name => name.trim()).filter(Boolean).join(',') || null;
        const raw = call(() => nativeApi().waveDiff(
            traceA.file, traceB.file, signals, from, to, Math.min(input.limit || 50, 1000)));
        return result('wave.diff', {
            ...raw,
            from: tickString(Number(raw.from)),
            to: tickString(Number(raw.to)),
            firstDiff: raw.firstDiff ? { ...raw.firstDiff, t: tickString(Number(raw.firstDiff.t)) } : null,
            diffs: raw.diffs.map(entry => ({ ...entry, t: tickString(Number(entry.t)) })),
            stats: { a: traceA.stats, b: traceB.stats },
        });
    } finally { traceB.close(); }
}

/** CSV 单元格转义：逗号/引号/换行才加引号，引号翻倍。 */
function csvCell(text) {
    const value = String(text ?? '');
    return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

const MAX_CSV_ROWS = 100000;

/** CSV 导出（形态参考 pywellen export_to_csv）：行=窗口内任一信号的终值跳变时刻，
 * 列=各信号该时刻的终值位串（含 X/Z，证据口径）；行预算 10 万，超出标 truncated。 */
async function exportCsv(trace, input, { ids, names, from, to }) {
    // 分页取合并时间线（单页上限与 timeline 命令一致），总行预算 MAX_CSV_ROWS。
    const rows = [];
    let cursor = from, complete = false;
    for (;;) {
        const raw = call(() => nativeApi().waveTimeline(trace.handle, ids, cursor, to, 2000));
        const room = MAX_CSV_ROWS - rows.length;
        for (const group of raw.groups.slice(0, room)) rows.push(group);
        if (room < raw.groups.length) break; // 行预算耗尽，本页仍有组未装下
        if (raw.next === null) { complete = true; break; }
        cursor = Number(raw.next);
    }
    const truncated = !complete;
    const paths = ids.map(id => names.get(id).path);
    // 窗口前基线：from=0 时首行前的值为 null（用空单元格表示）。
    const baseline = from > 0 ? storeValues(trace, ids, from - 1) : {};
    const current = new Map();
    ids.forEach((id, index) => current.set(paths[index], baseline[id] ?? null));
    const lines = ['time,' + paths.map(csvCell).join(',')];
    for (const group of rows) {
        for (const change of group.changes) current.set(change.path, change.bits);
        lines.push(group.t + ',' + paths.map(p => csvCell(current.get(p) ?? '')).join(','));
    }
    const text = lines.join('\r\n') + '\r\n';
    const base = (input.title ? input.title.replace(/[\\/:*?"<>|]/g, '_') : path.basename(trace.file).replace(/\.(?:vcd|fst)$/i, '')) || 'waveform';
    const outputDirectory = path.resolve(trace.options.workspace, input.out);
    const artifacts = [];
    try {
        const created = (await createContainedDirectories(outputDirectory, trace.options.workspace)).created;
        try {
            const csvFile = path.join(outputDirectory, base + '.csv');
            await fs.writeFile(csvFile, text, 'utf8');
            artifacts.push({ kind: 'data', path: csvFile, sha256: hash(text), bytes: Buffer.byteLength(text), rows: rows.length, truncated });
        } catch (error) {
            await cleanupDirectories(created, trace.options.workspace);
            throw error;
        }
    } catch (error) {
        if (error.code === 'OUTSIDE_WORKSPACE') fail('INVALID_ARGUMENT', 'wave export 的 --out 通过符号链接逃逸出工作区', { out: input.out });
        if (error.code === 'OUT_NOT_DIRECTORY') fail('INVALID_ARGUMENT', 'wave export 的 --out 必须是工作区内的目录：' + input.out, { out: input.out });
        if (error.code === 'EACCES' || error.code === 'EPERM') fail('INVALID_ARGUMENT', 'wave export 的 --out 不可写：' + input.out, { out: input.out, reason: error.code });
        throw error;
    }
    return result('wave.export', {
        file: trace.file, from: tickString(from), to: tickString(to), timescale: trace.meta.timescale || null,
        out: outputDirectory, format: 'csv', rows: rows.length, truncated, signals: paths,
        stats: trace.stats
    }, null, [], artifacts);
}

/** 布局导出：--signals 的声明身份 + 窗口/游标写成 .svwave.json；查看器打开同名波形时自动套用。
 * 默认落在波形自己的目录（同名约定），--out 仍可指向工作区内其他目录；已存在需 --force。 */
async function exportLayout(trace, input, { ids, names, from, to }) {
    const cursorA = input.at !== undefined ? parseTick(trace, input.at, '--at') : from;
    const cursorB = input.atB !== undefined ? parseTick(trace, input.atB, '--at-b') : null;
    if (cursorA > to || cursorB !== null && cursorB > to) fail('INVALID_ARGUMENT', '游标时间超出导出窗口');
    const layout = { kind: 'svtools-wave-layout', version: 1,
        tracks: ids.map(id => { const variable = names.get(id);
            return { signal: { path: variable.path, range: variable.range || '', width: variable.width }, visible: true }; }),
        collapsedGroups: [], view: { start: from, span: to - from }, cursorA, cursorB,
        secondsPerTick: secondsPerTick(trace.meta.timescale), fullName: false, snap: true };
    try { layoutState.validate(layout); }
    catch (error) { fail('INVALID_ARGUMENT', 'wave export 布局无效：' + error.message); }
    const base = (input.title ? input.title.replace(/[\\/:*?"<>|]/g, '_') : path.basename(trace.file).replace(/\.(?:vcd|fst)$/i, '')) || 'waveform';
    const outputDirectory = path.resolve(trace.options.workspace, input.out ?? path.dirname(trace.file));
    // 与 createContainedDirectories 的 inside() 同口径：跨盘符时 path.relative 返回绝对路径，也要拒绝。
    const layoutFile = path.join(outputDirectory, base + '.svwave.json');
    const automaticFile = trace.file.replace(/\.(?:vcd|fst)$/i, '') + '.svwave.json';
    const autoLoads = path.relative(automaticFile, layoutFile) === '';
    const relative = path.relative(trace.options.workspace, outputDirectory);
    if (input.out === undefined && (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)))
        fail('INVALID_ARGUMENT', '波形文件不在工作区内：布局导出默认写波形同目录，请用 --out 指定工作区内目录');
    const artifacts = [];
    try {
        const created = (await createContainedDirectories(outputDirectory, trace.options.workspace)).created;
        try {
            const file = layoutFile;
            const text = JSON.stringify(layout, null, 2) + '\n';
            // --force 覆盖时不能跟随已存在的链接/别名写出工作区外。
            try { await assertExportTarget(file, trace.file); }
            catch (error) { fail('INVALID_ARGUMENT', 'wave export 布局目标不是独立普通文件：' + error.message, { file }); }
            try { await fs.writeFile(file, text, { encoding: 'utf8', flag: input.force ? 'w' : 'wx' }); }
            catch (error) { if (error.code === 'EEXIST') fail('FILE_EXISTS', '布局文件已存在，使用 --force 覆盖：' + file, { file }); throw error; }
            artifacts.push({ kind: 'layout', path: file, sha256: hash(text), bytes: Buffer.byteLength(text), tracks: layout.tracks.length });
        } catch (error) {
            await cleanupDirectories(created, trace.options.workspace);
            throw error;
        }
    } catch (error) {
        if (error.code === 'OUTSIDE_WORKSPACE') fail('INVALID_ARGUMENT', 'wave export 的 --out 通过符号链接逃逸出工作区', { out: input.out });
        if (error.code === 'OUT_NOT_DIRECTORY') fail('INVALID_ARGUMENT', 'wave export 的 --out 必须是工作区内的目录：' + input.out, { out: input.out });
        if (error.code === 'EACCES' || error.code === 'EPERM') fail('INVALID_ARGUMENT', 'wave export 的 --out 不可写：' + input.out, { out: input.out, reason: error.code });
        throw error;
    }
    return result('wave.export', {
        file: trace.file, from: tickString(from), to: tickString(to), timescale: trace.meta.timescale || null,
        out: outputDirectory, format: 'layout', tracks: layout.tracks.length,
        signals: layout.tracks.map(track => track.signal.path),
        cursor: { a: tickString(cursorA), ...(cursorB !== null ? { b: tickString(cursorB) } : {}) },
        viewer: autoLoads ? '打开同名波形时自动套用该布局' : '需用查看器“加载布局”手动打开该文件',
        stats: trace.stats
    }, null, [], artifacts);
}

/** 时间窗波形图导出：无宿主渲染（document 黑白风格），SVG/PNG 落入工作区目录并返回产物身份。 */
async function exportImage(trace, input) {
    const format = input.imageFormat || 'svg';
    if (!['svg', 'png', 'csv', 'layout'].includes(format)) fail('INVALID_ARGUMENT', 'wave export 的 --format 只支持 svg|png|csv|layout：' + format);
    if (input.out === undefined && format !== 'layout') fail('INVALID_ARGUMENT', 'wave export 需要 --out <dir>');
    const ids = requireSignals(trace, input);
    const names = displayPaths(trace.meta);
    const to = parseTick(trace, input.to ?? trace.meta.endTime, '--to');
    const from = input.from === undefined ? 0 : parseTick(trace, input.from, '--from');
    if (from >= to) fail('INVALID_ARGUMENT', '--from 必须早于 --to');
    if (format === 'csv') return exportCsv(trace, input, { ids, names, from, to });
    if (format === 'layout') return exportLayout(trace, input, { ids, names, from, to });
    const cursorA = input.at !== undefined ? parseTick(trace, input.at, '--at') : from;
    const cursorB = input.atB !== undefined ? parseTick(trace, input.atB, '--at-b') : null;
    if (cursorA > to || cursorB !== null && cursorB > to) fail('INVALID_ARGUMENT', '游标时间超出导出窗口');
    const prepared = model.prepareSignals(ids.map(id => names.get(id)));
    const keys = prepared.map(variable => model.signalKey(variable));
    const rows = rowLayout.buildRows(keys, new Map(prepared.map(variable => [model.signalKey(variable), variable])), {}, {}, {});
    const state = { rows, signals: new Map(prepared.map(variable => [model.signalKey(variable), variable])),
        metadata: trace.meta, view: { start: from, span: to - from }, cursorA, cursorB,
        secondsPerTick: secondsPerTick(trace.meta.timescale), multi: new Set(), selected: [], formats: {},
        groups: {}, heights: {}, highlights: {}, fullName: false, activeKey: null, rowPresentation: null };
    // 导出器只用到 window/values 两个查询；直接转发到 Rust，不必假装成完整 store。
    const request = async (method, params) => {
        if (method === 'window') {
            const raw = call(() => nativeApi().waveWindow(trace.handle, null, params.ids, params.start, params.end, params.pixels));
            return {
                series: raw.series.map(series => ({
                    id: series.id,
                    changes: series.changes.map(change => ({ t: Number(change.t), value: change.bits })),
                    dense: (series.dense || []).map(bucket => ({ start: Number(bucket.start), end: Number(bucket.end), count: bucket.count })),
                })),
            };
        }
        if (method === 'values') return { values: storeValues(trace, params.ids, params.time) };
        fail('INVALID_ARGUMENT', '导出不支持的查询：' + method);
    };
    const options = { range: cursorB !== null && cursorA !== cursorB ? 'ab' : 'view', signals: 'all' };
    const title = input.title || path.basename(trace.file);
    const image = await createWaveImage({ state, options, request, title });
    const base = (input.title ? input.title.replace(/[\\/:*?"<>|]/g, '_') : path.basename(trace.file).replace(/\.vcd$/i, '')) || 'waveform';
    const outputDirectory = path.resolve(trace.options.workspace, input.out);
    const artifacts = [];
    try {
        const created = (await createContainedDirectories(outputDirectory, trace.options.workspace)).created;
        try {
            const svgFile = path.join(outputDirectory, base + '.svg');
            await fs.writeFile(svgFile, image.svg);
            artifacts.push({ kind: 'image', path: svgFile, sha256: hash(image.svg), bytes: Buffer.byteLength(image.svg) });
            if (input.imageFormat === 'png') {
                const { png, width, height } = rasterizeSvg(image.svg, { scale: DEFAULT_SCALE });
                const pngFile = path.join(outputDirectory, base + '.png');
                await fs.writeFile(pngFile, png);
                artifacts.push({ kind: 'image', path: pngFile, sha256: hash(png), bytes: png.length, width, height });
            }
        } catch (error) {
            await cleanupDirectories(created, trace.options.workspace);
            throw error;
        }
    } catch (error) {
        if (error.code === 'OUTSIDE_WORKSPACE') fail('INVALID_ARGUMENT', 'wave export 的 --out 通过符号链接逃逸出工作区', { out: input.out });
        if (error.code === 'OUT_NOT_DIRECTORY') fail('INVALID_ARGUMENT', 'wave export 的 --out 必须是工作区内的目录：' + input.out, { out: input.out });
        if (error.code === 'EACCES' || error.code === 'EPERM') fail('INVALID_ARGUMENT', 'wave export 的 --out 不可写：' + input.out, { out: input.out, reason: error.code });
        throw error;
    }
    return result('wave.export', {
        file: trace.file, from: tickString(from), to: tickString(to), timescale: trace.meta.timescale || null,
        out: outputDirectory, format, width: image.width, height: image.height,
        signals: prepared.map(variable => variable.path), cursor: { a: tickString(cursorA), ...(cursorB !== null ? { b: tickString(cursorB) } : {}) },
        stats: trace.stats
    }, null, [], artifacts);
}

module.exports = { openTrace, secondsPerTick,
    signals: ownedQuery(signals), values: ownedQuery(values), changes: ownedQuery(changes),
    edges: ownedQuery(edges), glitches: ownedQuery(glitches), stats: ownedQuery(stats), timeline: ownedQuery(timeline),
    sample: ownedQuery(sample), diff: ownedQuery(diff), exportImage: ownedQuery(exportImage) };
