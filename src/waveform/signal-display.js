/* 信号展示事实：颜色目录、逐位投影和方向图标；不复制完整事件存储。 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WaveSignalDisplay = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const MAX_TRACKS = 2000;
    const HIGHLIGHTS = Object.freeze([
        { id: 'rose', label: '玫红', color: '#d64c79' }, { id: 'amber', label: '琥珀', color: '#cd870b' },
        { id: 'lime', label: '草绿', color: '#669b20' }, { id: 'teal', label: '青绿', color: '#139d91' },
        { id: 'sky', label: '天蓝', color: '#1684d6' }, { id: 'violet', label: '紫色', color: '#9560ce' }
    ].map(Object.freeze));
    const colorMap = new Map(HIGHLIGHTS.map(item => [item.id, item.color]));
    const ROLES = {
        input: { label: '输入端口', glyph: '→', paths: [[[1,6],[11,6]],[[7,2],[11,6],[7,10]],[[12,1],[12,11]]] },
        output: { label: '输出端口', glyph: '←', paths: [[[2,6],[12,6]],[[6,2],[2,6],[6,10]],[[1,1],[1,11]]] },
        inout: { label: '双向端口', glyph: '↔', paths: [[[1,6],[13,6]],[[4,3],[1,6],[4,9]],[[10,3],[13,6],[10,9]]] },
        internal: { label: '内部信号', glyph: '◇', paths: [[[1,6],[4,2],[10,2],[13,6],[10,10],[4,10],[1,6]]] },
        unknown: { label: '方向未知', glyph: '?', paths: [[[7,1],[13,6],[7,11],[1,6],[7,1]]] }
    };
    /** @param {string} id @returns {string|null} 颜色只允许本地登记项。 */
    function highlightColor(id) { return colorMap.get(id) || null; }
    /** @param {unknown} saved @param {Map<string,object>} signals @returns {object} 清理无效/失效行，拒绝任意CSS。 */
    function restoreHighlights(saved, signals) {
        const result = Object.create(null);
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [key, id] of Object.entries(saved)) {
            if (signals.has(key) && highlightColor(id)) result[key] = id;
        }
        return result;
    }
    /** @param {object} signal @returns {object} 图标只表达已确认的角色；wire/reg本身不能决定方向。 */
    function roleInfo(signal) {
        const role = Object.hasOwn(ROLES, signal.role) ? signal.role : 'unknown';
        const info = ROLES[role];
        return { ...info, role, label: info.label + ' · ' + signal.type + (signal.roleSource ? ' · ' + signal.roleSource : ' · 缺少匹配RTL') };
    }
    /** @param {object} signal @returns {boolean} 只展开多位数字信号，real与派生位不能再展开。 */
    function isBus(signal) { return !!signal && !Number.isInteger(signal.bitOffset) && signal.width > 1 && !/real|string/i.test(signal.type); }
    /** @param {string|null|undefined} value @param {number} offset LSB起算。@returns {string|null} 常量时间投影，避免为宽向量补齐字符串。 */
    function bitValue(value, offset) {
        if (value === null || value === undefined) return null;
        const raw = String(value), index = raw.length - 1 - offset, first = raw[0]?.toLowerCase();
        return index >= 0 ? raw[index].toLowerCase() : first === 'x' || first === 'z' ? first : '0';
    }
    function bitSignal(parent, offset) {
        const key = parent.key || parent.path;
        const attached = !parent.name.startsWith('\\') && parent.name.match(/\[([+-]?\d+):([+-]?\d+)\]$/);
        const candidate = String(parent.range || (attached ? attached[0] : '')).match(/^\[([+-]?\d+):([+-]?\d+)\]$/);
        const range = candidate && Math.abs(Number(candidate[1]) - Number(candidate[2])) + 1 === parent.width ? candidate : null;
        const suffixLength = !parent.range && attached && range ? attached[0].length : 0;
        const name = suffixLength ? parent.name.slice(0, -suffixLength) : parent.name;
        const path = suffixLength ? parent.path.slice(0, -suffixLength) : parent.path;
        const right = range ? Number(range[2]) : 0, left = range ? Number(range[1]) : parent.width - 1;
        const index = right + (left >= right ? offset : -offset);
        return { ...parent, key: JSON.stringify(['$bit', key, offset]), name: name + '[' + index + ']',
            path: path + '[' + index + ']', range: undefined, width: 1, parentKey: key,
            bitOffset: offset, bitIndex: index, sourceWidth: parent.width, bitIndexSource: range ? '声明范围' : '位位置' };
    }
    /** @param {object} parent @param {number} [limit=2000] @returns {object[]} 声明左界到右界；先检查容量，再分配子行。 */
    function bitSignals(parent, limit = MAX_TRACKS) {
        if (!isBus(parent) || parent.width > limit) return [];
        return Array.from({ length: parent.width }, (_, index) => bitSignal(parent, parent.width - index - 1));
    }
    /** @param {string[]} keys @param {Map<string,object>} signals @param {number} limit @returns {void} 按保存的少量键懒恢复，不展开所有总线。 */
    function restoreBits(keys, signals, limit) {
        for (const key of (Array.isArray(keys) ? keys : []).slice(0, limit)) {
            if (typeof key !== 'string' || key.length > 131072 || signals.has(key) || key[0] !== '[') continue;
            let tuple;
            try { tuple = JSON.parse(key); } catch { continue; } // 用户旧状态不构成波形解析失败。
            if (!Array.isArray(tuple) || tuple.length !== 3 || tuple[0] !== '$bit') continue;
            const parent = signals.get(tuple[1]), offset = tuple[2];
            if (!isBus(parent) || !Number.isInteger(offset) || offset < 0 || offset >= parent.width) continue;
            const signal = bitSignal(parent, offset);
            if (signal.key === key) signals.set(key, signal);
        }
    }
    /** @param {object} series 有界窗口。@param {object} signal @returns {object} 位投影合并未变化值，保守保留原密集区；缓存由绘制器限制在当前可见行。 */
    function projectSeries(series, signal) {
        if (!Number.isInteger(signal.bitOffset)) return series;
        const changes = []; let previous;
        for (const change of series.changes) {
            const value = bitValue(change.value, signal.bitOffset);
            if (value !== previous) { changes.push({ t: change.t, value }); previous = value; }
        }
        return { changes, dense: series.dense };
    }
    return { MAX_TRACKS, HIGHLIGHTS, highlightColor, restoreHighlights, roleInfo, isBus, bitValue, bitSignals, restoreBits, projectSeries };
});
