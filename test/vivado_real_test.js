'use strict';
// 真实Vivado门控测试：仅当指定工程且本机存在Vivado时运行，CI无Vivado时自动跳过。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { status, report, run, createProject, addFiles, setTop } = require('../src/agent/vivado');
const { findVivadoBinDir } = require('../src/vivado/toolchain');

const project = process.env.SVTOOLS_TEST_VIVADO_PROJECT;
const ready = !!project && !!findVivadoBinDir('');

test('真实Vivado状态查询绑定工程并返回器件与runs', { skip: !ready && '未设置SVTOOLS_TEST_VIVADO_PROJECT或未安装Vivado' }, async () => {
    const output = await status({ workspace: path.dirname(project), project: path.basename(project) });
    assert.equal(output.status, 'success', JSON.stringify(output.diagnostics));
    assert.equal(typeof output.data.version, 'string');
    assert.equal(typeof output.data.part, 'string');
    assert(Array.isArray(output.data.runs) && output.data.runs.length >= 1);
    assert.equal(output.context.project.kind, 'vivado');
});

const lifecycle = ready && process.env.SVTOOLS_TEST_VIVADO_LIFECYCLE === '1';
test('真实Vivado工程生命周期：创建/加源与XDC/设置两种top', { skip: !lifecycle && '需SVTOOLS_TEST_VIVADO_LIFECYCLE=1、工程与Vivado' }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-vivado-lifecycle-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'top.sv'), 'module top(input wire clk, output reg q); always @(posedge clk) q <= ~q; endmodule\n');
    await fs.writeFile(path.join(root, 'top.xdc'), 'create_clock -period 10.000 -name clk [get_ports clk]\n');
    const created = await createProject({ workspace: root, name: 'cap', part: process.env.SVTOOLS_TEST_VIVADO_PART || 'xc7z100ffg900-2' });
    assert.equal(created.data.created, true);
    const added = await addFiles({ workspace: root, project: 'cap.xpr', sources: ['top.sv'] });
    assert.equal(added.data.added.length, 1);
    assert(added.data.added[0].endsWith('top.sv'));
    const xdc = await addFiles({ workspace: root, project: 'cap.xpr', sources: ['top.xdc'], filesetTarget: 'constrs_1' });
    assert.equal(xdc.data.added.length, 1);
    assert(xdc.data.added[0].endsWith('top.xdc'));
    const tops = await setTop({ workspace: root, project: 'cap.xpr', top: 'top', simTop: 'top' });
    assert.equal(tops.data.applied.length, 2);
    const state = await status({ workspace: root, project: 'cap.xpr' });
    assert.equal(state.data.tops.sources, 'top');
    assert.equal(state.data.tops.sim, 'top');
});

const e2e = ready && process.env.SVTOOLS_TEST_VIVADO_E2E === '1';
test('真实Vivado端到端：创建→加源→综合→报告→改源→复跑→对比', { skip: !e2e && '需SVTOOLS_TEST_VIVADO_E2E=1、工程与Vivado', timeout: 900000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-vivado-e2e-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = withSecond =>
        'module top(input wire clk, input wire rst, input wire [7:0] a, output reg [7:0] q' + (withSecond ? ', output reg [7:0] q2' : '') + ');\n' +
        '    reg [7:0] stage0;\n' +
        '    always @(posedge clk) begin\n' +
        "        if (rst) begin stage0 <= 8'h00; q <= 8'h00;" + (withSecond ? " q2 <= 8'h00;" : '') + ' end\n' +
        "        else begin stage0 <= a + 8'h01; q <= stage0 ^ 8'hA5;" + (withSecond ? " q2 <= q ^ 8'h5A;" : '') + ' end\n' +
        '    end\n' +
        'endmodule\n';
    await fs.writeFile(path.join(root, 'top.sv'), source(false));
    await fs.writeFile(path.join(root, 'top.xdc'), 'create_clock -period 10.000 -name clk [get_ports clk]\n');
    await createProject({ workspace: root, name: 'e2e', part: process.env.SVTOOLS_TEST_VIVADO_PART || 'xc7z100ffg900-2' });
    await addFiles({ workspace: root, project: 'e2e.xpr', sources: ['top.sv'] });
    await addFiles({ workspace: root, project: 'e2e.xpr', sources: ['top.xdc'], filesetTarget: 'constrs_1' });
    await setTop({ workspace: root, project: 'e2e.xpr', top: 'top' });
    const first = await run({ workspace: root, project: 'e2e.xpr', run: 'synth_1', jobs: 4 });
    assert.match(first.data.status, /Complete/i);
    const utilFirst = await report({ workspace: root, project: 'e2e.xpr', kind: 'utilization', run: 'synth_1' });
    const counts = summary => {
        const match = (summary || []).join(' ').match(/LUT (\d+) \| FF (\d+)/);
        return match ? { lut: Number(match[1]), ff: Number(match[2]) } : null;
    };
    const before = counts(utilFirst.data.summary);
    assert(before, JSON.stringify(utilFirst.data.summary));
    await fs.writeFile(path.join(root, 'top.sv'), source(true));
    const second = await run({ workspace: root, project: 'e2e.xpr', run: 'synth_1', jobs: 4 });
    assert.match(second.data.status, /Complete/i);
    const utilSecond = await report({ workspace: root, project: 'e2e.xpr', kind: 'utilization', run: 'synth_1' });
    const after = counts(utilSecond.data.summary);
    assert(after, JSON.stringify(utilSecond.data.summary));
    assert.notDeepEqual(after, before, '改源后资源应有变化：' + JSON.stringify({ before, after }));
});
