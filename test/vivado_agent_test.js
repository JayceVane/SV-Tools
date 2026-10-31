'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const tasks = require('../src/agent/tasks');
const { status, report, createProject, addFiles, setTop } = require('../src/agent/vivado');

async function fixture(t) {
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-vivado-agent-')));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    await fs.writeFile(path.join(workspace, 'top.xpr'), '<Project/>');
    await fs.writeFile(path.join(workspace, 'top.sv'), 'module top;endmodule');
    return workspace;
}
// 与真实2022.1.2输出同构：版本/器件/tops/runs、时序路径数值与null。
const statusMarkers = 'SVTOOLS_JSON {"version":"2022.1.2","part":"xc7z100ffg900-2","tops":{"sources":"sfifo","sim":null},"runs":[{"name":"synth_1","status":"synth_design Complete!","progress":"100%"}]}\nSVTOOLS_DONE\n';
const timingMarkers = 'SVTOOLS_JSON {"run":"impl_1","paths":[{"name":"a/C --> b/D","slack":0.123,"startpoint":"a/C","endpoint":"b/D","pathgroup":null,"logic":3}]}\nSVTOOLS_DONE\n';

test('状态查询解析真实marker结构并绑定工程上下文', async t => {
    const workspace = await fixture(t);
    const output = await status({ workspace, project: 'top.xpr' }, { runner: async () => statusMarkers });
    assert.equal(output.status, 'success');
    assert.equal(output.data.version, '2022.1.2');
    assert.equal(output.data.part, 'xc7z100ffg900-2');
    assert.equal(output.data.tops.sources, 'sfifo');
    assert.equal(output.data.tops.sim, null);
    assert.equal(output.data.runs[0].progress, '100%');
    assert.equal(output.context.project.kind, 'vivado');
});

test('时序报告保持数值与null语义，不伪造字段', async t => {
    const workspace = await fixture(t);
    const output = await report({ workspace, project: 'top.xpr', kind: 'timing', run: 'impl_1' }, { runner: async () => timingMarkers });
    assert.equal(output.data.kind, 'timing');
    const first = output.data.paths[0];
    assert.equal(first.slack, 0.123);
    assert.equal(first.pathgroup, null);
    assert.equal(first.logic, 3);
    assert.equal(first.startpoint, 'a/C');
});

test('资源报告按分层表解析为行摘要并给出文本字节预算', async t => {
    const workspace = await fixture(t);
    const table = ['SVTOOLS_UTIL | Instance | Module | Total LUTs | Logic LUTs | LUTRAMs | SRLs | FFs | RAMB36 | RAMB18 | DSP Blocks |',
        'SVTOOLS_UTIL | (top) | (top) | 12 | 10 | 0 | 0 | 24 | 0 | 0 | 0 |'];
    // 与真实 batch stdout 一致：同一批 marker 出现两遍，解析必须去重。
    const markers = [...table, 'SVTOOLS_DONE', '', ...table, 'SVTOOLS_DONE', ''].join('\n');
    const output = await report({ workspace, project: 'top.xpr', kind: 'utilization', run: 'synth_1' }, { runner: async () => markers });
    assert.equal(output.data.kind, 'utilization');
    assert.equal(output.data.run, 'synth_1');
    assert(Array.isArray(output.data.summary));
    assert(output.data.summary[0].includes('top 自身'), JSON.stringify(output.data.summary));
    assert(output.data.textBytes > 0);
});

test('错误marker优先于结果，缺结果与非法输入明确失败', async t => {
    const workspace = await fixture(t);
    await assert.rejects(status({ workspace, project: 'top.xpr' }, { runner: async () => 'SVTOOLS_ERROR 工程无法打开\n' }), { code: 'VIVADO_SCRIPT_FAILED' });
    await assert.rejects(status({ workspace, project: 'top.xpr' }, { runner: async () => 'nothing here\n' }), { code: 'VIVADO_NO_RESULT' });
    await assert.rejects(report({ workspace, project: 'top.xpr', kind: 'timing', run: '../../escape' }, { runner: async () => '' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(report({ workspace, project: 'top.xpr', kind: 'unknown' }, { runner: async () => '' }), { code: 'INVALID_ARGUMENT' });
    const plain = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-vivado-none-')));
    t.after(() => fs.rm(plain, { recursive: true, force: true }));
    await fs.writeFile(path.join(plain, 'top.sv'), 'module top;endmodule');
    await assert.rejects(status({ workspace: plain }), { code: 'VIVADO_PROJECT_REQUIRED' });
});

test('工程创建幂等：已存在时返回created=false并绑定工程上下文', async t => {
    const workspace = await fixture(t);
    const runner = async () => { await fs.writeFile(path.join(workspace, 'cap.xpr'), '<Project/>'); return 'SVTOOLS_PROJECT_READY\n'; };
    const first = await createProject({ workspace, name: 'cap', part: 'xc7z020clg400-1' }, { runner });
    assert.equal(first.status, 'success');
    assert.equal(first.data.created, true);
    assert.equal(first.context.project.kind, 'vivado');
    const second = await createProject({ workspace, name: 'cap' }, { runner });
    assert.equal(second.data.created, false);
});

test('工程加文件按类型推断文件集，并区分新增与已存在', async t => {
    const workspace = await fixture(t);
    await fs.writeFile(path.join(workspace, 'a.sv'), 'module a;endmodule');
    await fs.writeFile(path.join(workspace, 'p.xdc'), 'create_clock -period 10 [get_ports clk]');
    const added = await addFiles({ workspace, project: 'top.xpr', sources: ['a.sv'] }, { runner: async () => 'SVTOOLS_ADDED a.sv\nSVTOOLS_DONE\n' });
    assert.equal(added.data.fileset, 'sources_1');
    assert.deepEqual(added.data.added, ['a.sv']);
    const constrs = await addFiles({ workspace, project: 'top.xpr', sources: ['p.xdc'], filesetTarget: 'constrs_1' }, { runner: async () => 'SVTOOLS_ALREADY_IN p.xdc\nSVTOOLS_DONE\n' });
    assert.equal(constrs.data.fileset, 'constrs_1');
    assert.deepEqual(constrs.data.already, ['p.xdc']);
    await assert.rejects(addFiles({ workspace, project: 'top.xpr', sources: ['missing.sv'] }, { runner: async () => '' }), { code: 'SOURCE_NOT_FOUND' });
    await assert.rejects(addFiles({ workspace, project: 'top.xpr', sources: ['a.sv'], filesetTarget: 'nope' }, { runner: async () => '' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(addFiles({ workspace, project: 'top.xpr' }, { runner: async () => '' }), { code: 'FILE_REQUIRED' });
});

test('设置两种top按文件集分别执行并返回应用结果', async t => {
    const workspace = await fixture(t);
    const calls = [];
    const runner = async ({ script }) => { calls.push(/sources_1/.test(script) ? 'sources_1' : 'sim_1'); return 'SVTOOLS_TOP_SET top\nSVTOOLS_DONE\n'; };
    const output = await setTop({ workspace, project: 'top.xpr', top: 'top', simTop: 'tb' }, { runner });
    assert.equal(output.data.applied.length, 2);
    assert.deepEqual(calls, ['sources_1', 'sim_1']);
    await assert.rejects(setTop({ workspace, project: 'top.xpr' }, { runner }), { code: 'INVALID_ARGUMENT' });
});

test('工程写操作对Tcl错误与未完成显式失败', async t => {
    const workspace = await fixture(t);
    await fs.writeFile(path.join(workspace, 'a.sv'), 'module a;endmodule');
    await assert.rejects(addFiles({ workspace, project: 'top.xpr', sources: ['a.sv'] }, { runner: async () => 'SVTOOLS_TCL_ERROR boom\n' }), { code: 'VIVADO_SCRIPT_FAILED' });
    await assert.rejects(addFiles({ workspace, project: 'top.xpr', sources: ['a.sv'] }, { runner: async () => 'SVTOOLS_ADDED a.sv\n' }), { code: 'VIVADO_SCRIPT_FAILED' });
});

test('后台操作白名单拒绝未知operation', async t => {
    const workspace = await fixture(t);
    await assert.rejects(tasks.start({ workspace, file: 'top.sv', operation: 'bogus' }), { code: 'INVALID_ARGUMENT' });
});
