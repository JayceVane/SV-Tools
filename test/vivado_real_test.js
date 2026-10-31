'use strict';
// 真实Vivado门控测试：仅当指定工程且本机存在Vivado时运行，CI无Vivado时自动跳过。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../src/agent/tasks');
const { status, report, run, createProject, addFiles, setTop } = require('../src/agent/vivado');
const { findVivadoBinDir } = require('../src/vivado/toolchain');

const project = process.env.SVTOOLS_TEST_VIVADO_PROJECT;
/** Vivado退出后仍有句柄，清理需等待释放；EBUSY/EPERM时重试而不是判测试失败。 */
async function removeWithRetry(directory) {
    for (let attempt = 0; attempt < 40; attempt++) {
        try { await fs.rm(directory, { recursive: true, force: true }); return true; }
        catch (error) { if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    return false;
}
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
    t.after(async () => { if (!await removeWithRetry(root)) t.diagnostic('残留临时目录：' + root); });
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

const cancelCase = ready && process.env.SVTOOLS_TEST_VIVADO_CANCEL === '1';
test('真实后台运行取消：保留cancelled合同与vivado.run操作名', { skip: !cancelCase && '需SVTOOLS_TEST_VIVADO_CANCEL=1、工程与Vivado', timeout: 300000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-vivado-cancel-'));
    t.after(async () => { if (!await removeWithRetry(root)) t.diagnostic('残留临时目录：' + root); });
    await fs.writeFile(path.join(root, 'top.sv'), 'module top(input wire clk, output reg q); always @(posedge clk) q <= ~q; endmodule' + String.fromCharCode(10));
    await fs.writeFile(path.join(root, 'top.xdc'), 'create_clock -period 10.000 -name clk [get_ports clk]' + String.fromCharCode(10));
    await createProject({ workspace: root, name: 'cancel', part: process.env.SVTOOLS_TEST_VIVADO_PART || 'xc7z100ffg900-2' });
    await addFiles({ workspace: root, project: 'cancel.xpr', sources: ['top.sv'] });
    await addFiles({ workspace: root, project: 'cancel.xpr', sources: ['top.xdc'], filesetTarget: 'constrs_1' });
    await setTop({ workspace: root, project: 'cancel.xpr', top: 'top' });
    const started = await tasks.start({ workspace: root, project: 'cancel.xpr', run: 'synth_1', operation: 'vivado.run' });
    const id = started.data.id;
    const wait = async (states, ms) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            const output = await tasks.status({ workspace: root }, id);
            if (states.includes(output.data.task.state)) return output.data;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.fail('任务未达到状态：' + states.join(','));
    };
    await wait(['running'], 60000);
    assert.equal((await tasks.cancel({ workspace: root }, id)).data.accepted, true);
    const final = await wait(['cancelled', 'failed'], 180000);
    assert.equal(final.task.state, 'cancelled');
    assert.equal(final.result.status, 'cancelled');
    assert.equal(final.result.operation, 'vivado.run');
});

const e2e = ready && process.env.SVTOOLS_TEST_VIVADO_E2E === '1';
test('真实Vivado端到端：创建→加源→综合→报告→改源→复跑→对比', { skip: !e2e && '需SVTOOLS_TEST_VIVADO_E2E=1、工程与Vivado', timeout: 900000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-vivado-e2e-'));
    t.after(async () => { if (!await removeWithRetry(root)) t.diagnostic('残留临时目录：' + root); });
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
    assert.equal(utilFirst.data.stale, false);
    const drc = await report({ workspace: root, project: 'e2e.xpr', kind: 'drc', run: 'synth_1' });
    assert.equal(drc.data.checked, 1);
    assert(Array.isArray(drc.data.violations));
    const counts = summary => {
        const match = (summary || []).join(' ').match(/LUT (\d+) \| FF (\d+)/);
        return match ? { lut: Number(match[1]), ff: Number(match[2]) } : null;
    };
    const before = counts(utilFirst.data.summary);
    assert(before, JSON.stringify(utilFirst.data.summary));
    await fs.writeFile(path.join(root, 'top.sv'), source(true));
    const staleCheck = await report({ workspace: root, project: 'e2e.xpr', kind: 'utilization', run: 'synth_1' });
    assert.equal(staleCheck.data.stale, true, '改源后未重跑，报告必须标记过期');
    const second = await run({ workspace: root, project: 'e2e.xpr', run: 'synth_1', jobs: 4 });
    assert.match(second.data.status, /Complete/i);
    const utilSecond = await report({ workspace: root, project: 'e2e.xpr', kind: 'utilization', run: 'synth_1' });
    assert.equal(utilSecond.data.stale, false, '重跑后报告应对应当前输入');
    const after = counts(utilSecond.data.summary);
    assert(after, JSON.stringify(utilSecond.data.summary));
    assert.notDeepEqual(after, before, '改源后资源应有变化：' + JSON.stringify({ before, after }));
});
