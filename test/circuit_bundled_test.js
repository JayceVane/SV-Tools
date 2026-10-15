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
