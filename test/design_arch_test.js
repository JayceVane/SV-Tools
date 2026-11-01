'use strict';
// M3 交付1验收：Yosys 链接空模块后的顶层架构投影（blackbox 保留、未用实例不丢、端口位宽、接口表、边界与错误路径）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { run } = require('../src/cli/main');
const { buildArchitecture, DEFAULT_BUDGET, buildArchScript, classifyYosysFailure, blackboxFlag } = require('../src/design/arch');
const { bundlePorts } = require('../src/design/bundles');

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

test('A1 顶层组合/时序逻辑的 $ 单元不进入架构图', async t => {
    const directory = await workspace(t, 'toplogic');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'logic_top']);
    assert.equal(response.exitCode, 0);
    const data = response.output.data;
    assert.deepEqual(data.instances.map(instance => instance.name), ['u_child']);
    for (const node of data.graph.nodes) {
        assert.equal(node.id.startsWith('instance:$'), false, node.id);
        assert.equal(String(node.name).startsWith('$'), false, node.name);
    }
    assert.equal(data.instances.some(instance => instance.nodeId.includes('$') || instance.module.startsWith('$')), false);
    assert.equal(data.unresolved.length, 0);
    assert.equal(data.graph.nodes.filter(node => node.kind === 'instance').length, 1);
});

test('A2 参数覆盖：实例标签与盒位宽取覆盖值，模块表保留声明默认值', async t => {
    const directory = await workspace(t, 'override');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'override_top']);
    assert.equal(response.exitCode, 0);
    const data = response.output.data;
    const instance = data.instances[0];
    assert.equal(instance.name, 'u_child');
    assert.match(instance.module, /WIDTH\s*=\s*16/);
    assert.deepEqual(portTriples(instance.ports), [['clk', 'input', 1], ['din', 'input', 16], ['dout', 'output', 16]]);
    const declared = data.modules.find(module => module.name.startsWith('child'));
    assert(declared, '接口表应包含声明模块');
    assert.equal(declared.parameters.WIDTH, 8);
    assert.deepEqual(portTriples(declared.ports), [['clk', 'input', 1], ['din', 'input', 8], ['dout', 'output', 8]]);
    assert.equal(data.limitations.some(text => text.includes('参数覆盖')), true);
});

test('A4 折叠子模块内部存储：proc+memory_collect 可输出且无 $mem 节点', async t => {
    const directory = await workspace(t, 'memory');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'mem_top']);
    assert.equal(response.exitCode, 0);
    const data = response.output.data;
    assert.deepEqual(data.instances.map(instance => [instance.name, instance.implementation]), [['u_mem', 'collapsed']]);
    for (const node of data.graph.nodes) {
        assert.equal(/^\$(?:mem|dff)/.test(String(node.name || '')), false, node.name);
        assert.equal(String(node.id).includes('$mem'), false, node.id);
    }
    assert.equal(data.limitations.some(text => text.includes('存储')), true);
    const script = buildArchScript(['/source/top.sv'], [], [], 'top', '/task/circuit.json').split('\n');
    assert.match(script[0], /^read_verilog -sv/);
    assert.equal(script[1], 'hierarchy -top top');
    assert.equal(script[2], 'proc');
    assert.equal(script[3], 'memory_collect');
    assert.match(script[4], /^write_json /);
});

test('blackbox 三形态与 Yosys 失败分类', () => {
    for (const value of [true, 1, '00000000000000000000000000000001']) {
        assert.equal(blackboxFlag(value), true, String(value));
    }
    for (const value of [false, 0, '00000000000000000000000000000000', undefined]) {
        assert.equal(blackboxFlag(value), false, String(value));
    }
    assert.equal(classifyYosysFailure('ERROR: Re-definition of module `\\dup\'').code, 'AMBIGUOUS_MODULE');
    assert.equal(classifyYosysFailure("ERROR: Module `nosuch' not found!").code, 'MODULE_NOT_FOUND');
    assert.equal(classifyYosysFailure('内置 Yosys 资源缺失，请重新安装完整 VSIX').code, 'TOOL_NOT_FOUND');
    assert.equal(classifyYosysFailure('ERROR: syntax error').code, 'DESIGN_FAILED');
});

test('Yosys 语法错误返回 DESIGN_FAILED 并附日志，8MiB 超限仍是 SOURCE_LIMIT', async t => {
    const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-design-error-')));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    await fsp.writeFile(path.join(directory, 'bad.sv'), 'module bad(input logic a; endmodule\n');
    const failed = await run(['design', 'arch', '--workspace', directory, '--top', 'bad']);
    assert.equal(failed.exitCode, 2);
    assert.equal(failed.output.diagnostics[0].code, 'DESIGN_FAILED');
    assert.equal(fs.existsSync(failed.output.data.logPath), true);
    assert.equal(failed.output.artifacts[0].kind, 'log');
    await fsp.writeFile(path.join(directory, 'bad.sv'), 'module big; endmodule\n' + ' '.repeat(8 * 1024 * 1024));
    const limited = await run(['design', 'arch', '--workspace', directory, '--top', 'big']);
    assert.equal(limited.exitCode, 2);
    assert.equal(limited.output.diagnostics[0].code, 'SOURCE_LIMIT');
});

test('inout 补全只使用用户实例，未连接 inout 不产出接口', async t => {
    const leakDirectory = await workspace(t, 'inout-leak');
    const leak = await run(['design', 'arch', '--workspace', leakDirectory, '--top', 'inout_leak_top']);
    assert.equal(leak.exitCode, 0);
    const data = leak.output.data;
    assert.deepEqual(data.instances.map(instance => instance.name), ['u_pad']);
    assert.equal(data.graph.nodes.some(node => String(node.name).startsWith('$')), false);
    assert.equal(data.interfaces.length, 1);
    assert.deepEqual(data.interfaces[0].from, { kind: 'boundary', name: 'io' });
    assert.deepEqual(data.interfaces[0].to, { kind: 'instance', name: 'u_pad' });
    assert.equal(data.interfaces[0].direction, 'bidirectional');
    for (const item of data.interfaces) {
        assert.equal([item.from.name, item.to.name].some(name => name.includes('$')), false);
    }
    const emptyDirectory = await workspace(t, 'inout-empty');
    for (const top of ['inout_empty', 'gpio_empty']) {
        const response = await run(['design', 'arch', '--workspace', emptyDirectory, '--top', top]);
        assert.equal(response.exitCode, 0, top);
        assert.deepEqual(response.output.data.interfaces, [], top);
    }
});

test('边界前缀使用命名空间，gpio 与 gpio_a 不合并', async t => {
    const directory = await workspace(t, 'boundary-collision');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'collision_top']);
    assert.equal(response.exitCode, 0);
    const interfaces = response.output.data.interfaces;
    assert.equal(interfaces.length, 2);
    assert.deepEqual(interfaces.map(item => item.from.name).sort(), ['gpio', 'gpio_a']);
    assert.equal(interfaces.some(item => item.from.name.includes('+')), false);
    assert.deepEqual(interfaces.map(item => item.to.name).sort(), ['u_a', 'u_b']);
});

test('data 含 designId/modelSha256/sourceFiles，sourceFiles 与工作区文件一致', async t => {
    const directory = await workspace(t, 'skeleton');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'fifo_top']);
    assert.equal(response.exitCode, 0);
    const data = response.output.data;
    assert.match(data.designId, /^design:[0-9a-f]{16}$/);
    assert.match(data.modelSha256, /^[0-9a-f]{64}$/);
    assert.equal(data.modelSha256, data.archSha256);
    const expected = fs.readdirSync(directory).filter(name => name.endsWith('.sv')).sort().map(name => ({
        path: name, sha256: createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')
    }));
    assert.deepEqual(data.sourceFiles, expected);
});

test('实例双向对合并，不同源端口集合不误合并', async t => {
    const directory = await workspace(t, 'pairing');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'pairing_top']);
    assert.equal(response.exitCode, 0);
    const interfaces = response.output.data.interfaces;
    const pair = interfaces.filter(item => item.from.kind === 'instance' && item.to.kind === 'instance'
        && [item.from.name, item.to.name].sort().join('|') === 'u_a|u_b');
    assert.equal(pair.length, 1);
    assert.equal(pair[0].direction, 'bidirectional');
    assert.deepEqual(pair[0].signals.map(signal => signal.name).sort(), ['w_ab', 'w_ba']);
    const fromF = interfaces.filter(item => item.from.name === 'u_f');
    assert.equal(fromF.length, 2, '不同源端口集合不得合并');
    assert.deepEqual(fromF.map(item => item.to.name).sort(), ['u_d', 'u_e']);
    assert.equal(fromF.some(item => item.to.name.includes('+')), false);
});

test('端口折叠：前缀聚类守卫、成员守恒与显示名覆盖', () => {
    const ports = [
        { name: 's0_awaddr', width: 32, direction: 'input' },
        { name: 's0_wdata', width: 64, direction: 'input' },
        { name: 's0_rdata', width: 64, direction: 'output' },
        { name: 'm_axi_araddr', width: 32, direction: 'output' },
        { name: 'm_axi_rdata', width: 64, direction: 'input' },
        { name: 'm_valid', width: 1, direction: 'input' },
        { name: 'ddr_cas_n', width: 1, direction: 'output' },
        { name: 'ddr_we_n', width: 1, direction: 'output' },
        { name: 's_awaddr', width: 32, direction: 'input' },
        { name: 's_wdata', width: 32, direction: 'output' },
        { name: 'clk_sys', width: 1, direction: 'input' },
        { name: 'clk_pix', width: 1, direction: 'input' },
        { name: 'rst_n_in', width: 1, direction: 'input' },
        { name: 'irq', width: 4, direction: 'input' }
    ];
    const bundles = bundlePorts(ports);
    assert.deepEqual(bundles.map(bundle => [bundle.name, bundle.direction, bundle.bits, bundle.members.length]), [
        ['s0', 'inout', 160, 3], ['m_axi', 'inout', 96, 2], ['m_valid', 'input', 1, 1], ['ddr', 'output', 2, 2],
        ['s_awaddr', 'input', 32, 1], ['s_wdata', 'output', 32, 1],
        ['clk_sys', 'input', 1, 1], ['clk_pix', 'input', 1, 1], ['rst_n_in', 'input', 1, 1], ['irq', 'input', 4, 1]
    ]);
    assert.deepEqual(bundles[0].members.map(member => member.name), ['s0_awaddr', 's0_wdata', 's0_rdata']);
    assert.equal(bundles.reduce((total, bundle) => total + bundle.members.length, 0), ports.length, '成员总和等于输入端口数');
    const named = bundlePorts(ports, { names: { s0: 's0_axi', m_axi: 'm_axi' } });
    assert.equal(named[0].name, 's0_axi');
    assert.equal(named[0].prefix, 's0');
});

test('packed struct 空模块按结构判 blackbox，含 assign/always_ff 仍 collapsed', async t => {
    const directory = await workspace(t, 'struct-empty');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'struct_empty_top']);
    assert.equal(response.exitCode, 0, JSON.stringify(response.output.diagnostics));
    const instances = new Map(response.output.data.instances.map(item => [item.name, item]));
    assert.deepEqual([instances.get('u_empty').implementation, instances.get('u_empty').empty, instances.get('u_empty').blackboxSource],
        ['blackbox', true, 'structure']);
    assert.equal(instances.get('u_assign').implementation, 'collapsed', 'assign 产生 $and 单元，应为 collapsed');
    assert.equal(instances.get('u_ff').implementation, 'collapsed', 'always_ff 产生 $dff 单元，应为 collapsed');
    const modules = new Map(response.output.data.modules.map(item => [item.name, item]));
    assert.deepEqual([modules.get('leaf_empty').blackbox, modules.get('leaf_empty').empty, modules.get('leaf_empty').blackboxSource],
        [true, true, 'structure']);
    assert.equal(modules.get('leaf_assign').blackbox, false);
    assert.equal(modules.get('leaf_assign').empty, false);
});

test('纯 alias 与常量 assign 不得判为空模块', async t => {
    const directory = await workspace(t, 'alias-empty');
    const response = await run(['design', 'arch', '--workspace', directory, '--top', 'alias_empty_top']);
    assert.equal(response.exitCode, 0, JSON.stringify(response.output.diagnostics));
    const instances = new Map(response.output.data.instances.map(item => [item.name, item]));
    assert.deepEqual([instances.get('u_alias').implementation, instances.get('u_alias').empty, instances.get('u_alias').blackboxSource],
        ['collapsed', false, null]);
    assert.deepEqual([instances.get('u_const').implementation, instances.get('u_const').empty, instances.get('u_const').blackboxSource],
        ['collapsed', false, null]);
    assert.equal(instances.get('u_empty').implementation, 'blackbox');
    assert.equal(instances.get('u_empty').empty, true);
    const modules = new Map(response.output.data.modules.map(item => [item.name, item]));
    assert.deepEqual([modules.get('alias_mod').blackbox, modules.get('alias_mod').empty], [false, false]);
    assert.deepEqual([modules.get('const_mod').blackbox, modules.get('const_mod').empty], [false, false]);
    assert.equal(modules.get('empty_mod').blackbox, true);
    assert.equal(modules.get('empty_mod').empty, true);
});

test('端口折叠前缀必须是完整的下划线 token，m_axi 与 m_axil/m_axis 不误合并', () => {
    const ports = [
        { name: 'm_axi_araddr', width: 32, direction: 'output' },
        { name: 'm_axi_rdata', width: 64, direction: 'input' },
        { name: 'm_axil_awaddr', width: 32, direction: 'output' },
        { name: 'm_axis_tdata', width: 32, direction: 'output' }
    ];
    const bundles = bundlePorts(ports);
    assert.deepEqual(bundles.map(bundle => [bundle.name, bundle.members.length, bundle.bits]), [
        ['m_axi', 2, 96], ['m_axil_awaddr', 1, 32], ['m_axis_tdata', 1, 32]
    ]);
    assert.deepEqual(bundles.find(bundle => bundle.name === 'm_axil_awaddr').members.map(member => member.name), ['m_axil_awaddr']);
    assert.equal(bundles.reduce((total, bundle) => total + bundle.members.length, 0), ports.length);
    const merged = bundlePorts([
        { name: 'm_axi_araddr', width: 32, direction: 'output' },
        { name: 'm_axi_rdata', width: 64, direction: 'input' }
    ]);
    assert.deepEqual(merged.map(bundle => [bundle.name, bundle.members.length]), [['m_axi', 2]]);
});
