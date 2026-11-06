'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { openCandidate, sha256 } = require('./release-archive.cjs');
const { packageAgent } = require('./package-agent.cjs');
const { verifyHosts } = require('./verify-m5-host-matrix.cjs');
const { verifyVivado } = require('./verify-m5-vivado.cjs');
const { findIverilogBinDir } = require('../src/toolchains/iverilog');
const { runProcess } = require('../src/toolchains/process');

const tool = path.resolve(__dirname, '..');

async function main() {
    const { values } = parseArgs({ options: { vsix: { type: 'string' }, ide: { type: 'string', multiple: true },
        iverilog: { type: 'string' }, cygwin: { type: 'string' }, vivado: { type: 'string' }, part: { type: 'string' } } });
    assert.ok(values.vsix && values.vivado, '使用 --vsix、--vivado 和两个 --ide 指定本轮候选与真机工具');
    const iverilogBin = findIverilogBinDir(values.iverilog);
    assert.ok(iverilogBin, 'Icarus 不可用');
    const root = path.join(tool, 'bin', 'm5-scenarios', 'run-' + randomUUID().slice(0, 8));
    const bundle = path.join(root, 'bundle');
    const extensionPath = path.join(root, 'extension');
    const vsix = path.resolve(values.vsix);
    await fs.mkdir(bundle, { recursive: true });
    const candidate = await openCandidate(vsix, extensionPath);
    const { run } = require(path.join(extensionPath, 'src/cli/main.js'));
    const steps = [];
    console.error('[m5] ' + root);
    async function save(name, value) {
        await fs.writeFile(path.join(bundle, name + '.json'), JSON.stringify(value, null, 2) + '\n');
    }
    async function step(label, execute) {
        console.error('[m5] ' + label);
        const started = Date.now();
        const result = await execute();
        steps.push({ label, durationMs: Date.now() - started });
        return result;
    }
    async function workflow(script, extra = []) {
        const args = [path.join(tool, 'scripts', script), '--iverilog', iverilogBin, ...extra];
        if (values.cygwin) args.push('--cygwin', values.cygwin);
        const result = await runProcess(process.execPath, args, { cwd: tool, timeoutMs: 120000,
            env: { ...process.env, SVTOOLS_CANDIDATE_ROOT: extensionPath } });
        assert.equal(result.code, 0, result.stderr || result.stdout || result.errorMessage);
        const summary = JSON.parse(result.stdout);
        const stages = Object.fromEntries(summary.outcomes.map(item => [item.label, item.verification]));
        assert.deepEqual(stages, { baseline: 'accepted', 'injected-defect': 'failed', repaired: 'accepted' });
        if (script === 'verify-design-workflow.cjs') assert.ok(summary.tbEditDetected);
        else {
            assert.match(summary.outcomes[0].simulationTail, /TC_PASS verified=220/);
            assert.match(summary.outcomes[1].simulationTail, /PHANTOM_READ/);
        }
        return summary;
    }

    const agent = await step('从候选 VSIX 构建便携 Agent 并从解压目录试跑', () => packageAgent(vsix,
        path.join(root, `svtools-agent-v${candidate.version}-win32-x64.zip`)));
    assert.equal(agent.vsixSha256, candidate.vsixSha256);

    const skeleton = path.join(root, 'skeleton');
    await fs.cp(path.join(tool, 'test/fixtures/design/skeleton'), skeleton, { recursive: true });
    await step('架构骨架、结构检查、差异及报告', async () => {
        for (const [action, args, allowed] of [
            ['arch', ['--depth', '2', '--save', 'arch-m5'], [0]], ['check', [], [0, 1]],
            ['diff', ['--baseline', 'arch-m5'], [0]], ['report', ['--out', 'report-bundle'], [0]]
        ]) {
            const result = await run(['design', action, '--workspace', skeleton, '--top', 'fifo_top', ...args]);
            assert.ok(allowed.includes(result.exitCode), JSON.stringify(result.output?.diagnostics));
            await save('architecture-' + action, result.output);
        }
        const reportDir = path.join(skeleton, 'report-bundle');
        const manifest = JSON.parse(await fs.readFile(path.join(reportDir, 'report.json'), 'utf8'));
        assert.ok(manifest.files.length >= 4);
        for (const entry of manifest.files) {
            if (entry.kind === 'manifest') continue;
            const file = path.join(reportDir, path.basename(entry.path));
            assert.equal(await sha256(file), entry.sha256);
            await fs.copyFile(file, path.join(bundle, 'architecture-file-' + path.basename(file)));
        }
    });
    await save('synchronous', await step('同步模块交接、注错和复验', () => workflow('verify-design-workflow.cjs')));
    const fifo = await step('FIFO 多时钟及分域复位试点', () => workflow('verify-fifo-workflow.cjs'));
    await save('fifo', fifo);
    const independent = await step('独立 RTL 与参考队列 TB 交接、注错、复验', () => workflow('verify-design-workflow.cjs', ['--independent']));
    assert.equal(independent.fixtureProvenance.context, 'separate-agents-shared-interface-only');
    await save('independent', independent);

    await step('从同一 FIFO 波形导出布局、CSV 与图像', async () => {
        const common = ['wave', 'export', '--workspace', fifo.root, '--file', '.svtools/vcd/tb.vcd', '--signals', 'tb.o_empty,tb.o_full'];
        for (const format of ['layout', 'csv', 'png']) {
            const args = format === 'layout' ? [] : ['--out', 'reports'];
            const result = await run([...common, '--format', format, '--from', '3000ns', '--to', '3100ns', ...args]);
            assert.equal(result.exitCode, 0, JSON.stringify(result.output?.diagnostics));
            assert.ok(result.output.artifacts.length > 0);
            for (const artifact of result.output.artifacts) {
                assert.equal(await sha256(artifact.path), artifact.sha256);
                await fs.copyFile(artifact.path, path.join(bundle, 'wave-' + path.basename(artifact.path)));
            }
        }
    });
    const vivado = await step('真实 Vivado 从工程到综合报告，再按报告优化并复验', () => verifyVivado({
        workspace: path.join(root, 'vivado'), extensionPath, vivado: values.vivado, part: values.part || 'xc7z100ffg900-2',
        iverilogBin, cygwin: values.cygwin }));
    await save('vivado', vivado);
    for (const item of vivado.steps) {
        assert.equal(await sha256(item.file), item.sha256);
        await fs.copyFile(item.file, path.join(bundle, 'vivado-' + path.basename(item.file)));
    }
    const hostRoot = path.join(root, 'hosts');
    const matrix = await step('两款 IDE 验证同一 VSIX 解包目录', () => verifyHosts({ directory: hostRoot,
        extensionPath, candidate, ideEntries: values.ide, iverilogBin, cygwin: values.cygwin }));
    for (const row of matrix.rows) {
        const file = path.join(hostRoot, row.report);
        assert.equal(await sha256(file), row.sha256);
        await fs.copyFile(file, path.join(bundle, 'host-' + row.report.split(path.sep)[0] + '.json'));
    }
    await save('host-matrix', matrix);
    await save('agent', agent);
    assert.equal(await sha256(vsix), candidate.vsixSha256);
    const scenarios = [
        { id: 'S1', result: 'verified', evidence: ['architecture-report.json', 'vivado-project-create.json', 'vivado-project-status.json'] },
        { id: 'S2', result: 'verified', evidence: ['fifo.json', 'independent.json', 'wave-tb.svwave.json'] },
        { id: 'S3', result: 'verified', evidence: ['vivado.json', 'vivado-utilization-before.json', 'vivado-utilization-after.json'] },
        { id: 'S4', result: 'verified', evidence: ['host-matrix.json', 'agent.json', 'architecture-report.json'] }
    ];
    await save('scenarios', { schemaVersion: 2, candidate, generatedUtc: new Date().toISOString(), scenarios, steps });
    for (const scenario of scenarios) for (const file of scenario.evidence) await fs.access(path.join(bundle, file));
    const files = [];
    for (const name of (await fs.readdir(bundle)).sort()) files.push({ name, sha256: await sha256(path.join(bundle, name)) });
    await save('manifest', { schemaVersion: 1, candidate, files });
    console.log(JSON.stringify({ root, candidate, agent, scenarios, vivado: { before: vivado.before, after: vivado.after,
        cycles: vivado.comparedCycles }, hostRows: matrix.rows.length, files: files.length }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
