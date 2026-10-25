'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { createCircuitTracer } = require('../src/circuit/trace');
const { createTraceViews } = require('../src/circuit/trace-view');
const { createTraceController } = require('../src/circuit/trace-controller');
const { traceOrigin, bitIndices } = require('../src/circuit/trace-actions');
const { layoutProjection } = require('../src/circuit/layout');

function fixture() {
    const design = fromYosys({ modules: { top: { ports: { a: { direction: 'input', bits: [2] }, clk: { direction: 'input', bits: [3] }, q: { direction: 'output', bits: [5] } },
        cells: { one: { type: '$not', port_directions: { A: 'input', Y: 'output' }, connections: { A: [2], Y: [4] } },
            ff: { type: '$dff', port_directions: { D: 'input', CLK: 'input', Q: 'output' }, parameters: { CLK_POLARITY: '1' }, connections: { D: [4], CLK: [3], Q: [5] } } }, netnames: {} } } });
    const tracer = createCircuitTracer(design), views = createTraceViews({ design, tracer });
    const root = { moduleId: design.top, direction: 'drivers', instancePath: [], origin: { objectId: design.modules[0].ports.find(port => port.name === 'q').id }, branches: [] };
    return { design, tracer, views, root };
}

test('局部图重放展开并保留显式时序边界，展开请求只能引用有效边界', async () => {
    const { views, root } = fixture();
    const first = await views.render(root), sequential = first.trace.frontiers.find(frontier => frontier.reason === 'sequential');
    assert.equal(sequential.kind, 'expand');
    assert.equal(first.trace.contextLabel, 'top');
    const expanded = await views.render({ ...root, branches: [{ id: sequential.id }] });
    assert.equal(expanded.trace.precision, 'cell');
    assert.ok(expanded.trace.frontiers.some(frontier => frontier.reason === 'sequential' && frontier.kind === 'boundary'));
    const depth = expanded.trace.frontiers.find(frontier => frontier.reason === 'depth'); assert.ok(depth);
    const next = await views.render({ ...root, branches: [{ id: sequential.id }, { id: depth.id }] });
    assert.equal(next.trace.branches[1].parentId, sequential.id);
    assert.ok(next.trace.anchor.previous && next.trace.anchor.current);
    assert.ok(expanded.nodes.some(node => node.traceNew));
    await assert.rejects(views.render({ ...root, branches: [{ id: 'not-current' }] }), /过期/);
    views.dispose(); await assert.rejects(views.render(root), /关闭/);
});

test('控制器前进返回恢复分支及关注，收起父分支删除其后代，非法位选择保留当前图', async () => {
    const { design, views, root } = fixture(), messages = [], errors = [];
    let graph, generation = 0;
    const descriptor = { id: 'design', revision: 1, top: design.top };
    const controller = createTraceController({
        session: { request(command, payload) { return command === 'traceLayout' ? views.render(payload) : (views.cancel(), Promise.resolve({ cancelled: true })); } },
        send: async message => messages.push(message), descriptor: () => descriptor, graph: () => graph,
        beginOperation: () => ++generation, current: ticket => ticket === generation,
        displayTrace: async value => { graph = value; }, displayModule: async () => ({ ok: true }), onError: error => errors.push(error)
    });
    await controller.begin(root);
    const initial = graph, rootNode = initial.nodes.find(node => node.traceOrigin?.objectId === root.origin.objectId);
    await controller.focus({ type: 'node', id: rootNode.id });
    const sequential = graph.trace.frontiers.find(frontier => frontier.reason === 'sequential');
    await controller.expand(sequential.id);
    const depth = graph.trace.frontiers.find(frontier => frontier.reason === 'depth'); await controller.expand(depth.id);
    assert.equal(graph.trace.branches.length, 2);
    await controller.go(-1); assert.equal(graph.trace.branches.length, 1);
    assert.deepEqual(controller.navigation().focus, [root.origin.objectId]);
    await controller.go(1); assert.equal(graph.trace.branches.length, 2);
    await controller.collapse(sequential.id); assert.equal(graph.trace.branches.length, 0);
    const current = graph;
    await controller.handlers['trace-start']({ selection: { type: 'node', id: rootNode.id }, direction: 'drivers', bitChoice: 'bad' });
    assert.equal(graph, current); assert.equal(messages.at(-1).type, 'notice'); assert.equal(errors.length, 1);
    const pending = controller.expand(sequential.id); await controller.cancel(); await pending;
    assert.equal(graph, current); assert.equal(controller.state().busy, false);
    controller.dispose();
});

test('常量合并展示不能反推其它端口，HDL位选择受边界限制', () => {
    const graph = { nodes: [{ id: 'constant', ports: [{ id: 'constant-port:c:0', bits: ['c:0'] }] },
        { id: 'bus', ports: [{ id: 'synthetic', bits: ['c:0'] }] }], edges: [{ id: 'edge', source: 'constant-port:c:0', target: 'synthetic', bits: ['c:0'] }] };
    assert.equal(traceOrigin(graph, { type: 'edge', id: 'edge' }), null);
    assert.deepEqual(bitIndices('7:4'), [4, 5, 6, 7]); assert.deepEqual(bitIndices('-2'), [-2]);
    assert.throws(() => bitIndices('4096:0'), /4096/);
});

test('布局已经开始时的取消、后续请求和关闭，均使迟到结果失效', async () => {
    const { design, tracer, root } = fixture();
    let release, started;
    const entering = new Promise(resolve => { started = resolve; });
    const views = createTraceViews({ design, tracer, layout: async projection => {
        started(); await new Promise(resolve => { release = resolve; }); return layoutProjection(projection);
    } });
    const pending = views.render(root); await entering; views.cancel();
    const rejected = assert.rejects(pending, /取代/); release(); await rejected;
    const next = views.render(root), closing = assert.rejects(next, /取代/);
    views.dispose(); release(); await closing; tracer.dispose();
});

test('进入实例使用已确认的端口位置映射，子模块声明下标与父模块分开解释', async () => {
    const design = fromYosys({ modules: {
        top: { attributes: { top: 1 }, ports: { y: { direction: 'output', bits: [2, 3] } }, netnames: { y: { bits: [2, 3], offset: 8 } },
            cells: { unit: { type: 'leaf', port_directions: { y: 'output' }, connections: { y: [2, 3] } } } },
        leaf: { ports: { y: { direction: 'output', bits: [6, 7] }, a: { direction: 'input', bits: [2, 3] } }, netnames: { y: { bits: [6, 7], offset: 4 } },
            cells: { invert: { type: '$not', port_directions: { A: 'input', Y: 'output' }, connections: { A: [2, 3], Y: [6, 7] } } } }
    } });
    const tracer = createCircuitTracer(design), views = createTraceViews({ design, tracer });
    const descriptor = { id: 'instances', revision: 1, top: design.top }; let graph, generation = 0;
    const controller = createTraceController({ session: { request: (_command, payload) => views.render(payload) }, send: async () => {},
        descriptor: () => descriptor, graph: () => graph, beginOperation: () => ++generation, current: ticket => ticket === generation,
        displayTrace: async value => { graph = value; }, onError: error => { throw error; } });
    try {
        const top = design.modules.find(module => module.id === design.top), cell = top.cells[0];
        await controller.begin({ moduleId: top.id, origin: { objectId: top.ports[0].id, positions: [1] }, direction: 'drivers', instancePath: [] });
        assert.deepEqual(graph.trace.origin.bits.map(bit => bit.index), [9]);
        const boundary = graph.trace.frontiers.find(frontier => frontier.kind === 'enter'); assert.ok(boundary);
        await controller.expand(boundary.id); assert.equal(graph.moduleId, cell.moduleId);
        assert.deepEqual(graph.trace.context.instancePath, [cell.id]); assert.equal(graph.trace.contextLabel, 'top/unit');
        assert.deepEqual(graph.trace.origin.bits.map(bit => bit.index), [5]);
        await controller.go(-1); assert.equal(graph.moduleId, top.id);
        assert.deepEqual(graph.trace.origin.bits.map(bit => bit.index), [9]);
    } finally { controller.dispose(); views.dispose(); tracer.dispose(); }
});
