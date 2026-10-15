'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createDesign, findModule, MAX_BIT_REFERENCES } = require('../src/circuit/model');
const { fromYosys } = require('../src/circuit/adapters/yosys');

function yosysFixture() {
    return { creator: 'Yosys fixture 1.0', modules: {
        lane: { attributes: { src: 'rtl/lane.sv:2.1-5.10' }, parameter_default_values: { W: '00001000' },
            ports: { a: { direction: 'input', bits: [2, 3] }, y: { direction: 'output', bits: [4, 5] } },
            cells: { choose: { type: '$mux', parameters: { WIDTH: '10' }, attributes: { src: 'rtl/lane.sv:3.11-3.28' },
                port_directions: { A: 'input', B: 'input', S: 'input', Y: 'output' },
                connections: { A: [2, 3], B: ['0', '1'], S: ['x'], Y: [4, 5] } } },
            netnames: { a: { bits: [2, 3], hide_name: 0 }, alias: { bits: [2, 3], hide_name: 0 } } },
        top: { attributes: { top: '0001', src: 'C:\\rtl\\top.sv:10.2-20.1|rtl/generated.sv:1.1-2.1' },
            ports: { a: { direction: 'input', bits: [2, 3], offset: -2, upto: 0 }, y: { direction: 'output', bits: [4, 5], offset: 4, upto: 1 } },
            cells: { 'u.lane[0]': { type: 'lane', parameters: { W: '00000010' }, attributes: { src: 'rtl/top.sv:12.5-12.24' }, connections: { a: [2, 'z'], y: [4, 5] } } },
            netnames: { a: { bits: [2, 3], offset: -2, upto: 0, hide_name: 0 }, y: { bits: [4, 5], offset: 4, upto: 1, hide_name: 0 },
                partial: { bits: [3, 4], hide_name: 0 }, '$hidden': { bits: [99], hide_name: 1 } } },
    } };
}
function validDesign() { return fromYosys(yosysFixture()); }

test('Yosys adapter preserves hierarchy, aliases, parameters, constants and LSB-first ranges', () => {
    const design = validDesign(), top = findModule(design, design.top), lane = design.modules.find(module => module.name === 'lane');
    assert.equal(design.schemaVersion, 1);
    assert.equal(top.name, 'top');
    assert.deepEqual(top.ports[0].bits, ['n:2', 'n:3']);
    assert.equal(top.ports[0].offset, -2);
    assert.equal(top.ports[0].upto, false);
    assert.equal(top.ports[1].offset, 4);
    assert.equal(top.ports[1].upto, true);
    assert.equal(top.cells[0].moduleId, lane.id);
    assert.equal(top.cells[0].kind, 'instance');
    assert.equal(top.cells[0].parameters.W, '00000010');
    assert.equal(lane.parameters.W, '00001000');
    assert.deepEqual(lane.signals[0].bits, lane.signals[1].bits);
    assert.deepEqual(lane.cells[0].ports.flatMap(port => port.bits).filter(bit => bit.startsWith('c:')), ['c:0', 'c:1', 'c:x']);
    assert.equal(top.cells[0].ports[0].direction, 'input');
    assert.deepEqual(top.cells[0].ports[0].bits, ['n:2', 'c:z']);
    assert.equal(top.signals.find(signal => signal.name === '$hidden').hidden, true);
});

test('module-local bit identities never connect across hierarchy', () => {
    const design = validDesign(), top = findModule(design, design.top), lane = design.modules.find(module => module.name === 'lane');
    assert.equal(top.ports[0].bits[0], lane.ports[0].bits[0]);
    assert.notEqual(top.ports[0].id, lane.ports[0].id);
    assert.equal(findModule(design, 'missing'), undefined);
});

test('source mapping keeps Windows drive paths and resolves relative source paths', () => {
    const design = fromYosys(yosysFixture(), { sourceRoot: path.resolve('project') });
    const top = findModule(design, design.top), lane = design.modules.find(module => module.name === 'lane');
    assert.deepEqual(top.source, { path: 'C:\\rtl\\top.sv', line: 10, column: 2 });
    assert.equal(lane.source.path, path.resolve('project', 'rtl/lane.sv'));
    assert.equal(top.cells[0].source.line, 12);
});

test('top inference rejects ambiguity and accepts explicit module name or ID', () => {
    const fixture = yosysFixture();
    delete fixture.modules.top.attributes.top;
    assert.equal(findModule(fromYosys(fixture), fromYosys(fixture).top).name, 'top');
    fixture.modules.other = { ports: {}, cells: {}, netnames: {} };
    assert.throws(() => fromYosys(fixture), /multiple possible top/);
    const design = fromYosys(fixture, { top: 'lane', title: 'Chosen lane' });
    assert.equal(design.title, 'Chosen lane');
    assert.equal(fromYosys(fixture, { top: design.top }).top, design.top);
    assert.throws(() => fromYosys(fixture, { top: 'missing' }), /unknown top/);
});

test('Yosys malformed inputs fail instead of producing an empty design', () => {
    for (const raw of [undefined, null, [], {}, { modules: {} }]) assert.throws(() => fromYosys(raw), /Yosys JSON/);
    for (const badBit of [-1, 1.5, '2', 'X', null, {}, Number.MAX_SAFE_INTEGER + 1]) {
        const fixture = yosysFixture();
        fixture.modules.top.ports.a.bits = [badBit];
        assert.throws(() => fromYosys(fixture), /invalid bit/);
    }
    const fixture = yosysFixture();
    fixture.modules.top.ports.a.upto = 2;
    assert.throws(() => fromYosys(fixture), /upto/);
    for (const field of ['attributes', 'netnames', 'cells']) {
        for (const value of [null, false, 0, '']) {
            const invalid = yosysFixture();
            invalid.modules.top[field] = value;
            assert.throws(() => fromYosys(invalid), /Yosys JSON/);
        }
    }
});

test('Yosys structural names that resemble object prototypes remain ordinary identifiers', () => {
    const raw = JSON.parse('{"modules":{"__proto__":{"ports":{"constructor":{"direction":"input","bits":[2]}},"cells":{},"netnames":{"__proto__":{"bits":[2]}}}}}');
    const design = fromYosys(raw);
    assert.equal(design.modules[0].name, '__proto__');
    assert.equal(design.modules[0].ports[0].name, 'constructor');
    assert.equal(design.modules[0].signals[0].name, '__proto__');
    assert.equal(Object.prototype.polluted, undefined);
});

test('model validates duplicate identities, directions, ranges, metadata and hierarchy references', () => {
    const mutations = [
        design => { design.modules.push(structuredClone(design.modules[0])); },
        design => { design.modules[0].signals[0].id = design.modules[0].ports[0].id; },
        design => { design.modules[0].ports[0].direction = 'west'; },
        design => { design.modules[0].ports[0].bits[0] = 'n:'; },
        design => { design.modules[0].ports[0].bits[0] = 'n:bad bit'; },
        design => { design.modules[0].ports[0].offset = .5; },
        design => { design.modules[0].ports[0].offset = Number.MAX_SAFE_INTEGER; },
        design => { design.modules[0].ports[0].upto = 1; },
        design => { design.modules[0].source.column = 0; },
        design => { design.modules[0].attributes = JSON.parse('{"__proto__":"unsafe"}'); },
        design => { design.modules[0].parameters = { W: { value: 4 } }; },
        design => { design.modules[0].cells[0].moduleId = 'missing'; },
        design => { design.top = 'missing'; },
    ];
    for (const mutate of mutations) {
        const design = validDesign();
        mutate(design);
        assert.throws(() => createDesign(design), /Circuit model/);
    }
});

test('model copies validated data without sharing mutable bit arrays or metadata', () => {
    const original = validDesign(), copy = createDesign(original);
    copy.modules[0].ports[0].bits[0] = 'n:999';
    copy.modules[0].parameters.W = 'changed';
    assert.equal(original.modules[0].ports[0].bits[0], 'n:2');
    assert.equal(original.modules[0].parameters.W, '00001000');
});

test('bit reference budgets fail before iterating oversized arrays', () => {
    const fixture = yosysFixture();
    fixture.modules.top.ports.a.bits = new Array(MAX_BIT_REFERENCES + 1);
    assert.throws(() => fromYosys(fixture), /2,000,000 bit references/);
    const design = validDesign();
    design.modules[0].ports[0].bits = new Array(MAX_BIT_REFERENCES + 1);
    assert.throws(() => createDesign(design), /2,000,000 bit references/);
});

test('sparse arrays never bypass bit or entity validation', () => {
    for (const field of ['ports', 'cells', 'signals']) {
        const design = validDesign();
        design.modules[0][field] = new Array(1);
        assert.throws(() => createDesign(design), /expected an object/);
    }
    const fixture = yosysFixture();
    fixture.modules.top.ports.a.bits = new Array(1);
    assert.throws(() => fromYosys(fixture), /invalid bit/);
    const design = validDesign();
    design.modules[0].ports[0].bits = new Array(1);
    assert.throws(() => createDesign(design), /invalid bit/);
});

test('provenance preserves an explicit flat hierarchy limitation', () => {
    const design = validDesign();
    design.provenance.hierarchy = 'flat';
    assert.equal(createDesign(design).provenance.hierarchy, 'flat');
    design.provenance.hierarchy = '';
    assert.throws(() => createDesign(design), /provenance.hierarchy/);
});

test('cell kinds distinguish register, mux, arithmetic, memory, logic and unknown primitives', () => {
    const types = ['$adffe', '$_DFF_P_', '$pmux', '$add', '$mem_v2', '$reduce_or', 'vendor_primitive', '$aldff', '$demux', '$neg', '$lut'];
    const cells = Object.fromEntries(types.map((type, index) => [`c${index}`, { type, connections: {} }]));
    const design = fromYosys({ modules: { top: { ports: {}, cells, netnames: {} } } });
    assert.deepEqual(design.modules[0].cells.map(cell => cell.kind), ['register', 'register', 'mux', 'arithmetic', 'memory', 'logic', 'unknown', 'register', 'mux', 'arithmetic', 'logic']);
});

test('unlowered memories and processes are rejected rather than silently omitted', () => {
    for (const field of ['memories', 'processes']) {
        const fixture = yosysFixture();
        fixture.modules.top[field] = { pending: {} };
        assert.throws(() => fromYosys(fixture), /run prep/);
    }
});
