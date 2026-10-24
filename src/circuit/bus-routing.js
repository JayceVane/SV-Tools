'use strict';

const PORT_SIZE = 8;
const NODE_WIDTH = 164;
const LANE_SPACING = 28;

function positionsLabel(positions) {
    if (positions.length === 1) return `[${positions[0]}]`;
    const step = positions[1] - positions[0];
    if (Math.abs(step) === 1 && positions.every((value, i) => !i || value - positions[i - 1] === step)) {
        return `[${positions.at(-1)}:${positions[0]}]`;
    }
    const shown = positions.slice(-8).reverse().join(',');
    return `[${shown}${positions.length > 8 ? ',…' : ''}]`;
}
function endpoint(id, label, direction, bits, extra = {}) {
    return { id, label, direction, bits: [...bits], x: 0, y: 0, width: PORT_SIZE, height: PORT_SIZE, ...extra };
}
function portGroups(port, incidents) {
    const groups = new Map(), positions = new Map();
    port.bits.forEach((bit, i) => {
        if (!positions.has(bit)) positions.set(bit, []);
        positions.get(bit).push(i);
    });
    for (const edge of incidents || []) {
        if (groups.has(edge.netId)) continue;
        const bitPositions = edge.bits.map(bit => {
            if (!positions.has(bit)) throw new TypeError('总线分支包含端口中不存在的位：' + port.id);
            return positions.get(bit);
        });
        groups.set(edge.netId, { netId: edge.netId, bits: edge.bits, bitPositions });
    }
    return [...groups.values()];
}
function needsRouting(port, incidents) {
    if (!incidents?.length) return false;
    const first = incidents[0];
    return first.bits.length !== port.bits.length || first.bits.some((bit, i) => bit !== port.bits[i])
        || incidents.some(edge => edge.netId !== first.netId);
}
function branchPort(id, group, direction) {
    const positions = group.bitPositions.flat(), label = positionsLabel(positions);
    const copies = group.bitPositions[0].length;
    const start = positions.reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const isRepeated = copies > 1 && group.bitPositions.every((items, bit) => items.length === copies
        && items.every((position, copy) => position === start + copy * group.bits.length + bit));
    const mapping = positions.length === group.bits.length ? label : `→${positions.length}b`;
    const wireLabel = isRepeated ? `${group.bits.length}b ×${copies}` : `${group.bits.length}b ${mapping}`;
    return endpoint(id, label, direction, group.bits, { bitPositions: group.bitPositions.map(items => [...items]), wireLabel,
        description: `${group.bits.length} bit连线，对应完整端口位位置${label}${isRepeated ? `，每位重复${copies}次` : ''}；位置从LSB=0计数` });
}

/**
 * 把多位引脚的异质连接投影为拼接/拆分主干；仅修改新建展示图，不改变领域网表。
 * @param {object[]} nodes 展示节点。 @param {object[]} edges 按真实位网络分组的连线。
 * @param {{maxNodes:number,maxEdges:number,maxPorts:number}} limits 展示容量预算。
 * @returns {number} 新增的总线连接节点数。
 * @throws {RangeError|TypeError} 展示预算超限或位映射不一致，不省略连接。
 */
function addBusConnections(nodes, edges, { maxNodes, maxEdges, maxPorts }) {
    const incidents = new Map(), remapped = new Map(), trunks = [];
    for (const edge of edges) {
        for (const id of [edge.source, edge.target]) {
            if (!incidents.has(id)) incidents.set(id, []);
            incidents.get(id).push(edge);
        }
    }
    const original = [...nodes];
    let portCount = nodes.reduce((sum, node) => sum + node.ports.length, 0), count = 0;
    for (const node of original) for (const port of node.ports) {
        if (port.bits.length < 2 || !['input', 'output'].includes(port.direction)) continue;
        const connected = incidents.get(port.id);
        if (!needsRouting(port, connected)) continue;
        const groups = portGroups(port, connected);
        if (nodes.length >= maxNodes) throw new RangeError(`Circuit module exceeds ${maxNodes.toLocaleString('en-US')} display nodes; choose a smaller module`);
        if (edges.length + trunks.length >= maxEdges) throw new RangeError(`Circuit module exceeds ${maxEdges.toLocaleString('en-US')} display edges; choose a smaller module`);
        portCount += groups.length + 1;
        if (portCount > maxPorts) throw new RangeError(`总线连接节点使当前模块超过${maxPorts.toLocaleString('en-US')}引脚展示预算，请选择子模块`);
        const isSplit = port.direction === 'output', id = `bundle:${port.id}`;
        const bus = endpoint(id + ':bus', `${port.bits.length} bit`, isSplit ? 'input' : 'output', port.bits);
        const branches = groups.map((group, i) => branchPort(id + ':lane:' + i, group, isSplit ? 'output' : 'input'));
        const labelLength = branches.reduce((longest, branch) => Math.max(longest, branch.wireLabel.length), bus.label.length);
        const width = Math.max(NODE_WIDTH, Math.min(320, 2 * (labelLength * 7.3 + 16)));
        nodes.push({ id, kind: 'bus', routing: isSplit ? 'split' : 'join', label: `${port.label} · ${port.bits.length} bit`,
            detail: `总线${isSplit ? '拆分' : '拼接'}，仅表示位连接；端口位位置从LSB=0计数`,
            originalPort: { id: port.id, label: port.label, nodeId: node.id },
            x: 0, y: 0, width, height: Math.max(72, groups.length * LANE_SPACING + 28), ports: [bus, ...branches] });
        remapped.set(port.id, new Map(groups.map((group, i) => [group.netId, branches[i].id])));
        trunks.push({ id: id + ':trunk', netId: id + ':net', netIds: groups.map(group => group.netId), bundleNode: id,
            label: `${port.label} · ${port.bits.length} bit`, bits: [...port.bits],
            source: isSplit ? port.id : bus.id, target: isSplit ? bus.id : port.id, sections: [] });
        count++;
    }
    for (const edge of edges) {
        edge.source = remapped.get(edge.source)?.get(edge.netId) || edge.source;
        edge.target = remapped.get(edge.target)?.get(edge.netId) || edge.target;
    }
    edges.push(...trunks);
    return count;
}

module.exports = { addBusConnections };
