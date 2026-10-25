'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { CircuitSession } = require('../src/circuit/session');

function wideModule(count) {
    const inputs = Array.from({ length: count }, (_, i) => i + 2), outputs = inputs.map(bit => bit + count);
    const cells = Object.fromEntries(inputs.map((bit, i) => ['not_' + i, { type: '$not',
        port_directions: { A: 'input', Y: 'output' }, connections: { A: [bit], Y: [outputs[i]] } }]));
    return { modules: { large: { ports: { input: { direction: 'input', bits: inputs }, output: { direction: 'output', bits: outputs } }, cells, netnames: {} } } };
}

test('完整模块超过布局预算时，Worker直接查询局部位级逻辑而不先布局', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-trace-worker-'));
    const session = new CircuitSession();
    t.after(async () => { session.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const filePath = path.join(root, 'large.json');
    await fs.writeFile(filePath, JSON.stringify(wideModule(3000)));
    const descriptor = await session.request('load', { filePath });
    await assert.rejects(session.request('layout', { moduleId: descriptor.top }), /display nodes|展示预算/);
    const request = { designId: descriptor.id, revision: descriptor.revision, moduleId: descriptor.top };
    const objects = await session.request('traceSignals', { ...request, query: 'output' });
    assert.equal(objects.items.length, 1);
    const result = await session.request('trace', { ...request, direction: 'drivers',
        origin: { objectId: objects.items[0].objectId, positions: [2345] } });
    assert.equal(result.cells.length, 1); assert.equal(result.cells[0].name, 'not_2345');
    assert.equal(result.truncated, false); assert.equal(result.precision, 'bit');
    assert.equal(result.indexStats.builds, 1);
    const local = await session.request('traceLayout', { ...request, direction: 'drivers',
        origin: { objectId: objects.items[0].objectId, positions: [2345] }, branches: [] });
    assert.equal(local.trace.truncated, false); assert.equal(local.stats.cellCount, 1);
    assert.ok(local.nodes.length <= 3); assert.ok(local.edges.every(edge => edge.bits.length === 1));
    assert.deepEqual(local.trace.origin.bits.map(bit => bit.index), [2345]);
    const warm = await session.request('trace', { ...request, direction: 'drivers', origin: { objectId: objects.items[0].objectId, positions: [0] } });
    assert.equal(warm.indexStats.builds, 1);
});

test('重载相同JSON也使旧追踪世代失效，并释放旧索引', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-trace-reload-'));
    const session = new CircuitSession();
    t.after(async () => { session.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const filePath = path.join(root, 'small.json');
    await fs.writeFile(filePath, JSON.stringify(wideModule(2)));
    const first = await session.request('load', { filePath });
    const old = { designId: first.id, revision: first.revision, moduleId: first.top };
    const candidates = await session.request('traceSignals', old);
    const origin = { objectId: candidates.items.find(item => item.name === 'output').objectId };
    await session.request('trace', { ...old, direction: 'drivers', origin });
    const second = await session.request('load', { filePath });
    assert.equal(first.id, second.id); assert.notEqual(first.revision, second.revision);
    await assert.rejects(session.request('trace', { ...old, direction: 'drivers', origin }), /过期/);
    await assert.rejects(session.request('traceLayout', { ...old, direction: 'drivers', origin, branches: [] }), /过期/);
    const current = await session.request('trace', { ...old, revision: second.revision, direction: 'drivers', origin });
    assert.equal(current.indexStats.builds, 1);
    await assert.rejects(session.request('trace', { moduleId: second.top, direction: 'drivers', origin }), /过期/);
    const pending = session.request('trace', { ...old, revision: second.revision, direction: 'drivers', origin });
    const cancelled = assert.rejects(pending, /关闭/);
    session.dispose();
    await cancelled;
    await assert.rejects(session.request('traceSignals', old), /关闭/);
});
