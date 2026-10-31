'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { projectModule } = require('../src/circuit/projection');
const { layoutModule } = require('../src/circuit/layout');

function fixture({ readEnable = '0', readClock = ['x'], parameters = {}, type = '$mem_v2', otherUnknown = false } = {}) {
    return { modules: { top: { ports: {
        i_clk_rd: { direction: 'input', bits: [2] }, i_clk_wr: { direction: 'input', bits: [3] },
        address: { direction: 'input', bits: [4, 5] }, data: { direction: 'input', bits: [6, 7] },
        q: { direction: 'output', bits: [8, 9] },
    }, cells: {
        mem: { type, parameters: { RD_PORTS: 1, WR_PORTS: 1, RD_CLK_ENABLE: readEnable, RD_CLK_POLARITY: '1',
            WR_CLK_ENABLE: '1', WR_CLK_POLARITY: '1', ...parameters },
            port_directions: { RD_CLK: 'input', RD_ADDR: 'input', RD_DATA: 'output', WR_CLK: 'input', WR_ADDR: 'input', WR_DATA: 'input', WR_EN: 'input' },
            connections: { RD_CLK: readClock, RD_ADDR: [4, 5], RD_DATA: [10, 11], WR_CLK: [3], WR_ADDR: [4, 5], WR_DATA: [6, 7], WR_EN: ['1', '1'] } },
        output_ff: { type: '$dff', parameters: { CLK_POLARITY: '1', WIDTH: 2 }, port_directions: { CLK: 'input', D: 'input', Q: 'output' },
            connections: { CLK: [2], D: [10, 11], Q: [8, 9] } },
        ...(otherUnknown ? { actual_unknown: { type: '$not', port_directions: { A: 'input', Y: 'output' }, connections: { A: ['x'], Y: [12] } } } : {}),
    }, netnames: {} } } };
}

test('异步存储器隐藏无效读时钟，输出寄存器仍由真实读时钟驱动且原模型不变', async () => {
    const design = fromYosys(fixture()), before = JSON.stringify(design);
    const graph = await layoutModule(design, design.top), mem = graph.nodes.find(node => node.toolName === 'mem');
    assert.ok(!mem.ports.some(port => port.label === 'RD_CLK'));
    assert.match(mem.modeLabel, /异步读.*同步写/);
    assert.match(mem.description, /RD_CLK.*未使用/);
    assert.equal(mem.ports.find(port => port.label === 'WR_CLK').role, 'clock');
    assert.equal(mem.ports.find(port => port.label === 'WR_CLK').polarity, 1);
    assert.ok(!graph.nodes.some(node => node.kind === 'constant' && node.ports.some(port => port.bits.includes('c:x'))));
    const ff = graph.nodes.find(node => node.toolName === 'output_ff'), clk = ff.ports.find(port => port.label === 'CLK');
    assert.deepEqual(clk.bits, ['n:2']);
    assert.ok(graph.edges.some(edge => edge.target === clk.id && edge.bits.includes('n:2')));
    assert.equal(JSON.stringify(design), before);
    assert.deepEqual(design.modules[0].cells.find(cell => cell.name === 'mem').ports.find(port => port.name === 'RD_CLK').bits, ['c:x']);
});

test('同步读时钟即使接X仍必须显示，其他逻辑中的有效X常量也不被删除', () => {
    for (const readEnable of ['1', undefined, 'x', 'not-a-mask']) {
        const raw = fixture({ readEnable, otherUnknown: true });
        if (readEnable === undefined) delete raw.modules.top.cells.mem.parameters.RD_CLK_ENABLE;
        const design = fromYosys(raw), graph = projectModule(design, design.top);
        const mem = graph.nodes.find(node => node.toolName === 'mem');
        assert.ok(mem.ports.some(port => port.label === 'RD_CLK'), String(readEnable));
        assert.ok(graph.nodes.some(node => node.kind === 'constant' && node.ports.some(port => port.bits.includes('c:x'))));
    }
    const design = fromYosys(fixture({ otherUnknown: true })), graph = projectModule(design, design.top);
    assert.ok(!graph.nodes.find(node => node.toolName === 'mem').ports.some(port => port.label === 'RD_CLK'));
    assert.ok(graph.nodes.some(node => node.kind === 'constant' && node.ports.some(port => port.bits.includes('c:x'))));
});

test('局部追踪在生成常量前移除未使用时钟，不遗留孤立X占位且保留原始追踪结果', () => {
    const { projectTrace } = require('../src/circuit/trace-projection');
    const design = fromYosys(fixture()), module = design.modules[0];
    const result = { moduleId: module.id, direction: 'drivers', context: [], cells: [], transitions: [], boundaries: [],
        selections: [...module.ports, ...module.cells.flatMap(cell => cell.ports)].map(port => ({ objectId: port.id, positions: port.bits.map((_, i) => i) })),
        origin: { kind: 'port', objectId: module.ports[4].id }, truncated: false };
    const before = JSON.stringify(result), graph = projectTrace(design, result, 'memory');
    assert.ok(!graph.nodes.find(node => node.toolName === 'mem').ports.some(port => port.label === 'RD_CLK'));
    assert.ok(!graph.nodes.some(node => node.kind === 'constant' && node.ports.some(port => port.originalBits?.includes('c:x'))));
    const ff = graph.nodes.find(node => node.toolName === 'output_ff');
    assert.deepEqual(ff.ports.find(port => port.label === 'CLK').originalBits, ['n:2']);
    assert.equal(JSON.stringify(result), before);
});

test('多口混合模式保留完整时钟总线，并明确标出各读口的同步与异步属性', () => {
    const design = fromYosys(fixture({ readEnable: '10', readClock: ['x', 2], parameters: { RD_PORTS: 2, RD_CLK_POLARITY: '10' } }));
    const graph = projectModule(design, design.top), mem = graph.nodes.find(node => node.toolName === 'mem');
    assert.match(mem.modeLabel, /混合读/);
    assert.deepEqual(mem.ports.find(port => port.label === 'RD_CLK').bits, ['c:x', 'n:2']);
    assert.match(mem.description, /读口0.*异步.*读口1.*同步/);
});

test('异步写时钟隐藏；用户同名模块不按Yosys内置存储器解释', () => {
    const design = fromYosys(fixture({ readEnable: '1', readClock: [2], type: '$mem', parameters: { WR_CLK_ENABLE: 0 } }));
    const mem = projectModule(design, design.top).nodes.find(node => node.toolName === 'mem');
    assert.ok(!mem.ports.some(port => port.label === 'WR_CLK'));
    assert.match(mem.modeLabel, /同步读.*异步写/);
    const raw = fixture(); raw.modules.$mem_v2 = { ports: {}, cells: {}, netnames: {} };
    const user = fromYosys(raw, { top: 'top' }), instance = projectModule(user, user.top).nodes.find(node => node.toolName === 'mem');
    assert.ok(instance.ports.some(port => port.label === 'RD_CLK'));
    assert.equal(instance.modeLabel, undefined);
});
