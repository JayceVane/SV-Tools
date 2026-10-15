'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { projectModule, MAX_NODES, MAX_EDGES } = require('../src/circuit/projection');
const { layoutModule } = require('../src/circuit/layout');

function makeDesign({ ports = {}, cells = {}, netnames = {} } = {}) {
    return fromYosys({ modules: { top: { ports, cells, netnames } } });
}
function cell(type, connections, port_directions = {}) { return { type, connections, port_directions }; }
function project(design) { return projectModule(design, design.top); }

test('布局端口保留声明方向，生成单元短标签不丢工具身份', () => {
    const name = '$add$generated/source.sv:12$7';
    const design = makeDesign({ ports: { a: { direction: 'input', bits: [2] } },
        cells: { [name]: cell('$add', { A: [2], B: ['1'], Y: [3] }, { A: 'input', B: 'input', Y: 'output' }) } });
    const graph = project(design);
    const input = graph.nodes.find(node => node.kind === 'input');
    assert.equal(input.ports[0].direction, 'output');
    assert.equal(input.ports[0].declaredDirection, 'input');
    const adder = graph.nodes.find(node => node.kind === 'arithmetic');
    assert.equal(adder.label, 'add');
    assert.equal(adder.toolName, name);
});

test('单模块位引用预算在构建大型连接Map之前拒绝展示', () => {
    const wide = Array(100001).fill(2);
    const design = makeDesign({ ports: { a: { direction: 'input', bits: wide }, y: { direction: 'output', bits: wide } } });
    assert.throws(() => project(design), /200,000/);
});
function fakeElk() {
    return { async layout(input) {
        return { ...input, width: 600, height: 300,
            children: input.children.map((node, index) => ({ ...node, x: index * 100, y: 20,
                ports: node.ports.map((port, i) => ({ ...port, x: 0, y: 16 + i * 10 })) })),
            edges: input.edges.map(edge => ({ ...edge, sections: [{ startPoint: { x: 100, y: 25 }, bendPoints: [{ x: 150, y: 25 }, { x: 150, y: 50 }], endPoint: { x: 200, y: 50 } }] })),
        };
    } };
}

test('projection aggregates a bus without losing aliases, bit order or partial connections', () => {
    const design = makeDesign({ ports: { a: { direction: 'input', bits: [2, 3, 4, 5] }, y: { direction: 'output', bits: [2, 3] }, z: { direction: 'output', bits: [4, 5] } },
        netnames: { a: { bits: [2, 3, 4, 5], offset: 4, upto: 1 }, alias: { bits: [2, 3, 4, 5] } } });
    const graph = project(design);
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.edges.length, 2);
    assert.deepEqual(graph.edges.map(edge => edge.bits), [['n:2', 'n:3'], ['n:4', 'n:5']]);
    assert.deepEqual(graph.edges.map(edge => edge.label), ['a[6:7]', 'a[4:5]']);
    assert.equal(graph.signals.length, 2);
    assert.equal(graph.nodes[0].ports[0].direction, 'output');
    assert.equal(graph.nodes[1].ports[0].direction, 'input');
});

test('projection keeps multi-driver and undriven connections visible through explicit junctions', () => {
    const design = makeDesign({ ports: { a: { direction: 'input', bits: [2, 3] }, b: { direction: 'input', bits: [2, 3] }, y: { direction: 'output', bits: [2, 3] }, floating: { direction: 'output', bits: [9] } } });
    const graph = project(design), junctions = graph.nodes.filter(node => node.kind === 'unknown');
    assert.equal(junctions.length, 2);
    assert.ok(junctions.some(node => node.detail.includes('Multiple drivers')));
    assert.ok(junctions.some(node => node.detail.includes('Undriven')));
    assert.equal(graph.edges.length, 4);
    assert.equal(graph.stats.multiDriverBitCount, 2);
    assert.equal(graph.stats.undrivenBitCount, 1);
    assert.ok(graph.edges.every(edge => edge.bits.length > 0));
});

test('unknown directions and inout pins retain all endpoints without invented drivers', () => {
    const design = makeDesign({ ports: { pad: { direction: 'inout', bits: [2] } }, cells: { unresolved: cell('blackbox', { P: [2] }) } });
    const graph = project(design);
    assert.equal(graph.stats.ambiguousBitCount, 1);
    assert.equal(graph.edges.length, 2);
    assert.equal(graph.nodes.filter(node => node.detail?.includes('Bidirectional')).length, 1);
    const endpointIds = new Set(graph.edges.flatMap(edge => [edge.source, edge.target]));
    for (const node of graph.nodes.filter(node => !node.id.startsWith('junction:'))) assert.ok(endpointIds.has(node.ports[0].id));
});

test('all four constant states get explicit sources and repeated constant bits stay in model ports', () => {
    const design = makeDesign({ cells: { sink: cell('$and', { A: ['0', '0', '1', 'x', 'z'] }, { A: 'input' }) } });
    const graph = project(design);
    assert.equal(graph.nodes.filter(node => node.kind === 'constant').length, 4);
    assert.equal(graph.edges.length, 4);
    assert.deepEqual(design.modules[0].cells[0].ports[0].bits, ['c:0', 'c:0', 'c:1', 'c:x', 'c:z']);
});

test('projection is deterministic and ELK input contains no engine-specific fields or model mutations', () => {
    const design = makeDesign({ ports: { a: { direction: 'input', bits: [2] }, y: { direction: 'output', bits: [2] } } });
    const before = structuredClone(design), first = project(design), second = project(design);
    assert.deepEqual(first, second);
    assert.deepEqual(design, before);
    assert.ok(first.input.children.every(node => !Object.hasOwn(node, 'cellId') && !Object.hasOwn(node, 'source')));
    assert.ok(first.input.edges.every(edge => edge.sources.length === 1 && edge.targets.length === 1));
});

test('layout combines injected ELK coordinates with model metadata without writing back', async () => {
    const design = makeDesign({ ports: { a: { direction: 'input', bits: [2] }, y: { direction: 'output', bits: [2] } } });
    const before = structuredClone(design), graph = await layoutModule(design, design.top, { elk: fakeElk() });
    assert.equal(graph.width, 600);
    assert.equal(graph.moduleId, design.top);
    assert.equal(graph.nodes[0].y, 20);
    assert.equal(graph.nodes[1].x, 100);
    assert.equal(graph.nodes[0].ports[0].y, 16);
    assert.equal(graph.edges[0].sections[0].bendPoints.length, 2);
    assert.deepEqual(design, before);
});

test('layout rejects missing nodes, missing paths, NaN coordinates and invalid engines', async () => {
    const design = makeDesign({ ports: { a: { direction: 'input', bits: [2] }, y: { direction: 'output', bits: [2] } } });
    await assert.rejects(layoutModule(design, 'missing', { elk: fakeElk() }), /module not found/);
    await assert.rejects(layoutModule(design, design.top, { elk: {} }), /ELK layout instance/);
    const mutations = [result => { result.children.pop(); }, result => { result.children[0].ports = []; }, result => { result.edges[0].sections = []; }, result => { result.width = NaN; }, result => { result.children[0].height = -1; }];
    for (const mutate of mutations) {
        const base = fakeElk();
        await assert.rejects(layoutModule(design, design.top, { elk: { async layout(input) { const result = await base.layout(input); mutate(result); return result; } } }), /ELK/);
    }
});

test('module display node budget errors explicitly instead of truncating cells', () => {
    const cells = Object.fromEntries(Array.from({ length: MAX_NODES + 1 }, (_, i) => [`cell${i}`, cell('primitive', {})]));
    const design = makeDesign({ cells });
    assert.throws(() => project(design), /2,000 display nodes/);
    assert.equal(design.modules[0].cells.length, MAX_NODES + 1);
});

test('module display edge budget errors before producing an oversized graph', () => {
    // 80 个驱动端连接 80 个各含 80 个引脚的接收单元，160 节点产生 6,400 条真实连接。
    const ports = {}, cells = {};
    for (let i = 0; i < 80; i++) ports[`in${i}`] = { direction: 'input', bits: [i + 2] };
    for (let i = 0; i < 80; i++) {
        const connections = {}, directions = {};
        for (let j = 0; j < 80; j++) { connections[`p${j}`] = [j + 2]; directions[`p${j}`] = 'input'; }
        cells[`cell${i}`] = cell('primitive', connections, directions);
    }
    assert.equal(MAX_EDGES, 6000);
    assert.throws(() => project(makeDesign({ ports, cells })), /6,000 display edges/);
});

test('a wide multi-driver bus uses one junction rather than a node for every bit', () => {
    const bits = Array.from({ length: 4096 }, (_, i) => i + 2);
    const graph = project(makeDesign({ ports: { a: { direction: 'input', bits }, b: { direction: 'input', bits }, y: { direction: 'output', bits } } }));
    assert.equal(graph.nodes.length, 4);
    assert.equal(graph.edges.length, 3);
    assert.equal(graph.edges[0].bits.length, 4096);
});

test('the pinned ELK engine routes normal, constant, undriven, multi-driver and bidirectional nets', async () => {
    const Elk = require('elkjs');
    const design = makeDesign({ ports: { a: { direction: 'input', bits: [2, 3] }, b: { direction: 'input', bits: [2, 3] }, y: { direction: 'output', bits: [2, 3] },
        floating: { direction: 'output', bits: [9] }, pad: { direction: 'inout', bits: [10] } },
    cells: { constantSink: cell('$and', { A: ['0', '1'], B: [2, 3], Y: [11, 12] }, { A: 'input', B: 'input', Y: 'output' }),
        blackbox: cell('unknown', { PAD: [10] }) } });
    const graph = await layoutModule(design, design.top, { elk: new Elk() });
    assert.ok(graph.width > 0 && graph.height > 0);
    assert.ok(graph.edges.length > 0);
    assert.ok(graph.edges.every(edge => edge.sections.every(section => Number.isFinite(section.startPoint.x) && Number.isFinite(section.endPoint.y))));
    const portIds = new Set(graph.nodes.flatMap(node => node.ports.map(port => port.id)));
    assert.ok(graph.edges.every(edge => portIds.has(edge.source) && portIds.has(edge.target)));
    assert.equal(graph.stats.multiDriverBitCount, 2);
    assert.equal(graph.stats.ambiguousBitCount, 1);
});

test('the pinned ELK engine handles an empty module and a feedback connection', async () => {
    const Elk = require('elkjs');
    const empty = makeDesign(), emptyGraph = await layoutModule(empty, empty.top, { elk: new Elk() });
    assert.equal(emptyGraph.nodes.length, 0);
    assert.equal(emptyGraph.edges.length, 0);
    const feedback = makeDesign({ cells: { latch: cell('$dlatch', { D: [2], Q: [2] }, { D: 'input', Q: 'output' }) } });
    const graph = await layoutModule(feedback, feedback.top, { elk: new Elk() });
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.nodes[0].kind, 'register');
    assert.ok(graph.edges[0].sections.length);
});

test('the packaged ELK dependency loads lazily through the default entry point', async () => {
    const design = makeDesign({ ports: { a: { direction: 'input', bits: [2] }, y: { direction: 'output', bits: [2] } } });
    const graph = await layoutModule(design, design.top);
    assert.equal(graph.moduleId, design.top);
    assert.equal(graph.edges.length, 1);
    assert.ok(graph.edges[0].sections.length);
});
