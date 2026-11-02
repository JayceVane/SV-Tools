'use strict';
/** M4 波形查询服务：VCD 打开与索引缓存、信号/取值/跳变/沿/采样/差异查询。
 * 时间输出一律整数 tick 字符串（JSON 内不出现浮点时标），物理换算并列展示；原始位值与 X/Z 原样保留。 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { TextDecoder } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const { createVcdParser } = require('../waveform/parser');
const { VcdStore } = require('../waveform/store');
const model = require('../waveform/model');
const rowLayout = require('../waveform/row-layout');
const { bitValue } = require('../waveform/signal-display');
const { readSignalRoles } = require('../waveform/source-roles');
const { isExcludedSourcePath } = require('../workspace/source-policy');
const { createWaveImage } = require('../waveform/node-export');
const { createContainedDirectories, cleanupDirectories } = require('../design/scaffold-paths');
const { rasterizeSvg, DEFAULT_SCALE } = require('../graphics/rasterize');
const { readOptions, hash } = require('./context');
const { directory, writeJson } = require('./storage');
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

/** 主进程流式解析 VCD；解析期间文件变化即失败，不把半旧数据当本轮结果。 */
async function parseVcdFile(file, stat) {
    const store = new VcdStore();
    const parser = createVcdParser({ onVariable: variable => store.register(variable), onChange: (id, time, value) => store.add(id, time, value) });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let read = 0;
    try {
        for await (const chunk of createReadStream(file, { highWaterMark: 256 * 1024 })) {
            read += chunk.length;
            if (read > MAX_VCD_BYTES) fail('SOURCE_LIMIT', 'VCD 文件读取超过 2048MiB 上限', { file });
            parser.write(decoder.decode(chunk, { stream: true }));
        }
        parser.write(decoder.decode());
    } catch (error) {
        if (error.code === 'VCD_PARSE' || error.code === 'VCD_RESOURCE_LIMIT') fail(error.code, error.message, { file, line: error.line, column: error.column });
        if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') fail('VCD_PARSE', 'VCD 不是有效的 UTF-8 文本', { file });
        throw error;
    }
    const meta = parser.finish();
    const after = await fs.stat(file);
    if (after.size !== stat.size || Math.round(after.mtimeMs) !== Math.round(stat.mtimeMs)) fail('SOURCE_CHANGED', 'VCD 读取期间文件已变化，请在仿真结束后重试', { file });
    return { store, meta };
}

/** 打开 VCD：按绝对路径哈希落索引缓存（size+mtime 身份），命中时零拷贝加载，否则解析后原子写缓存。 */
async function openTrace(input) {
    const { options } = await readOptions(input);
    if (!input.file) fail('FILE_REQUIRED', 'wave 命令需要 --file <vcd>');
    const file = path.resolve(options.workspace, input.file);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) fail('SOURCE_NOT_FOUND', 'VCD 文件不存在：' + input.file, { file });
    if (stat.size > MAX_VCD_BYTES) fail('SOURCE_LIMIT', 'VCD 文件超过 2048MiB 上限', { file, size: stat.size });
    const fileIdentity = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
    const cacheKey = createHash('sha256').update(file.toLowerCase()).digest('hex').slice(0, 16);
    const cacheDirectory = await directory(options.workspace, 'wave', cacheKey);
    const indexFile = path.join(cacheDirectory, 'index.bin'), metaFile = path.join(cacheDirectory, 'meta.json');
    const startedAt = Date.now();
    try {
        const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
        if (meta.fileIdentity?.size === fileIdentity.size && meta.fileIdentity?.mtimeMs === fileIdentity.mtimeMs) {
            const store = VcdStore.loadSnapshot(await fs.readFile(indexFile), null);
            return { options, file, store, meta, stats: { cached: true, loadMs: Date.now() - startedAt, fileBytes: stat.size, eventCount: meta.eventCount } };
        }
    } catch { /* 缓存缺失或损坏时重新解析并覆盖。 */ }
    const parsed = await parseVcdFile(file, stat);
    const meta = parsed.store.metadata(parsed.meta, stat.size);
    meta.fileIdentity = fileIdentity;
    const temporary = indexFile + '.' + randomUUID() + '.tmp';
    try {
        await fs.writeFile(temporary, parsed.store.snapshot());
        await fs.rename(temporary, indexFile);
        await writeJson(metaFile, meta);
    } catch { /* 索引缓存写失败不阻塞查询，仅失去复用。 */ await fs.rm(temporary, { force: true }); }
    return { options, file, store: parsed.store, meta,
        stats: { cached: false, parseMs: Date.now() - startedAt, loadMs: Date.now() - startedAt, fileBytes: stat.size, eventCount: meta.eventCount } };
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
    const found = trace.store.values({ ids, time: at }).values;
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
    const response = trace.store.changes({ ids, from, to, limit: Math.min(input.limit || 200, 10000) });
    return result('wave.changes', {
        file: trace.file, from: tickString(from + 1), to: tickString(to), timescale: trace.meta.timescale || null,
        series: response.series.map(series => {
            const variable = names.get(series.id);
            return { path: variable.path, width: variable.width, total: series.total,
                // --from 含起点语义；next 给出下一页可直接使用的 --from（最后返回事件 tick + 1）。
                next: series.next === null ? null : tickString(series.next + 1),
                events: series.events.map(event => ({ t: tickString(event.t), bits: event.value })) };
        }),
        stats: trace.stats
    });
}

/** 沿/X/Z 搜索：分页拉取窗口事件流式过滤；rise/fall 需要标量信号或 --bit 位级投影。 */
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
    const project = value => bitOffset === null ? value : bitValue(value, bitOffset);
    const matches = (before, after) => {
        if (kind === 'any') return true;
        const low = String(before).toLowerCase(), high = String(after).toLowerCase();
        if (kind === 'rise') return low === '0' && high === '1';
        if (kind === 'fall') return low === '1' && high === '0';
        if (kind === 'x') return high.includes('x');
        return high.includes('z');
    };
    const events = [];
    let cursor = from, previous = null, total = 0, next = null, exhausted = false;
    while (!exhausted && total < limit) {
        const page = trace.store.changes({ ids, from: cursor, to, limit: ENUM_PAGE }).series[0];
        for (const event of page.events) {
            const current = project(event.value);
            if (previous !== null && current !== previous && matches(previous, current)) {
                total++;
                if (events.length < limit) events.push({ t: tickString(event.t), from: previous, to: current });
                else { next = tickString(event.t + 1); exhausted = true; break; }
            }
            previous = current;
        }
        if (page.next === null) exhausted = true; else cursor = page.next;
    }
    return result('wave.edges', {
        file: trace.file, signal: variable.path, ...(bitOffset !== null ? { bit: bitOffset } : {}), kind,
        from: tickString(from + 1), to: tickString(to), timescale: trace.meta.timescale || null,
        matched: total, truncated: next !== null, next,
        events, stats: trace.stats
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
        const page = trace.store.sample({ clock: clockIds[0], edge: clockEdge, ids, from: cursor, to, limit: 4096 });
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

/** 双指针逐对比较两个 VCD 的同名信号：首差异时刻 + 前 N 条差异；事件总量超预算时明确截断。 */
async function diff(input) {
    if (input.against === undefined) fail('INVALID_ARGUMENT', 'wave diff 需要 --against <vcd>');
    const traceA = await openTrace(input);
    const traceB = await openTrace({ ...input, file: input.against });
    const namesA = displayPaths(traceA.meta), namesB = displayPaths(traceB.meta);
    const byPathA = new Map(traceA.meta.vars.map(variable => [variable.path + (variable.range || ''), variable]));
    const byPathB = new Map(traceB.meta.vars.map(variable => [variable.path + (variable.range || ''), variable]));
    let keys = [...byPathA.keys()].filter(key => byPathB.has(key));
    if (input.signals !== undefined) {
        const wanted = new Set(String(input.signals).split(',').map(name => name.trim()).filter(Boolean));
        // 键含向量 range 后缀（如 tb.q[7:0]），短名匹配先剥掉再比较。
        const strip = key => key.replace(/\[[^\]]*\]$/, '');
        keys = keys.filter(key => wanted.has(key) || wanted.has(strip(key))
            || [...wanted].some(name => strip(key) === name || strip(key).endsWith('.' + name)));
        if (!keys.length) fail('SIGNAL_NOT_FOUND', '两份 VCD 中没有可比对的指定信号', { signals: input.signals });
    }
    if (!keys.length) fail('SIGNAL_NOT_FOUND', '两份 VCD 没有同名信号可比较');
    const end = Math.min(traceA.meta.endTime, traceB.meta.endTime);
    const to = parseTick(traceA, input.to ?? end, '--to');
    const from = input.from === undefined ? 0 : parseTick(traceA, input.from, '--from');
    if (from >= to) fail('INVALID_ARGUMENT', '--from 必须早于 --to');
    const limit = Math.min(input.limit || 50, 1000);
    const diffs = [];
    let first = null, totalSignals = 0, totalDiffs = 0, truncated = false;
    for (const key of keys) {
        const a = traceA.store.signals.get(byPathA.get(key).id), b = traceB.store.signals.get(byPathB.get(key).id);
        const width = Math.max(byPathA.get(key).width, byPathB.get(key).width);
        let indexA = a.upperBound(from) - 1, indexB = b.upperBound(from) - 1;
        let valueA = indexA >= 0 ? a.event(indexA).value : null, valueB = indexB >= 0 ? b.event(indexB).value : null;
        let differing = model.binaryValue(valueA, width) !== model.binaryValue(valueB, width);
        let hadDifference = differing;
        let budget = Math.floor(MAX_DIFF_EVENTS / keys.length) + 1000;
        if (differing) {
            totalDiffs++;
            if (!first) first = { path: key, t: tickString(from), a: valueA, b: valueB };
            if (diffs.length < limit) diffs.push({ path: key, t: tickString(from), a: valueA, b: valueB });
        }
        while (budget-- > 0) {
            const timeA = indexA + 1 < a.length ? a.timeAt(indexA + 1) : Infinity;
            const timeB = indexB + 1 < b.length ? b.timeAt(indexB + 1) : Infinity;
            const time = Math.min(timeA, timeB);
            if (time > to || time === Infinity) break;
            if (timeA === time) { indexA++; valueA = a.event(indexA).value; }
            if (timeB === time) { indexB++; valueB = b.event(indexB).value; }
            const nowDiffering = model.binaryValue(valueA, width) !== model.binaryValue(valueB, width);
            if (nowDiffering !== differing) {
                if (nowDiffering) {
                    totalDiffs++;
                    hadDifference = true;
                    if (!first) first = { path: key, t: tickString(time), a: valueA, b: valueB };
                    if (diffs.length < limit) diffs.push({ path: key, t: tickString(time), a: valueA, b: valueB });
                }
                differing = nowDiffering;
            }
        }
        if (hadDifference) totalSignals++;
        if (budget <= 0) truncated = true;
    }
    return result('wave.diff', {
        file: traceA.file, against: traceB.file, from: tickString(from), to: tickString(to),
        timescale: traceA.meta.timescale || null, againstTimescale: traceB.meta.timescale || null,
        pairs: keys.length, totalDiffs, differingSignals: totalSignals, truncated,
        firstDiff: first, diffs, stats: { a: traceA.stats, b: traceB.stats }
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
    const request = (method, params) => Promise.resolve(trace.store[method](params));
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
