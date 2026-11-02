'use strict';
// design check/diff：结构诊断逐项可指认（悬空/无驱动/多驱动/隐式扩展/缺失模块），
// 常量驱动不产生假诊断；快照对比报告实例/模块/端口/接口差异并单列补实现信号。
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli/main');

const FIXTURES = path.join(__dirname, 'fixtures', 'design');

/** @param {object} t 测试上下文 @param {string} name fixture 名称。 @returns {Promise<string>} 隔离工作区。 */
async function workspace(t, name) {
    const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-check-')));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    await fsp.cp(path.join(FIXTURES, name), directory, { recursive: true });
    return directory;
}

test('design check 指认悬空、无驱动、多驱动、隐式扩展与缺失模块', async t => {
    const directory = await workspace(t, 'check');
    const response = await run(['design', 'check', '--workspace', directory, '--top', 'check_top']);
    assert.equal(response.exitCode, 1, '存在 error 级结构问题时退出码为 1');
    assert.equal(response.output.status, 'failed');
    assert.equal(response.output.data.status, 'errors');
    const byCode = Object.fromEntries(response.output.data.checks.map(item => [item.code, item]));
    // 4 error：缺失模块、悬空 input、网络无驱动 input、多驱动；每条可指认到实例/端口/来源行。
    assert.equal(response.output.data.errorCount, 4);
    assert.equal(byCode.UNRESOLVED_MODULE.details.instance, 'u_g');
    assert.match(byCode.UNRESOLVED_MODULE.message, /ghost_mod/);
    assert.equal(byCode.UNRESOLVED_MODULE.source.file, 'check_top.sv');
    assert.equal(byCode.UNDRIVEN_INPUT.details.instance, 'u_b');
    assert.equal(byCode.UNDRIVEN_INPUT.details.port, 'wide_in');
    assert.deepEqual(byCode.MULTI_DRIVER.details.drivers, ['u_a/used_out', 'u_b/used_out']);
    assert.equal(byCode.MULTI_DRIVER.details.width, 4);
    // 4 warning：两个悬空 output、顶层无驱动输出、隐式扩展。
    assert.equal(response.output.data.warningCount, 4);
    assert.equal(response.output.data.checks.filter(item => item.code === 'UNCONNECTED_PORT').length, 2);
    assert.equal(byCode.UNDRIVEN_OUTPUT.details.port, 'dangling_out');
    assert.equal(byCode.WIDTH_MISMATCH.details.connectedWidth, 4);
    assert.equal(byCode.WIDTH_MISMATCH.details.declaredWidth, 8);
    // 常量驱动（const_in 8'h00）不产生任何假诊断：无 UNDRIVEN、无假 MULTI_DRIVER。
    assert.equal(response.output.data.checks.some(item => item.message.includes('const_in')), false);
    // 诊断进入顶层 diagnostics，与 data.checks 一致。
    assert.equal(response.output.diagnostics.length, response.output.data.checks.length);
    // 同一源码两次检查结果确定。
    const again = await run(['design', 'check', '--workspace', directory, '--top', 'check_top']);
    assert.deepEqual(again.output.data.checks, response.output.data.checks);
});

test('design check 干净设计返回 clean 且退出码 0', async t => {
    const directory = await workspace(t, 'skeleton');
    const response = await run(['design', 'check', '--workspace', directory, '--top', 'fifo_top']);
    assert.equal(response.exitCode, 0, JSON.stringify(response.output.data && response.output.data.checks));
    assert.equal(response.output.data.status, 'clean');
    assert.deepEqual(response.output.data.checks, []);
});

test('design arch 数据自带 checks；check 与 arch 的诊断一致', async t => {
    const directory = await workspace(t, 'check');
    const check = await run(['design', 'check', '--workspace', directory, '--top', 'check_top']);
    const arch = await run(['design', 'arch', '--workspace', directory, '--top', 'check_top']);
    assert.equal(arch.exitCode, 0);
    assert.deepEqual(arch.output.data.checks, check.output.data.checks);
});

test('design diff 报告补实现、实例增删与端口变化；未变化时为 unchanged', async t => {
    const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-diff-')));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'top.sv');
    // v1：leaf 为空骨架（blackbox），top 悬空输出 leaf_y。
    await fsp.writeFile(file, [
        'module leaf (input logic a, output logic y);',
        'endmodule',
        'module diff_top (input logic clk, output logic leaf_y);',
        '    leaf u_leaf (.a(clk), .y(leaf_y));',
        'endmodule',
        ''
    ].join('\n'));
    const saved = await run(['design', 'arch', '--workspace', directory, '--top', 'diff_top', '--save', 'v1']);
    assert.equal(saved.exitCode, 0, JSON.stringify(saved.output.diagnostics));
    // 源码未变时 diff 为 unchanged。
    const same = await run(['design', 'diff', '--workspace', directory, '--top', 'diff_top', '--baseline', 'v1']);
    assert.equal(same.exitCode, 0);
    assert.equal(same.output.data.status, 'unchanged');
    assert.deepEqual(same.output.data.diff.implemented, []);
    // v2：leaf 补实现（blackbox→collapsed）、新增实例、顶层端口位宽变化。
    await fsp.writeFile(file, [
        'module leaf (input logic a, output logic y);',
        '    assign y = ~a;',
        'endmodule',
        'module extra (input logic b, output logic c);',
        'endmodule',
        'module diff_top (input logic clk, input logic en, output logic [3:0] leaf_y);',
        '    wire [3:0] bus;',
        '    leaf u_leaf (.a(clk), .y(bus[0]));',
        '    extra u_extra (.b(en), .c(bus[1]));',
        '    assign leaf_y = bus;',
        'endmodule',
        ''
    ].join('\n'));
    const changed = await run(['design', 'diff', '--workspace', directory, '--top', 'diff_top', '--baseline', 'v1']);
    assert.equal(changed.exitCode, 0);
    const diff = changed.output.data.diff;
    assert.equal(changed.output.data.status, 'changed');
    assert.deepEqual(diff.implemented, ['u_leaf'], '空骨架补实现是 diff 的核心信号');
    assert.deepEqual(diff.instances.added.map(item => item.name), ['u_extra']);
    assert.deepEqual(diff.instances.removed, []);
    assert.equal(diff.summary.implementedInstances, 1);
    assert.equal(diff.topPorts.added.some(item => item.name === 'en'), true);
    const leafY = diff.topPorts.changed.find(item => item.name === 'leaf_y');
    assert.deepEqual(leafY.changes.width, { baseline: 1, current: 4 });
    assert.equal(diff.sourceFiles.changed.some(item => item.path === 'top.sv'), true);
    // 基线身份保留在结果中，可追溯到快照。
    assert.equal(changed.output.data.baseline.name, 'v1');
    assert.match(changed.output.data.baseline.archSha256, /^[0-9a-f]{64}$/);
});

test('design diff 基线不存在、顶层不一致与非法基线返回稳定错误', async t => {
    const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-diff-err-')));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    await fsp.writeFile(path.join(directory, 'top.sv'), 'module diff_top (input logic a); endmodule\n');
    const missing = await run(['design', 'diff', '--workspace', directory, '--top', 'diff_top', '--baseline', 'nope']);
    assert.equal(missing.exitCode, 2);
    assert.equal(missing.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    assert.match(missing.output.diagnostics[0].message, /快照不存在/);
    await fsp.writeFile(path.join(directory, 'bad.json'), '{"schemaVersion": 9}');
    const invalid = await run(['design', 'diff', '--workspace', directory, '--top', 'diff_top', '--baseline', 'bad.json']);
    assert.equal(invalid.exitCode, 2);
    assert.match(invalid.output.diagnostics[0].message, /不是架构快照/);
    await fsp.writeFile(path.join(directory, 'other.json'), JSON.stringify({ schemaVersion: 1, stage: 'source', graph: {}, top: { name: 'other_top' }, instances: [], modules: [], interfaces: [], sourceFiles: [] }));
    const mismatched = await run(['design', 'diff', '--workspace', directory, '--top', 'diff_top', '--baseline', 'other.json']);
    assert.equal(mismatched.exitCode, 2);
    assert.match(mismatched.output.diagnostics[0].message, /顶层 other_top 与 --top diff_top 不一致/);
    const noBaseline = await run(['design', 'diff', '--workspace', directory, '--top', 'diff_top']);
    assert.equal(noBaseline.exitCode, 2);
    assert.match(noBaseline.output.diagnostics[0].message, /--baseline/);
});

test('capabilities 包含 design.check 与 design.diff', async t => {
    const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-cap-')));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    const response = await run(['doctor', '--workspace', directory]);
    assert.equal(response.output.data.capabilities.includes('design.check'), true);
    assert.equal(response.output.data.capabilities.includes('design.diff'), true);
    const help = await run(['--help']);
    assert.match(help.text, /design check --top/);
    assert.match(help.text, /design diff --top <module> --baseline/);
});
