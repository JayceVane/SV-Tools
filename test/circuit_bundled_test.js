'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createToolTaskManager } = require('../src/toolchains/job');
const { prepareSourceRequest } = require('../src/circuit/source-request');
const { runYosysCircuit } = require('../src/circuit/yosys-runner');
const { CircuitSession } = require('../src/circuit/session');

for (const frontend of ['verilog', 'slang']) test(`内置 ${frontend} 无 PATH 工具完成含空格/中文路径、宏、相对 readmem 和脏正文回映射`, { timeout: 30000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-bundled-'));
    const workspace = path.join(root, 'workspace'), sources = path.join(root, 'RTL space 中文');
    const headers = path.join(root, 'include space'), artifacts = path.join(root, 'output space');
    for (const folder of [workspace, sources, headers]) await fs.mkdir(folder);
    const original = path.join(sources, 'top.sv'), disk = 'module disk; endmodule\n';
    await fs.writeFile(original, disk);
    await fs.writeFile(path.join(headers, 'width.vh'), '`define WIDTH 8\n');
    await fs.writeFile(path.join(workspace, 'data.hex'), '01\n02\n03\n04\n');
    const manager = createToolTaskManager(), task = manager.start('bundled-test');
    const session = new CircuitSession();
    t.after(async () => {
        session.dispose(); task.cancel(); await task.finish({ keepArtifacts: true });
        await manager.dispose(); await fs.rm(root, { recursive: true, force: true });
    });
    const text = '`include "width.vh"\nmodule top(input [1:0] address, input [`WIDTH-1:0] a, output [`WIDTH-1:0] y);\n'
        + 'reg [`WIDTH-1:0] mem [0:3];\ninitial $readmemh("data.hex", mem);\nassign y = mem[address] + a + `STEP;\nendmodule\n';
    const request = await prepareSourceRequest({ document: { uri: { fsPath: original }, isDirty: true, getText: () => text },
        root: workspace, task, top: 'top', outputBase: artifacts,
        config: { frontend, includeDirs: [headers], defines: ['STEP=(1 + 2)'] } });
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
    const generated = await runYosysCircuit({ ...request, task, outputBase: artifacts, executable: 'bundled',
        timeoutMs: 20000, env: { ...process.env, [pathKey]: '' } });
    const raw = JSON.parse(await fs.readFile(generated.filePath, 'utf8'));
    assert.match(raw.creator, /^Yosys 0\.68/);
    const memory = Object.values(raw.modules.top.cells).find(cell => cell.type === '$mem_v2');
    assert.ok(memory, '真实工具应保留已收集存储器');
    assert.match(memory.parameters.INIT, /00000001$/);
    const descriptor = await session.request('load', { ...generated, sourceMap: request.sourceMap, top: 'top', stage: 'rtl' });
    const source = await session.request('source', { moduleId: descriptor.top });
    assert.equal(path.resolve(source.path), path.resolve(original));
    const graph = await session.request('layout', { moduleId: descriptor.top });
    assert.ok(graph.nodes.some(node => node.kind === 'memory'));
    assert.equal(await fs.readFile(original, 'utf8'), disk);
    await task.finish({ keepArtifacts: true });
});

for (const scope of ['compilation-unit', 'module']) test(`默认内置前端支持${scope}的timeunit/timeprecision并保留异步复位语义`, { timeout: 30000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-timeunit-'));
    const original = path.join(root, 'sync_resetn.sv'), outputBase = path.join(root, 'tasks');
    const timing = 'timeunit 1ns;\ntimeprecision 1ps;\n';
    const body = 'module sync_resetn(input i_clk, input i_rst_n, output reg o_rst_n);\n'
        + (scope === 'module' ? timing : '')
        + 'always @(posedge i_clk or negedge i_rst_n) begin\n'
        + 'if (!i_rst_n) o_rst_n <= 0; else o_rst_n <= 1;\nend\nendmodule\n';
    const text = (scope === 'compilation-unit' ? timing : '') + body;
    const disk = scope === 'module' ? 'module disk; endmodule\n' : text;
    await fs.writeFile(original, disk);
    const manager = createToolTaskManager(), task = manager.start('timeunit-test'), session = new CircuitSession();
    t.after(async () => {
        session.dispose(); task.cancel(); await task.finish({ keepArtifacts: true });
        await manager.dispose(); await fs.rm(root, { recursive: true, force: true });
    });
    const request = await prepareSourceRequest({ task, root, top: 'sync_resetn', config: {}, outputBase,
        document: { uri: { fsPath: original }, isDirty: scope === 'module', getText: () => text } });
    const generated = await runYosysCircuit({ ...request, task, outputBase });
    const raw = JSON.parse(await fs.readFile(generated.filePath, 'utf8')), module = raw.modules.sync_resetn;
    const cell = Object.values(module.cells).find(cell => cell.type === '$aldff');
    assert.ok(cell, '应保留带异步装载的触发器');
    assert.equal(parseInt(cell.parameters.ALOAD_POLARITY, 2), 0);
    assert.equal(parseInt(cell.parameters.CLK_POLARITY, 2), 1);
    assert.deepEqual(cell.connections.AD, ['0']); assert.deepEqual(cell.connections.D, ['1']);
    for (const [pin, port] of [['CLK','i_clk'], ['ALOAD','i_rst_n'], ['Q','o_rst_n']]) assert.deepEqual(cell.connections[pin], module.ports[port].bits);
    const descriptor = await session.request('load', { ...generated, sourceMap: request.sourceMap, top: 'sync_resetn', stage: 'rtl' });
    const graph = await session.request('layout', { moduleId: descriptor.top });
    assert.ok(graph.nodes.some(node => node.kind === 'register'));
    const source = await session.request('source', { moduleId: descriptor.top });
    assert.equal(path.resolve(source.path), path.resolve(original));
    assert.equal(await fs.readFile(original, 'utf8'), disk);
    assert.match(await fs.readFile(path.join(path.dirname(generated.filePath), 'circuit.ys'), 'utf8'), /^read_slang /);
});
