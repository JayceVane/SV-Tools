'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { createCircuitTracer } = require('../src/circuit/trace');
const { createTraceViews } = require('../src/circuit/trace-view');

function fanoutModel(count, direction = 'input') {
    return fromYosys({ modules: { top: { ports: { enable: { direction: 'input', bits: [2] } }, netnames: {},
        cells: Object.fromEntries(Array.from({ length: count }, (_, i) => ['load_' + i, { type: '$and',
            port_directions: { A: direction, B: 'input', Y: 'output' }, connections: { A: [2], B: [i + 3], Y: [i + count + 3] } }])) } } });
}

test('高扇出在端点收集前遵守单元预算，局部图保留部分结果及真实总扇出', async () => {
    const design = fanoutModel(3000), tracer = createCircuitTracer(design), views = createTraceViews({ design, tracer });
    const request = { moduleId: design.top, direction: 'loads', origin: { objectId: design.modules[0].ports[0].id }, branches: [] };
    try {
        const result = tracer.trace(request); assert.equal(result.truncated, true);
        assert.ok(result.selections.filter(item => item.cellId).length <= 256);
        assert.equal(result.nets.find(net => net.bit === 'n:2').loadCount, 3000);
        const graph = await views.render(request);
        assert.equal(graph.trace.truncated, true); assert.ok(graph.trace.truncationReasons.includes('cell-budget'));
        assert.deepEqual(graph.trace.truncationLabels, ['单元数量上限']);
        assert.ok(graph.stats.cellCount <= 128); assert.ok(graph.edges.length > 0);
    } finally { views.dispose(); tracer.dispose(); }
});

test('未知或双向高扇出也受端点单元预算约束，保留方向不确定边界', () => {
    const design = fanoutModel(3000, 'inout'), tracer = createCircuitTracer(design);
    try {
        const result = tracer.trace({ moduleId: design.top, direction: 'loads', origin: { objectId: design.modules[0].ports[0].id } });
        assert.equal(result.truncated, true); assert.ok(result.selections.filter(item => item.cellId).length <= 128);
        assert.ok(result.boundaries.some(boundary => boundary.reason === 'unknown-direction'));
        assert.equal(result.nets.find(net => net.bit === 'n:2').ambiguousCount, 3000);
    } finally { tracer.dispose(); }
});
