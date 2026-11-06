'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { sha256 } = require('./release-archive.cjs');

const ports = 'input clk, rst, sel, input [15:0] a, b, output wire [15:0] q';
const baseline = `module mux_pipe(${ports});
    (* DONT_TOUCH = "TRUE" *) reg [15:0] left_q, right_q;
    reg sel_q;
    always @(posedge clk) begin
        if (rst) begin left_q <= 0; right_q <= 0; sel_q <= 0; end
        else begin left_q <= a; right_q <= b; sel_q <= sel; end
    end
    assign q = sel_q ? right_q : left_q;
endmodule
`;
const optimized = `module mux_pipe(${ports});
    reg [15:0] result;
    always @(posedge clk) begin
        if (rst) result <= 0;
        else result <= sel ? b : a;
    end
    assign q = result;
endmodule
`;
const comparison = `\u0060timescale 1ns/1ps
module tb;
    reg clk=0, rst=1, sel=0;
    reg [15:0] a=0, b=0, expected;
    wire [15:0] before_q, after_q;
    mux_pipe_before before_dut(clk,rst,sel,a,b,before_q);
    mux_pipe after_dut(clk,rst,sel,a,b,after_q);
    always #5 clk=~clk;
    initial begin
        for (integer i=0; i<128; i=i+1) begin
            @(negedge clk);
            rst=(i==0 || i==69); sel=i[0]; a=i*331; b=(i*719)^16'hA5C3;
            expected=rst ? 16'b0 : (sel ? b : a);
            @(posedge clk); #1;
            if (before_q!==expected || after_q!==expected) $fatal(1,"output mismatch cycle=%0d",i);
        end
        $display("M5_MUX_EQUIVALENT cycles=128");
        $finish;
    end
endmodule
`;

function counts(report) {
    const match = report.summary.join(' ').match(/LUT (\d+) \| FF (\d+)/);
    assert.ok(match, JSON.stringify(report.summary));
    return { lut: Number(match[1]), ff: Number(match[2]) };
}

async function verifyVivado({ workspace, extensionPath, vivado, part, iverilogBin, cygwin }) {
    const { run: cli } = require(path.join(extensionPath, 'src/cli/main.js'));
    const service = require(path.join(extensionPath, 'src/agent/vivado.js'));
    const { runProcess } = require(path.join(extensionPath, 'src/toolchains/process.js'));
    const { buildChildEnv, findCygwinBinDir } = require(path.join(extensionPath, 'src/toolchains/iverilog.js'));
    await fs.mkdir(workspace, { recursive: true });
    const source = path.join(workspace, 'mux_pipe.sv');
    await fs.writeFile(source, baseline);
    await fs.writeFile(path.join(workspace, 'clock.xdc'), 'create_clock -period 10.000 -name clk [get_ports clk]\n');
    const beforeSource = await sha256(source);
    const steps = [];
    async function save(label, call) {
        console.error('[vivado] ' + label);
        const response = await call();
        assert.equal(response.status, 'success', JSON.stringify(response.diagnostics));
        const file = path.join(workspace, label + '.json');
        await fs.writeFile(file, JSON.stringify(response, null, 2) + '\n');
        steps.push({ label, file, sha256: await sha256(file) });
        return response.data;
    }
    const options = { workspace, vivado, project: 'm5candidate.xpr', run: 'synth_1', jobs: 4, timeoutMs: 300000 };
    const architecture = await save('architecture', async () => (await cli(['design', 'report', '--workspace', workspace,
        '--top', 'mux_pipe', '--out', 'architecture'])).output);
    assert.ok(architecture.files.some(file => file.kind === 'document'));
    const created = await save('project-create', () => service.createProject({ workspace, vivado, name: 'm5candidate', part }));
    assert.equal(created.created, true);
    const rtl = await save('project-add-rtl', () => service.addFiles({ ...options, sources: ['mux_pipe.sv'] }));
    assert.equal(rtl.added.length, 1);
    const xdc = await save('project-add-xdc', () => service.addFiles({ ...options, sources: ['clock.xdc'], filesetTarget: 'constrs_1' }));
    assert.equal(xdc.added.length, 1);
    const top = await save('project-set-top', () => service.setTop({ ...options, top: 'mux_pipe', simTop: 'mux_pipe' }));
    assert.equal(top.applied.length, 2);
    const status = await save('project-status', () => service.status(options));
    assert.equal(status.tops.sources, 'mux_pipe');
    assert.equal(status.tops.sim, 'mux_pipe');
    const first = await save('synthesis-before', () => service.run(options));
    assert.match(first.status, /Complete/i);
    const beforeReport = await save('utilization-before', () => service.report({ ...options, kind: 'utilization' }));
    assert.equal(beforeReport.stale, false);
    const before = counts(beforeReport);
    assert.ok(before.ff >= 32, '首轮报告必须观察到两组寄存器，才执行共享寄存器优化');
    const drc = await save('drc', () => service.report({ ...options, kind: 'drc' }));
    assert.ok(Array.isArray(drc.violations));
    await fs.writeFile(source, optimized);
    const stale = await save('utilization-stale', () => service.report({ ...options, kind: 'utilization' }));
    assert.equal(stale.stale, true);
    const second = await save('synthesis-after', () => service.run(options));
    assert.match(second.status, /Complete/i);
    const afterReport = await save('utilization-after', () => service.report({ ...options, kind: 'utilization' }));
    assert.equal(afterReport.stale, false);
    const after = counts(afterReport);
    assert.ok(after.ff < before.ff, JSON.stringify({ before, after }));
    assert.notEqual(await sha256(source), beforeSource);

    // 对比复验独立放置，避免新增第二套 DUT/TB 改写 Vivado 工程的输入清单。
    const compare = path.join(workspace, 'comparison');
    await fs.mkdir(compare);
    await fs.writeFile(path.join(compare, 'before.sv'), baseline.replace('module mux_pipe(', 'module mux_pipe_before('));
    await fs.copyFile(source, path.join(compare, 'after.sv'));
    await fs.writeFile(path.join(compare, 'tb.sv'), comparison);
    const env = buildChildEnv(findCygwinBinDir(cygwin, iverilogBin));
    const compile = await runProcess(path.join(iverilogBin, 'iverilog.exe'),
        ['-g2012', '-s', 'tb', '-o', 'check.vvp', 'tb.sv', 'before.sv', 'after.sv'], { cwd: compare, env, timeoutMs: 30000 });
    assert.equal(compile.code, 0, compile.stderr || compile.errorMessage);
    const simulation = await runProcess(path.join(iverilogBin, 'vvp.exe'), ['check.vvp'], { cwd: compare, env, timeoutMs: 30000 });
    assert.equal(simulation.code, 0, simulation.stderr || simulation.stdout);
    assert.match(simulation.stdout, /M5_MUX_EQUIVALENT cycles=128/);
    await fs.writeFile(path.join(compare, 'simulation.log'), simulation.stdout + simulation.stderr);
    return { part, before, after, staleTransition: [false, true, false], comparedCycles: 128, beforeSource,
        afterSource: await sha256(source), simulationSha256: await sha256(path.join(compare, 'simulation.log')), steps };
}

module.exports = { verifyVivado };
