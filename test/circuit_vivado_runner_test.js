'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runVivadoCircuit } = require('../src/circuit/vivado-runner');

async function fixture(t, produce = async directory => fs.writeFile(path.join(directory, 'circuit.vivado.json'), '{}')) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-circuit-vivado-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const projectPath = path.join(root, 'project.xpr'); await fs.writeFile(projectPath, '<Project/>');
    const calls = [];
    const task = { async waitForPrevious() { calls.push('wait'); }, throwIfCancelled() {},
        async directory(base, kind) { assert.equal(kind, 'circuit-vivado'); const result = path.join(base, kind); await fs.mkdir(result, { recursive: true }); return result; },
        async run(executable, args, options) {
            calls.push({ executable, args, options }); await produce(options.cwd, options);
            return { code: 0, output: '', stdout: '', stderr: '', elapsedMs: 1, logPath: path.join(options.cwd, 'vivado.log') };
        }
    };
    return { root, projectPath, task, calls, options: { task, executable: '/tools/vivado', projectPath, outputBase: path.join(root, 'output') } };
}

test('Vivado runner isolates cwd, quotes artifact paths, forwards timeout/output and preserves XPR', async t => {
    const f = await fixture(t); const output = () => {};
    const result = await runVivadoCircuit({ ...f.options, timeoutMs: 12345, onOutput: output });
    assert.equal(result.sourceRoot, f.root); assert.equal(f.calls[0], 'wait');
    const run = f.calls[1]; assert.deepEqual(run.args.slice(0, 5), ['-mode', 'batch', '-nojournal', '-nolog', '-source']);
    assert.equal(run.options.timeoutMs, 12345); assert.equal(run.options.onStdout, output);
    assert.equal(path.dirname(result.filePath), run.options.cwd);
    assert.equal(await fs.readFile(f.projectPath, 'utf8'), '<Project/>');
    const script = await fs.readFile(run.args[5], 'utf8'); assert.ok(script.includes('svtools_circuit::exportProject'));
});

test('Vivado runner reports explicit Tcl failure and persistent log', async t => {
    const f = await fixture(t); f.task.run = async (command, args, options) => {
        options.onLine('SVTOOLS_CIRCUIT_ERROR missing top', true, {});
        return { code: 1, output: 'SVTOOLS_CIRCUIT_ERROR missing top', logPath: '/task/vivado.log' };
    };
    await assert.rejects(runVivadoCircuit(f.options), /missing top\n完整日志：\/task\/vivado.log/);
});

test('Vivado runner rejects incomplete, empty and over-budget artifacts', async t => {
    for (const produce of [async () => {}, async dir => fs.writeFile(path.join(dir, 'circuit.vivado.json'), ''),
        async dir => { const handle = await fs.open(path.join(dir, 'circuit.vivado.json'), 'w'); try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); } }]) {
        const f = await fixture(t, produce);
        await assert.rejects(runVivadoCircuit(f.options), /未生成完整|超过 64 MiB/);
    }
});

test('Vivado runner cancels before launching and validates XPR/timeout', async t => {
    const f = await fixture(t); await assert.rejects(runVivadoCircuit({ ...f.options, timeoutMs: 0 }), /超时/);
    const wrongPath = path.join(f.root, 'project.txt'); await fs.writeFile(wrongPath, 'x');
    await assert.rejects(runVivadoCircuit({ ...f.options, projectPath: wrongPath }), /XPR/);
    f.task.throwIfCancelled = () => { throw new Error('cancelled'); };
    await assert.rejects(runVivadoCircuit(f.options), /cancelled/); assert.equal(f.calls.filter(call => typeof call === 'object').length, 0);
});
