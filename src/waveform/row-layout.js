/* 行布局与动画几何是纯规则；控制器和 Canvas 共用同一坐标定义。 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WaveRowLayout = api;
})(typeof window === 'object' ? window : globalThis, function () {
    'use strict';
    const DIGITAL_HEIGHT = 38, DEFAULT_ANALOG_HEIGHT = 100, MIN_ANALOG_HEIGHT = 60, MAX_ANALOG_HEIGHT = 480;
    const RESIZE_HIT = 6, MOTION_MS = 180, SCROLL_EDGE = 40, SCROLL_SPEED = 600;

    /** @param {unknown} value @returns {number} 合法模拟量行高；无效保存值使用默认值。 */
    function analogHeight(value) {
        return typeof value === 'number' && Number.isFinite(value) && value > 0
            ? Math.round(Math.min(MAX_ANALOG_HEIGHT, Math.max(MIN_ANALOG_HEIGHT, value))) : DEFAULT_ANALOG_HEIGHT;
    }
    /** @param {object} signal @param {string|undefined} format @returns {boolean} 当前行是否为模拟量模式。 */
    function isAnalog(signal, format) { return format === 'analog' || !format && /real/i.test(signal.type); }

    /** @param {unknown} saved @param {Map<string,object>} signals @returns {Record<string,number>} 剔除失效键与非法行高。 */
    function restoreHeights(saved, signals) {
        const heights = Object.create(null);
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return heights;
        for (const [key, value] of Object.entries(saved)) {
            if (signals.has(key) && typeof value === 'number' && Number.isFinite(value) && value > 0) heights[key] = analogHeight(value);
        }
        return heights;
    }

    /** @param {string[]} order @param {Map<string,object>} signals @param {object} formats @param {object} heights @returns {object[]} 行坐标。 */
    function buildRows(order, signals, formats, heights) {
        let y = 0;
        return order.filter(key => signals.has(key)).map(key => {
            const signal = signals.get(key), analog = isAnalog(signal, formats[key]);
            const height = analog ? analogHeight(heights[key]) : DIGITAL_HEIGHT;
            const row = { key, signal, analog, y, height }; y += height; return row;
        });
    }
    /** @param {object[]} rows @returns {number} 已排布行的总高度。 */
    function totalHeight(rows) { const last = rows[rows.length - 1]; return last ? last.y + last.height : 0; }

    /** @param {object[]} rows @param {number} y @returns {object|undefined} 左闭右开命中，边界属于下一行。 */
    function rowAt(rows, y) {
        let low = 0, high = rows.length;
        while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].y + rows[middle].height <= y) low = middle + 1; else high = middle; }
        const row = rows[low]; return row && row.y <= y ? row : undefined;
    }

    /** @param {object[]} rows @param {number} y @returns {object|undefined} 模拟量底边两侧的命中带，数字行不响应。 */
    function resizeAt(rows, y) {
        const row = rowAt(rows, y), previous = rowAt(rows, y - RESIZE_HIT - 1);
        return [row, previous].find(candidate => candidate?.analog && Math.abs(candidate.y + candidate.height - y) <= RESIZE_HIT);
    }

    /** @param {object[]} rows @param {number} top @param {number} height @param {Map<string,number>|null} positions @returns {object[]} 可见行；动画时兼顾目标和插值位置。 */
    function visibleRows(rows, top, height, positions = null) {
        const bottom = top + height;
        return rows.flatMap(row => {
            const y = positions?.get(row.key) ?? row.y;
            return y < bottom && y + row.height > top || row.y < bottom && row.y + row.height > top
                ? [{ ...row, y }] : [];
        }).sort((a, b) => a.y - b.y);
    }

    /** @param {string[]} order @param {Iterable<string>} targets @param {number} slot @returns {string[]} 在剩余行的明确边界插入整个选择集。 */
    function insertBlock(order, targets, slot) {
        const chosen = new Set(targets), moving = order.filter(key => chosen.has(key)), rest = order.filter(key => !chosen.has(key));
        const index = Math.max(0, Math.min(rest.length, Number.isFinite(slot) ? Math.round(slot) : 0));
        return [...rest.slice(0, index), ...moving, ...rest.slice(index)];
    }

    /** @param {object[]} previewRows @param {Iterable<string>} targets @param {number} y @returns {number} 以未移动行的中点决定插入边界。 */
    function insertionSlot(previewRows, targets, y) {
        const chosen = new Set(targets);
        return previewRows.filter(row => !chosen.has(row.key) && row.y + row.height / 2 <= y).length;
    }

    /** @param {Map<string,number>} from @param {Map<string,number>} to @param {number} elapsed @param {number} duration @returns {{positions:Map<string,number>,done:boolean}} 三次缓出动画。 */
    function motionPositions(from, to, elapsed, duration = MOTION_MS) {
        const progress = duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 1, eased = 1 - (1 - progress) ** 3;
        return { positions: new Map([...to].map(([key, y]) => [key, (from.get(key) ?? y) + (y - (from.get(key) ?? y)) * eased])), done: progress === 1 };
    }

    /** @param {number} y @param {number} viewportHeight @returns {number} 边缘自动滚动速度（px/s），中间区域为零。 */
    function edgeScroll(y, viewportHeight) {
        const edge = Math.min(SCROLL_EDGE, viewportHeight / 3);
        if (edge <= 0) return 0;
        if (y < edge) return -SCROLL_SPEED * Math.min(1, (edge - y) / edge) ** 2;
        if (y > viewportHeight - edge) return SCROLL_SPEED * Math.min(1, (y - viewportHeight + edge) / edge) ** 2;
        return 0;
    }

    return { DIGITAL_HEIGHT, DEFAULT_ANALOG_HEIGHT, MIN_ANALOG_HEIGHT, MAX_ANALOG_HEIGHT, RESIZE_HIT, MOTION_MS,
        analogHeight, isAnalog, restoreHeights, buildRows, totalHeight, rowAt, resizeAt, visibleRows, insertBlock, insertionSlot, motionPositions, edgeScroll };
});
