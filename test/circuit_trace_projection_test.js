'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { createCircuitTracer } = require('../src/circuit/trace');
const { mergeTraces, projectTrace } = require('../src/circuit/trace-projection');
const { layoutProjection } = require('../src/circuit/layout');

function fixture() {
    const model = fromYosys({ modules: { top: { ports: { a: { direction: 'input', bits: [2, 3, 4, 5], offset: 4 },
        y: { direction: 'output', bits: [10, 11, 12, 13], offset: 8 }, z: { direction: 'output', bits: [20, 21, 22, 23] } }, cells: {
        one: { type: '$and', port_directions: { A: 'input', B: 'input', Y: 'output' }, connections: { A: [2, 3, 4, 5], B: ['0', '1', '0', '1'], Y: [6, 7, 8, 9] } },
        two: { type: '$or', port_directions: { A: 'input', B: 'input', Y: 'output' }, connections: { A: [6, 7, 8, 9], B: ['0', '1', '0', '1'], Y: [10, 11, 12, 13] } },
        other: { type: '$not', port_directions: { A: 'input', Y: 'output' }, connections: { A: [2, 3, 4, 5], Y: [20, 21, 22, 23] } }
    }, netnames: { a: { bits: [2, 3, 4, 5], offset: 4 }, middle: { bits: [6, 7, 8, 9] } } } } });
    const module = model.modules[0], tracer = createCircuitTracer(model);
    return { model, module, tracer, origin: { objectId: module.ports.find(port => port.name === 'y').id, indices: [10] } };
}

test('局部投影只保留选定位和真实声明下标，不改变领域模型', async () => {
    const { model, module, tracer, origin } = fixture(), before = JSON.stringify(model);
    const result = tracer.trace({ moduleId: module.id, origin, direction: 'drivers', depth: 1 });
    const projection = projectTrace(model, result, 'view');
    assert.ok(!projection.nodes.some(node => node.toolName === 'other'));
    assert.ok(projection.nodes.some(node => node.label === 'y[10]'));
    const y = projection.nodes.find(node => node.label === 'y[10]').ports[0];
    assert.deepEqual(y.originalBits, ['n:12']); assert.equal(y.originalWidth, 4);
    assert.deepEqual(y.traceOrigin.positions, [2]);
    const graph = await layoutProjection(projection);
    assert.ok(graph.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
    assert.equal(JSON.stringify(model), before);
});

test('展开结果按实际端口位置合并，已展开的深度边界移除', () => {
    const { model, module, tracer, origin } = fixture();
    const root = tracer.trace({ moduleId: module.id, origin, direction: 'drivers' });
    const boundary = root.boundaries.find(boundary => boundary.reason === 'depth');
    const expansion = tracer.trace({ moduleId: module.id, direction: 'drivers', origin: { objectId: boundary.objectId, positions: boundary.positions } });
    const merged = mergeTraces([root, expansion]);
    assert.equal(merged.boundaries.filter(boundary => boundary.reason === 'depth').length, 0);
    const graph = projectTrace(model, merged, 'expanded');
    assert.ok(graph.nodes.some(node => node.label === 'a[6]'));
    assert.ok(!graph.nodes.some(node => node.toolName === 'other'));
});

test('同值常量按不同端口隔离，常量分支动作只包含对应值的原位置', () => {
    const { model, module, tracer } = fixture();
    const result = tracer.trace({ moduleId: module.id, direction: 'drivers', depth: 4,
        origin: { objectId: module.ports.find(port => port.name === 'y').id } });
    const projection = projectTrace(model, result, 'constant');
    const constants = projection.nodes.filter(node => node.kind === 'constant');
    assert.equal(constants.length, 4);
    const zeros = constants.filter(node => node.label.startsWith('0'));
    assert.equal(zeros.length, 2);
    assert.ok(zeros[0].ports[0].bits.every(bit => !zeros[1].ports[0].bits.includes(bit)));
    const branches = projection.edges.filter(edge => edge.originalBits?.every(bit => bit === 'c:0'));
    assert.ok(branches.length > 0);
    assert.ok(branches.every(edge => edge.traceOrigin.positions.every(position => [0, 2].includes(position))));
});

test('信号别名起点具有明确观察标记，而不伪造模块接口', () => {
    const { model, module, tracer } = fixture();
    const signal = module.signals.find(signal => signal.name === 'middle');
    const result = tracer.trace({ moduleId: module.id, direction: 'loads', origin: { objectId: signal.id, positions: [1] } });
    const graph = projectTrace(model, result, 'alias');
    const marker = graph.nodes.find(node => node.label.includes('起点'));
    assert.equal(marker.kind, 'junction'); assert.deepEqual(marker.traceOrigin, { objectId: signal.id, positions: [1] });
});
