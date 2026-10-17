'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createViewportIndex } = require('../src/circuit/viewport');
const { createGraphIndex } = require('../src/circuit/graph-index');

const wire = (id, points) => ({ id, sections: [{ startPoint: points[0], bendPoints: points.slice(1, -1), endPoint: points.at(-1) }] });

test('裁剪保留端点均在屏外的穿越连线，排除包围盒相交而线段不相交的折线', () => {
    const scene = createViewportIndex({ nodes: [], edges: [
        wire('cross', [{ x: -1000, y: 100 }, { x: 1000, y: 100 }]),
        wire('around', [{ x: -1000, y: -1000 }, { x: 1000, y: -1000 }, { x: 1000, y: 1000 }]),
        wire('vertical', [{ x: 50, y: -1000 }, { x: 50, y: 1000 }]),
        wire('invalid', [{ x: 0, y: 0 }, { x: NaN, y: 0 }])
    ] });
    assert.deepEqual([...scene.query({ x: 0, y: 0, scale: 1 }, 200, 200)].sort(), ['edge:cross', 'edge:vertical']);
});

test('包围盒树和穷举结果一致，支持负坐标、标签外边界及极端相机比例', () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => ({ id: String(i), x: i % 40 * 250 - 5000, y: Math.floor(i / 40) * 150 - 3000, width: 160, height: 90 }));
    const scene = createViewportIndex({ nodes, edges: [] });
    for (const scale of [.0001, .1, .5, 1, 8]) for (const offset of [-2500, 0, 3000]) {
        const camera = { x: offset, y: offset / 2, scale }, margin = 100 / scale;
        const view = { left: -camera.x / scale - margin, right: (900 - camera.x) / scale + margin, top: -camera.y / scale - margin, bottom: (600 - camera.y) / scale + margin };
        const expected = nodes.filter(node => node.x - 24 <= view.right && node.x + node.width + 24 >= view.left && node.y - 24 <= view.bottom && node.y + node.height + 24 >= view.top).map(node => 'node:' + node.id).sort();
        assert.deepEqual([...scene.query(camera, 900, 600)].sort(), expected);
    }
    assert.equal(createViewportIndex({ nodes: [], edges: [] }).query({ x: 0, y: 0, scale: 1 }, 1, 1).size, 0);
});

test('拓扑索引保留分支高亮、端口局部连接、稳定别名顺序和搜索去重', () => {
    const graph = { nodes: [{ id: 'a', label: 'driver', ports: [{ id: 'out', label: 'data' }] }, { id: 'b', label: 'sink', ports: [{ id: 'in', label: 'D' }] }, { id: 'c', label: 'branch', ports: [{ id: 'in2' }] }],
        edges: [{ id: 'e1', netId: 'bus', source: 'out', target: 'in', label: 'payload' }, { id: 'e2', netId: 'bus', source: 'out', target: 'in2', label: 'payload' }],
        signals: [{ name: 'first', bits: ['n:2', 'n:3'] }, { name: 'second', bits: ['n:1', 'n:2'] }, { name: 'constant', bits: ['c:0'] }] };
    const index = createGraphIndex(graph), selected = index.selection({ type: 'edge', id: 'e2' });
    assert.deepEqual([...selected.edges], ['e1', 'e2']); assert.deepEqual([...selected.ports], ['out', 'in', 'in2']); assert.equal(selected.connected.size, 3);
    assert.deepEqual([...index.selection({ type: 'port', id: 'in' }).edges], ['e1']);
    assert.equal(index.selection({ type: 'node', id: 'missing' }).nodes.size, 0);
    assert.deepEqual(index.relatedSignals(['n:1', 'n:2', 'n:2', 'c:0']).map(signal => signal.name), ['first', 'second']);
    const result = index.search('PAYLOAD'); assert.deepEqual(result.matches, [{ type: 'edge', id: 'e1' }]); assert.equal(result.edges.size, 2);
    assert.equal(index.search(' payload '), result); assert.equal(index.search('').matches.length, 0);
    assert.deepEqual(index.search('data').matches, [{ type: 'node', id: 'a' }]);
});
