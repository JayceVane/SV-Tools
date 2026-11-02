'use strict';

const { bitValue } = require('./signal-display');
const { DEFAULT_LIMITS } = require('./parser');
const { CompositeEvents } = require('./composite-events');

const EVENT_CHUNK_MAX = 65536;
const VALUE_CHUNK_SIZE = 65536;
const BYTE_CHUNK_SIZE = 65536;
const SCALARS = ['0', '1', 'x', 'z'];
const DEFAULT_MAX_STORE_BYTES = 512 * 1024 * 1024;
const MAX_QUERY_IDS = 256;
const MAX_QUERY_PIXELS = 4096;
const MAX_QUERY_POINTS = 262144;
const MAX_CHANGES = 10000;
const MAX_SAMPLES = 4096;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;

function queryError(message, code = 'VCD_QUERY') {
    const error = new Error(message);
    error.code = code;
    return error;
}

/** 所有查询共享保守传输预算，在解码大值之前拒绝超限。 */
class ResponseBudget {
    constructor(maxBytes) { this.maxBytes = maxBytes; this.bytes = 32; }
    reserve(bytes) {
        this.bytes += bytes;
        if (this.bytes > this.maxBytes) {
            const limit = this.maxBytes >= 1048576 ? (this.maxBytes / 1048576).toFixed(2) + ' MiB' : this.maxBytes + ' 字节';
            throw queryError('VCD 查询响应超过 ' + limit + ' 预算，请减少信号或分批查询', 'VCD_RESOURCE_LIMIT');
        }
    }
    id(id) { this.reserve(Buffer.byteLength(JSON.stringify(id)) + 64); }
    value(length) { this.reserve(length * 2 + 64); }
}

/** 对 typed 分块和元数据作保守预算；超限时停止解析，避免把宿主拖入 OOM。 */
class StorageBudget {
    constructor(maxBytes) { this.maxBytes = maxBytes; this.bytes = 0; }
    reserve(bytes) {
        if (this.bytes + bytes > this.maxBytes) throw queryError('VCD 紧凑存储超过 ' + Math.round(this.maxBytes / 1048576) + ' MiB 上限，请缩小记录范围或提高显式预算', 'VCD_RESOURCE_LIMIT');
        this.bytes += bytes;
    }
}

/**
 * 标量使用固定码；向量以 2 bit/位存储，real 使用 ASCII 字节池。
 * 值描述符和载荷都是 typed chunks，不为每个值保留 JS 对象或字符串。
 */
class ValuePool {
    constructor(budget) {
        this.budget = budget;
        this.descriptors = [];
        this.bytes = [];
        this.valueCount = 0;
        this.byteCount = 0;
    }
    writeByte(value) {
        const chunkIndex = Math.floor(this.byteCount / BYTE_CHUNK_SIZE);
        if (!this.bytes[chunkIndex]) {
            this.budget.reserve(BYTE_CHUNK_SIZE);
            this.bytes.push(new Uint8Array(BYTE_CHUNK_SIZE));
        }
        this.bytes[chunkIndex][this.byteCount++ % BYTE_CHUNK_SIZE] = value;
    }
    byteAt(index) { return this.bytes[Math.floor(index / BYTE_CHUNK_SIZE)][index % BYTE_CHUNK_SIZE]; }
    add(value) {
        const scalar = SCALARS.indexOf(value);
        if (scalar >= 0) return scalar;
        const chunkIndex = Math.floor(this.valueCount / VALUE_CHUNK_SIZE);
        if (!this.descriptors[chunkIndex]) {
            this.budget.reserve(VALUE_CHUNK_SIZE * 9);
            this.descriptors.push({ offsets: new Uint32Array(VALUE_CHUNK_SIZE), lengths: new Uint32Array(VALUE_CHUNK_SIZE), kinds: new Uint8Array(VALUE_CHUNK_SIZE) });
        }
        const descriptor = this.descriptors[chunkIndex];
        const slot = this.valueCount % VALUE_CHUNK_SIZE;
        const isVector = /^[01xz]+$/.test(value);
        descriptor.offsets[slot] = this.byteCount;
        descriptor.lengths[slot] = value.length;
        descriptor.kinds[slot] = isVector ? 0 : 1;
        if (isVector) {
            for (let index = 0; index < value.length; index += 4) {
                let packed = 0;
                for (let bit = 0; bit < 4 && index + bit < value.length; bit++) {
                    const code = value.charCodeAt(index + bit);
                    const state = code === 48 ? 0 : code === 49 ? 1 : code === 120 ? 2 : 3;
                    packed |= state << (bit * 2);
                }
                this.writeByte(packed);
            }
        } else {
            for (let index = 0; index < value.length; index++) this.writeByte(value.charCodeAt(index));
        }
        return this.valueCount++ + SCALARS.length;
    }
    length(handle) {
        if (handle < SCALARS.length) return 1;
        const index = handle - SCALARS.length;
        return this.descriptors[Math.floor(index / VALUE_CHUNK_SIZE)].lengths[index % VALUE_CHUNK_SIZE];
    }
    /** @param {number} handle @param {number} offset @returns {string} 直接从2-bit载荷取位，不解码整条宽总线。 */
    bit(handle, offset) {
        if (handle < SCALARS.length) return bitValue(SCALARS[handle], offset);
        const index = handle - SCALARS.length, descriptor = this.descriptors[Math.floor(index / VALUE_CHUNK_SIZE)], slot = index % VALUE_CHUNK_SIZE;
        if (descriptor.kinds[slot] !== 0) throw queryError('该信号包含非位向量值，无法逐位导航');
        const start = descriptor.offsets[slot], position = descriptor.lengths[slot] - 1 - offset;
        const code = position >= 0 ? (this.byteAt(start + Math.floor(position / 4)) >> ((position % 4) * 2)) & 3 : this.byteAt(start) & 3;
        return SCALARS[position >= 0 || code >= 2 ? code : 0];
    }
    get(handle) {
        if (handle < SCALARS.length) return SCALARS[handle];
        const index = handle - SCALARS.length;
        const descriptor = this.descriptors[Math.floor(index / VALUE_CHUNK_SIZE)];
        const slot = index % VALUE_CHUNK_SIZE;
        const offset = descriptor.offsets[slot];
        const length = descriptor.lengths[slot];
        const parts = [];
        // 小块 ASCII 解码避免逐字符拼接产生与大值长度成比例的字符串 rope 节点。
        for (let base = 0; base < length; base += 4096) {
            const end = Math.min(base + 4096, length);
            const bytes = Buffer.allocUnsafe(end - base);
            for (let position = base; position < end; position++) {
                bytes[position - base] = descriptor.kinds[slot] === 0
                    ? SCALARS[(this.byteAt(offset + Math.floor(position / 4)) >> ((position % 4) * 2)) & 3].charCodeAt(0)
                    : this.byteAt(offset + position);
            }
            parts.push(bytes.toString('ascii'));
        }
        return parts.join('');
    }
}

/** 每个 id 保存时间和值 handle；alias 不创建第二份数据。 */
class SignalEvents {
    constructor(variable, budget, values) {
        this.width = variable.width;
        this.type = variable.type || 'wire';
        this.budget = budget;
        this.values = values;
        this.chunks = [];
        this.length = 0;
        this.lastValue = null;
    }
    chunkForIndex(index) {
        let left = 0;
        let right = this.chunks.length;
        while (left < right) {
            const middle = (left + right) >>> 1;
            if (this.chunks[middle].start <= index) left = middle + 1;
            else right = middle;
        }
        return this.chunks[left - 1];
    }
    event(index) {
        const chunk = this.chunkForIndex(index);
        const slot = index - chunk.start;
        return { t: chunk.times[slot], value: this.values.get(chunk.values[slot]) };
    }
    bitAt(index, offset) {
        const chunk = this.chunkForIndex(index);
        return this.values.bit(chunk.values[index - chunk.start], offset);
    }
    valueLengthAt(index) {
        const chunk = this.chunkForIndex(index);
        return this.values.length(chunk.values[index - chunk.start]);
    }
    timeAt(index) {
        const chunk = this.chunkForIndex(index);
        return chunk.times[index - chunk.start];
    }
    semanticValue(value) {
        if (this.type === 'real' || this.type === 'realtime') return String(Number(value));
        if (this.width === 1 && value.length === 1 && SCALARS.includes(value)) return value;
        if (/^[01xz]+$/.test(value)) {
            if (value.length > this.width) throw queryError('VCD 向量超过声明位宽：' + value.length + ' > ' + this.width, 'VCD_PARSE');
            const fill = value[0] === 'x' ? 'x' : value[0] === 'z' ? 'z' : '0';
            const leading = fill === 'x' ? /^x+(?=.)/ : fill === 'z' ? /^z+(?=.)/ : /^0+(?=.)/;
            return fill + ':' + value.replace(leading, '');
        }
        return value;
    }
    append(time, value) {
        const semantic = this.semanticValue(value);
        if (semantic === this.lastValue) return 0;
        if (this.length && this.timeAt(this.length - 1) === time) {
            const chunk = this.chunkForIndex(this.length - 1);
            if (this.length > 1 && this.semanticValue(this.event(this.length - 2).value) === semantic) {
                chunk.length--;
                this.length--;
                // 回退的空 chunk 留作后续复用，不重复计入预算。
                this.lastValue = semantic;
                return -1;
            }
            chunk.values[this.length - 1 - chunk.start] = this.values.add(value);
            this.lastValue = semantic;
            return 0;
        }
        let chunk = this.chunks[this.chunks.length - 1];
        if (!chunk || chunk.length === chunk.times.length) {
            const capacity = chunk ? Math.min(chunk.times.length * 4, EVENT_CHUNK_MAX) : 64;
            this.budget.reserve(capacity * 12);
            chunk = { start: this.length, length: 0, times: new Float64Array(capacity), values: new Uint32Array(capacity) };
            this.chunks.push(chunk);
        }
        chunk.times[chunk.length] = time;
        chunk.values[chunk.length++] = this.values.add(value);
        this.length++;
        this.lastValue = semantic;
        return 1;
    }
    /** 返回第一个 timeAt(index) > time 的事件索引。 */
    upperBound(time) {
        let left = 0;
        let right = this.length;
        while (left < right) {
            const middle = (left + right) >>> 1;
            if (this.timeAt(middle) <= time) left = middle + 1;
            else right = middle;
        }
        return left;
    }
}

/** @param {object} [options] 保留完整事件，查询时才按像素限制传输。 */
class VcdStore {
    constructor({ maxStoreBytes = DEFAULT_MAX_STORE_BYTES, maxResponseBytes = MAX_RESULT_BYTES, maxBitEdgeScan = 100000 } = {}) {
        if (!Number.isSafeInteger(maxStoreBytes) || maxStoreBytes <= 0 || maxStoreBytes > 0xffffffff) throw queryError('非法 VCD 存储预算');
        if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 32 || maxResponseBytes > MAX_RESULT_BYTES) throw queryError('非法 VCD 响应预算', 'VCD_RESOURCE_LIMIT');
        if (!Number.isSafeInteger(maxBitEdgeScan) || maxBitEdgeScan < 1 || maxBitEdgeScan > 1000000) throw queryError('非法位边沿扫描预算');
        this.maxBitEdgeScan = maxBitEdgeScan;
        this.maxResponseBytes = maxResponseBytes;
        this.budget = new StorageBudget(maxStoreBytes);
        this.valuesPool = new ValuePool(this.budget);
        this.signals = new Map();
        this.composites = new Map();
        this.eventCount = 0;
        this.rawEventCount = 0;
    }
    register(variable) {
        if (!Number.isSafeInteger(variable.width) || variable.width < 1 || variable.width > DEFAULT_LIMITS.maxSignalWidth) throw queryError('VCD 声明位宽超过安全上限', 'VCD_RESOURCE_LIMIT');
        this.budget.reserve(256 + 2 * (variable.name.length + variable.path.length + variable.id.length));
        const existing = this.signals.get(variable.id);
        if (existing && existing.width !== variable.width) throw queryError('同 id alias 的位宽不一致：' + variable.id, 'VCD_PARSE');
        if (!existing) this.signals.set(variable.id, new SignalEvents(variable, this.budget, this.valuesPool));
    }
    add(id, time, value) {
        if (typeof value !== 'string' || value.length > DEFAULT_LIMITS.maxSignalWidth) throw queryError('VCD 值超过安全长度', 'VCD_RESOURCE_LIMIT');
        this.rawEventCount++;
        this.eventCount += this.signals.get(id).append(time, value);
    }
    compose(ids) {
        const key = JSON.stringify(ids);
        if (this.composites.has(key)) return this.composites.get(key);
        const members = ids.map(id => this.signals.get(id));
        if (members.some(member => !member || member.width !== 1)) throw queryError('合并总线需要标量来源');
        this.budget.reserve(256 + key.length * 2 + ids.length * 64);
        const signal = new CompositeEvents(members, this.budget), id = '\0bus:' + this.composites.size;
        this.signals.set(id, signal); this.composites.set(key, id); return id;
    }
    metadata(parsed, fileBytes) {
        return { ...parsed, vars: parsed.vars.map(variable => ({ ...variable, changeCount: this.signals.get(variable.id).length })),
            eventCount: this.eventCount, rawEventCount: this.rawEventCount, fileBytes, storageBytes: this.budget.bytes };
    }
    queryIds(ids) {
        if (!Array.isArray(ids) || ids.length > MAX_QUERY_IDS || ids.some(id => typeof id !== 'string')) throw queryError('查询 ids 必须为最多 ' + MAX_QUERY_IDS + ' 个信号 id');
        return [...new Set(ids)];
    }
    checkTime(time) {
        if (!Number.isFinite(time) || time < 0 || time > Number.MAX_SAFE_INTEGER) throw queryError('查询时间必须是非负有限数值');
    }
    /** 窗口枚举的时间界：from 为左开（上一页最后事件时间），-1 覆盖首事件。 */
    checkRange(from, to, limit, maximum, label) {
        this.checkTime(to);
        if (!Number.isFinite(from) || from < -1 || from >= to) throw queryError(label + ' 的 from 必须为 -1 到 to 之间的开区间下界');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw queryError(label + ' 的 limit 必须为 1–' + maximum + ' 的整数');
    }
    window({ ids, start, end, pixels }) {
        ids = this.queryIds(ids);
        this.checkTime(start);
        this.checkTime(end);
        if (end < start || !Number.isInteger(pixels) || pixels < 1 || pixels > MAX_QUERY_PIXELS || ids.length * pixels > MAX_QUERY_POINTS) throw queryError('视窗范围或像素预算无效，请减少同时显示的信号或像素数');
        const response = new ResponseBudget(this.maxResponseBytes);
        const series = ids.map(id => {
            response.id(id);
            const signal = this.signals.get(id);
            const changes = [];
            const dense = [];
            const push = index => {
                response.value(signal.valueLengthAt(index));
                const event = signal.event(index);
                changes.push(event);
                return event;
            };
            if (!signal || !signal.length) return { id, changes, dense };
            let left = signal.upperBound(start);
            if (left) push(left - 1);
            if (end === start) return { id, changes, dense };
            for (let bucket = 0; bucket < pixels; bucket++) {
                const boundary = bucket === pixels - 1 ? end : start + (end - start) * (bucket + 1) / pixels;
                const right = signal.upperBound(boundary);
                const count = right - left;
                if (count) {
                    const first = push(left);
                    if (count > 1) {
                        const last = push(right - 1);
                        if (count > 2) {
                            response.reserve(128);
                            dense.push({ start: first.t, end: last.t, count });
                        }
                    }
                }
                left = right;
            }
            return { id, changes, dense };
        });
        return { series };
    }
    values({ ids, time }) {
        this.checkTime(time);
        const values = Object.create(null);
        const response = new ResponseBudget(this.maxResponseBytes);
        for (const id of this.queryIds(ids)) {
            response.id(id);
            const signal = this.signals.get(id);
            const index = signal ? signal.upperBound(time) - 1 : -1;
            if (index >= 0) response.value(signal.valueLengthAt(index));
            else response.reserve(16);
            values[id] = index >= 0 ? signal.event(index).value : null;
        }
        return { values };
    }
    /** 窗口内全保真跳变枚举（与按像素降采样的 window 互补）：返回 t 满足 from < t <= to 的事件，
     * 每信号最多 limit 条；total 为窗口内总数，next 为下一页应传的 from（最后返回事件时间），无更多时为 null。 */
    changes({ ids, from = -1, to, limit = 200 }) {
        ids = this.queryIds(ids);
        this.checkRange(from, to, limit, MAX_CHANGES, 'changes');
        const response = new ResponseBudget(this.maxResponseBytes);
        const series = ids.map(id => {
            response.id(id);
            const signal = this.signals.get(id);
            if (!signal || !signal.length) return { id, total: 0, events: [], next: null };
            const first = signal.upperBound(from);
            const last = signal.upperBound(to);
            const end = Math.min(last, first + limit);
            const events = [];
            for (let index = first; index < end; index++) {
                response.value(signal.valueLengthAt(index));
                const event = signal.event(index);
                events.push({ t: event.t, value: event.value });
            }
            return { id, total: last - first, events, next: end < last ? signal.timeAt(end - 1) : null };
        });
        return { series };
    }

    /** 指定时钟边沿采样：clock 必须为 1 位标量信号，X/Z 不构成沿；每个命中沿时刻读取 ids 的左闭值。
     * next 为下一页应传的 from（最后采样时刻），total 为窗口内沿总数。 */
    sample({ clock, edge = 'rise', ids, from = -1, to, limit = 256 }) {
        if (typeof clock !== 'string') throw queryError('采样需要时钟信号 id');
        if (!['rise', 'fall', 'both'].includes(edge)) throw queryError('采样边沿必须为 rise、fall 或 both');
        ids = this.queryIds(ids);
        this.checkRange(from, to, limit, MAX_SAMPLES, 'sample');
        const clockSignal = this.signals.get(clock);
        if (!clockSignal) throw queryError('时钟信号不存在：' + clock);
        if (clockSignal.width !== 1) throw queryError('采样时钟必须是 1 位标量信号');
        const response = new ResponseBudget(this.maxResponseBytes);
        for (const id of ids) response.id(id);
        const samples = [];
        let total = 0, previous = null;
        const first = clockSignal.upperBound(from), last = clockSignal.upperBound(to);
        const initial = first - 1;
        if (initial >= 0) previous = clockSignal.event(initial).value;
        for (let index = first; index < last; index++) {
            const value = clockSignal.event(index).value;
            const rising = previous === '0' && value === '1';
            const falling = previous === '1' && value === '0';
            previous = value;
            if (!(edge === 'rise' ? rising : edge === 'fall' ? falling : rising || falling)) continue;
            total++;
            if (samples.length >= limit) continue;
            const t = clockSignal.timeAt(index);
            const values = Object.create(null);
            for (const id of ids) {
                const signal = this.signals.get(id);
                const at = signal ? signal.upperBound(t) - 1 : -1;
                if (at >= 0) response.value(signal.valueLengthAt(at));
                else response.reserve(16);
                values[id] = at >= 0 ? signal.event(at).value : null;
            }
            samples.push({ t, values });
        }
        return { clock, edge, total, samples, next: total > samples.length && samples.length ? samples[samples.length - 1].t : null };
    }

    edge({ id, time, direction, bitOffset, bitWidth = 1, continuation }) {
        this.checkTime(time);
        if (typeof id !== 'string') throw queryError('边沿查询需要信号 id');
        const next = direction === 'next' || direction === 'forward' || direction === 1;
        const previous = direction === 'previous' || direction === 'backward' || direction === -1;
        if (!next && !previous) throw queryError('边沿方向必须为 next 或 previous');
        const signal = this.signals.get(id);
        if (!signal) return { time: null, value: null };
        let index = signal.upperBound(time);
        if (previous) {
            index--;
            if (index >= 0 && signal.timeAt(index) === time) index--;
        }
        if (bitOffset !== undefined) {
            if (!Number.isSafeInteger(bitOffset) || bitOffset < 0 || !Number.isSafeInteger(bitWidth) || bitWidth < 1 || bitOffset + bitWidth > signal.width || /real|string/i.test(signal.type)) throw queryError('位边沿下标无效');
            const bound = index;
            if (continuation !== undefined) {
                if (!Number.isSafeInteger(continuation) || continuation < 0 || continuation >= signal.length
                    || (next ? continuation < bound : continuation > bound)) throw queryError('位边沿续查位置无效');
                index = continuation;
            }
            const at = signal.upperBound(time) - 1;
            const budget = new ResponseBudget(this.maxResponseBytes); budget.value(bitWidth);
            const read = index => {
                if (index < 0) return null;
                if (bitWidth === 1) return signal.bitAt(index, bitOffset);
                const parts = [];
                for (let base = 0; base < bitWidth; base += 4096) {
                    const bytes = Buffer.allocUnsafe(Math.min(4096, bitWidth - base));
                    for (let bit = 0; bit < bytes.length; bit++) bytes[bit] = signal.bitAt(index, bitOffset + bitWidth - 1 - base - bit).charCodeAt(0);
                    parts.push(bytes.toString('ascii'));
                }
                return parts.join('');
            };
            const initial = read(at), scanLimit = Math.max(1, Math.floor(this.maxBitEdgeScan / bitWidth));
            for (let scanned = 0; index >= 0 && index < signal.length; scanned++, index += next ? 1 : -1) {
                if (scanned >= scanLimit) return { time: null, value: null, continuation: index };
                const value = read(index);
                const before = next ? initial : read(index - 1);
                if (value !== before) return { time: signal.timeAt(index), value };
            }
            return { time: null, value: null };
        }
        if (index < 0 || index >= signal.length) return { time: null, value: null };
        const response = new ResponseBudget(this.maxResponseBytes);
        response.value(signal.valueLengthAt(index));
        const event = signal.event(index);
        return { time: event.t, value: event.value };
    }

    /** @returns {object} 序列化视图：vars 由调用方（parser 元数据）持有，这里只存事件结构与值池。 */
    describeSnapshot() {
        return {
            budgetBytes: this.budget.bytes, eventCount: this.eventCount, rawEventCount: this.rawEventCount,
            pool: { valueCount: this.valuesPool.valueCount, byteCount: this.valuesPool.byteCount,
                descriptors: this.valuesPool.descriptors.map(chunk => ({ count: chunk.offsets.length })) },
            signals: [...this.signals.entries()].map(([id, signal]) => ({ id, width: signal.width, type: signal.type, length: signal.length,
                chunks: signal.chunks.map(chunk => ({ start: chunk.start, length: chunk.length, capacity: chunk.times.length })) }))
        };
    }

    /** 把当前事件存储与值池序列化为单个 Buffer；typed 数组按 8 字节对齐排布，反序列化可直接建立零拷贝视图。 */
    snapshot() {
        const blocks = [];
        let length = 0;
        const align = () => { const pad = (8 - length % 8) % 8; if (pad) { blocks.push(Buffer.alloc(pad)); length += pad; } };
        const push = (typed, bytesPerElement) => {
            align();
            blocks.push(Buffer.from(typed.buffer, typed.byteOffset, typed.length * bytesPerElement));
            length += typed.length * bytesPerElement;
            return { offset: length - typed.length * bytesPerElement, count: typed.length };
        };
        const layout = { pool: { descriptors: [] }, bytes: [], signals: [] };
        for (const chunk of this.valuesPool.descriptors) {
            layout.pool.descriptors.push({ offsets: push(chunk.offsets, 4), lengths: push(chunk.lengths, 4), kinds: push(chunk.kinds, 1) });
        }
        for (const chunk of this.valuesPool.bytes) layout.bytes.push(push(chunk, 1));
        for (const signal of this.signals.values()) {
            const entry = [];
            for (const chunk of signal.chunks) entry.push({ start: chunk.start, length: chunk.length, times: push(chunk.times, 8), values: push(chunk.values, 4) });
            layout.signals.push(entry);
        }
        // 头部用空格补齐到 8 字节倍数，使数据段绝对偏移始终 8 对齐，反序列化可零拷贝建视图。
        const json = JSON.stringify({ v: 1, ...this.describeSnapshot(), layout });
        const headerLength = (Buffer.byteLength(json, 'utf8') + 7) & ~7;
        const header = Buffer.alloc(headerLength, 0x20);
        header.write(json, 0, 'utf8');
        const prefix = Buffer.alloc(8);
        prefix.write('SVTW', 0, 'ascii'); prefix.writeUInt32LE(headerLength, 4);
        const total = 8 + headerLength + length;
        let cursor = 0;
        const out = Buffer.allocUnsafe((total + 7) & ~7);
        for (const block of [prefix, header, ...blocks]) { block.copy(out, cursor); cursor += block.length; }
        return out;
    }

    /** 从快照恢复事件存储（零拷贝视图）；结构与 magic/version 不匹配时拒绝。 */
    static loadSnapshot(buffer, variables) {
        if (buffer.length < 8 || buffer.toString('ascii', 0, 4) !== 'SVTW') throw queryError('不是 SV Tools 波形索引快照', 'VCD_SNAPSHOT');
        const headerLength = buffer.readUInt32LE(4);
        if (8 + headerLength > buffer.length) throw queryError('波形索引快照头不完整', 'VCD_SNAPSHOT');
        let header;
        try { header = JSON.parse(buffer.toString('utf8', 8, 8 + headerLength)); }
        catch { throw queryError('波形索引快照头损坏', 'VCD_SNAPSHOT'); }
        if (header.v !== 1) throw queryError('不支持的波形索引快照版本：' + header.v, 'VCD_SNAPSHOT');
        const base = 8 + headerLength;
        const view = (elementBytes, spot) => {
            const offset = base + spot.offset, count = spot.count, bytes = count * elementBytes;
            if (offset % elementBytes || offset + bytes > buffer.length) throw queryError('波形索引快照数据段越界', 'VCD_SNAPSHOT');
            const kind = elementBytes === 8 ? Float64Array : elementBytes === 4 ? Uint32Array : Uint8Array;
            // buffer 自身已按元素对齐时直接共享底层数组；否则复制进新分配的对齐数组。
            if ((buffer.byteOffset + offset) % elementBytes === 0) return new kind(buffer.buffer, buffer.byteOffset + offset, count);
            const copy = new kind(count);
            Buffer.from(copy.buffer, 0, bytes).set(buffer.subarray(offset, offset + bytes));
            return copy;
        };
        const store = new VcdStore({ maxStoreBytes: header.budgetBytes, maxResponseBytes: MAX_RESULT_BYTES, maxBitEdgeScan: 100000 });
        store.budget.bytes = header.budgetBytes;
        store.eventCount = header.eventCount;
        store.rawEventCount = header.rawEventCount;
        const pool = store.valuesPool;
        pool.valueCount = header.pool.valueCount;
        pool.byteCount = header.pool.byteCount;
        pool.descriptors = header.layout.pool.descriptors.map(spots => ({
            offsets: view(4, spots.offsets), lengths: view(4, spots.lengths), kinds: view(1, spots.kinds)
        }));
        pool.bytes = header.layout.bytes.map(spot => view(1, spot));
        for (const [index, record] of header.signals.entries()) {
            const signal = new SignalEvents({ width: record.width, type: record.type }, store.budget, pool);
            signal.length = record.length;
            signal.chunks = header.layout.signals[index].map(chunk => ({
                start: chunk.start, length: chunk.length,
                times: view(8, chunk.times), values: view(4, chunk.values)
            }));
            signal.lastValue = signal.length ? signal.semanticValue(signal.event(signal.length - 1).value) : null;
            const existing = store.signals.get(record.id);
            if (existing) { if (existing.width !== record.width) throw queryError('同 id alias 的位宽不一致：' + record.id, 'VCD_PARSE'); }
            else store.signals.set(record.id, signal);
        }
        if (variables) for (const variable of variables) if (!store.signals.has(variable.id)) store.register(variable);
        return store;
    }
}

module.exports = { VcdStore };
