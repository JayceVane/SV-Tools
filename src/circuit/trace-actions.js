(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CircuitTraceActions = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    /** @param {object} graph 已由宿主生成的图。 @param {object} selection 现有对象ID。 @returns {object|null} 原始模型起点；常量不按值反推归属。 */
    function traceOrigin(graph, selection) {
        if (!graph || !selection) return null;
        const ports = graph.nodes.flatMap(node => node.ports.map(port => ({ node, port })));
        if (selection.type === 'node') {
            const node = graph.nodes.find(node => node.id === selection.id);
            if (node?.traceOrigin) return node.traceOrigin;
            if (node?.ports.length === 1) return traceOrigin(graph, { type: 'port', id: node.ports[0].id });
            return null;
        }
        if (selection.type === 'port') {
            const port = ports.find(entry => entry.port.id === selection.id)?.port;
            if (port?.traceOrigin) return port.traceOrigin;
            if (graph.trace) return null;
            return port?.id.startsWith('port:') ? { objectId: port.id.slice(5), positions: port.bits.map((_, position) => position) } : null;
        }
        const edge = selection.type === 'edge' && graph.edges.find(edge => edge.id === selection.id);
        if (!edge) return null;
        if (edge.traceOrigin) return edge.traceOrigin;
        if (graph.trace) return null;
        const direct = ports.find(entry => entry.port.id === edge.target && entry.port.id.startsWith('port:'))
            || ports.find(entry => entry.port.id === edge.source && entry.port.id.startsWith('port:'));
        const candidate = direct || (!edge.bits.some(bit => bit.startsWith('c:')) && ports.find(entry => entry.port.id.startsWith('port:') && edge.bits.every(bit => entry.port.bits.includes(bit))));
        if (!candidate) return null;
        const positions = candidate.port.bits.flatMap((bit, position) => edge.bits.includes(bit) ? [position] : []);
        return positions.length ? { objectId: candidate.port.id.slice(5), positions } : null;
    }
    /** @param {object[]} branches 分支树。 @param {string} id 收起分支ID。 @returns {object[]} 移除该分支及其后代。 */
    function collapseBranches(branches, id) {
        const removed = new Set([id]);
        for (const branch of branches) if (removed.has(branch.parentId)) removed.add(branch.id);
        return branches.filter(branch => !removed.has(branch.id));
    }
    /** @param {string} value HDL十进制下标或切片。 @returns {number[]|undefined} LSB-first声明下标，*由调用者解释为当前选择。 */
    function bitIndices(value) {
        const text = String(value).trim();
        if (!text || text === '*') return undefined;
        const match = /^(-?\d+)\s*(?::\s*(-?\d+))?$/.exec(text);
        if (!match) throw new Error('位选择应为HDL下标、范围（如7:4）或*');
        const left = Number(match[1]), right = match[2] === undefined ? left : Number(match[2]);
        if (![left, right].every(Number.isSafeInteger) || Math.abs(left - right) >= 4096) throw new RangeError('位选择超过4096位或有效整数范围');
        return Array.from({ length: Math.abs(left - right) + 1 }, (_, i) => right + i * (left >= right ? 1 : -1));
    }
    return { traceOrigin, collapseBranches, bitIndices };
});
