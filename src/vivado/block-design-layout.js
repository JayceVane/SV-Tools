'use strict';

const { elkNode, placeBoundaryColumns } = require('../circuit/projection');
const { layoutProjection } = require('../circuit/layout');

const parentOf = id => id.slice(0, id.lastIndexOf('/'));
const shortName = id => id.slice(id.lastIndexOf('/') + 1);
const isInterface = item => item.kind.startsWith('interface_');
const endpointKey = (item, id = item.id) => (isInterface(item) ? 'interface:' : 'signal:') + id;
const heading = 50;
const pitch = 19;
const inset = 12;

function direction(endpoint) {
    switch (endpoint.direction.toLowerCase()) {
        case 'i': case 'input': case 'slave': return 'input';
        case 'o': case 'output': case 'master': return 'output';
        default: return 'shared';
    }
}

function pinLabel(endpoint) {
    const { left, right } = endpoint;
    const range = left != null && right != null && left !== '' && right !== '' && left !== right ? `[${left}:${right}]` : '';
    return shortName(endpoint.id) + range;
}

const shorten = (label, length = 33) => label.length > length ? label.slice(0, length - 1) + '…' : label;
const widthOf = label => Array.from(label).reduce((sum, char) => sum + (char.codePointAt(0) > 255 ? 12 : 7), 0);

function schematicPin(endpoint, index, boundary) {
    const declared = direction(endpoint);
    const drive = boundary ? declared === 'input' : declared === 'output';
    const side = (boundary ? declared !== 'output' : drive) ? 'EAST' : 'WEST';
    const label = pinLabel(endpoint);
    return { id: 'pin-' + index, index, name: endpoint.id, label,
        kind: isInterface(endpoint) ? 'interface' : label !== shortName(endpoint.id) ? 'bus'
            : /^(clk|clock|rst|reset)$/iu.test(endpoint.type) ? 'control' : 'signal',
        side, drive, width: 0, height: 0 };
}

function block(cell, index, pins) {
    const label = shortName(cell.id);
    const subtitle = cell.type === 'hier' ? '层级块' : cell.vlnv.split(':')[2] || cell.type;
    const sides = ['WEST', 'EAST'].map(side => pins.filter(pin => pin.side === side)
        .sort((a, b) => Number(b.kind === 'interface') - Number(a.kind === 'interface')));
    const widths = sides.map(side => side.reduce((widest, pin) => Math.max(widest, widthOf(shorten(pin.label))), 0));
    const width = Math.max(176, 2 * inset + 32 + widths[0] + widths[1], 2 * inset + widthOf(shorten(label, 42)));
    const height = heading + Math.max(1, ...sides.map(side => side.length)) * pitch + 8;
    for (const side of sides) {
        side.forEach((pin, row) => { pin.x = pin.side === 'EAST' ? width : 0; pin.y = heading + row * pitch + pitch / 2; });
    }
    return { id: 'cell-' + index, kind: 'cell', index, name: cell.id, label, subtitle, hierarchy: cell.type === 'hier',
        width, height, ports: sides.flat() };
}

function boundaryNode(pin) {
    const width = Math.max(70, widthOf(shorten(pin.label, 42)) + 32), height = 26;
    pin.x = pin.side === 'EAST' ? width : 0;
    pin.y = height / 2;
    return { id: 'boundary-' + pin.index, kind: 'boundary', boundary: true,
        width, height, ports: [pin] };
}

function fork(index) {
    const port = (side, x) => ({ id: `fork-${index}-${side}`, side, x, y: 3, width: 0, height: 0 });
    return { id: 'fork-' + index, kind: 'fork', net: index, width: 6, height: 6, ports: [port('WEST', 0), port('EAST', 6)] };
}

function schematicProjection(model, level, expandedInterfaces) {
    const byCell = new Map(), visiblePins = new Map(), nodes = [], edges = [];
    const discreteNets = new Set();
    if (!expandedInterfaces) {
        for (const net of model.nets) {
            if (!isInterface(net) && parentOf(net.id) === level) {
                for (const id of net.endpoints) discreteNets.add(id);
            }
        }
    }
    model.endpoints.forEach((endpoint, index) => {
        if (!expandedInterfaces && endpoint.interfaceId && !discreteNets.has(endpoint.id)) return;
        const boundary = endpoint.cell === level;
        if (!boundary && (!endpoint.cell || parentOf(endpoint.cell) !== level)) return;
        const pin = schematicPin(endpoint, index, boundary);
        visiblePins.set(endpointKey(endpoint), pin);
        if (boundary) nodes.push(boundaryNode(pin));
        else {
            if (!byCell.has(endpoint.cell)) byCell.set(endpoint.cell, []);
            byCell.get(endpoint.cell).push(pin);
        }
    });
    model.cells.forEach((cell, index) => {
        if (parentOf(cell.id) === level) nodes.push(block(cell, index, byCell.get(cell.id) || []));
    });
    const append = (net, kind, from, to) => edges.push({
        id: 'edge-' + edges.length, net, kind, from: from.id, to: to.id
    });
    model.nets.forEach((net, index) => {
        if (parentOf(net.id) !== level) return;
        const pins = [...new Set(net.endpoints.map(id => visiblePins.get(endpointKey(net, id))).filter(Boolean))];
        if (pins.length < 2) return;
        // ELK 只需要绘图顺序。总线接口和双向端口不在图上推断信号方向。
        const first = pins.findIndex(pin => pin.drive);
        const [source] = pins.splice(first < 0 ? 0 : first, 1);
        const kind = isInterface(net) ? 'interface'
            : [source, ...pins].some(pin => pin.kind === 'bus') ? 'bus' : source.kind === 'control' ? 'control' : 'signal';
        if (pins.length === 1) append(index, kind, source, pins[0]);
        else {
            const node = fork(index);
            nodes.push(node);
            append(index, kind, source, node.ports[0]);
            for (const pin of pins) append(index, kind, node.ports[1], pin);
        }
    });
    if (nodes.length > 1200 || edges.length > 5000 || visiblePins.size > 8000) {
        throw new RangeError('当前层级超过原理图绘制预算，可通过层级选择器或右侧对象列表查看。');
    }
    const input = { id: 'block-design', layoutOptions: {
        'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
        'elk.spacing.nodeNode': '24', 'elk.spacing.edgeEdge': '11',
        'elk.layered.spacing.nodeNodeBetweenLayers': '72', 'elk.layered.spacing.edgeNodeBetweenLayers': '14',
        'elk.layered.mergeEdges': 'true', 'elk.padding': '[top=24,left=24,bottom=24,right=24]'
    }, children: nodes.map(elkNode),
    edges: edges.map(({ id, from, to }) => ({ id, sources: [from], targets: [to] })) };
    placeBoundaryColumns(input, nodes);
    return { input, nodes, edges };
}

async function layoutSchematic(model, level, { elk, expandedInterfaces = false } = {}) {
    const projection = schematicProjection(model, level, expandedInterfaces);
    if (!projection.nodes.length) return { width: 0, height: 0, nodes: [], edges: [] };
    const { width, height, nodes, edges } = await layoutProjection(projection, { elk });
    return { width, height, nodes, edges };
}

module.exports = { layoutSchematic, parentOf, endpointKey, shortName, isInterface };
