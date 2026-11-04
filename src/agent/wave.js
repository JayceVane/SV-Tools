'use strict';
/** M4 波形查询服务：VCD 打开与索引缓存、信号/取值/跳变/沿/采样/差异查询。
 * 时间输出一律整数 tick 字符串（JSON 内不出现浮点时标），物理换算并列展示；原始位值与 X/Z 原样保留。 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { nativeApi, call } = require('../waveform/rust-backend');
const model = require('../waveform/model');
const rowLayout = require('../waveform/row-layout');
const { bitValue } = require('../waveform/signal-display');
const { readSignalRoles } = require('../waveform/source-roles');
const { isExcludedSourcePath } = require('../workspace/source-policy');
const { createWaveImage } = require('../waveform/node-export');
const { createContainedDirectories, cleanupDirectories } = require('../design/scaffold-paths');
const { rasterizeSvg, DEFAULT_SCALE } = require('../graphics/rasterize');
const { readOptions, hash } = require('./context');
const { result, fail } = require('./protocol');

const MAX_VCD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SIGNALS_OUTPUT = 2000;
const MAX_RTL_FILES = 512;
const MAX_DIFF_EVENTS = 2000000;
const ENUM_PAGE = 10000;

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

/** 已打开会话：绝对路径 → Rust 句柄。CLI 单次进程里最多一条；agent 服务长驻，靠重开与 close 收敛。 */
const openHandles = new Map();

/** 释放某个文件的会话句柄（幂等，无句柄时无操作）。 */
function closeTrace(file) {
    const handle = openHandles.get(file);
    if (handle === undefined) return;
    openHandles.delete(file);
    try { nativeApi().waveSessionClose(handle); }
    catch { /* 关闭失败不应影响命令结果；进程退出时资源随之释放。 */ }
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
    // 一个命令通常只开一份波形；同名文件重复打开时先释放旧句柄，
    // 避免长驻进程（agent 服务）里的注册表累积。
    closeTrace(file);
    let meta, handle = null;
    try {
        const opened = call(() => nativeApi().waveSessionOpen(file));
        handle = opened.handle;
        meta = opened.meta;
    } catch (error) {
        // Rust 的错误码与 CLI 码基本同名；个别情况补映射说明。
        if (error.code === 'WAVE_FORMAT_UNSUPPORTED') fail('VCD_PARSE', error.message, { file });
        fail(error.code || 'VCD_PARSE', error.message, { file });
    }
    const after = await fs.stat(file);
    if (after.size !== stat.size || Math.round(after.mtimeMs) !== Math.round(stat.mtimeMs)) {
        // 文件在解析期间变了：句柄指向的是旧内容，必须丢弃，避免后续查询读到半旧数据。
        try { nativeApi().waveSessionClose(handle); } catch { /* 忽略 */ }
        fail('SOURCE_CHANGED', 'VCD 读取期间文件已变化，请在仿真结束后重试', { file });
    }
    openHandles.set(file, handle);
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
        options, file, handle, meta: normalized,
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

/** @returns {{total:number,next:number|null,samples:Array<{t:number,values:Record<string,string|null>}>}} */
function storeSample(trace, { clock, edge, ids, from, to, limit }) {
    const clockPath = pathOf(trace, clock);
    const paths = ids.map(id => pathOf(trace, id));
    const raw = call(() => nativeApi().waveSample(
        trace.handle, null, clockPath, edge, paths.join(','), from ?? null, to, limit, null));
    return {
        total: raw.scannedEdges,
        next: raw.next === null ? null : Number(raw.next),
        samples: raw.samples.map(sample => ({
            t: Number(sample.t),
            values: Object.fromEntries(ids.map(id => {
                const entry = sample.values[pathOf(trace, id)];
                return [id, entry ? entry.bits ?? null : null];
            })),
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

/** --where 受限条件：`信号 op [字面量]`，op ∈ == != contains-x contains-z；字面量支持 0b/0x/SV 进制与十进制。 */
function parseWhere(text) {
    const match = /^(.+?)\s+(==|!=|contains-x|contains-z)(?:\s+(.+))?$/.exec(String(text).trim());
    if (!match || (!match[3] && !match[2].includes('contains'))) fail('INVALID_ARGUMENT', '--where 格式无效：' + text + '（示例 "dut.q != 8\'hA5" 或 "dut.bus contains-x"）');
    return { name: match[1].trim(), operator: match[2], literal: match[3]?.trim() ?? null };
}
function literalBits(literal, width) {
    const text = String(literal).replace(/\s+/g, '');
    let digits = null, radix = 10;
    const sv = /^(\d+)'([hbd])([0-9a-f_]+)$/i.exec(text);
    if (sv) { radix = { h: 16, b: 2, d: 10 }[sv[2].toLowerCase()]; digits = sv[3].replace(/_/g, ''); }
    else if (/^0b[01_]+$/i.test(text)) { radix = 2; digits = text.slice(2).replace(/_/g, ''); }
    else if (/^0x[0-9a-f_]+$/i.test(text)) { radix = 16; digits = text.slice(2).replace(/_/g, ''); }
    else if (/^[0-9_]+$/.test(text)) digits = text.replace(/_/g, '');
    if (digits === null) fail('INVALID_ARGUMENT', '--where 字面量无效：' + literal + '（支持 0b/0x/十进制与 8\'hA5 风格）');
    const normalized = digits.replace(/^0+/, '') || '0';
    let value;
    try { value = BigInt(radix === 16 ? '0x' + normalized : radix === 2 ? '0b' + normalized : normalized); }
    catch { fail('INVALID_ARGUMENT', '--where 字面量无效：' + literal); }
    const bits = value.toString(2);
    if (bits.length > width) fail('INVALID_ARGUMENT', '--where 字面量超过信号位宽 ' + width, { width });
    return bits.padStart(width, '0');
}
function evaluateWhere(conditions, valuesById, names) {
    for (const condition of conditions) {
        const entry = names.get(condition.name);
        if (!entry) fail('SIGNAL_NOT_FOUND', '--where 引用的信号不存在：' + condition.name);
        const variable = entry.variable;
        const raw = valuesById[variable.id];
        const bits = raw === null || raw === undefined ? null : model.binaryValue(raw, variable.width);
        if (condition.operator === 'contains-x') { if (!bits || !bits.includes('x')) return false; }
        else if (condition.operator === 'contains-z') { if (!bits || !bits.includes('z')) return false; }
        else if (entry.against) {
            // 信号对信号：按各自位宽规范化后逐位比较，X/Z 参与比较而非通配。
            const other = valuesById[entry.against.id];
            const otherBits = other === null || other === undefined ? null : model.binaryValue(other, entry.against.width);
            const equal = bits !== null && otherBits !== null && otherBits === bits;
            if (equal !== (condition.operator === '==')) return false;
        }
        else {
            const expected = literalBits(condition.literal, variable.width);
            const equal = bits !== null && model.binaryValue(expected, variable.width) === bits;
            if (equal !== (condition.operator === '==')) return false;
        }
    }
    return true;
}

async function signals(input) {
    const trace = await openTrace(input);
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
    return entry;
}

async function values(input) {
    const trace = await openTrace(input);
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

async function changes(input) {
    const trace = await openTrace(input);
    const to = parseTick(trace, input.to ?? trace.meta.endTime, '--to');
    const from = input.from === undefined ? -1 : parseTick(trace, input.from, '--from') - 1;
    if (from >= to) fail('INVALID_ARGUMENT', '--from 必须早于 --to');
    const ids = requireSignals(trace, input);
    const names = displayPaths(trace.meta);
    const response = storeChanges(trace, { ids, from, to, limit: Math.min(input.limit || 200, 10000) });
    return result('wave.changes', {
        file: trace.file, from: tickString(from + 1), to: tickString(to), timescale: trace.meta.timescale || null,
        series: response.series.map(series => {
            const variable = names.get(series.id);
            return { path: variable.path, width: variable.width, total: series.total,
                // Rust 侧的 next 已经是「下一页可直接使用的 --from」（最后返回事件 tick + 1），
                // 这里不能再加一次，否则每翻一页会跳过一整 tick。
                next: series.next === null ? null : tickString(series.next),
                events: series.events.map(event => ({ t: tickString(event.t), bits: event.value })) };
        }),
        stats: trace.stats
    });
}

/** 沿/X/Z 搜索：交由 Rust 处理（含位级投影与分页续查）。 */
async function edges(input) {
    const trace = await openTrace(input);
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
        matched: raw.matched, truncated: raw.truncated, next: raw.next === null ? null : tickString(Number(raw.next)),
        events: raw.events.map(event => ({ t: tickString(Number(event.t)), from: event.from, to: event.to })),
        stats: trace.stats
    });
}

async function sample(input) {
    const trace = await openTrace(input);
    if (input.clock === undefined) fail('INVALID_ARGUMENT', 'wave sample 需要 --clock <信号>');
    const clockEdge = input.clockEdge || 'rise';
    if (!['rise', 'fall', 'both'].includes(clockEdge)) fail('INVALID_ARGUMENT', '--clock-edge 必须为 rise|fall|both');
    const clockIds = resolveIds(trace.meta.vars, [input.clock]);
    const ids = requireSignals(trace, input);
    const names = displayPaths(trace.meta);
    const conditions = (input.where || []).map(parseWhere);
    const conditionNames = new Map(conditions.map(condition => {
        const id = resolveIds(trace.meta.vars, [condition.name])[0];
        const entry = { name: condition.name, variable: displayPaths(trace.meta).get(id) };
        // 比较右值若唯一命中一个信号则按信号对信号比较，否则按字面量解析。
        if (condition.literal) {
            const name = condition.literal;
            const exact = trace.meta.vars.filter(variable => variable.path === name);
            const loose = trace.meta.vars.filter(variable => variable.path.endsWith('.' + name) || variable.name === name);
            const matches = exact.length === 1 ? exact : loose.length === 1 ? loose : exact.length + loose.length > 1 ? [] : null;
            if (matches === null) entry.against = null;
            else if (matches.length === 1) entry.against = displayPaths(trace.meta).get(matches[0].id);
            else fail('SIGNAL_NOT_FOUND', '--where 右值匹配多个信号，请使用完整路径：' + name, { name, candidates: [...new Set([...exact, ...loose])].slice(0, 20).map(variable => variable.path) });
        }
        return [condition.name, entry];
    }));
    const to = parseTick(trace, input.to ?? trace.meta.endTime, '--to');
    const from = input.from === undefined ? -1 : parseTick(trace, input.from, '--from') - 1;
    if (from >= to) fail('INVALID_ARGUMENT', '--from 必须早于 --to');
    const limit = Math.min(input.limit || (conditions.length ? 50 : 256), 4096);
    const hits = [];
    let cursor = from, scanned = 0, matched = 0, next = null, done = false;
    while (!done) {
        const page = storeSample(trace, { clock: clockIds[0], edge: clockEdge, ids, from: cursor, to, limit: 4096 });
        scanned += page.total;
        for (const point of page.samples) {
            if (!conditions.length || evaluateWhere(conditions, point.values, conditionNames)) {
                matched++;
                if (hits.length < limit) {
                    const values = {};
                    for (const id of ids) values[names.get(id).path] = decodedValue(point.values[id], names.get(id));
                    hits.push({ t: tickString(point.t), values });
                } else { next = tickString(point.t + 1); done = true; break; }
            }
        }
        if (page.next === null) done = true; else cursor = page.next;
    }
    return result('wave.sample', {
        file: trace.file, clock: names.get(clockIds[0]).path, clockEdge, from: tickString(from + 1), to: tickString(to),
        timescale: trace.meta.timescale || null, ...(conditions.length ? { where: input.where } : {}),
        scannedEdges: scanned, matched, truncated: next !== null, next, samples: hits, stats: trace.stats
    });
}

/** 双 VCD 同名信号差异：Rust（wellen）双指针逐对比较，输出与 CLI 协定一致。 */
async function diff(input) {
    if (input.against === undefined) fail('INVALID_ARGUMENT', 'wave diff 需要 --against <vcd>');
    // 两次 openTrace 会各解析一遍文件；Rust 侧 `wave_diff` 内部也各自打开，
    // 这里保留 openTrace 是为了沿用统一的路径校验、文件变化检测与 stats 输出。
    const traceA = await openTrace(input);
    const traceB = await openTrace({ ...input, file: input.against });
    // A 的句柄可能被 B 的 openTrace 关掉（同文件自比对时），而下面的 waveDiff
    // 直接用路径、不走句柄，所以这里不需要补开。
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
}

/** 时间窗波形图导出：无宿主渲染（document 黑白风格），SVG/PNG 落入工作区目录并返回产物身份。 */
async function exportImage(input) {
    const trace = await openTrace(input);
    if (input.out === undefined) fail('INVALID_ARGUMENT', 'wave export 需要 --out <dir>');
    const ids = requireSignals(trace, input);
    const names = displayPaths(trace.meta);
    const to = parseTick(trace, input.to ?? trace.meta.endTime, '--to');
    const from = input.from === undefined ? 0 : parseTick(trace, input.from, '--from');
    if (from >= to) fail('INVALID_ARGUMENT', '--from 必须早于 --to');
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
        out: outputDirectory, format: input.imageFormat || 'svg', width: image.width, height: image.height,
        signals: prepared.map(variable => variable.path), cursor: { a: tickString(cursorA), ...(cursorB !== null ? { b: tickString(cursorB) } : {}) },
        stats: trace.stats
    }, null, [], artifacts);
}

module.exports = { openTrace, signals, values, changes, edges, sample, diff, exportImage, secondsPerTick };
