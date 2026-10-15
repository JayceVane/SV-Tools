/* 存储器归并与有界分页规则；Node 和 webview 复用，不读取或复制事件序列。 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WaveMemory = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const MAX_PAGE_CELLS = 128;
    const DEFAULT_PAGE_COUNT = 8;

    /**
     * @typedef {object} MemoryGroup
     * @property {string} key 无歧义的 scope/name tuple。
     * @property {string} name 不含 unpacked 索引的名称。
     * @property {string} path 作用域内的存储器名称。
     * @property {number} width 每个 word 的位宽。
     * @property {1|2} dimensions unpacked 维数。
     * @property {number[]} rows 升序排列的实际地址，不扩展地址空洞。
     * @property {number[]} columns 升序排列的实际列地址；1D 固定为 [0]。
     * @property {Map<string, object>} cells JSON.stringify([row,column]) 到原始信号的映射。
     * @property {number} cellCount 实际 dump 的单元数量。
     */

    /** 只接受尾部一到两个整数索引；packed range 和更高维数组不猜测为地址。 */
    function memoryReference(signal) {
        const source = signal.referenceName ?? signal.name;
        if (typeof source !== 'string') return null;
        const reference = source.startsWith('\\') ? source.slice(1) : source;
        const match = reference.match(/^([^\[\]]+)((?:\[[+-]?\d+\])+)$/);
        if (!match) return null;
        const indices = Array.from(match[2].matchAll(/\[([+-]?\d+)\]/g), part => Number(part[1]));
        return { name: match[1], indices };
    }

    function signalScope(signal) {
        if (typeof signal.scopePath === 'string') return signal.scopePath;
        const path = signal.path || '';
        return path.endsWith('.' + signal.name) ? path.slice(0, -signal.name.length - 1) : '';
    }

    /** 只更新当前候选组；一旦冲突，最终归并会排除整组。 */
    function addCell(candidate, reference, signal) {
        const { group } = candidate;
        const row = reference.indices[0], column = reference.indices.length === 2 ? reference.indices[1] : 0;
        const coordinate = JSON.stringify([row, column]), previous = group.cells.get(coordinate);
        let conflict;
        if (!Number.isSafeInteger(signal.width) || signal.width < 1 || signal.width !== group.width) conflict = 'word 位宽不一致或无效';
        else if (reference.indices.length !== group.dimensions) conflict = '同名变量的 unpacked 维数不一致';
        else if (previous && (previous.id !== signal.id || (previous.range || '') !== (signal.range || ''))) conflict = '同坐标存在不同 ID 或 packed range';
        if (conflict) {
            candidate.conflict ||= { code: 'MEMORY_CONFLICT', key: group.key, path: group.path, row, column,
                signalPath: signal.path, previousPath: previous?.path, message: conflict };
        } else if (!previous) {
            group.cells.set(coordinate, signal);
            candidate.rows.add(row); candidate.columns.add(column);
        }
    }

    /**
     * 同坐标 ID/range 不同、维数或 word 位宽不一致时整组排除并返回诊断。
     * 同 ID 的不同地址仍是独立单元；同坐标的完全相同声明只保留一个引用。
     * @param {object[]} signals 已准备的 VCD 变量，packed 范围在 range/referenceName 元数据中。
     * @returns {{groups:MemoryGroup[],diagnostics:object[]}} 不修改 signals，也不构造未 dump 的单元。
     */
    function indexMemories(signals) {
        const candidates = new Map(), diagnostics = [];
        for (const signal of signals) {
            const reference = memoryReference(signal);
            if (!reference) continue;
            const scope = signalScope(signal);
            const key = JSON.stringify([scope, reference.name]);
            const path = scope ? scope + '.' + reference.name : reference.name;
            if (reference.indices.length > 2 || reference.indices.some(index => !Number.isSafeInteger(index))) {
                diagnostics.push({ code: 'MEMORY_INDEX', key, path, signalPath: signal.path,
                    message: reference.indices.length > 2 ? '只支持一维或二维 unpacked 索引' : '地址超出安全整数范围' });
                continue;
            }
            let candidate = candidates.get(key);
            if (!candidate) {
                const group = { key, name: reference.name, path, width: signal.width,
                    dimensions: reference.indices.length, rows: [], columns: [], cells: new Map(), cellCount: 0 };
                candidate = { group, rows: new Set(), columns: new Set(), conflict: null };
                candidates.set(key, candidate);
            }
            addCell(candidate, reference, signal);
        }
        const groups = [];
        for (const { group, rows, columns, conflict } of candidates.values()) {
            if (conflict) { diagnostics.push(conflict); continue; }
            group.rows = [...rows].sort((a, b) => a - b);
            group.columns = [...columns].sort((a, b) => a - b);
            group.cellCount = group.cells.size;
            if (group.cellCount) groups.push(group);
        }
        groups.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        return { groups, diagnostics };
    }

    function pageCount(value) {
        const count = value === undefined ? DEFAULT_PAGE_COUNT : value;
        if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PAGE_CELLS) {
            throw new RangeError('存储器分页数量必须为 1–' + MAX_PAGE_CELLS + ' 的整数');
        }
        return count;
    }
    function pageStart(value, length) {
        return Math.min(Math.max(0, length - 1), Math.max(0, Number.isSafeInteger(value) ? value : 0));
    }

    /**
     * start 是实际地址排序数组内的位置，非地址值；越界 start 夹在有效范围。
     * count 非正整数或请求乘积超过 128 时抛 RangeError；缺失单元 signal=null。
     * @param {MemoryGroup} group indexMemories 返回的存储器。
     * @param {{rowStart?:number,columnStart?:number,rowCount?:number,columnCount?:number}} [options]
     * @returns {{rows:number[],columns:number[],cells:object[],rowStart:number,columnStart:number}}
     */
    function memoryPage(group, { rowStart = 0, columnStart = 0, rowCount, columnCount } = {}) {
        const height = pageCount(rowCount), width = pageCount(columnCount);
        if (height * width > MAX_PAGE_CELLS) throw new RangeError('存储器每页最多 ' + MAX_PAGE_CELLS + ' 个单元');
        rowStart = pageStart(rowStart, group.rows.length);
        columnStart = pageStart(columnStart, group.columns.length);
        const rows = group.rows.slice(rowStart, rowStart + height);
        const columns = group.columns.slice(columnStart, columnStart + width);
        const cells = [];
        for (const row of rows) for (const column of columns) {
            cells.push({ row, column, signal: group.cells.get(JSON.stringify([row, column])) || null });
        }
        return { rows, columns, cells, rowStart, columnStart };
    }

    /** 规范化缩短的 VCD 向量，用 fill+body 比较避免分配 width 长的扩展字符串。 */
    function comparableValue(value, signal) {
        const raw = String(value).toLowerCase();
        if (/real/i.test(signal.type || '')) {
            const number = Number(raw);
            return raw.trim() && Number.isFinite(number) ? number : raw;
        }
        if (!/^[01xz]+$/.test(raw) || !Number.isSafeInteger(signal.width) || signal.width < raw.length) return raw;
        const fill = /^[xz]/.test(raw) ? raw[0] : '0';
        let index = 0;
        while (raw[index] === fill) index++;
        return fill + ':' + raw.slice(index);
    }

    /**
     * 比较原始位值，进制或 signed 显示方式不影响变化判定。X/Z 首位按 VCD 扩展。
     * @param {string|null|undefined} a A 游标的值。
     * @param {string|null|undefined} b B 游标的值。
     * @param {{width:number,type?:string}} signal word 声明。
     * @returns {boolean|null} 缺失初值返回 null，其余返回是否发生变化。
     */
    function compareMemoryValues(a, b, signal) {
        if (a === null || a === undefined || b === null || b === undefined) return null;
        return comparableValue(a, signal) !== comparableValue(b, signal);
    }
    return { indexMemories, memoryPage, compareMemoryValues };
});

