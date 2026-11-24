'use strict';
const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tclgen = require('../src/vivado/tclgen');
const { createRtlCommands } = require('../src/agent/rtl');
const { trace } = require('../src/agent/circuit');
const { simulate } = require('../src/agent/simulate');
const { parseRunProgress } = require('../src/vivado/progress');
const { runVivadoBatchTask } = require('../src/vivado/batch');

const SOURCE = 'module top(input logic clk, input logic [7:0] d, output logic [7:0] q);\n' +
    'logic [7:0] mid;\n' +
    'always_ff @(posedge clk) mid <= d;\n' +
    'assign q = mid;\n' +
    'endmodule\n';

async function workspace() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-cli-'));
    await fs.writeFile(path.join(dir, 'top.sv'), SOURCE);
    return dir;
}

test('bitstream 让 impl 运行停在 write_bitstream', () => {
    const script = tclgen.buildLaunchRunScript({ xprPath: 'C:/work/demo.xpr', run: 'impl_1', jobs: 2, toStep: 'write_bitstream' });
    assert.match(script, /launch_runs impl_1 -to_step write_bitstream -jobs 2/u);
    assert.match(script, /SVTOOLS_RUN_PROGRESS impl_1/u);
    assert.match(script, /after 2000/u);
    assert.doesNotMatch(script, /wait_on_run/u);
});

test('解析批处理 run 进度标记', () => {
    assert.deepEqual(parseRunProgress('SVTOOLS_RUN_PROGRESS impl_1 45% write_bitstream Running'),
        { run: 'impl_1', progress: '45%', status: 'write_bitstream Running' });
    assert.deepEqual(parseRunProgress('SVTOOLS_RUN_PROGRESS synth_1 100% synth_design Complete!'),
        { run: 'synth_1', progress: '100%', status: 'synth_design Complete!' });
    assert.deepEqual(parseRunProgress('SVTOOLS_RUN_PROGRESS impl_1 83.333333333333343% write_bitstream ERROR'),
        { run: 'impl_1', progress: '83%', status: 'write_bitstream ERROR' });
    assert.equal(parseRunProgress('INFO: unrelated'), null);
});

test('批处理进度标记转交状态栏回调', async () => {
    const seen = [];
    const task = { run: async (command, args, options) => {
        options.onLine('SVTOOLS_RUN_PROGRESS impl_1 45% route_design', false, {});
        options.onLine('INFO: unrelated', false, {});
        return { code: 0, output: '', stdout: '', stderr: '', elapsedMs: 1 };
    } };
    const output = await runVivadoBatchTask({ task, executable: process.execPath, args: [], cwd: process.cwd(), scriptPath: 'x.tcl',
        onProgress: line => seen.push(line) });
    assert.deepEqual(seen, ['SVTOOLS_RUN_PROGRESS impl_1 45% route_design']);
    assert.equal(output.ok, true);
});

test('工程移出/移动/约束目标脚本保留标记与属性', () => {
    const remove = tclgen.buildRemoveFilesScript('C:/work/demo.xpr', 'C:/work/top.sv', 'sources_1');
    assert.match(remove, /SVTOOLS_REMOVED/u);
    assert.match(remove, /remove_files/u);
    const move = tclgen.buildMoveFileScript({ xprPath: 'C:/work/demo.xpr', file: 'C:/work/top.sv', from: 'sources_1', to: 'sim_1' });
    assert.match(move, /SVTOOLS_MOVED/u);
    assert.match(move, /add_files/u);
    const constraint = tclgen.buildSetConstraintTargetScript('C:/work/demo.xpr', 'constrs_1', 'C:/work/timing.xdc');
    assert.match(constraint, /TARGET_CONSTRS_FILE/u);
    assert.match(constraint, /timing\.xdc/u);
});

test('rtl 生成复用原生接口并可写入文件', async () => {
    const dir = await workspace();
    const native = {
        generateModuleInst: (text, options) => ({ success: true, module: 'top', result: 'top u_top (.clk(clk));' }),
        generateTestbench: (text, options) => ({ success: true, module: 'top', result: 'module tb; top dut(); endmodule' })
    };
    const rtl = createRtlCommands({ native });
    const instance = await rtl.instantiate({ workspace: dir, file: 'top.sv' });
    assert.equal(instance.status, 'success');
    assert.equal(instance.data.module, 'top');
    assert.match(instance.data.text, /u_top/u);
    const tb = await rtl.testbench({ workspace: dir, file: 'top.sv', out: 'tb.sv' });
    assert.equal(tb.status, 'success');
    assert.equal(await fs.readFile(path.join(dir, 'tb.sv'), 'utf8'), 'module tb; top dut(); endmodule');
});

test('circuit trace 返回位级网络与边界', async () => {
    const dir = await workspace();
    const output = await trace({ workspace: dir, file: 'top.sv', top: 'top', signal: 'mid', direction: 'loads' });
    assert.equal(output.status, 'success');
    assert.equal(output.data.signal.name, 'mid');
    assert.equal(output.data.nets.length, 8);
    assert.ok(output.data.boundaries.some(item => item.reason === 'module-port'));
});

test('simulate 拒绝未知引擎', async () => {
    const dir = await workspace();
    await assert.rejects(simulate({ workspace: dir, file: 'top.sv', top: 'top', engine: 'verilator' }),
        error => error.code === 'INVALID_ARGUMENT');
});
