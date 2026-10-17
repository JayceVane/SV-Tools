'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerSymbol } = require('../src/circuit/register-symbol');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { layoutModule } = require('../src/circuit/layout');

function register(type, parameters = {}) {
    return { type, kind: 'register', parameters, ports: [
        { name: 'D', direction: 'input', bits: ['c:1'] },
        { name: 'CLK', direction: 'input', bits: ['n:2'] },
        { name: 'ALOAD', direction: 'input', bits: ['n:3'] },
        { name: 'AD', direction: 'input', bits: ['c:0'] },
        { name: 'Q', direction: 'output', bits: ['n:4'] },
    ] };
}

test('异步装载触发器从明确参数读取时钟和装载极性，保留真实引脚名', () => {
    const cell = register('$aldff', { CLK_POLARITY: '0001', ALOAD_POLARITY: '0000' });
    const before = JSON.stringify(cell), symbol = registerSymbol(cell);
    assert.equal(symbol.symbol, 'DFF');
    assert.equal(symbol.ports.CLK.role, 'clock');
    assert.equal(symbol.ports.CLK.polarity, 1);
    assert.equal(symbol.ports.ALOAD.polarity, 0);
    assert.match(symbol.ports.CLK.description, /上升沿/);
    assert.match(symbol.ports.ALOAD.description, /异步装载.*低电平.*AD.*0/);
    assert.equal(symbol.ports.AD.role, 'data');
    assert.equal(JSON.stringify(cell), before);
});

test('时钟与控制极性不凭名字或缺失参数猜测，也不把 latch 画成边沿触发器', () => {
    assert.equal(registerSymbol(register('vendor_reg')), null);
    assert.equal(registerSymbol({ ...register('$aldff'), moduleId: 'user-module' }), null);
    for (const value of [undefined, 'x', '10', 2, false]) {
        const symbol = registerSymbol(register('$aldff', { CLK_POLARITY: value }));
        assert.equal(symbol.ports.CLK.polarity, undefined);
        assert.match(symbol.ports.CLK.description, /未知/);
    }
    const negative = registerSymbol(register('$dff', { CLK_POLARITY: 0 }));
    assert.equal(negative.ports.CLK.polarity, 0);
    assert.match(negative.ports.CLK.description, /下降沿/);
    const latch = registerSymbol(register('$dlatch', { EN_POLARITY: '0' }));
    assert.equal(latch.symbol, 'LATCH');
    assert.equal(latch.ports.CLK, undefined);
    assert.equal(latch.ports.EN.polarity, 0);
});

test('复位与使能类型保留同步/异步和优先级，动态 AD 不冒充常量复位', () => {
    for (const [type, pin, parameter, expected] of [
        ['$adff', 'ARST', 'ARST_POLARITY', /异步复位/],
        ['$sdff', 'SRST', 'SRST_POLARITY', /同步复位/],
        ['$dffe', 'EN', 'EN_POLARITY', /使能/],
        ['$dffsr', 'CLR', 'CLR_POLARITY', /异步清零/],
        ['$dffsr', 'SET', 'SET_POLARITY', /异步置位/],
    ]) {
        const symbol = registerSymbol(register(type, { [parameter]: '0', ARST_VALUE: '1010', SRST_VALUE: '0000' }));
        assert.equal(symbol.ports[pin].polarity, 0);
        assert.match(symbol.ports[pin].description, expected);
    }
    assert.match(registerSymbol(register('$sdffe')).description, /复位优先/);
    assert.match(registerSymbol(register('$sdffce')).description, /使能优先/);
    const dynamic = register('$aldff', { ALOAD_POLARITY: '1' });
    dynamic.ports.find(p => p.name === 'AD').bits = ['n:5'];
    assert.doesNotMatch(registerSymbol(dynamic).ports.ALOAD.description, /常量|清零|复位/);
});

test('真实 ELK 布局保留 sync_resetn 的五个端点及全部连接，同时完整容纳控制标签', async () => {
    const original = register('$aldff', { CLK_POLARITY: '1', ALOAD_POLARITY: '0' });
    const directions = Object.fromEntries(original.ports.map(p => [p.name, p.direction]));
    const connections = Object.fromEntries(original.ports.map(p => [p.name, p.bits.map(b => b.startsWith('c:') ? b.slice(2) : Number(b.slice(2)))]));
    const design = fromYosys({ modules: { top: { ports: {
        i_clk: { direction: 'input', bits: [2] }, i_rst_n: { direction: 'input', bits: [3] }, o_rst_n: { direction: 'output', bits: [4] },
    }, cells: { '$reset': { type: '$aldff', parameters: original.parameters, port_directions: directions, connections } } } } });
    const before = JSON.stringify(design), graph = await layoutModule(design, design.top);
    const node = graph.nodes.find(n => n.kind === 'register');
    assert.equal(node.symbol, 'DFF');
    assert.equal(node.ports.find(p => p.label === 'ALOAD').polarity, 0);
    assert.equal(node.ports.find(p => p.label === 'CLK').role, 'clock');
    assert.ok(node.width >= 196);
    assert.equal(node.ports.length, 5);
    assert.equal(graph.edges.length, 5);
    assert.deepEqual(node.parameters, original.parameters);
    for (const port of node.ports) {
        assert.deepEqual(port.bits, original.ports.find(p => p.name === port.label).bits);
        assert.ok(Number.isFinite(port.x) && Number.isFinite(port.y));
        assert.ok(graph.edges.some(e => e.source === port.id || e.target === port.id));
    }
    assert.equal(JSON.stringify(design), before);
});


test('Yosys 异步复位锁存器归类为寄存器，保持 latch 的电平敏感符号', () => {
    const design = fromYosys({ modules: { top: { ports: {}, cells: { latch: {
        type: '$adlatch', parameters: { EN_POLARITY: '0', ARST_POLARITY: '1', ARST_VALUE: '0' },
        port_directions: { EN: 'input', ARST: 'input', D: 'input', Q: 'output' },
        connections: { EN: [2], ARST: [3], D: [4], Q: [5] },
    } } } } });
    const cell = design.modules[0].cells[0];
    assert.equal(cell.kind, 'register');
    const symbol = registerSymbol(cell);
    assert.equal(symbol.symbol, 'LATCH');
    assert.equal(symbol.ports.EN.polarity, 0);
    assert.equal(symbol.ports.ARST.polarity, 1);
    assert.equal(symbol.ports.CLK, undefined);
});
