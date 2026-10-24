'use strict';

const MAX_INDEX_REFERENCES = 500_000;
const MAX_INDEX_OBJECTS = 100_000;
const MAX_ORIGIN_BITS = 4096;
const inverseFlow = direction => direction === 'input' ? 'drivers' : direction === 'output' ? 'loads' : 'ambiguous';
const cellFlow = direction => direction === 'output' ? 'drivers' : direction === 'input' ? 'loads' : 'ambiguous';

/** @param {object} object 位向量对象。 @param {number} position LSB-first位置。 @returns {number} 原始HDL下标。 */
function declaredIndex(object, position) {
    return (object.offset || 0) + (object.upto ? object.bits.length - 1 - position : position);
}

function resolveOrigin(objects, origin) {
    if (!origin || typeof origin !== 'object') throw new TypeError('追踪起点必须指定objectId');
    const entry = objects.get(origin.objectId);
    if (!entry) throw new TypeError('追踪起点在当前模块中不存在');
    if (origin.indices !== undefined && origin.positions !== undefined) throw new TypeError('不能同时指定HDL下标和位位置');
    const requested = origin.indices ?? origin.positions;
    if (requested !== undefined && (!Array.isArray(requested) || !requested.length)) throw new TypeError('追踪位选择必须是非空数组');
    if ((requested?.length ?? entry.object.bits.length) > MAX_ORIGIN_BITS) throw new RangeError('追踪起点超过4096位，请选择切片');
    const selected = requested ?? Array.from({ length: entry.object.bits.length }, (_, i) => i);
    if (!selected.length) throw new TypeError('追踪起点没有连接位');
    const bits = [], seen = new Set();
    for (const item of selected) {
        if (!Number.isSafeInteger(item)) throw new TypeError('追踪位下标必须是安全整数');
        const offset = entry.object.offset || 0;
        const position = origin.indices === undefined ? item : entry.object.upto ? offset + entry.object.bits.length - 1 - item : item - offset;
        if (position < 0 || position >= entry.object.bits.length) throw new RangeError('追踪位超出声明范围');
        if (seen.has(position)) continue;
        seen.add(position);
        bits.push({ position, index: declaredIndex(entry.object, position), bit: entry.object.bits[position] });
    }
    return { objectId: entry.object.id, name: entry.object.name, kind: entry.kind, cellId: entry.cellId,
        width: entry.object.bits.length, bits };
}

/**
 * 为已验证模块建立连接索引，不读取布局或跨模块合并位ID。
 * @param {object} module createDesign验证后的单个模块；调用者保持其不可变。
 * @returns {object} 有界索引；常量只通过具体端口位置访问，不成为共享网络。
 * @throws {RangeError} 超过端口位索引预算。
 */
function createTopologyIndex(module) {
    const objectCount = module.ports.length + module.signals.length
        + module.cells.reduce((sum, cell) => sum + 1 + cell.ports.length, 0);
    if (objectCount > MAX_INDEX_OBJECTS) throw new RangeError('当前模块超过100,000对象追踪索引预算，请选择子模块');
    const terminals = [], objects = new Map(), terminalIds = new Map(), cells = new Map();
    function terminal(port, cell) {
        const entry = { port, cell, base: 0, flow: cell ? cellFlow(port.direction) : inverseFlow(port.direction) };
        terminalIds.set(port.id, terminals.length);
        terminals.push(entry);
        objects.set(port.id, { object: port, kind: cell ? 'cell-port' : 'module-port', cellId: cell?.id });
    }
    module.ports.forEach(port => terminal(port));
    for (const cell of module.cells) {
        cells.set(cell.id, cell);
        cell.ports.forEach(port => terminal(port, cell));
    }
    module.signals.forEach(object => objects.set(object.id, { object, kind: 'signal' }));
    const referenceCount = terminals.reduce((sum, entry) => sum + entry.port.bits.length, 0);
    if (referenceCount > MAX_INDEX_REFERENCES) throw new RangeError('当前模块超过500,000端口位追踪索引预算，请选择子模块');
    const owners = new Uint32Array(referenceCount), positions = new Uint32Array(referenceCount), wires = new Map();
    let occurrence = 0;
    for (const [owner, entry] of terminals.entries()) {
        entry.base = occurrence;
        for (const [position, bit] of entry.port.bits.entries()) {
            owners[occurrence] = owner; positions[occurrence] = position;
            if (bit.startsWith('n:')) {
                if (!wires.has(bit)) wires.set(bit, { drivers: [], loads: [], ambiguous: [] });
                wires.get(bit)[entry.flow].push(occurrence);
            }
            occurrence++;
        }
    }
    function endpoint(id) {
        if (!Number.isSafeInteger(id) || id < 0 || id >= referenceCount) throw new RangeError('追踪端点不存在');
        const entry = terminals[owners[id]], position = positions[id];
        return { id, portId: entry.port.id, name: entry.port.name, cellId: entry.cell?.id,
            position, index: declaredIndex(entry.port, position), bit: entry.port.bits[position], flow: entry.flow };
    }
    return { moduleId: module.id, referenceCount, objectCount, wireCount: wires.size, resolveOrigin: origin => resolveOrigin(objects, origin), endpoint,
        object: id => objects.get(id), cell: id => cells.get(id),
        net: bit => wires.get(bit),
        occurrence(portId, position) {
            const owner = terminalIds.get(portId), entry = owner === undefined ? null : terminals[owner];
            if (!entry || !Number.isSafeInteger(position) || position < 0 || position >= entry.port.bits.length) throw new RangeError('追踪端口位置不存在');
            return entry.base + position;
        } };
}

module.exports = { MAX_INDEX_REFERENCES, MAX_INDEX_OBJECTS, MAX_ORIGIN_BITS, declaredIndex, createTopologyIndex };
