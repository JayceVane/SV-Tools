'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createToolTaskManager } = require('../src/toolchains/job');
const { runYosysCircuit } = require('../src/circuit/yosys-runner');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { CircuitSession } = require('../src/circuit/session');
const { snapshotSources } = require('../src/circuit/source-snapshots');

test('真实Slang压力夹具：768扇出保留截断图，多时钟重复实例和存储器保持边界', { timeout: 60000 }, async t => {
    const root = path.resolve('bin/circuit-trace-m3-native'); await fs.mkdir(root, { recursive: true });
    const source = path.resolve('test/fixtures/circuit-trace-stress.sv'), original = await fs.readFile(source);
    const manager = createToolTaskManager(), session = new CircuitSession();
    t.after(async () => { session.dispose(); await manager.dispose(); });
    const sourceSnapshots = await snapshotSources({ sources: [source] }), reports = [];
    for (const top of ['trace_fanout', 'trace_complex']) {
        const task = manager.start('stress');
        try {
        const generated = await runYosysCircuit({ sources: [source], sourceRoot: path.dirname(source), executable: 'bundled', includeDirs: [], defines: [], top, frontend: 'auto', task, outputBase: root, timeoutMs: 30000 });
        const descriptor = await session.request('load', { ...generated, top, sourceSnapshots });
        const raw = JSON.parse(await fs.readFile(generated.filePath, 'utf8')), design = fromYosys(raw, { top });
        const module = design.modules.find(module => module.id === design.top);
        const identity = { designId: descriptor.id, revision: descriptor.revision, moduleId: descriptor.top };
        if (top === 'trace_fanout') {
            const port = module.ports.find(port => port.name === 'i_enable');
            const graph = await session.request('traceLayout', { ...identity, direction: 'loads', origin: { objectId: port.id }, branches: [] });
            assert.equal(graph.trace.truncated, true); assert.ok(graph.stats.cellCount <= 128); assert.ok(graph.edges.length > 0);
            reports.push({ top, json: generated.filePath, totalCells: module.cells.length, localCells: graph.stats.cellCount, nodes: graph.nodes.length, edges: graph.edges.length, truncated: graph.trace.truncationReasons });
        } else {
            const q = module.ports.find(port => port.name === 'q_a');
            const result = await session.request('trace', { ...identity, direction: 'drivers', origin: { objectId: q.id, positions: [2] } });
            const next = result.boundaries.find(boundary => boundary.reason === 'instance').next;
            const child = design.modules.find(module => module.id === next.moduleId);
            const sequential = await session.request('trace', { ...identity, moduleId: child.id, instancePath: [next.cellId], direction: 'drivers', origin: { objectId: next.objectId, positions: [2] } });
            const boundary = sequential.boundaries.find(boundary => boundary.reason === 'sequential'); assert.ok(boundary);
            assert.ok(boundary.controls.some(control => control.role === 'clock'));
            const memory = module.ports.find(port => port.name === 'memory_data');
            const memoryTrace = await session.request('trace', { ...identity, direction: 'drivers', origin: { objectId: memory.id }, depth: 4 });
            assert.ok(memoryTrace.boundaries.some(boundary => boundary.reason === 'memory'));
            const ascending = module.ports.find(port => port.name === 'ascending'); assert.equal(ascending.upto, true);
            const constant = await session.request('trace', { ...identity, direction: 'drivers', origin: { objectId: ascending.id, indices: [3] } });
            assert.ok(constant.boundaries.some(boundary => boundary.reason === 'constant' && boundary.value === '1'));
            reports.push({ top, json: generated.filePath, instance: next, clock: boundary.controls, memoryBoundary: true, ascendingConstant: true });
        }
        } finally { await task.finish({ keepArtifacts: true }); }
    }
    assert.deepEqual(await fs.readFile(source), original);
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(reports, null, 2));
});
