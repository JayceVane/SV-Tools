(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CircuitGraphIndex = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const key = value => String(value);
    const searchable = values => values.map(value => String(value || '').toLocaleLowerCase());
    const add = (map, id, value) => { const idKey = key(id); if (!map.has(idKey)) map.set(idKey, []); map.get(idKey).push(value); };

    function createSearch(records) {
        let lastQuery = null, lastResult;
        return function search(query) {
            const needle = String(query || '').trim().toLocaleLowerCase();
            if (needle === lastQuery) return lastResult;
            const matches = [], nodeIds = new Set(), edgeIds = new Set(), nets = new Set();
            if (needle) for (const record of records) {
                if (!record.text.some(value => value.includes(needle))) continue;
                (record.type === 'node' ? nodeIds : edgeIds).add(record.id);
                if (record.type === 'edge' && nets.has(record.netId)) continue;
                matches.push({ type: record.type, id: record.id });
                if (record.type === 'edge') nets.add(record.netId);
            }
            lastQuery = needle; return lastResult = { matches, nodes: nodeIds, edges: edgeIds };
        };
    }

    function selectObjects({ nodes, ports, edges, netEdges, portEdges }, value) {
        const nodeIds = new Set(), portIds = new Set(), edgeIds = new Set(), connected = new Set();
        const id = key(value?.id), node = value?.type === 'node' ? nodes.get(id) : null;
        const pin = value?.type === 'port' ? ports.get(id) : null, edge = value?.type === 'edge' ? edges.get(id) : null;
        if (node) nodeIds.add(id);
        if (pin) { nodeIds.add(key(pin.node.id)); portIds.add(id); }
        for (const item of edge ? netEdges.get(key(edge.netId)) || [] : pin ? portEdges.get(id) || [] : []) {
            edgeIds.add(key(item.id)); portIds.add(key(item.source)); portIds.add(key(item.target));
        }
        for (const portId of portIds) { const entry = ports.get(portId); if (entry) connected.add(key(entry.node.id)); }
        return { nodes: nodeIds, ports: portIds, edges: edgeIds, connected };
    }

    function findSignals(signalBits, signals, bits) {
        const found = new Set();
        for (const bit of bits) if (!/^(?:c:)?(0|1|x|z)$/i.test(key(bit))) for (const index of signalBits.get(key(bit)) || []) found.add(index);
        return [...found].sort((a, b) => a - b).slice(0, 24).map(index => signals[index]);
    }

    /** @param {object} graph 不可变的已布局模块。 @returns {object} 共享的拓扑、搜索和信号别名索引。 */
    function createGraphIndex(graph) {
        const nodes = new Map(), ports = new Map(), edges = new Map(), netEdges = new Map(), portEdges = new Map();
        const records = [], signalBits = new Map(), signals = graph.signals || [];
        for (const node of graph.nodes || []) {
            nodes.set(key(node.id), node);
            records.push({ type: 'node', id: key(node.id), text: searchable([node.label, node.toolName, node.detail, ...(node.ports || []).map(port => port.label)]) });
            for (const port of node.ports || []) ports.set(key(port.id), { port, node });
        }
        for (const edge of graph.edges || []) {
            edges.set(key(edge.id), edge); add(netEdges, edge.netId, edge); add(portEdges, edge.source, edge); add(portEdges, edge.target, edge);
            records.push({ type: 'edge', id: key(edge.id), netId: key(edge.netId), text: searchable([edge.label, edge.netId]) });
        }
        signals.forEach((signal, index) => { for (const bit of new Set(signal.bits || [])) add(signalBits, bit, index); });
        const topology = { nodes, ports, edges, netEdges, portEdges };
        return { ...topology, search: createSearch(records), selection: value => selectObjects(topology, value), relatedSignals: bits => findSignals(signalBits, signals, bits) };
    }
    return { createGraphIndex };
});
