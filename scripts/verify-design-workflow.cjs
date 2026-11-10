'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const tool = path.resolve(__dirname, '..');
const runtime = process.env.SVTOOLS_CANDIDATE_ROOT || tool;
const { run } = require(path.join(runtime, 'src/cli/main'));
const { runProcess } = require(path.join(runtime, 'src/toolchains/process'));
const { findIverilogBinDir, findCygwinBinDir, buildChildEnv } = require(path.join(runtime, 'src/toolchains/iverilog'));

const synchronous = {
    top: 'transform', overview: 'Synchronous transform evidence chain',
    clocks: ['clk rising edge'], resets: ['rst_n asynchronous low'],
    signals: ['tb.clk', 'tb.rst_n', 'tb.q'],
    requirements: [{ id: 'R1', text: 'Output is the registered bitwise inverse of sampled input' }],
    oracle: 'Independently computed sampled input XOR ff and asynchronous reset observation',
    good: /TC1_PASS/, bad: /TC1_FAIL/,
    designActor: 'design-phase', verificationActor: 'verification-phase',
    rtl: 'module transform(input clk, input rst_n, input [7:0] d, output reg [7:0] q); always @(posedge clk or negedge rst_n) if (!rst_n) q <= 0; else q <= ~d; endmodule\n',
    before: 'q <= ~d', after: 'q <= d',
    tb: `module tb;
reg clk=0, rst_n=1; reg [7:0] d=0; wire [7:0] q;
transform dut(clk,rst_n,d,q);
always #5 clk=~clk;
integer i; reg [7:0] expected;
initial begin
 $dumpfile(".svtools/vcd/tb.vcd"); $dumpvars(0,tb);
 #1; rst_n=0; #1; if(q!==0) $fatal(1,"reset mismatch");
 #1; rst_n=1;
 for(i=0;i<16;i=i+1) begin
   @(negedge clk); d=i*13;
   @(posedge clk); expected=d ^ 8'hff;
   #1; if(q!==expected) $fatal(1,"TC1_FAIL input=%h got=%h expected=%h",d,q,expected);
 end
 $display("TC1_PASS 16 independent expected-value comparisons"); $finish;
end
endmodule
`
};

async function independentFixture() {
    const normalize = text => text.replace(/\r\n/g, '\n');
    const fixture = path.join(tool, 'test', 'fixtures', 'design', 'm5-independent');
    const [rtl, tb, provenance] = await Promise.all(['afifo_m5.sv', 'tb.sv', 'provenance.json'].map(name => fs.readFile(path.join(fixture, name), 'utf8')));
    return {
        top: 'afifo_m5', overview: 'Four-entry 8-bit asynchronous FIFO. Each role received only the shared interface contract.',
        clocks: ['wr_clk rising edge', 'rd_clk rising edge'], resets: ['shared active-low asynchronous reset'],
        signals: ['wr_clk', 'rd_clk', 'rst_n', 'wr_full', 'rd_empty', 'rd_valid'].map(name => 'tb.' + name),
        requirements: [
            { id: 'R1', text: 'Accepted reads preserve order, data and valid indication' },
            { id: 'R2', text: 'Four entries, backpressure and concurrent read/write' },
            { id: 'R3', text: 'Reset flushes pending entries without phantom reads' }
        ],
        oracle: 'Separate verifier reference queue, accepted handshakes and asynchronous reset checks',
        good: /M5_CASES_PASS R1 R2 R3/, bad: /data mismatch/i,
        designActor: 'independent-rtl', verificationActor: 'independent-testbench',
        rtl: normalize(rtl), tb: normalize(tb), provenance: JSON.parse(provenance), before: 'rd_data <= storage[rd_bin[1:0]];',
        after: "rd_data <= storage[rd_bin[1:0]] ^ 8'h01;"
    };
}

async function main() {
    const { values } = parseArgs({ options: { iverilog: { type: 'string' }, cygwin: { type: 'string' }, independent: { type: 'boolean' } } });
    const fixture = values.independent ? await independentFixture() : synchronous;
    const toolBin = findIverilogBinDir(values.iverilog);
    assert.ok(toolBin, '使用 --iverilog <bin> 指定 Icarus');
    const env = { ...buildChildEnv(findCygwinBinDir(values.cygwin, toolBin)), IVERILOG_DUMPER: 'vcd' };
    const root = path.join(tool, 'bin', 'workflow-e2e-' + randomUUID());
    const rtlName = 'rtl/' + fixture.top + '.sv';
    const planId = 'm5-' + fixture.top;
    const requirementIds = fixture.requirements.map(item => item.id);
    const outcomes = [];
    await fs.mkdir(path.join(root, '.svtools', 'vcd'), { recursive: true });

    const query = args => run([...args, '--workspace', root]);
    async function design(action, args = []) {
        const result = await query(['design', action, ...args]);
        assert.equal(result.exitCode, 0, JSON.stringify(result.output));
        return result.output.data;
    }
    async function ref(name) {
        const contents = await fs.readFile(path.join(root, name));
        return { path: name, sha256: createHash('sha256').update(contents).digest('hex') };
    }
    async function file(name, value) {
        await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await fs.writeFile(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        return ref(name);
    }
    const rtlRef = await file(rtlName, fixture.rtl);
    const tbRef = await file('sim/tb.sv', fixture.tb);
    if (fixture.provenance) {
        assert.equal(rtlRef.sha256, fixture.provenance.rtlSha256);
        assert.equal(tbRef.sha256, fixture.provenance.testbenchSha256);
    }
    await file('reports/design.md', fixture.overview);
    await file('spec.json', { schemaVersion: 1, id: planId, title: 'M5 real Icarus trial', top: fixture.top,
        overview: fixture.overview, clocks: fixture.clocks, resets: fixture.resets, requirements: fixture.requirements,
        modules: [{ id: fixture.top, name: fixture.top, responsibility: fixture.overview, sources: [rtlName],
            requirements: requirementIds, deltaSignals: fixture.signals }] });
    await design('plan', ['--spec', 'spec.json']);
    const compiler = path.join(toolBin, process.platform === 'win32' ? 'iverilog.exe' : 'iverilog');
    const simulator = path.join(toolBin, process.platform === 'win32' ? 'vvp.exe' : 'vvp');
    const execute = (exe, args) => runProcess(exe, args, { cwd: root, env, timeoutMs: 60000 });
    const version = (await execute(compiler, ['-V'])).stdout.split('\n')[0];
    const coordinator = 'review-phase';
    const transition = (action, actor, revision, args = []) => design(action,
        ['--module', fixture.top, '--actor', actor, '--revision', String(revision), ...args]);

    async function cycle(label, expectPass) {
        let state = await design('tasks');
        const claim = await transition('claim', fixture.designActor, state.revision, ['--role', 'design']);
        state = await transition('submit', fixture.designActor, claim.revision, ['--token', claim.token, '--evidence', 'reports/design.md']);
        const verification = await transition('claim', fixture.verificationActor, state.revision, ['--role', 'verification']);
        const { candidateId, candidateInputs: inputs } = state.modules[0];
        const verificationInputs = [await ref('sim/tb.sv')];
        const compileArgs = ['-g2012', '-s', 'tb', '-o', 'simulation.vvp', rtlName, 'sim/tb.sv'];
        const compilation = await execute(compiler, compileArgs);
        assert.equal(compilation.code, 0, compilation.stderr);
        const compileLog = await file(`reports/${label}-compile.log`, compilation.stdout + compilation.stderr);
        const receipt = { schemaVersion: 1, candidateId, inputs: [...inputs, ...verificationInputs], completed: true };
        const compile = await file(`reports/${label}-compile.json`, { ...receipt, kind: 'compile', status: 'passed', exitCode: compilation.code });

        const simulation = await execute(simulator, ['simulation.vvp']);
        const log = simulation.stdout + simulation.stderr;
        const passed = simulation.code === 0 && fixture.good.test(log);
        assert.equal(passed, expectPass, log);
        if (!expectPass) { assert.notEqual(simulation.code, 0); assert.match(log, fixture.bad); }
        const status = passed ? 'passed' : 'failed';
        const simLog = await file(`reports/${label}-simulation.log`, log);
        const waveformFile = `reports/${label}.vcd`;
        await fs.copyFile(path.join(root, '.svtools/vcd/tb.vcd'), path.join(root, waveformFile));
        const waveform = await ref(waveformFile);
        const sim = await file(`reports/${label}-simulation.json`, { ...receipt, kind: 'simulation', status, exitCode: simulation.code,
            waveforms: [waveform], cases: [{ id: 'TC1', requirements: requirementIds, status, oracle: fixture.oracle }] });

        const args = ['wave', 'glitches', '--file', waveform.path, '--signals', fixture.signals.join(',')];
        const glitches = await query(args);
        assert.equal(glitches.exitCode, 0);
        assert.equal(glitches.output.data.complete, true);
        assert.equal(glitches.output.data.matched, 0, JSON.stringify(glitches.output.data.series));
        const delta = await file(`reports/${label}-delta.json`, glitches.output);
        const evidenceFile = `reports/${label}-evidence.json`;
        await file(evidenceFile, { schemaVersion: 1, planId, moduleId: fixture.top, candidateId, inputs, verificationInputs, checks: [
            { id: 'compile', status: 'passed', command: [compiler, ...compileArgs], toolVersion: version, report: compile, log: compileLog },
            { id: 'simulation', status, command: [simulator, 'simulation.vvp'], toolVersion: version, report: sim, log: simLog },
            { id: 'delta-cycle', status: 'passed', command: ['node', path.join(runtime, 'src/cli/main.js'), ...args, '--workspace', root],
                toolVersion: require(path.join(runtime, 'package.json')).version, report: delta, waveform, dispositions: [] }
        ] });
        state = await transition('submit', fixture.verificationActor, verification.revision, ['--token', verification.token, '--evidence', evidenceFile]);
        if (passed) {
            state = await transition('review', coordinator, state.revision, ['--reason', 'Actual Icarus output, reference model, waveform and input hashes checked']);
            assert.equal(state.summary.accepted, 1);
        } else {
            assert.equal(state.modules[0].verification, 'failed');
            const review = await query(['design', 'review', '--module', fixture.top, '--actor', coordinator, '--revision', String(state.revision), '--reason', 'Must reject failing candidate']);
            assert.notEqual(review.exitCode, 0);
        }
        outcomes.push({ label, compilerExit: compilation.code, simulationExit: simulation.code, verification: state.modules[0].verification,
            accepted: state.summary.accepted, simulationLog: simLog, waveform });
        return state;
    }

    await cycle('baseline', true);
    assert.ok(fixture.rtl.includes(fixture.before));
    await file(rtlName, fixture.rtl.replace(fixture.before, fixture.after));
    let state = await design('tasks');
    assert.equal(state.modules[0].designCurrent, false);
    await transition('return', coordinator, state.revision, ['--reason', 'Exercise controlled defect against unchanged checker']);
    state = await cycle('injected-defect', false);
    await transition('return', coordinator, state.revision, ['--reason', 'Restore original RTL after independently detected data error']);
    await file(rtlName, fixture.rtl);
    await cycle('repaired', true);
    await fs.appendFile(path.join(root, 'sim/tb.sv'), '\n// verification input changed\n');
    state = await design('tasks');
    assert.equal(state.modules[0].verification, 'stale');
    assert.equal(state.summary.accepted, 0);
    const { projectProgress } = require(path.join(runtime, 'src/project/progress'));
    const progress = await projectProgress({ id: 'e2e', root });
    assert.equal(progress.snapshot.summary.stale, 1);
    const summary = { root, version, outcomes, tbEditDetected: true, progressReadOnly: progress.snapshot.readOnly,
        execution: fixture.provenance ? 'coordinator-replay-of-independent-fixtures' : 'single-agent-phased',
        fixtureProvenance: fixture.provenance ?? null, originalInputs: [rtlRef, tbRef] };
    await file('reports/summary.json', summary);
    console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
