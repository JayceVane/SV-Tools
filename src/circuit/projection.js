'use strict';

const { createHash } = require('crypto');
const { findModule } = require('./model');
const { registerSymbol } = require('./register-symbol');

const MAX_NODES = 2_000;
const MAX_EDGES = 6_000;
const MAX_LAYOUT_BIT_REFERENCES = 200_000;
const MAX_PORTS = 16_384;
const PORT_SIZE = 8;
const MIN_REGISTER_WIDTH = 196; // 留出完整控制名与中央符号的间距。

function stableId(prefix, value) { return `${prefix}:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`; }
function inverse(direction) { return direction === 'input' ? 'output' : direction === 'output' ? 'input' : direction; }
function graphPort(port, direction = port.direction) {
    return { id: `port:${port.id}`, label: port.name, direction, declaredDirection: port.direction,
        x: 0, y: 0, width: PORT_SIZE, height: PORT_SIZE, bits: [...port.bits] };
}
function nodeSize(label, ports, small = false) {
    const inputs = ports.filter(port => port.direction !== 'output').length;
    const outputs = ports.length - inputs;
    const bitCount = small && ports.length === 1 ? ports[0].bits.length : 0;
    const widthLabel = bitCount > 1 ? `${bitCount} bit` : '';
    return { width: small ? Math.min(180, Math.max(70, label.length * 7.3 + 28, widthLabel.length * 7.3 + 28)) : Math.min(280, Math.max(132, label.length * 7 + 40)),
        height: Math.max(small ? (bitCount > 1 ? 66 : 36) : 62, Math.max(inputs, outputs) * 22 + 32) };
}
function netLabel(bits, aliases) {
    const candidate = aliases.get(bits[0]);
    if (!candidate) return bits.length === 1 && bits[0].startsWith('c:') ? bits[0].slice(2) : undefined;
    const { signal, index } = candidate;
    if (!bits.every((bit, i) => signal.bits[index + i] === bit)) return undefined;
    const offset = signal.offset || 0;
    const indexAt = position => signal.upto ? offset + signal.bits.length - 1 - position : offset + position;
    if (signal.bits.length === 1) return signal.name;
    const first = indexAt(index), last = indexAt(index + bits.length - 1);
    return `${signal.name}[${bits.length === 1 ? first : `${last}:${first}`}]`;
}
function elkPort(port) {
    return { id: port.id, width: port.width, height: port.height, layoutOptions: { 'elk.port.side': port.direction === 'output' ? 'EAST' : 'WEST' } };
}

/**
 * @param {object} design 已验证的领域设计。
 * @param {string} moduleId 模块标识。
 * @returns {{input:object,nodes:object[],edges:object[],signals:object[],stats:object,id:string,name:string}} 纯 ELK 输入及独立展示元数据。
 * @throws {RangeError|TypeError} 模块不存在或超过节点/边预算；不截断原模型。
 */
function projectModule(design, moduleId) {
    const module = findModule(design, moduleId);
    if (!module) throw new TypeError(`Circuit module not found: ${moduleId}`);
    const ports = module.ports.length + module.cells.reduce((sum, cell) => sum + cell.ports.length, 0);
    if (ports > MAX_PORTS) throw new RangeError('当前模块超过 16,384 引脚展示预算，请选择子模块');
    const references = [...module.ports, ...module.signals, ...module.cells.flatMap(cell => cell.ports)]
        .reduce((sum, item) => sum + item.bits.length, 0);
    if (references > MAX_LAYOUT_BIT_REFERENCES) throw new RangeError('当前模块超过 200,000 位引用展示预算，请选择子模块');
    const nodes = [], edges = [], nets = new Map(), aliases = new Map();
    function addNode(node) {
        if (nodes.length >= MAX_NODES) throw new RangeError(`Circuit module exceeds ${MAX_NODES.toLocaleString('en-US')} display nodes; choose a smaller module`);
        nodes.push(node);
    }
    function connect(port) {
        for (const bit of new Set(port.bits)) {
            if (!nets.has(bit)) nets.set(bit, { drivers: new Set(), sinks: new Set(), ambiguous: new Set() });
            const net = nets.get(bit);
            net[port.direction === 'output' ? 'drivers' : port.direction === 'input' ? 'sinks' : 'ambiguous'].add(port.id);
        }
    }
    for (const signal of [...module.signals.filter(signal => !signal.hidden), ...module.signals.filter(signal => signal.hidden)]) {
        for (const [index, bit] of signal.bits.entries()) {
            if (!aliases.has(bit)) aliases.set(bit, { signal, index });
            if (!nets.has(bit)) nets.set(bit, { drivers: new Set(), sinks: new Set(), ambiguous: new Set() });
        }
    }
    for (const port of module.ports) {
        const terminal = graphPort(port, inverse(port.direction));
        addNode({ id: `node:${port.id}`, label: port.name, kind: port.direction === 'unknown' ? 'unknown' : port.direction,
            detail: `${port.direction} · ${port.bits.length} bit${port.bits.length === 1 ? '' : 's'}`, source: port.source,
            x: 0, y: 0, ...nodeSize(port.name, [terminal], true), ports: [terminal] });
        connect(terminal);
    }
    for (const cell of module.cells) {
        const semantics = registerSymbol(cell);
        const ports = cell.ports.map(port => ({ ...graphPort(port), ...semantics?.ports[port.name] }));
        const label = !cell.moduleId && cell.name.startsWith('$')
            ? cell.type.replace(/^\$/, '') + (cell.source?.line ? ' @' + cell.source.line : '') : cell.name;
        const size = nodeSize(label, ports);
        if (semantics) size.width = Math.max(MIN_REGISTER_WIDTH, size.width);
        addNode({ id: `node:${cell.id}`, cellId: cell.id, moduleId: cell.moduleId, source: cell.source, label, toolName: cell.name,
            detail: cell.type, kind: cell.kind, x: 0, y: 0, ...size,
            ...(semantics ? { symbol: semantics.symbol, description: semantics.description, parameters: cell.parameters } : {}), ports });
        ports.forEach(connect);
    }
    for (const [bit, net] of nets) {
        if (!bit.startsWith('c:') || (!net.drivers.size && !net.sinks.size && !net.ambiguous.size)) continue;
        const terminal = { id: `constant-port:${bit}`, label: bit.slice(2), direction: 'output', x: 0, y: 0, width: PORT_SIZE, height: PORT_SIZE, bits: [bit] };
        addNode({ id: `constant:${bit}`, label: bit.slice(2), kind: 'constant', detail: 'Constant', x: 0, y: 0, width: 54, height: 36, ports: [terminal] });
        net.drivers.add(terminal.id);
    }
    const groups = new Map();
    for (const [bit, net] of nets) {
        const drivers = [...net.drivers].sort(), sinks = [...net.sinks].sort(), ambiguous = [...net.ambiguous].sort();
        const key = JSON.stringify([drivers, sinks, ambiguous]);
        if (!groups.has(key)) groups.set(key, { key, drivers, sinks, ambiguous, bits: [] });
        groups.get(key).bits.push(bit);
    }
    let undrivenBitCount = 0, multiDriverBitCount = 0, ambiguousBitCount = 0;
    function addEdge(source, target, group) {
        if (edges.length >= MAX_EDGES) throw new RangeError(`Circuit module exceeds ${MAX_EDGES.toLocaleString('en-US')} display edges; choose a smaller module`);
        edges.push({ id: stableId('edge', [module.id, source, target, group.bits]), netId: stableId('net', [module.id, group.bits]),
            label: netLabel(group.bits, aliases), bits: [...group.bits], source, target, sections: [] });
    }
    for (const group of groups.values()) {
        const { drivers, sinks, ambiguous } = group;
        if (!drivers.length && (sinks.length || ambiguous.length)) undrivenBitCount += group.bits.length;
        if (drivers.length > 1) multiDriverBitCount += group.bits.length;
        if (ambiguous.length) ambiguousBitCount += group.bits.length;
        if (drivers.length === 1 && !ambiguous.length) {
            sinks.forEach(sink => addEdge(drivers[0], sink, group));
            continue;
        }
        if (!sinks.length && !ambiguous.length && drivers.length < 2) continue;
        const junctionId = stableId('junction', [module.id, group.key]);
        const details = [];
        if (!drivers.length) details.push('Undriven');
        if (drivers.length > 1) details.push('Multiple drivers');
        if (ambiguous.length) details.push('Bidirectional / Unknown direction');
        const inputs = [...drivers, ...ambiguous].map((endpoint, i) => ({ endpoint, port: { id: `${junctionId}:in:${i}`, label: '', direction: 'input', x: 0, y: 0, width: PORT_SIZE, height: PORT_SIZE, bits: [...group.bits] } }));
        const outputs = sinks.map((endpoint, i) => ({ endpoint, port: { id: `${junctionId}:out:${i}`, label: '', direction: 'output', x: 0, y: 0, width: PORT_SIZE, height: PORT_SIZE, bits: [...group.bits] } }));
        const ports = [...inputs, ...outputs].map(item => item.port);
        const label = netLabel(group.bits, aliases) || (group.bits.length === 1 ? group.bits[0] : `${group.bits.length} bits`);
        addNode({ id: junctionId, label, detail: details.join(' · '), kind: 'unknown', x: 0, y: 0, ...nodeSize(label, ports, true), ports });
        inputs.forEach(item => addEdge(item.endpoint, item.port.id, group));
        outputs.forEach(item => addEdge(item.port.id, item.endpoint, group));
    }
    const graphId = `graph:${module.id}`;
    const input = { id: graphId, layoutOptions: {
        'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
        'elk.spacing.nodeNode': '38', 'elk.layered.spacing.nodeNodeBetweenLayers': '84',
        'elk.padding': '[top=32,left=32,bottom=32,right=32]',
    }, children: nodes.map(node => ({ id: node.id, width: node.width, height: node.height,
        layoutOptions: { 'elk.portConstraints': 'FIXED_ORDER' }, ports: node.ports.map(elkPort) })),
    edges: edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })) };
    return { id: graphId, moduleId: module.id, name: module.name, input, nodes, edges, signals: module.signals, parameters: module.parameters,
        stats: { bitCount: nets.size, portCount: module.ports.length, cellCount: module.cells.length, nodeCount: nodes.length, edgeCount: edges.length,
            undrivenBitCount, multiDriverBitCount, ambiguousBitCount } };
}

module.exports = { MAX_NODES, MAX_EDGES, MAX_LAYOUT_BIT_REFERENCES, projectModule };
