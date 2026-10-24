'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createToolTaskManager } = require('../src/toolchains/job');
const { prepareSourceRequest } = require('../src/circuit/source-request');
const { runYosysCircuit } = require('../src/circuit/yosys-runner');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { fromVivado } = require('../src/circuit/adapters/vivado');
const { createCircuitTracer } = require('../src/circuit/trace');
const { CircuitSession } = require('../src/circuit/session');

test('真实Slang/Yosys输出核对升降序、切片、复制、常量、时序及两个实例边界', { timeout: 30000 }, async t => {
    const base = path.resolve(__dirname, '../bin/circuit-trace-native');
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'run-'));
    const original = await fs.readFile(path.join(__dirname, 'fixtures/circuit-trace.sv'));
    const sourceFile = path.join(root, 'circuit-trace.sv'); await fs.writeFile(sourceFile, original);
    const manager = createToolTaskManager(), task = manager.start('trace-native'), session = new CircuitSession();
    t.after(async () => { session.dispose(); task.cancel(); await task.finish({ keepArtifacts: true }); await manager.dispose(); });
    const request = await prepareSourceRequest({ task, root, top: 'trace_top', config: {}, outputBase: root,
        document: { uri: { fsPath: sourceFile }, isDirty: false, getText: () => original.toString('utf8') } });
    const generated = await runYosysCircuit({ ...request, task, outputBase: root, timeoutMs: 20000 });
    const raw = JSON.parse(await fs.readFile(generated.filePath, 'utf8'));
    assert.match(raw.creator, /^Yosys 0\.68/);
    const model = fromYosys(raw, { top: 'trace_top', stage: 'rtl' }), tracer = createCircuitTracer(model);
    const top = model.modules.find(module => module.id === model.top);
    const lane = model.modules.find(module => module.id === top.cells.find(cell => cell.name === 'u_left')?.moduleId); assert.ok(lane);
    const named = name => lane.ports.find(port => port.name === name);
    const result = tracer.trace({ moduleId: lane.id, direction: 'drivers', depth: 4,
        origin: { objectId: named('y').id, indices: [8] } });
    const selected = name => result.selections.find(item => item.objectId === named(name).id)?.positions;
    assert.deepEqual(selected('a'), [2]); // y[8]对应a[6]。
    assert.deepEqual(selected('b'), [0]); // b[0:3]的最低有效位是b[3]。
    assert.deepEqual(selected('select_b'), [0]);
    assert.equal(result.precision, 'bit');
    const repeated = tracer.trace({ moduleId: lane.id, direction: 'drivers', origin: { objectId: named('repeated').id, positions: [2] } });
    assert.deepEqual(repeated.selections.find(item => item.objectId === named('a').id).positions, [1]);
    const constants = tracer.trace({ moduleId: lane.id, direction: 'drivers', origin: { objectId: named('constants').id, positions: [0, 1] } });
    assert.deepEqual(constants.boundaries.filter(item => item.reason === 'constant').map(item => item.value), ['1', '0']);
    assert.equal(constants.nets.length, 0);
    const sequential = tracer.trace({ moduleId: lane.id, direction: 'drivers', origin: { objectId: named('q').id, positions: [0] } });
    const controls = sequential.boundaries.find(item => item.reason === 'sequential')?.controls; assert.ok(controls);
    assert.ok(controls.some(item => item.role === 'clock' && item.polarity === 1));
    assert.ok(controls.some(item => item.role === 'control' && item.polarity === 0));
    assert.equal(sequential.transitions.length, 0);
    const descriptor = await session.request('load', { ...generated, top: 'trace_top', sourceMap: request.sourceMap });
    for (const side of ['left', 'right']) {
        const output = top.ports.find(port => port.name === 'y_' + side);
        const traced = await session.request('trace', { designId: descriptor.id, revision: descriptor.revision, moduleId: descriptor.top,
            direction: 'drivers', origin: { objectId: output.id, positions: [0] } });
        const boundary = traced.boundaries.find(item => item.reason === 'instance');
        assert.equal(boundary.next.moduleId, top.cells.find(cell => cell.name === 'u_' + side).moduleId);
        assert.equal(traced.cells.find(item => item.id === boundary.cellId).name, 'u_' + side);
    }
    assert.deepEqual(await fs.readFile(sourceFile), original);
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ tool: raw.creator, filePath: generated.filePath,
        sourceSha256: createHash('sha256').update(original).digest('hex'), result, repeated, constants, sequential }, null, 2));
});

test('Vivado平坦模型复用相同位连接查询，不按引脚名称推断时钟或伪造跨层关系', () => {
    const bit = (name, net, direction = 'IN') => ({ name, net, direction });
    const model = fromVivado({ schemaVersion: 1, engine: 'vivado', version: 'export contract fixture', stage: 'elaborated-rtl', view: 'flat', top: 'top',
        ports: [bit('d', 'data'), bit('clock', 'clk'), bit('q', 'state', 'OUT')], signals: [bit('u/path/q', 'state')],
        cells: [{ name: 'u/path/reg', type: 'RTL_REG', isSequential: true, isBlackbox: false,
            ports: [bit('D', 'data'), bit('CLK', 'clk'), bit('Q', 'state', 'OUT')] }] });
    const tracer = createCircuitTracer(model), module = model.modules[0];
    const result = tracer.trace({ moduleId: model.top, direction: 'drivers', origin: { objectId: module.ports.find(port => port.name === 'q').id } });
    assert.equal(result.cells[0].name, 'u/path/reg');
    const sequential = result.boundaries.find(item => item.reason === 'sequential');
    assert.deepEqual(sequential.controls, []);
    assert.equal(result.transitions.length, 0);
    assert.equal(model.provenance.hierarchy, 'flat');
});
