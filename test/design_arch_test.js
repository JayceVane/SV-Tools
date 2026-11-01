'use strict';
// M3 交付1验收：Yosys 链接空模块后的顶层架构投影（blackbox 保留、未用实例不丢、端口位宽、接口表、边界与错误路径）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../src/cli/main');
const { buildArchitecture, DEFAULT_BUDGET } = require('../src/design/arch');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'design');

/** @param {string} directory @returns {{path:string,text:string}[]} 递归读取目录中的源码文件。 */
function readDirectory(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return entry.name === '.svtools' ? [] : readDirectory(file);
        }
        return entry.isFile() ? [{ path: file, text: fs.readFileSync(file, 'utf8') }] : [];
    });
}

/** @param {object} t 测试上下文 @param {string} name fixture 名称 @returns {Promise<string>} 隔离工作区（避免测试写入仓库夹具）。 */
async function workspace(t, name) {
    const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-design-')));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    await fsp.cp(path.join(FIXTURES, name), directory, { recursive: true });
    return directory;
}

/** @param {string} directory @returns {Promise<object>} 只含源码文本的文件列表。 */
async function sources(directory) {
    return readDirectory(directory);
}

/** @param {object} data 架构数据 @returns {object[]} 端口名·方向·位宽三元组。 */
function portTriples(ports) {
    return ports.map(port => [port.name, port.direction, port.width]);
}

test('skeleton：两个 blackbox 实例、端口位宽、顶层端口边界与 6 条边', async t => {
    const directory = await workspace(t, 'skeleton');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'fifo_top']);
    assert.equal(response.exitCode, 0);
    assert.equal(response.output.operation, 'design.arch');
    const data = response.output.data;
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.stage, 'source');
    assert.equal(data.top.name, 'fifo_top');
    assert.match(data.archSha256, /^[0-9a-f]{64}$/);
    assert.match(data.contextRevision, /^[0-9a-f]{64}$/);
    assert.equal(data.modules.length, 3);
    assert.deepEqual(data.modules.map(module => [module.name, module.blackbox]), [['fifo_top', false], ['fifo_buf #(WIDTH=8)', true], ['axis_sink', true]]);
    const fifoBuf = data.modules.find(module => module.name.startsWith('fifo_buf'));
    assert.deepEqual(fifoBuf.parameters, { WIDTH: 8 });
    assert.deepEqual(portTriples(fifoBuf.ports), [['clk', 'input', 1], ['din', 'input', 8], ['dout', 'output', 8]]);
    assert.equal(fifoBuf.ports[1].source.file, 'fifo_buf.sv');
    assert.deepEqual(data.instances.map(instance => [instance.name, instance.implementation, instance.status]), [['u_buf', 'blackbox', 'resolved'], ['u_sink', 'blackbox', 'resolved']]);
    assert.deepEqual(portTriples(data.instances[0].ports), [['clk', 'input', 1], ['din', 'input', 8], ['dout', 'output', 8]]);
    assert.deepEqual(portTriples(data.instances[1].ports), [['clk', 'input', 1], ['tdata', 'input', 8], ['tready', 'output', 1]]);
    const boundaries = data.graph.nodes.filter(node => node.kind === 'boundary');
    assert.deepEqual(boundaries.map(node => [node.id, node.direction]), [['boundary:clk', 'input'], ['boundary:din', 'input'], ['boundary:dout', 'output'], ['boundary:ready', 'output']]);
    assert.equal(data.graph.nodes.filter(node => node.kind === 'instance').length, 2);
    assert.equal(data.graph.edges.length, 6);
    const widths = data.graph.edges.map(edge => edge.width).sort((left, right) => left - right);
    assert.deepEqual(widths, [1, 1, 1, 8, 8, 8]);
    const busEdge = data.graph.edges.find(edge => edge.targetNode === 'instance:u_sink' && edge.targetPort === 'tdata');
    assert.equal(busEdge.width, 8);
    assert.equal(busEdge.netNames.includes('buf_out'), true);
    assert.deepEqual(data.graph.stats, { bits: 18, undrivenBits: 0, multiDriverBits: 0, ambiguousBits: 0, modules: 3, instances: 2, boundaries: 4, nodes: 6, edges: 6, depth: 1 });
    assert.deepEqual(data.unresolved, []);
    assert.equal(data.limitations.some(text => text.includes('未综合')), true);
});

test('filled：实现已补仍折叠为盒，hierarchy+proc 生成 JSON 且保留 2 个实例', async t => {
    const directory = await workspace(t, 'filled');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'fifo_top']);
    assert.equal(response.exitCode, 0);
    const data = response.output.data;
    assert.deepEqual(data.instances.map(instance => [instance.name, instance.implementation]), [['u_buf', 'collapsed'], ['u_sink', 'collapsed']]);
    assert.equal(data.modules.filter(module => module.blackbox).length, 0);
    assert.equal(data.graph.edges.length, 6);
    assert.deepEqual(portTriples(data.instances[0].ports), [['clk', 'input', 1], ['din', 'input', 8], ['dout', 'output', 8]]);
});

test('unused-instance：输出未连接的实例不被优化掉', async t => {
    const directory = await workspace(t, 'unused-instance');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'fifo_top']);
    assert.equal(response.exitCode, 0);
    const data = response.output.data;
    assert.deepEqual(data.instances.map(instance => instance.name), ['u_buf', 'u_sink']);
    const sink = data.instances.find(instance => instance.name === 'u_sink');
    assert.equal(sink.implementation, 'blackbox');
    assert.deepEqual(portTriples(sink.ports), [['clk', 'input', 1], ['tdata', 'input', 8], ['tready', 'output', 1]]);
    assert.equal(data.graph.edges.length, 5);
    assert.deepEqual(data.graph.stats.boundaries, 3);
});

test('重复声明返回 AMBIGUOUS_MODULE 与全部候选', async t => {
    const directory = await workspace(t, 'ambiguous');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'dup_top']);
    assert.equal(response.exitCode, 2);
    assert.equal(response.output.status, 'failed');
    assert.equal(response.output.diagnostics[0].code, 'AMBIGUOUS_MODULE');
    assert.deepEqual(response.output.data.names, ['dup_mod']);
    assert.deepEqual(response.output.data.candidates, [
        { name: 'dup_mod', file: 'dup_a.sv', line: 2 },
        { name: 'dup_mod', file: 'dup_b.sv', line: 2 }
    ]);
});

test('顶层缺失返回 MODULE_NOT_FOUND', async t => {
    const directory = await workspace(t, 'skeleton');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'nosuch']);
    assert.equal(response.exitCode, 2);
    assert.equal(response.output.diagnostics[0].code, 'MODULE_NOT_FOUND');
});

test('缺失子模块记为 unresolved 且不伪造端口表', async t => {
    const directory = await workspace(t, 'unresolved');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'ghost_top']);
    assert.equal(response.exitCode, 0);
    const data = response.output.data;
    assert.deepEqual(data.modules.map(module => module.name), ['ghost_top']);
    assert.equal(data.instances.length, 1);
    assert.equal(data.instances[0].status, 'unresolved');
    assert.deepEqual(data.instances[0].ports, []);
    assert.equal(data.graph.nodes.find(node => node.id === 'instance:u_ghost').ports.length, 0);
    assert.deepEqual(data.unresolved, [{ kind: 'instance', name: 'u_ghost', module: 'ghost_mod', instance: 'instance:u_ghost', source: { file: 'ghost_top.sv', line: 6, column: 15 } }]);
    assert.equal(data.limitations.some(text => text.includes('unresolved')), true);
});

test('接口表字段与 --save 落盘可被后续命令读取', async t => {
    const directory = await workspace(t, 'skeleton');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'fifo_top', '--save', 'arch-1']);
    assert.equal(response.exitCode, 0);
    const data = response.output.data;
    for (const module of data.modules) {
        for (const port of module.ports) {
            assert.equal(typeof port.name, 'string');
            assert(['input', 'output', 'inout', 'unknown'].includes(port.direction));
            assert.equal(Number.isSafeInteger(port.width) && port.width >= 1, true);
        }
    }
    assert.deepEqual(data.snapshot.name, 'arch-1');
    assert.equal(data.snapshot.sha256, data.archSha256);
    const stored = JSON.parse(await fsp.readFile(path.join(directory, '.svtools', 'agent', 'design', 'arch-1.json'), 'utf8'));
    assert.equal(stored.archSha256, data.archSha256);
    assert.equal(stored.instances.length, 2);
});

test('预算超限返回 DESIGN_LIMIT 且不截断', async t => {
    assert.deepEqual({ ...DEFAULT_BUDGET }, { modules: 4096, instances: 20000, edges: 50000 });
    const directory = await workspace(t, 'skeleton');
    const files = await sources(directory);
    await assert.rejects(buildArchitecture({ workspace: directory, files, top: 'fifo_top', budget: { modules: 1 } }), error => {
        assert.equal(error.code, 'DESIGN_LIMIT');
        assert.equal(error.details.kind, 'modules');
        return true;
    });
    await assert.rejects(buildArchitecture({ workspace: directory, files, top: 'fifo_top', budget: { instances: 1 } }), error => {
        assert.equal(error.code, 'DESIGN_LIMIT');
        assert.equal(error.details.kind, 'instances');
        return true;
    });
    await assert.rejects(buildArchitecture({ workspace: directory, files, top: 'fifo_top', budget: { edges: 1 } }), error => {
        assert.equal(error.code, 'DESIGN_LIMIT');
        assert.equal(error.details.kind, 'edges');
        return true;
    });
});

test('capabilities 增加 design.arch，CLI 子进程输出单份 JSON', async t => {
    const directory = await workspace(t, 'skeleton');
    const doctor = await run(['doctor', '--workspace', directory]);
    assert.equal(doctor.exitCode, 0);
    assert.equal(doctor.output.data.capabilities.includes('design.arch'), true);
    const cli = path.join(ROOT, 'src', 'cli', 'main.js');
    const child = spawnSync(process.execPath, [cli, 'design', 'arch', '--workspace', directory, '--top', 'fifo_top'], { encoding: 'utf8' });
    assert.equal(child.status, 0);
    const output = JSON.parse(child.stdout);
    assert.equal(output.operation, 'design.arch');
    assert.deepEqual(output.data.instances.map(instance => instance.name), ['u_buf', 'u_sink']);
    assert.equal(output.data.graph.edges.length, 6);
});
