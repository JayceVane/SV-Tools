/* 选择与排序以已添加行顺序为准，菜单操作使用打开时冻结的目标。 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WaveInteractions = api;
})(typeof window === 'object' ? window : globalThis, function () {
    'use strict';

    /** @param {string[]} order @param {Iterable<string>} keys @returns {string[]} 当前行顺序的有效选择。 */
    function orderedTargets(order, keys) {
        const selected = new Set(keys);
        return order.filter(key => selected.has(key));
    }

    /**
     * Shift 保留独立锚点；Ctrl/Meta+Shift 扩展选择，普通 Shift 替换范围。
     * @param {string[]} order @param {Iterable<string>} selected @param {string} key
     * @param {string|null} anchor @param {{shiftKey?:boolean,ctrlKey?:boolean,metaKey?:boolean}} modifiers
     * @returns {{keys:string[],anchor:string|null,activeKey:string|null}}
     */
    function selectSignals(order, selected, key, anchor, modifiers = {}) {
        if (!order.includes(key)) return { keys: orderedTargets(order, selected), anchor, activeKey: null };
        const additive = modifiers.ctrlKey || modifiers.metaKey;
        let keys = new Set(additive ? orderedTargets(order, selected) : []);
        if (modifiers.shiftKey) {
            anchor = order.includes(anchor) ? anchor : key;
            const first = order.indexOf(anchor), last = order.indexOf(key);
            for (const member of order.slice(Math.min(first, last), Math.max(first, last) + 1)) keys.add(member);
        } else {
            if (additive && keys.has(key)) keys.delete(key); else keys.add(key);
            anchor = key;
        }
        return { keys: orderedTargets(order, keys), anchor, activeKey: key };
    }

    /** @param {string[]} order @param {Iterable<string>} selected @param {string} key @param {string|null} anchor */
    function selectContextTargets(order, selected, key, anchor) {
        const keys = orderedTargets(order, selected);
        return keys.includes(key)
            ? { keys, anchor, activeKey: key }
            : selectSignals(order, [], key, anchor);
    }

    /** @param {string} name @returns {string} 合法分组名称；非法名称抛出 Error。 */
    function groupName(name) {
        const normalized = String(name).trim();
        if (!normalized) throw new Error('请输入分组名称');
        if (normalized.length > 80) throw new Error('分组名称最多 80 个字符');
        if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('分组名称不能含控制字符');
        return normalized;
    }

    /**
     * 加入已有组时合并整个组，保留原行顺序，在最早成员位置形成连续块。
     * @param {string[]} order @param {Record<string,string>} groups @param {Iterable<string>} targets @param {string} name
     * @returns {{order:string[],groups:Record<string,string>}}
     */
    function assignGroup(order, groups, targets, name) {
        const label = groupName(name), selected = new Set(orderedTargets(order, targets));
        const nextGroups = Object.assign(Object.create(null), groups);
        for (const key of selected) nextGroups[key] = label;
        if (!selected.size) return { order: order.slice(), groups: nextGroups };
        const members = order.filter(key => nextGroups[key] === label), block = new Set(members);
        const first = order.findIndex(key => block.has(key));
        const before = order.slice(0, first).filter(key => !block.has(key));
        const after = order.slice(first).filter(key => !block.has(key));
        return { order: [...before, ...members, ...after], groups: nextGroups };
    }

    /** @param {string[]} order @param {Iterable<string>} targets @param {string} target @returns {string[]} 整体拖动选中行。 */
    function moveSignals(order, targets, target) {
        const moving = orderedTargets(order, targets), selected = new Set(moving);
        if (!moving.length || !order.includes(target) || selected.has(target)) return order.slice();
        const rest = order.filter(key => !selected.has(key));
        const insertion = rest.indexOf(target) + (order.indexOf(target) > order.indexOf(moving[0]) ? 1 : 0);
        return [...rest.slice(0, insertion), ...moving, ...rest.slice(insertion)];
    }

    /** @param {number} x @param {number} y @param {number} width @param {number} height @param {number} viewportWidth @param {number} viewportHeight */
    function menuPosition(x, y, width, height, viewportWidth, viewportHeight) {
        const margin = 6;
        return { x: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
            y: Math.max(margin, Math.min(y, viewportHeight - height - margin)) };
    }

    /** @param {{id:string,widths?:number[]}} option @param {object[]} signals @param {(signal:object,id:string)=>boolean} supports */
    function formatAvailability(option, signals, supports) {
        const count = signals.filter(signal => supports(signal, option.id)).length;
        return { disabled: !signals.length || count !== signals.length, compatible: count, total: signals.length,
            detail: count !== signals.length ? `仅适用 ${count}/${signals.length}` : '' };
    }

    return { orderedTargets, selectSignals, selectContextTargets, groupName, assignGroup, moveSignals, menuPosition, formatAvailability };
});
