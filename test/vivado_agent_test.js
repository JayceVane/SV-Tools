'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const tasks = require('../src/agent/tasks');
const { status, report, run, createProject, addFiles, setTop } = require('../src/agent/vivado');
const { argumentsFor, run: cli } = require('../src/cli/main');
const { doctor } = require('../src/agent/operations');
const { resolveContext } = require('../src/agent/context');
const { command: assetCommand } = require('../src/agent/vivado-assets');

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
async function assetRows(directory, rows) {
    await fs.writeFile(path.join(directory, 'assets.tsv'), ['SVTOOLS_ASSETS_V1',
        ...rows.map(([kind, ...fields]) => [kind, ...fields.map(value => Buffer.from(value).toString('hex'))].join('\t')), 'END'].join('\n'));
    return 'SVTOOLS_DONE\n';
}
async function completedRun({snapshot}) {
    const checkpoint=path.join(snapshot.root,'mock.dcp');await fs.writeFile(checkpoint,'isolated checkpoint');
    return 'SVTOOLS_RUN_STATUS synth_design Complete! 100%\nSVTOOLS_RUN_VERSION 2022.1.2\nSVTOOLS_CHECKPOINT '+checkpoint+'\nSVTOOLS_DONE\n';
}

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

test('功耗报告返回同一检查点的组件阈值，命令失败时不返回零功耗', async t => {
    const workspace = await fixture(t);
    const input = { workspace, project: 'top.xpr', kind: 'power', run: 'production' };
    const output = await report(input, { runner: async ({ script, runDirectory }) => {
        assert.match(script, /open_project -read_only/u);
        assert.match(script, /report_power -file/u);
        await fs.writeFile(path.join(runDirectory, 'summary_power.rpt'), [
            '| Total On-Chip Power (W) | 0.105 |', '| Dynamic (W) | 0.001 |', '| Device Static (W) | 0.104 |',
            '| Confidence Level | Medium |', '1.1 On-Chip Components', '| Clocks | <0.001 |', '1.2 Power Supply Summary'
        ].join('\n'));
        return assetRows(runDirectory, []);
    } });
    assert.equal(output.data.run, 'production');
    assert.equal(output.data.stale, null);
    assert.deepEqual(output.data.power.components, [{ label: 'Clocks', watts: null, below: 0.001 }]);
    assert(output.artifacts.some(item => item.kind === 'report' && item.path.endsWith('summary_power.rpt')));
    await assert.rejects(report(input, { runner: ({ runDirectory }) =>
        assetRows(runDirectory, [['analysis_error', 'power', 'checkpoint incomplete']]) }), { code: 'VIVADO_SCRIPT_FAILED' });
});

test('原工程消息按自定义顶层 run 筛选分页并保留日志位置', async t => {
    const workspace = await fixture(t);
    const input = { workspace, project: 'top.xpr', run: 'production', severity: 'critical-warning', limit: 1, query: 'timing' };
    const runDir = path.join(workspace, 'top.runs', 'production');
    await fs.mkdir(runDir, { recursive: true });
    const log = path.join(runDir, 'runme.log');
    await fs.writeFile(log, 'Command: route_design\nWARNING: [Route 35-1] Timing\nCRITICAL WARNING: [Timing 38-1] First\nCRITICAL WARNING: [Timing 38-2] Second\n');
    const row = (id, source) => ['run', id, 'Complete!', '100%', '', '0', '', '', '', '', '', '', '', '1', '', source, '', '0'];
    const runner = ({ runDirectory }) => assetRows(runDirectory, [
        ['project', 'top', 'x', workspace, 'top', ''], ['current_runs', '', 'production'], ['fileset', 'rtl', 'DesignSrcs'],
        ['fileset', 'child', 'BlockSrcs'], row('production', 'rtl'), row('production_child', 'child')
    ]);
    const { data } = await assetCommand('messages', undefined, input, { runner });
    assert.equal(data.source, 'project');
    assert.equal(data.counts.production.counts.criticalWarnings, 2);
    assert.equal(data.nextOffset, 1);
    assert.deepEqual(data.items.map(item => [item.run, item.id, item.file, item.line]), [['production', 'Timing 38-1', log, 3]]);
    await assert.rejects(assetCommand('messages', undefined, { ...input, run: 'production_child' }, { runner }), { code: 'VIVADO_RUN_NOT_FOUND' });
});

test('资产 CLI 清单无需工具，项目成员与 BD 版本不匹配时不执行写入', async t => {
    const workspace = await fixture(t);
    const file = path.join(workspace, 'fabric.bd');
    await fs.writeFile(file, '{}');
    await fs.writeFile(path.join(workspace, 'top.xpr'),
        '<Project><FileSets><FileSet Name="sources_1" Type="DesignSrcs"><File Path="fabric.bd"/><File Path="clock.xci"/></FileSet></FileSets></Project>');
    const listed = await cli(['vivado', 'ip', 'list', '--workspace', workspace, '--project', 'top.xpr', '--query', 'clock']);
    assert.equal(listed.output.operation, 'vivado.ip.list');
    assert.deepEqual(listed.output.data.items, [{ name: 'clock', fileset: 'sources_1', file: path.join(workspace, 'clock.xci') }]);
    const runner = () => assert.fail('无效请求启动了 Vivado');
    await assert.rejects(assetCommand('ip', 'generate', { workspace, file: 'unrelated.xci' }, { runner }), { code: 'ASSET_NOT_FOUND' });
    await assert.rejects(assetCommand('bd', 'edit', { workspace, file, expect: '0'.repeat(64),
        spec: '{"action":"add-cell","type":"hier","name":"nested"}' }, { runner }), { code: 'CONTEXT_CHANGED' });
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

test('--jobs 不被解析器丢弃，数值参数保持', () => {
    const parsed = argumentsFor(['vivado', 'run', '--jobs', '12', '--timeout', '60000']);
    assert.equal(parsed.input.jobs, 12);
    assert.equal(parsed.input.timeoutMs, 60000);
});

test('工具执行失败（退出码非零）即使有marker也必须报错', async t => {
    const workspace = await fixture(t);
    await assert.rejects(status({ workspace, project: 'top.xpr' }, { runner: async () => ({ stdout: 'SVTOOLS_JSON {"version":"2022.1.2","part":"x","tops":{"sources":null,"sim":null},"runs":[]}\nSVTOOLS_DONE\n', exitCode: 7 }) }), { code: 'VIVADO_EXEC_FAILED' });
});

test('创建工程即使已有XPR和READY标记也不接受失败退出码', async t => {
    const workspace = await fixture(t);
    await assert.rejects(createProject({ workspace, name: 'top' }, { runner: async () => ({ stdout: 'SVTOOLS_PROJECT_READY\n', exitCode: 7 }) }), { code: 'VIVADO_EXEC_FAILED' });
});

test('run状态为ERROR时不能返回成功', async t => {
    const workspace = await fixture(t);
    await assert.rejects(run({ workspace, project: 'top.xpr', run: 'synth_1' }, { runner: async () => 'SVTOOLS_RUN_STATUS synth_design ERROR 0%\nSVTOOLS_DONE\n' }), { code: 'VIVADO_RUN_FAILED' });
});

test('取消优先于失败：中止后返回TOOL_CANCELLED而不是脚本失败', async t => {
    const workspace = await fixture(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(run({ workspace, project: 'top.xpr', run: 'synth_1' }, { signal: controller.signal, runner: async () => 'SVTOOLS_RUN_STATUS synth_design Complete! 100%\nSVTOOLS_DONE\n' }), { code: 'TOOL_CANCELLED' });
});

test('报告绑定run输入：改源后过期、还原后当前', async t => {
    const workspace = await fixture(t);
    const done = completedRun;
    await run({ workspace, project: 'top.xpr', run: 'synth_1' }, { runner: done });
    const table = 'SVTOOLS_UTIL | Instance | Module | Total LUTs | Logic LUTs | LUTRAMs | SRLs | FFs | RAMB36 | RAMB18 | DSP Blocks |\nSVTOOLS_UTIL | (top) | (top) | 10 | 10 | 0 | 0 | 16 | 0 | 0 | 0 |\nSVTOOLS_DONE\n';
    const fresh = await report({ workspace, project: 'top.xpr', kind: 'utilization', run: 'synth_1' }, { runner: async () => table });
    assert.equal(fresh.data.stale, false);
    assert.equal(fresh.data.runInfo.status, 'synth_design Complete! 100%');
    const file = path.join(workspace, 'top.sv');
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, original + '\n// changed');
    const stale = await report({ workspace, project: 'top.xpr', kind: 'utilization', run: 'synth_1' }, { runner: async () => table });
    assert.equal(stale.data.stale, true);
    assert(stale.data.staleInputs.some(value => value.endsWith('top.sv')), JSON.stringify(stale.data.staleInputs));
    await fs.writeFile(file, original);
    const restored = await report({ workspace, project: 'top.xpr', kind: 'utilization', run: 'synth_1' }, { runner: async () => table });
    assert.equal(restored.data.stale, false);
});

test('XDC变化改变上下文revision，报告据此可判失效', async t => {
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-vivado-xdc-')));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    await fs.writeFile(path.join(workspace, 'top.sv'), 'module top(input clk);endmodule');
    await fs.writeFile(path.join(workspace, 'top.xdc'), 'create_clock -period 10 [get_ports clk]');
    await fs.writeFile(path.join(workspace, 'design.xpr'), '<Project Version="7"><Configuration><Option Name="Part" Val="xc7z100ffg900-2"/></Configuration><FileSets><FileSet Name="sources_1" Type="DesignSrcs"><File Path="top.sv"/></FileSet><FileSet Name="constrs_1" Type="Constrs"><File Path="top.xdc"/></FileSet><FileSet Name="sim_1" Type="SimulationSrcs"/></FileSets></Project>');
    const first = await resolveContext({ workspace, project: 'design.xpr' });
    assert.equal(first.context.constraints.length, 1);
    assert(first.context.constraints[0].sha256);
    await fs.writeFile(path.join(workspace, 'top.xdc'), 'create_clock -period 5 [get_ports clk]');
    const second = await resolveContext({ workspace, project: 'design.xpr' });
    assert.notEqual(second.context.revision, first.context.revision);
});

test('doctor能力清单包含工程生命周期、报告和资产命令', async t => {
    const workspace = await fixture(t);
    const output = await doctor({ workspace });
    for (const name of ['project.create', 'project.add', 'project.set-top', 'vivado.messages', 'vivado.overview', 'vivado.report.power',
        'vivado.ip.catalog', 'vivado.ip.configure', 'vivado.bd.inspect', 'vivado.bd.edit']) assert(output.data.capabilities.includes(name), name);
});

test('DRC脚本先执行report_drc再读取违规对象', () => {
    const tclgen = require('../src/vivado/tclgen');
    const script = tclgen.buildVivadoDrcScript({ xprPath: 'C:/x/top.xpr', run: 'synth_1' });
    assert(script.indexOf('report_drc') >= 0);
    assert(script.indexOf('report_drc') < script.indexOf('get_drc_violations'));
});

test('后台操作白名单拒绝未知operation', async t => {
    const workspace = await fixture(t);
    await assert.rejects(tasks.start({ workspace, file: 'top.sv', operation: 'bogus' }), { code: 'INVALID_ARGUMENT' });
});
