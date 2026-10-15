'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fromVivado } = require('../src/circuit/adapters/vivado');
const { buildVivadoExportScript } = require('../src/circuit/vivado-export');

function bit(name, net, direction = 'IN', bus) { return { name, net, direction, ...bus }; }
function bus(name, nets, left, right, direction = 'IN') {
    const low = Math.min(left, right);
    return nets.map((net, i) => bit(name + '[' + (low + i) + ']', net, direction, { busName: name, left, right, index: low + i }));
}
function fixture() {
    return { schemaVersion: 1, engine: 'vivado', version: '2022.1.2', stage: 'elaborated-rtl', view: 'flat', top: 'top',
        ports: [bit('clk', 'clk'), ...bus('a', ['a0', 'a1'], 1, 0), ...bus('q', ['q0', 'q1'], 1, 0, 'OUT')],
        cells: [{ name: 'u/reg', type: 'RTL_REG__BREG_2', isSequential: true, isBlackbox: false,
            ports: [bit('C', 'clk'), ...bus('D', ['a0', 'a1'], 1, 0), ...bus('Q', ['q0', 'q1'], 1, 0, 'OUT')],
            source: { path: '/design.sv', line: 7, column: 1 } }],
        signals: [...bus('u/a', ['a0', 'a1'], 1, 0), ...bus('u/q', ['q0', 'q1'], 1, 0)] };
}

test('Vivado adapter keeps actual cross-hierarchy connections and explicit flat provenance', () => {
    const input = fixture(), before = JSON.stringify(input), design = fromVivado(input, { title: 'RTL' }), module = design.modules[0];
    assert.equal(design.title, 'RTL'); assert.equal(design.provenance.engine, 'vivado');
    assert.equal(design.provenance.stage, 'elaborated-rtl'); assert.equal(design.provenance.hierarchy, 'flat');
    assert.equal(module.attributes.view, 'flat'); assert.equal(module.cells[0].name, 'u/reg');
    assert.equal(module.cells[0].kind, 'register'); assert.equal(module.cells[0].moduleId, undefined);
    assert.deepEqual(module.cells[0].ports[1].bits, module.ports[1].bits);
    assert.deepEqual(module.cells[0].ports[2].bits, module.ports[2].bits);
    assert.deepEqual(module.signals[0].bits, module.ports[1].bits);
    assert.deepEqual(module.cells[0].source, { path: '/design.sv', line: 7, column: 1 });
    assert.equal(JSON.stringify(input), before);
});

test('Vivado ascending and nonzero/negative descending buses are LSB-first', () => {
    const input = fixture(); input.ports = [...bus('asc', ['n2', 'n3', 'n4', 'n5'], 2, 5), ...bus('neg', ['n-2', 'n-1', 'n0'], 0, -2)];
    input.signals = [bit('low', 'n5'), bit('high', 'n2'), bit('negative', 'n-2')];
    const module = fromVivado(input).modules[0];
    assert.equal(module.ports[0].offset, 2); assert.equal(module.ports[0].upto, true);
    assert.equal(module.ports[0].bits[0], module.signals[0].bits[0]);
    assert.equal(module.ports[0].bits[3], module.signals[1].bits[0]);
    assert.equal(module.ports[1].offset, -2); assert.equal(module.ports[1].upto, false);
    assert.equal(module.ports[1].bits[0], module.signals[2].bits[0]);
});

test('Vivado opaque ids permit escaped names without merging unrelated names or unconnected pins', () => {
    const input = fixture(); input.ports = [bit('a b', 'net with space'), bit('unconnected', null), bit('other', null)];
    input.signals = [bit('alias', 'net with space'), bit('different', 'a b'), bit('literal', 'unconnected:port:top:unconnected')];
    const module = fromVivado(input).modules[0];
    assert.equal(module.ports[0].name, 'a b'); assert.equal(module.ports[0].bits[0], module.signals[0].bits[0]);
    const bits = [...module.ports.map(port => port.bits[0]), module.signals[1].bits[0], module.signals[2].bits[0]];
    assert.equal(new Set(bits).size, 5); assert.ok(bits.every(value => /^n:\S+$/.test(value)));
});

test('Vivado sparse internal buses expose only existing bits', () => {
    const input = fixture(); input.signals = bus('sparse', ['a0', 'a1'], 7, 0);
    const module = fromVivado(input).modules[0];
    assert.deepEqual(module.signals.map(signal => signal.name), ['sparse[0]', 'sparse[1]']);
    assert.ok(module.signals.every(signal => signal.bits.length === 1));
});

test('Vivado bus metadata errors fail rather than fabricating or reordering a connection', () => {
    const missing = fixture(); missing.ports.pop(); assert.throws(() => fromVivado(missing), /总线位缺失/);
    const duplicate = fixture(); duplicate.ports.push(duplicate.ports[0]); assert.throws(() => fromVivado(duplicate), /重复位/);
    const conflict = fixture(); conflict.ports[2].right = -1; assert.throws(() => fromVivado(conflict), /元数据冲突/);
    const invalid = fixture(); invalid.ports[1].index = 2; assert.throws(() => fromVivado(invalid), /索引无效/);
});

test('Vivado unsupported schemas, stages and malformed flags are rejected', () => {
    for (const change of [{ schemaVersion: 2 }, { engine: 'yosys' }, { stage: 'source-index' }, { view: 'hierarchical' }]) {
        assert.throws(() => fromVivado({ ...fixture(), ...change }), /不是支持的/);
    }
    const input = fixture(); input.cells[0].isBlackbox = 'false'; assert.throws(() => fromVivado(input), /布尔值/);
});

test('Vivado cell classification recognizes RTL operators and preserves black boxes', () => {
    const input = fixture();
    input.cells = ['RTL_ADD', 'RTL_MUX', 'RTL_RAM', 'RTL_AND', 'LUT6', 'CUSTOM_IP'].map((type, index) => ({
        name: 'u' + index, type, isSequential: false, isBlackbox: type === 'CUSTOM_IP', ports: []
    }));
    assert.deepEqual(fromVivado(input).modules[0].cells.map(cell => cell.kind), ['arithmetic', 'mux', 'memory', 'logic', 'logic', 'instance']);
});

test('Vivado Tcl entry quotes paths and delegates only to the read-only exporter', () => {
    const text = buildVivadoExportScript({ projectPath: 'C:/work {a}/$x[1].xpr', outputPath: 'C:/work x/out.json', exporterPath: 'C:/extension/vivado-export.tcl' });
    assert.match(text, /svtools_circuit::exportProject/); assert.match(text, /source \{C:\/extension\/vivado-export.tcl\}/);
    assert.ok(text.includes('\\$x\\[1\\]')); assert.ok(text.includes('exit 1')); assert.ok(!/save_project|launch_runs|update_compile_order/.test(text));
    assert.throws(() => buildVivadoExportScript({ projectPath: 'x\nexit 0', outputPath: 'x', exporterPath: 'y' }), /路径无效/);
});
