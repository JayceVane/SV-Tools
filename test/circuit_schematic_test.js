'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const symbols = require('../src/circuit/symbol-library');
const routes = require('../src/circuit/route-geometry');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { layoutModule } = require('../src/circuit/layout');
const { createMinimap, mapTransform } = require('../src/circuit/minimap');

function gate(type = '$and', width = 1) {
    return { id: 'gate', label: 'u_gate', kind: 'logic', detail: type, ports: [
        { id: 'a', label: 'A', direction: 'input', bits: Array(width).fill('n:2') },
        { id: 'b', label: 'B', direction: 'input', bits: Array(width).fill('n:3') },
        { id: 'y', label: 'Y', direction: 'output', bits: Array(width).fill('n:4') },
    ] };
}
function edge(id, netId, points, source = 'out') {
    return { id, netId, source, target: id, bits: ['n:2'], sections: [{ startPoint: points[0], bendPoints: points.slice(1, -1), endPoint: points.at(-1) }] };
}

test('标准门只消费明确类型和标量端口，用户模块、多位与逻辑归约保持功能块', () => {
    for (const [type, kind] of [['$and', 'and'], ['$_NAND_', 'nand'], ['RTL_OR', 'or'], ['$_NOR_', 'nor'], ['$xor', 'xor'], ['$xnor', 'xnor']]) {
        assert.equal(symbols.prepareNode(gate(type)).symbolKind, kind);
    }
    for (const node of [gate('$logic_and'), gate('$and', 8), { ...gate(), moduleId: 'user' }, gate('my_and')]) {
        assert.equal(symbols.prepareNode(node).symbolKind, 'block');
    }
});

test('符号几何不修改输入，锚点、绘制边界与门形使用同一坐标', () => {
    const source = gate('$_NAND_'), before = structuredClone(source), node = symbols.prepareNode(source);
    assert.deepEqual(source, before);
    assert.equal(node.ports[0].width, 0);
    assert.equal(node.ports[0].x, 0);
    assert.equal(node.ports[2].x, node.width);
    assert.ok(node.paintBounds.bottom >= node.height);
    assert.equal(symbols.geometry(node).kind, 'nand');
});

test('单比特接口标签收紧为32px，总线40px仍容纳独立位宽，标签长度决定宽度', () => {
    for (const kind of ['input', 'output', 'inout']) {
        const scalar = symbols.prepareNode({ kind, label: 'i_data', ports: [{ direction: 'output', bits: ['n:2'] }] });
        const bus = symbols.prepareNode({ kind, label: 'i_data', ports: [{ direction: 'output', bits: Array(32).fill('n:2') }] });
        assert.equal(scalar.height, 32); assert.equal(bus.height, 40);
        assert.ok(scalar.width <= 80); assert.ok(bus.width >= '32 bit'.length * 7.3 + 28);
        assert.equal(scalar.ports[0].y, scalar.height / 2);
    }
});

test('主体形状与选中外框共用几何，门、接口和功能块各取正确形状', () => {
    const gateNode = symbols.prepareNode(gate('$and'));
    assert.equal(symbols.bodyShape(gateNode).type, 'path');
    assert.equal(symbols.bodyShape(gateNode).attrs.d, symbols.gateOutline(gateNode).d);
    const output = symbols.prepareNode({ kind: 'output', label: 'q', ports: [{ direction: 'input', bits: ['n:2'] }] });
    assert.equal(symbols.bodyShape(output).type, 'polygon');
    const block = symbols.prepareNode({ kind: 'instance', label: 'u_child', moduleId: 'child', ports: [
        { id: 'd', label: 'D', direction: 'input', bits: ['n:2'] }, { id: 'q', label: 'Q', direction: 'output', bits: ['n:3'] }] });
    assert.equal(symbols.bodyShape(block).type, 'rect');
    assert.ok(symbols.bodyShape(block).attrs.width < block.width);
});

test('小地图相机更新只复制缓存位图，不重扫线路或强制读取样式', () => {
    let segments = 0, styleReads = 0, navigation;
    const target = () => ({ listeners: new Map(), addEventListener(type, callback) { this.listeners.set(type, callback); }, removeEventListener(type) { this.listeners.delete(type); } });
    const context = () => new Proxy({}, { get(_object, key) { return () => { if (key === 'lineTo') segments++; }; } });
    const canvas = { ...target(), width: 192, height: 120, getContext: () => context(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 192, height: 120 }) };
    canvas.ownerDocument = { createElement: () => ({ getContext: () => context() }), body: target() };
    const window = { ...target(), getComputedStyle() { styleReads++; return { getPropertyValue: () => '' }; } };
    const map = createMinimap(canvas, window, point => { navigation = point; });
    const bounds = { left: -100, top: -50, right: 900, bottom: 550 }, transform = mapTransform(bounds);
    map.setGraph({ nodes: [], edges: [edge('x', 'net', [{ x: 0, y: 0 }, { x: 100, y: 0 }])] }, bounds);
    const count = segments, reads = styleReads;
    for (let i = 0; i < 100; i++) map.update({ x: i, y: 0, scale: 1 }, 800, 600);
    assert.equal(segments, count); assert.equal(styleReads, reads);
    canvas.listeners.get('pointerdown')({ button: 0, pointerId: 1, clientX: transform.x, clientY: transform.y, preventDefault() {} });
    assert.ok(Math.abs(navigation.x) < 1e-9 && Math.abs(navigation.y) < 1e-9);
    map.destroy(); assert.equal(canvas.listeners.size, 0); assert.equal(window.listeners.size, 0);
});

test('真实ELK保留门与时序单元的固定锚点，连线终点准确接到引脚', async () => {
    const design = fromYosys({ modules: { top: { ports: { a: { direction: 'input', bits: [2] }, b: { direction: 'input', bits: [3] }, q: { direction: 'output', bits: [5] } },
        cells: { u_and: { type: '$and', port_directions: { A: 'input', B: 'input', Y: 'output' }, connections: { A: [2], B: [3], Y: [4] } },
            u_ff: { type: '$dff', parameters: { CLK_POLARITY: '1' }, port_directions: { D: 'input', CLK: 'input', Q: 'output' }, connections: { D: [4], CLK: [2], Q: [5] } } } } } });
    const before = structuredClone(design), graph = await layoutModule(design, design.top);
    const ports = new Map(graph.nodes.flatMap(node => node.ports.map(port => [port.id, { x: node.x + port.x, y: node.y + port.y }])));
    for (const wire of graph.edges) {
        assert.deepEqual(wire.sections[0].startPoint, ports.get(wire.source));
        assert.deepEqual(wire.sections.at(-1).endPoint, ports.get(wire.target));
    }
    assert.equal(graph.nodes.find(node => node.label === 'u_and').symbolKind, 'and');
    assert.deepEqual(design, before);
});

test('只为同一真实网络的T分叉画点，不把不同网络交叉或同值常量相连', () => {
    const a = edge('a', 'net', [{ x: 0, y: 20 }, { x: 100, y: 20 }]);
    const b = edge('b', 'net', [{ x: 0, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 80 }]);
    const crossing = edge('cross', 'other', [{ x: 70, y: 0 }, { x: 70, y: 40 }], 'other-source');
    const marks = routes.createJunctions([a, b, crossing]);
    assert.equal(marks.size, 1);
    assert.deepEqual([...marks.values()].map(mark => [mark.x, mark.y]), [[50, 20]]);
    const other = { ...b, netId: 'different', source: 'different' };
    assert.equal(routes.createJunctions([a, other]).size, 0);
});

test('路由合并共线与重复折点，圆角不越过真实接点，也不改写原路由', () => {
    const wire = edge('wire', 'net', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }]);
    const before = structuredClone(wire), d = routes.edgePath(wire.sections);
    assert.match(d, /Q/);
    assert.doesNotMatch(d, /L 10 0/);
    assert.doesNotMatch(routes.edgePath(wire.sections, [{ x: 20, y: 0 }]), /Q/);
    assert.deepEqual(wire, before);
});
