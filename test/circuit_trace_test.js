'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesign } = require('../src/circuit/model');
const { createTopologyIndex, MAX_INDEX_REFERENCES } = require('../src/circuit/topology');
const { createCircuitTracer } = require('../src/circuit/trace');
const { cellDependencies } = require('../src/circuit/trace-semantics');

const n = value => 'n:' + value;
const vector = (start, width) => Array.from({ length: width }, (_, i) => n(start + i));
const port = (id, direction, bits, extra = {}) => ({ id, name: id, direction, bits, ...extra });
function cell(id, type, kind, pins, extra = {}) {
    return { id, name: id, type, kind, ports: Object.entries(pins).map(([name, [direction, bits]]) => port(id + '/' + name, direction, bits, { name })), ...extra };
}
function design(module, others = []) {
    return createDesign({ schemaVersion: 1, title: 'trace fixture', top: module.id, provenance: { engine: 'yosys', version: 'fixture', stage: 'rtl' },
        modules: [{ name: module.id, ports: [], cells: [], signals: [], ...module }, ...others] });
}
function fixture(module, others) {
    const model = design({ id: 'top', ...module }, others), tracer = createCircuitTracer(model);
    return { model, tracer, run: (objectId, options = {}) => tracer.trace({ moduleId: model.top, direction: 'drivers', origin: { objectId }, depth: 4, ...options }) };
}
const selection = (result, id) => result.selections.find(item => item.objectId === id)?.positions;
const boundary = (result, reason) => result.boundaries.filter(item => item.reason === reason);

test('模块端口方向反转为内部连接，重复位保留独立端口位置，常量不建立共享网', () => {
    const f = fixture({ ports: [port('a', 'input', [n(1), n(1)]), port('y', 'output', [n(2)])], cells: [
        cell('and', '$and', 'logic', { A: ['input', [n(1)]], B: ['input', ['c:0']], Y: ['output', [n(2)]] })
    ] });
    const index = createTopologyIndex(f.model.modules[0]);
    assert.equal(index.net(n(1)).drivers.length, 2);
    assert.deepEqual(index.net(n(1)).drivers.map(id => index.endpoint(id).position), [0, 1]);
    assert.equal(index.net('c:0'), undefined);
    assert.equal(index.endpoint(index.occurrence('and/B', 0)).bit, 'c:0');
});

test('声明升降序、负下标及非零起点准确换算为LSB-first位置', () => {
    const f = fixture({ signals: [{ id: 'ascending', name: 'ascending', bits: vector(1, 4), offset: 4, upto: true },
        { id: 'descending', name: 'descending', bits: vector(10, 4), offset: -2, upto: false }] });
    const index = createTopologyIndex(f.model.modules[0]);
    assert.deepEqual(index.resolveOrigin({ objectId: 'ascending', indices: [4, 7, 4] }).bits,
        [{ position: 3, index: 4, bit: n(4) }, { position: 0, index: 7, bit: n(1) }]);
    assert.equal(index.resolveOrigin({ objectId: 'descending', indices: [-1] }).bits[0].position, 1);
    assert.throws(() => index.resolveOrigin({ objectId: 'ascending', indices: [8] }), /超出/);
    assert.throws(() => index.resolveOrigin({ objectId: 'ascending', indices: [4], positions: [0] }), /同时/);
});

test('只追踪MUX选定位的数据支路及选择控制，不扩展整条数据总线', () => {
    const f = fixture({ ports: [port('a', 'input', vector(1, 4)), port('b', 'input', vector(10, 4)), port('s', 'input', [n(20)]), port('y', 'output', vector(30, 4))],
        cells: [cell('choose', '$mux', 'mux', { A: ['input', vector(1, 4)], B: ['input', vector(10, 4)], S: ['input', [n(20)]], Y: ['output', vector(30, 4)] })] });
    const before = JSON.stringify(f.model);
    const result = f.run('y', { origin: { objectId: 'y', positions: [2] } });
    assert.deepEqual(selection(result, 'a'), [2]); assert.deepEqual(selection(result, 'b'), [2]);
    assert.deepEqual(selection(result, 's'), [0]);
    assert.equal(result.precision, 'bit'); assert.equal(result.truncated, false);
    assert.equal(result.transitions.length, 3);
    assert.ok(result.transitions.some(item => item.role === 'select'));
    assert.equal(JSON.stringify(f.model), before);
});

test('负载查询按位传播，MUX选择位的负载涵盖全部输出位', () => {
    const f = fixture({ ports: [port('a', 'input', vector(1, 3)), port('s', 'input', [n(9)]), port('y', 'output', vector(20, 3))],
        cells: [cell('mux', '$mux', 'mux', { A: ['input', vector(1, 3)], B: ['input', ['c:0', 'c:0', 'c:0']], S: ['input', [n(9)]], Y: ['output', vector(20, 3)] })] });
    const bit = f.run('a', { direction: 'loads', origin: { objectId: 'a', indices: [1] } });
    assert.deepEqual(selection(bit, 'y'), [1]);
    const select = f.run('s', { direction: 'loads' });
    assert.deepEqual(selection(select, 'y'), [0, 1, 2]);
});

test('拼接、切片、复制及重排以实际位ID关联，不通过信号名关联', () => {
    const f = fixture({ ports: [port('input', 'input', vector(1, 4)), port('output', 'output', [n(4), n(1), n(1), n(3)])],
        signals: [{ id: 'alias', name: 'unrelated_name', bits: [n(4), n(1), n(1), n(3)], offset: 8, upto: true }] });
    const result = f.run('alias', { origin: { objectId: 'alias', indices: [9] } });
    assert.equal(result.origin.bits[0].position, 2);
    assert.deepEqual(selection(result, 'input'), [0]);
    assert.equal(result.origin.bits[0].bit, n(1));
    const loads = f.run('input', { direction: 'loads', origin: { objectId: 'input', positions: [0] } });
    assert.deepEqual(selection(loads, 'output'), [1, 2]);
});

test('$concat与$slice的内部映射保留偏移，负载方向与驱动方向一致', () => {
    const concat = cell('cat', '$concat', 'logic', { A: ['input', vector(1, 2)], B: ['input', vector(3, 3)], Y: ['output', vector(10, 5)] });
    assert.deepEqual([...cellDependencies(concat, { portId: 'cat/Y', position: 3 }, 'drivers').targets], [{ portId: 'cat/B', position: 1, role: 'data' }]);
    assert.deepEqual([...cellDependencies(concat, { portId: 'cat/B', position: 1 }, 'loads').targets], [{ portId: 'cat/Y', position: 3, role: 'data' }]);
    const slice = cell('slice', '$slice', 'logic', { A: ['input', vector(1, 8)], Y: ['output', vector(10, 2)] }, { parameters: { OFFSET: '00000101' } });
    assert.equal([...cellDependencies(slice, { portId: 'slice/Y', position: 1 }, 'drivers').targets][0].position, 6);
    assert.deepEqual([...cellDependencies(slice, { portId: 'slice/A', position: 3 }, 'loads').targets], []);
    assert.throws(() => cellDependencies(slice, { portId: 'slice/A', position: 0 }, 'invalid'), /方向/);
});

test('同值常量不会串接其它单元；不同常量位的边界值保持独立', () => {
    const f = fixture({ ports: [port('y', 'output', [n(1)]), port('z', 'output', [n(2)])], cells: [
        cell('left', '$pos', 'logic', { A: ['input', ['c:0']], Y: ['output', [n(1)]] }),
        cell('right', '$pos', 'logic', { A: ['input', ['c:0']], Y: ['output', [n(2)]] })
    ], signals: [{ id: 'constants', name: 'constants', bits: ['c:0', 'c:1'] }] });
    const result = f.run('y');
    assert.deepEqual(result.cells.map(item => item.id), ['left']);
    assert.equal(boundary(result, 'constant').length, 1);
    assert.ok(result.nets.every(item => item.bit.startsWith('n:')));
    const constants = f.run('constants');
    assert.deepEqual(boundary(constants, 'constant').map(item => [item.value, item.positions]), [['0', [0]], ['1', [1]]]);
    const loads = f.run('left/A', { direction: 'loads' });
    assert.deepEqual(loads.cells.map(item => item.id), ['left']);
    assert.deepEqual(selection(loads, 'y'), [0]);
});

test('默认在寄存器停止，确认的时钟/复位极性来自现有符号语义', () => {
    const f = fixture({ ports: [port('d', 'input', vector(1, 2)), port('clk', 'input', [n(10)]), port('rst', 'input', [n(11)]), port('q', 'output', vector(20, 2))],
        cells: [cell('ff', '$adff', 'register', { D: ['input', vector(1, 2)], CLK: ['input', [n(10)]], ARST: ['input', [n(11)]], Q: ['output', vector(20, 2)] },
            { parameters: { CLK_POLARITY: '1', ARST_POLARITY: '0', ARST_VALUE: '00' } })] });
    const stopped = f.run('q', { origin: { objectId: 'q', positions: [1] } });
    assert.equal(stopped.transitions.length, 0);
    assert.equal(boundary(stopped, 'sequential')[0].controls.find(item => item.name === 'ARST').polarity, 0);
    assert.equal(selection(stopped, 'd'), undefined);
    const crossed = f.run('q', { crossSequential: true });
    assert.deepEqual(selection(crossed, 'd'), [0, 1]);
    assert.equal(crossed.precision, 'cell');
    assert.ok(crossed.transitions.every(item => item.relation === 'temporal-conservative'));
    assert.ok(crossed.transitions.some(item => item.role === 'clock'));
});

test('复杂运算与不等宽扩展明确标注保守候选，不冒充精确位依赖', () => {
    for (const [type, kind] of [['$add', 'arithmetic'], ['$and', 'logic']]) {
        const f = fixture({ ports: [port('a', 'input', vector(1, 2)), port('y', 'output', vector(20, 3))],
            cells: [cell('op', type, kind, { A: ['input', vector(1, 2)], B: ['input', vector(5, 3)], Y: ['output', vector(20, 3)] })] });
        const result = f.run('y', { origin: { objectId: 'y', positions: [2] } });
        assert.equal(result.precision, 'cell');
        assert.deepEqual(selection(result, 'a'), [0, 1]);
        assert.ok(result.transitions.every(item => item.precision === 'cell'));
    }
});

test('多驱动、未知方向、缺驱动及无负载分别保留边界', () => {
    const f = fixture({ ports: [port('a', 'input', [n(1)]), port('b', 'input', [n(1)]), port('io', 'inout', [n(1)]),
        port('y', 'output', [n(1)]), port('floating', 'output', [n(99)])] });
    const result = f.run('y');
    assert.equal(boundary(result, 'multiple-drivers')[0].driverCount, 2);
    assert.equal(boundary(result, 'unknown-direction')[0].objectId, 'io');
    assert.deepEqual(selection(result, 'a'), [0]); assert.deepEqual(selection(result, 'b'), [0]);
    assert.equal(boundary(f.run('floating'), 'undriven').length, 1);
    assert.equal(boundary(f.run('floating', { direction: 'loads' }), 'module-port').length, 1);
});

test('只有双向或未知方向端点时，不能误称信号没有驱动', () => {
    const f = fixture({ ports: [port('io', 'inout', [n(1)]), port('y', 'output', [n(1)])] });
    const result = f.run('y');
    assert.ok(boundary(result, 'unknown-direction').length > 0);
    assert.equal(boundary(result, 'undriven').length, 0);
});

test('组合环路终止，重汇合支路不能误报环路', () => {
    const loop = fixture({ ports: [port('y', 'output', [n(1)])], cells: [
        cell('a', '$not', 'logic', { A: ['input', [n(2)]], Y: ['output', [n(1)]] }),
        cell('b', '$not', 'logic', { A: ['input', [n(1)]], Y: ['output', [n(2)]] })] });
    assert.equal(boundary(loop.run('y', { depth: 16 }), 'loop').length, 1);
    const shared = fixture({ ports: [port('a', 'input', [n(1)]), port('y', 'output', [n(3)])], cells: [
        cell('buf', '$pos', 'logic', { A: ['input', [n(1)]], Y: ['output', [n(2)]] }),
        cell('and', '$and', 'logic', { A: ['input', [n(2)]], B: ['input', [n(2)]], Y: ['output', [n(3)]] })] });
    assert.equal(boundary(shared.run('y'), 'loop').length, 0);
});

test('深度、单元、端点、转换和工作预算返回已发现结果与明确截断', () => {
    const f = fixture({ ports: [port('a', 'input', vector(1, 4)), port('y', 'output', vector(20, 4))], cells: [
        cell('one', '$not', 'logic', { A: ['input', vector(1, 4)], Y: ['output', vector(10, 4)] }),
        cell('two', '$not', 'logic', { A: ['input', vector(10, 4)], Y: ['output', vector(20, 4)] })] });
    assert.equal(boundary(f.run('y', { depth: 0 }), 'depth').length, 1);
    for (const budget of [{ maxCells: 1 }, { maxVisitedBits: 1 }, { maxWireBits: 1 }, { maxTransitions: 1 }, { maxWork: 1 }]) {
        const result = f.run('y', budget);
        assert.equal(result.truncated, true, JSON.stringify(budget));
        assert.ok(result.boundaries.some(item => item.reason.endsWith('-budget')));
    }
    assert.equal(f.run('y').cells.length, 2);
    assert.throws(() => f.run('y', { depth: 33 }), /预算/);
    assert.throws(() => f.run('y', { maxWork: NaN }), /预算/);
});

test('实例边界只给出明确的等宽端口位置映射，定义查询与实例上下文区分', () => {
    const child = { id: 'child', name: 'child', ports: [port('child/a', 'input', [n(1)], { name: 'a' }), port('child/y', 'output', [n(1)], { name: 'y' })], cells: [], signals: [] };
    const f = fixture({ ports: [port('a', 'input', [n(1)]), port('y', 'output', [n(2)])], cells: [
        cell('u0', 'child', 'instance', { a: ['input', [n(1)]], y: ['output', [n(2)]] }, { moduleId: 'child' }),
        cell('u1', 'child', 'instance', { a: ['input', [n(3)]], y: ['output', [n(4)]] }, { moduleId: 'child' })] }, [child]);
    const result = f.run('y');
    assert.deepEqual(boundary(result, 'instance')[0].next, { moduleId: 'child', cellId: 'u0', objectId: 'child/y', mapping: 'position' });
    const request = { moduleId: 'child', origin: { objectId: 'child/y' }, direction: 'drivers', instancePath: ['u1'] };
    assert.deepEqual(f.tracer.trace(request).context.instancePath, ['u1']);
    assert.equal(f.tracer.trace({ ...request, instancePath: undefined }).context.kind, 'module-definition');
    assert.throws(() => f.tracer.trace({ ...request, instancePath: [] }), /不匹配/);
    assert.throws(() => f.tracer.trace({ ...request, instancePath: ['missing'] }), /不属于/);
});

test('黑盒与存储器不按端口名称猜测连接', () => {
    for (const kind of ['unknown', 'instance', 'memory']) {
        const f = fixture({ ports: [port('y', 'output', [n(2)])], cells: [cell('box', 'custom', kind, { CLK: ['input', [n(1)]], Q: ['output', [n(2)]] })] });
        const result = f.run('y');
        assert.equal(result.transitions.length, 0);
        assert.equal(boundary(result, kind === 'memory' ? 'memory' : 'blackbox').length, 1);
    }
});

test('实例端口方向不一致时不提供可继续追踪的跨层映射', () => {
    const child = { id: 'child', name: 'child', ports: [port('child/y', 'input', [n(1)], { name: 'y' })], cells: [], signals: [] };
    const f = fixture({ ports: [port('y', 'output', [n(1)])], cells: [
        cell('u', 'child', 'instance', { y: ['output', [n(1)]] }, { moduleId: 'child' })] }, [child]);
    const result = f.run('y');
    assert.equal(boundary(result, 'instance')[0].next, undefined);
    assert.equal(boundary(result, 'instance')[0].mappingStatus, 'incompatible-port');
});

test('索引缓存按需复用、检索有界，销毁后请求明确失败', () => {
    const f = fixture({ ports: [port('a', 'input', [n(1)]), port('y', 'output', [n(1)])] });
    assert.equal(f.tracer.stats().builds, 0);
    assert.equal(f.tracer.listSignals({ moduleId: 'top', query: '', limit: 1 }).truncated, true);
    assert.equal(f.tracer.stats().builds, 0);
    f.run('y'); f.run('y');
    assert.equal(f.tracer.stats().builds, 1);
    assert.throws(() => f.run('missing'), /不存在/);
    assert.throws(() => f.run('y', { direction: 'both' }), /方向/);
    f.tracer.dispose();
    assert.equal(f.tracer.stats().cachedModules, 0);
    assert.throws(() => f.run('y'), /关闭/);
});

test('索引预算在分配位数组之前拒绝超大端口', () => {
    const module = { id: 'large', ports: [port('wide', 'input', new Array(MAX_INDEX_REFERENCES + 1).fill(n(1)))], cells: [], signals: [] };
    assert.throws(() => createTopologyIndex(module), /索引预算/);
});

test('边界数量预算仍返回明确截断原因', () => {
    const f = fixture({ ports: [...vector(1, 600).map((bit, i) => port('a' + i, 'input', [bit])), port('y', 'output', vector(1, 600))] });
    const result = f.run('y');
    assert.equal(result.truncated, true);
    assert.ok(result.truncationReasons.includes('boundary-budget'));
    assert.ok(result.boundaries.length <= 512);
});

test('最多缓存四个模块，LRU淘汰后重新构建，模块局部位ID不会串联', () => {
    const modules = Array.from({ length: 5 }, (_, i) => ({ id: 'm' + i, name: 'm' + i,
        ports: [port('m' + i + '/a', 'input', [n(1)]), port('m' + i + '/y', 'output', [n(1)])], cells: [], signals: [] }));
    const tracer = createCircuitTracer(design(modules[0], modules.slice(1)));
    for (const module of modules) {
        const result = tracer.trace({ moduleId: module.id, direction: 'drivers', origin: { objectId: module.id + '/y' } });
        assert.ok(result.selections.every(item => item.objectId.startsWith(module.id + '/')));
    }
    assert.equal(tracer.stats().cachedModules, 4);
    assert.equal(tracer.stats().builds, 5);
    tracer.trace({ moduleId: 'm0', direction: 'drivers', origin: { objectId: 'm0/y' } });
    assert.equal(tracer.stats().builds, 6);
});
