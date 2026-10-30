'use strict';
const { createHash } = require('node:crypto');
const { projectModule, elkNode } = require('./projection');
const { prepareNode } = require('./symbol-library');
const { declaredIndex } = require('./topology');
const { memorySymbol } = require('./memory-symbol');

const MAX_VIEW_CELLS = 512, MAX_VIEW_POSITIONS = 16384, MAX_VIEW_REQUESTS = 16;
const idFor = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const REASONS = Object.freeze({ depth: '继续展开', sequential: '时序边界', instance: '模块边界', blackbox: '黑盒', memory: '存储器',
    'unknown-direction': '方向未知', 'multiple-drivers': '多个驱动', undriven: '无已知驱动', unloaded: '无负载', loop: '组合环路',
    constant: '常量', 'module-port': '模块接口', 'no-dependent-bits': '无相关位',
    'cell-budget': '单元数量上限', 'endpoint-budget': '端点位数量上限', 'transition-budget': '位关系数量上限',
    'boundary-budget': '边界数量上限', 'wire-budget': '网络位数量上限', 'work-budget': '查询工作量上限' });

/** @param {object[]} results 相同模块和上下文的M1结果。 @returns {object} 有界合并结果；跨模块由导航处理。 */
function mergeTraces(results) {
    if (!Array.isArray(results) || !results.length || results.length > MAX_VIEW_REQUESTS) throw new RangeError('局部视图最多保留16个展开分支');
    const first = results[0], selections = new Map(), cells = new Map(), expanded = new Map();
    let references = 0;
    for (const result of results) {
        if (result.moduleId !== first.moduleId || result.direction !== first.direction || JSON.stringify(result.context) !== JSON.stringify(first.context)) throw new TypeError('不能合并不同模块或实例上下文的追踪');
        for (const cell of result.cells) {
            if (!cells.has(cell.id)) cells.set(cell.id, cell);
            else if (cell.expanded) cells.set(cell.id, { ...cells.get(cell.id), expanded: true });
        }
        for (const selection of result.selections) {
            if (!selections.has(selection.objectId)) selections.set(selection.objectId, { ...selection, positions: new Set() });
            const target = selections.get(selection.objectId);
            if (selection.precision === 'cell') target.precision = 'cell';
            for (const position of selection.positions) if (!target.positions.has(position)) { target.positions.add(position); references++; }
        }
        for (const transition of result.transitions) {
            if (!expanded.has(transition.from.portId)) expanded.set(transition.from.portId, new Set());
            expanded.get(transition.from.portId).add(transition.from.position);
        }
    }
    if (cells.size > MAX_VIEW_CELLS || references > MAX_VIEW_POSITIONS) throw new RangeError('局部视图达到512单元/16,384位位置预算，请收起部分分支');
    const boundaries = results.flatMap(result => result.boundaries).flatMap(boundary => {
        const positions = (boundary.reason === 'depth' || boundary.reason === 'sequential' && !boundary.crossed)
            ? boundary.positions.filter(position => !expanded.get(boundary.objectId)?.has(position)) : boundary.positions;
        return positions.length ? [{ ...boundary, positions }] : [];
    });
    return { ...first, cells: [...cells.values()], selections: [...selections.values()].map(selection => ({ ...selection, positions: [...selection.positions].sort((a, b) => a - b) })),
        precision: results.some(result => result.precision === 'cell') ? 'cell' : 'bit',
        truncated: results.some(result => result.truncated), truncationReasons: [...new Set(results.flatMap(result => result.truncationReasons))], boundaries };
}

function indexSuffix(object, positions) {
    if (positions.length === object.bits.length) return '';
    const indices = positions.map(position => declaredIndex(object, position));
    if (indices.length === 1) return `[${indices[0]}]`;
    if (positions.every((position, i) => !i || position === positions[i - 1] + 1)) return `[${indices.at(-1)}:${indices[0]}]`;
    return `[${indices.slice(-8).reverse().join(',')}${indices.length > 8 ? ',…' : ''}]`;
}

function createSelectedPorts(selected) {
    const portInfo = new Map(), constantCells = [], constantValues = new Map();
    function trim(port) {
        const selection = selected.get(port.id);
        if (!selection?.positions.length) return null;
        const positions = selection.positions, groups = new Map();
        const bits = positions.map(position => {
            const bit = port.bits[position];
            if (!bit.startsWith('c:')) return bit;
            const unique = 'n:trace-constant:' + idFor([port.id, position]);
            if (!groups.has(bit)) groups.set(bit, []);
            groups.get(bit).push(unique); return unique;
        });
        for (const [value, constants] of groups) {
            const id = 'trace:constant:' + idFor([port.id, value]); constantValues.set(id, value);
            constantCells.push({ id, name: value.slice(2).toUpperCase() + (constants.length > 1 ? ` × ${constants.length}` : ''), type: 'constant', kind: 'logic',
                ports: [{ id: id + ':value', name: '', direction: 'output', bits: constants }] });
        }
        portInfo.set('port:' + port.id, { objectId: port.id, positions: [...positions], originalWidth: port.bits.length,
            displayBits: bits,
            originalBits: positions.map(position => port.bits[position]), indices: positions.map(position => declaredIndex(port, position)),
            label: port.name + indexSuffix(port, positions) });
        return { ...port, bits };
    }
    return { trim, portInfo, constantCells, constantValues };
}

function selectedAliases(module, ports, cells) {
    const wires = new Set([...ports, ...cells.flatMap(cell => cell.ports)].flatMap(port => port.bits));
    const signals = [];
    for (const signal of module.signals) {
        let start = -1;
        for (let position = 0; position <= signal.bits.length; position++) {
            const included = position < signal.bits.length && signal.bits[position].startsWith('n:') && wires.has(signal.bits[position]);
            if (included && start < 0) start = position;
            if (!included && start >= 0) {
                const bits = signal.bits.slice(start, position), lowest = Math.min(declaredIndex(signal, start), declaredIndex(signal, position - 1));
                signals.push({ ...signal, id: signal.id + ':run:' + start, bits, offset: lowest }); start = -1;
            }
        }
    }
    return signals;
}

function decorateNodes(projected, { portInfo, constantValues }, markerId) {
    const geometries = new Map(projected.input.children.map(child => [child.id, child]));
    for (const node of projected.nodes) {
        const constant = constantValues.get(node.cellId);
        if (constant) {
            node.kind = 'constant'; node.detail = '独立常量连接'; node.width = Math.max(54, Math.min(128, node.label.length * 8 + 24)); node.height = 36;
            for (const port of node.ports) port.originalBits = port.bits.map(() => constant);
            delete node.cellId;
        }
        if (node.id === 'node:' + markerId) { node.kind = 'junction'; node.detail = '追踪起点（非硬件接口）'; }
        for (const port of node.ports) {
            const original = portInfo.get(port.id);
            if (original) Object.assign(port, { label: original.label, originalBits: original.originalBits,
                originalWidth: original.originalWidth, traceOrigin: { objectId: original.objectId, positions: original.positions } });
        }
        if (node.ports.length === 1 && portInfo.has(node.ports[0].id) && !node.cellId) {
            node.traceOrigin = node.ports[0].traceOrigin;
            node.label = portInfo.get(node.ports[0].id).label;
            node.width = Math.min(180, Math.max(node.width, node.label.length * 7.3 + 28));
        }
        // 追踪裁剪可能改变常量、起点和端口名称；在同一合同内重新分配锚点。
        if (constant || node.id === 'node:' + markerId) delete node.symbolKind;
        Object.assign(node, prepareNode(node));
        Object.assign(geometries.get(node.id), elkNode(node));
    }
}

function decorateEdges(projected, portInfo) {
    const info = [...portInfo.values()];
    for (const edge of projected.edges) {
        const direct = portInfo.get(edge.target) || portInfo.get(edge.source);
        const candidate = direct || info.find(item => edge.bits.every(bit => item.displayBits.includes(bit)));
        if (!candidate) continue;
        const positions = candidate.positions.filter((position, i) => edge.bits.includes(candidate.displayBits[i]));
        // 常量隔离使用展示位ID；真实位置仍取该端口所选位置。
        edge.traceOrigin = { objectId: candidate.objectId, positions: positions.length ? positions : [...candidate.positions] };
        edge.originalBits = candidate.originalBits.filter((_, i) => edge.traceOrigin.positions.includes(candidate.positions[i]));
    }
}

function addOriginMarker(result, selected, selection, ports) {
    const root = result.origin;
    if (root.kind !== 'signal') return;
    const markerId = 'trace:origin:' + idFor([root.objectId, result.direction]);
    selected.set(markerId, { positions: root.bits.map((_, i) => i) });
    ports.push(selection.trim({ id: markerId, name: root.name + ' · 起点', direction: result.direction === 'drivers' ? 'output' : 'input', bits: root.bits.map(bit => bit.bit) }));
    selection.portInfo.set('port:' + markerId, { ...selection.portInfo.get('port:' + markerId), objectId: root.objectId, positions: root.bits.map(bit => bit.position), originalWidth: root.width,
        originalBits: root.bits.map(bit => bit.bit), indices: root.bits.map(bit => bit.index), label: root.name + ' · 起点' });
    return markerId;
}

/**
 * 局部模型投影；保留真实端口位置，常量按端口和常量值创建独立的展示驱动。
 * @param {object} design 领域设计。
 * @param {object} result 合并后的M1结果。
 * @param {string} viewId 宿主快照身份。
 * @returns {object} 与原有ELK/SVG合同一致的展示投影，附追踪动作元数据。
 */
function projectTrace(design, result, viewId) {
    const module = design.modules.find(module => module.id === result.moduleId);
    if (!module) throw new Error('局部视图模块不存在');
    const selected = new Map(result.selections.map(selection => [selection.objectId, selection])), selection = createSelectedPorts(selected);
    const ports = module.ports.map(selection.trim).filter(Boolean), cells = [];
    for (const cell of module.cells) {
        const semantics = memorySymbol(cell);
        // 在生成独立常量前过滤无效时钟，避免追踪视图留下孤立的X占位节点。
        const ports = cell.ports.filter(port => !semantics?.ports[port.name]?.hidden).map(selection.trim).filter(Boolean);
        if (ports.length) cells.push({ ...cell, ports });
    }
    if (cells.length > MAX_VIEW_CELLS) throw new RangeError('局部视图端点超过512单元，请收起部分分支');
    const markerId = addOriginMarker(result, selected, selection, ports);
    cells.push(...selection.constantCells);
    const signals = selectedAliases(module, ports, cells);
    const projected = projectModule({ ...design, modules: [{ ...module, ports, cells, signals }] }, module.id);
    projected.id = 'trace:' + viewId; projected.input.id = projected.id;
    decorateNodes(projected, selection, markerId);
    decorateEdges(projected, selection.portInfo);
    projected.traceResult = result;
    projected.stats.cellCount = cells.length - selection.constantCells.length;
    return projected;
}

module.exports = { MAX_VIEW_CELLS, MAX_VIEW_REQUESTS, REASONS, mergeTraces, projectTrace };
