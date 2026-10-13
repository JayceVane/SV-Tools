/* 纯视图规则；Node 合同测试与 webview 复用同一实现。 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WaveModel = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const units = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 };
    const MAX_FORMAT_BITS = 65536;

    /** @returns {{start:number,span:number}} 视口始终落在文件范围，最小一 tick。 */
    function clampView(start, span, end) {
        const limit = Math.max(1, end || 0);
        const width = Math.min(limit, Math.max(1, Number.isFinite(span) ? span : limit));
        return { start: Math.min(limit - width, Math.max(0, Number.isFinite(start) ? start : 0)), span: width };
    }

    /** 保持鼠标锚点所指的时间不变；factor < 1 放大。 */
    function zoomView(view, factor, anchor, end) {
        const ratio = Math.min(1, Math.max(0, anchor));
        const span = Math.max(1, view.span * factor);
        return clampView(view.start + (view.span - span) * ratio, span, end);
    }

    /** 无 timescale 时显示 ticks，不猜测时间单位。 */
    function formatTime(ticks, secondsPerTick) {
        if (ticks === null || !Number.isFinite(ticks)) return '—';
        if (!secondsPerTick) return `${Number.isInteger(ticks) ? ticks : Number(ticks.toPrecision(12))} ticks`;
        const seconds = ticks * secondsPerTick;
        const unit = Object.keys(units).find(name => Math.abs(seconds || secondsPerTick) >= units[name]) || 'fs';
        const ratio = units[unit] / secondsPerTick;
        const exponent = Math.round(Math.log10(ratio));
        // 标准十进制 timescale 使用整数除法，长捕获的 ns/fs 不丢有效位。
        if (Number.isInteger(ticks) && Number.isFinite(exponent) && Math.abs(ratio / 10 ** exponent - 1) < 1e-10) {
            const value = BigInt(Math.abs(ticks)), sign = ticks < 0 ? '-' : '';
            if (exponent < 0) return `${sign}${value * 10n ** BigInt(-exponent)} ${unit}`;
            const divisor = 10n ** BigInt(exponent);
            const fraction = (value % divisor).toString().padStart(exponent, '0').replace(/0+$/, '');
            return `${sign}${value / divisor}${fraction ? '.' + fraction : ''} ${unit}`;
        }
        return `${Number((seconds / units[unit]).toPrecision(15))} ${unit}`;
    }

    /** 裸数字为 ticks；物理单位要求已知 timescale。非法输入返回 null。 */
    function parseTime(text, secondsPerTick) {
        const match = String(text).trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(ticks?|s|ms|us|ns|ps|fs)?$/i);
        if (!match) return null;
        const unit = (match[2] || 'ticks').toLowerCase();
        if (!unit.startsWith('tick') && !secondsPerTick) return null;
        const time = Number(match[1]) * (unit.startsWith('tick') ? 1 : units[unit] / secondsPerTick);
        return Number.isFinite(time) && time >= 0 && time <= Number.MAX_SAFE_INTEGER ? Math.round(time) : null;
    }

    /** 缩短向量零扩展；首字符为 X/Z 时用同状态扩展。 */
    function binaryValue(value, width) {
        const raw = String(value).toLowerCase();
        if (!/^[01xz]+$/.test(raw)) return null;
        return raw.padStart(Math.max(1, width), /^[xz]/.test(raw) ? raw[0] : '0');
    }

    /** 宽总线用 BigInt，X/Z 保持可见，signed 按声明宽度二补码解释。 */
    function formatValue(value, signal, radix = 'hex') {
        if (value === null || value === undefined) return '—';
        if (/real/i.test(signal.type)) return String(value);
        if (signal.width > MAX_FORMAT_BITS) return `${signal.width}b VCD ${String(value).slice(0, 64)}${String(value).length > 64 ? '…' : ''}`;
        const bits = binaryValue(value, signal.width);
        if (!bits) return String(value);
        if (radix === 'bin' || (signal.width === 1 && radix !== 'sdec')) return bits;
        if (/[xz]/.test(bits)) {
            if (radix !== 'hex') return bits.includes('x') ? 'X' : 'Z';
            const nibbles = bits.padStart(Math.ceil(bits.length / 4) * 4, /^[xz]/.test(bits) ? bits[0] : '0');
            return '0x' + nibbles.match(/.{4}/g).map(part => part.includes('x') ? 'x' : part.includes('z') ? 'z' : parseInt(part, 2).toString(16)).join('').toUpperCase();
        }
        const number = BigInt('0b' + bits);
        if (radix === 'dec' || radix === 'analog') return number.toString();
        if (radix === 'sdec') return BigInt.asIntN(signal.width, number).toString();
        return '0x' + number.toString(16).toUpperCase().padStart(Math.ceil(signal.width / 4), '0');
    }

    /** 左闭取值；不存在初始化值时返回 null，仅用于已返回视口数据。 */
    function valueAt(changes, time) {
        let low = 0, high = changes.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (changes[mid].t <= time) low = mid + 1;
            else high = mid;
        }
        return low ? changes[low - 1].value : null;
    }

    /** 保留 alias 路径；常量开关不隐藏稳定线网。 */
    function filterSignals(signals, query, scope, showConstants) {
        const needle = query.toLowerCase().trim();
        return signals.filter(signal => (showConstants || !/^(spec)?parameter$/i.test(signal.type))
            && (!scope || signal.scopePath === scope || signal.scopePath.startsWith(scope + '.'))
            && (!needle || (signal.path + (signal.range || '')).toLowerCase().includes(needle)));
    }

    /** 人类可读 path 保持原文；同名切片用无歧义 tuple 标识独立视图行。 */
    function prepareSignals(signals) {
        const counts = new Map();
        for (const signal of signals) counts.set(signal.path, (counts.get(signal.path) || 0) + 1);
        return signals.map(signal => ({ ...signal, key: counts.get(signal.path) > 1
            ? JSON.stringify([signal.path, signal.id, signal.range || '']) : signal.path }));
    }
    function signalKey(signal) { return signal.key || signal.path; }

    /** 文件变化后剔除失效信号并约束恢复视口。 */
    function restoreState(saved, metadata, fileKey) {
        const paths = new Set(metadata.vars.map(signalKey));
        const valid = saved && saved.fileKey === fileKey ? saved : {};
        const selected = Array.isArray(valid.selected) ? [...new Set(valid.selected.filter(path => paths.has(path)))] : [];
        return { selected, view: clampView(valid.start || 0, valid.span || Math.max(1, metadata.endTime), metadata.endTime),
            cursorA: Number.isFinite(valid.cursorA) ? Math.min(metadata.endTime, Math.max(0, valid.cursorA)) : 0,
            cursorB: Number.isFinite(valid.cursorB) ? Math.min(metadata.endTime, Math.max(0, valid.cursorB)) : null };
    }
    return { clampView, zoomView, formatTime, parseTime, binaryValue, formatValue, valueAt, filterSignals, prepareSignals, signalKey, restoreState };
});
