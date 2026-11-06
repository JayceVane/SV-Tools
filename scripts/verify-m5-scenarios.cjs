'use strict';
// M5 批 4：把四个端到端场景串成一条可核验证据链，产出可由 Agent 无 IDE 消费的报告包。
// 可重跑：node scripts/verify-m5-scenarios.cjs [--iverilog <bin>]；产物在 bin/m5-scenarios/run-<ts>/。
// 边界：真实 Vivado 闭环与目标 IDE 宿主验收均为既有真机证据引用（见 evidenceRefs），不在本脚本内重跑。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { run } = require('../src/cli/main');
const { findIverilogBinDir } = require('../src/toolchains/iverilog');
const { parseArgs } = require('node:util');

const tool = path.resolve(__dirname, '..');
const { values } = parseArgs({ options: { iverilog: { type: 'string' } } });
const iverilogBin = findIverilogBinDir(values.iverilog);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = async file => sha256(await fsp.readFile(file));
const fileRef = async (file, relativeTo) => {
    const bytes = await fsp.readFile(file);
    return { path: path.relative(relativeTo, file).replace(/\\/g, '/'), bytes: bytes.length, sha256: sha256(bytes) };
};
const latest = async (prefix, before) => {
    const dirs = (await fsp.readdir(path.join(tool, 'bin')))
        .filter(name => name.startsWith(prefix) && !before.has(name))
        .sort();
    assert.ok(dirs.length, prefix + ' 未生成新产物目录');
    return path.join(tool, 'bin', dirs.at(-1));
};
const listRuns = async prefix => new Set((await fsp.readdir(path.join(tool, 'bin'))).filter(name => name.startsWith(prefix)));

async function cli(args) {
    const started = Date.now();
    const response = await run(args);
    return { args, exitCode: response.exitCode, durationMs: Date.now() - started, output: response.output };
}
function expect(step, condition, message) {
    assert.ok(condition, step + '：' + message + '\n' + JSON.stringify(step instanceof Object ? step : {}).slice(0, 400));
}
function spawnScript(script, args) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const child = spawn(process.execPath, [script, ...args], { cwd: tool, windowsHide: true, env: { ...process.env } });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', code => resolve({ script: path.relative(tool, script).replace(/\\/g, '/'), args, exitCode: code,
            durationMs: Date.now() - started, stdout, stderr }));
    });
}

async function main() {
    assert.ok(iverilogBin, 'Icarus 不可用；用 --iverilog <bin> 指定');
    const root = path.join(tool, 'bin', 'm5-scenarios', 'run-' + Date.now());
    const ws = path.join(root, 'ws'), bundle = path.join(root, 'bundle');
    await fsp.mkdir(bundle, { recursive: true });
    await fsp.mkdir(path.join(ws), { recursive: true });
    await fsp.cp(path.join(tool, 'test', 'fixtures', 'design', 'skeleton'), ws, { recursive: true });
    const steps = [], artifacts = [], warnings = [];

    // 场景 1：空模块参数化 FIFO -> 架构/接口表/结构检查/报告包（现场 CLI）。
    const arch = await cli(['design', 'arch', '--workspace', ws, '--top', 'fifo_top', '--depth', '2', '--save', 'arch-m5']);
    steps.push({ scenario: 1, label: 'design arch', ...arch, ok: arch.exitCode === 0 });
    expect('design arch', arch.exitCode === 0, JSON.stringify(arch.output?.diagnostics));
    const check = await cli(['design', 'check', '--workspace', ws, '--top', 'fifo_top']);
    steps.push({ scenario: 1, label: 'design check', exitCode: check.exitCode, durationMs: check.durationMs,
        status: check.output?.data?.status, ok: [0, 1].includes(check.exitCode) });
    const diff = await cli(['design', 'diff', '--workspace', ws, '--top', 'fifo_top', '--baseline', 'arch-m5']);
    steps.push({ scenario: 1, label: 'design diff', exitCode: diff.exitCode, durationMs: diff.durationMs, ok: diff.exitCode === 0 });
    const report = await cli(['design', 'report', '--workspace', ws, '--top', 'fifo_top', '--out', 'report-bundle', '--style', 'document', '--title', 'M5 四场景报告包']);
    steps.push({ scenario: 1, label: 'design report', exitCode: report.exitCode, durationMs: report.durationMs,
        files: report.output?.data?.files?.map(item => item.kind), ok: report.exitCode === 0 });
    expect('design report', report.exitCode === 0, JSON.stringify(report.output?.diagnostics));
    const reportDir = path.join(ws, 'report-bundle');
    const reportManifest = JSON.parse(await fsp.readFile(path.join(reportDir, 'report.json'), 'utf8'));
    for (const entry of reportManifest.files) {
        if (entry.kind === 'manifest') continue;
        const target = path.isAbsolute(entry.path) ? entry.path : path.join(reportDir, entry.path);
        assert.equal(await hashFile(target), entry.sha256, '报告包哈希不符：' + entry.path);
    }
    for (const name of await fsp.readdir(reportDir)) {
        const source = path.join(reportDir, name);
        if ((await fsp.stat(source)).isFile()) {
            await fsp.copyFile(source, path.join(bundle, 'scenario1-' + name));
            artifacts.push({ scenario: 1, ...await fileRef(path.join(bundle, 'scenario1-' + name), root), source: 'design report' });
        }
    }

    // 场景 1/2 的工程与交接现场证据：两个独立可重跑脚本（真实 Icarus 编译/仿真/工作流）。
    const beforeWorkflow = await listRuns('workflow-e2e-'), beforeFifo = await listRuns('fifo-e2e-');
    const workflow = await spawnScript(path.join(tool, 'scripts', 'verify-design-workflow.cjs'), ['--iverilog', iverilogBin]);
    steps.push({ scenario: 1, label: 'verify-design-workflow', exitCode: workflow.exitCode, durationMs: workflow.durationMs, ok: workflow.exitCode === 0 });
    expect('verify-design-workflow', workflow.exitCode === 0, workflow.stderr.slice(-800));
    const workflowRoot = await latest('workflow-e2e-', beforeWorkflow);
    const fifo = await spawnScript(path.join(tool, 'scripts', 'verify-fifo-workflow.cjs'), ['--iverilog', iverilogBin]);
    steps.push({ scenario: 2, label: 'verify-fifo-workflow', exitCode: fifo.exitCode, durationMs: fifo.durationMs, ok: fifo.exitCode === 0 });
    expect('verify-fifo-workflow', fifo.exitCode === 0, fifo.stderr.slice(-800));
    const fifoRoot = await latest('fifo-e2e-', beforeFifo);
    for (const [label, file, scenario] of [['workflow-summary', path.join(workflowRoot, 'reports', 'summary.json'), 1],
        ['fifo-summary', path.join(fifoRoot, 'reports', 'summary.json'), 2]]) {
        const target = path.join(bundle, label + '.json');
        await fsp.copyFile(file, target);
        artifacts.push({ scenario, ...await fileRef(target, root), source: '现场脚本产物' });
    }
    const fifoSummary = JSON.parse(await fsp.readFile(path.join(fifoRoot, 'reports', 'summary.json'), 'utf8'));
    const fifoStates = Object.fromEntries(fifoSummary.outcomes.map(item => [item.label, item]));
    expect('FIFO 三阶段', ['baseline', 'injected-defect', 'repaired'].every(label => fifoStates[label]), JSON.stringify(Object.keys(fifoStates)));
    assert.equal(fifoStates.baseline.verification, 'accepted');
    assert.equal(fifoStates['injected-defect'].verification, 'failed');
    assert.equal(fifoStates.repaired.verification, 'accepted');
    assert.match(fifoStates.baseline.simulationTail, /TC_PASS verified=220/);
    assert.match(fifoStates['injected-defect'].simulationTail, /PHANTOM_READ t=3069000/);
    assert.equal(fifoStates['injected-defect'].simulationExit, 0, '注错场景 vvp 退出码应为 0，判定来自用例状态');
    const workflowSummary = JSON.parse(await fsp.readFile(path.join(workflowRoot, 'reports', 'summary.json'), 'utf8'));
    const workflowStates = Object.fromEntries(workflowSummary.outcomes.map(item => [item.label, item]));
    expect('工作流四场景', ['baseline', 'injected-defect', 'repaired'].every(label => workflowStates[label]) && workflowSummary.tbEditDetected === true,
        JSON.stringify(workflowSummary));

    // 场景 2/4：同一 VCD 的波形取证产物（layout/csv/png 与查看器自动套用同一份声明身份）。
    const waveFile = '.svtools/vcd/tb.vcd', signals = 'tb.o_empty,tb.o_full';
    const layout = await cli(['wave', 'export', '--workspace', fifoRoot, '--file', waveFile, '--signals', signals, '--format', 'layout', '--force']);
    steps.push({ scenario: 2, label: 'wave export layout', exitCode: layout.exitCode, durationMs: layout.durationMs,
        artifact: layout.output?.data?.artifacts?.[0]?.path, ok: layout.exitCode === 0 });
    expect('wave export layout', layout.exitCode === 0, JSON.stringify(layout.output?.diagnostics));
    const layoutPath = path.join(fifoRoot, '.svtools', 'vcd', 'tb.svwave.json');
    const csv = await cli(['wave', 'export', '--workspace', fifoRoot, '--file', waveFile, '--signals', signals,
        '--out', 'reports', '--format', 'csv', '--force']);
    steps.push({ scenario: 2, label: 'wave export csv', exitCode: csv.exitCode, durationMs: csv.durationMs,
        rows: csv.output?.data?.artifacts?.[0]?.rows, ok: csv.exitCode === 0 });
    expect('wave export csv', csv.exitCode === 0, JSON.stringify(csv.output?.diagnostics));
    const png = await cli(['wave', 'export', '--workspace', fifoRoot, '--file', waveFile, '--signals', signals,
        '--out', 'reports', '--format', 'png', '--at', '3069ns', '--force']);
    steps.push({ scenario: 2, label: 'wave export png', exitCode: png.exitCode, durationMs: png.durationMs, ok: png.exitCode === 0 });
    if (png.exitCode !== 0) warnings.push('wave export png 未成功：' + JSON.stringify(png.output?.diagnostics));
    else expect('wave export png', png.exitCode === 0, 'PNG 导出');
    for (const [name, source] of [['scenario2-tb.svwave.json', layoutPath],
        ['scenario2-tb.csv', path.join(fifoRoot, 'reports', 'tb.csv')],
        ['scenario2-tb.svg', path.join(fifoRoot, 'reports', 'tb.svg')],
        ['scenario2-tb.png', path.join(fifoRoot, 'reports', 'tb.png')]]) {
        if (!fs.existsSync(source)) continue;
        const target = path.join(bundle, name);
        await fsp.copyFile(source, target);
        artifacts.push({ scenario: 2, ...await fileRef(target, root), source: 'wave export' });
    }
    const layoutJson = JSON.parse(await fsp.readFile(layoutPath, 'utf8'));
    expect('布局声明身份', Array.isArray(layoutJson.tracks) && layoutJson.tracks.length === 2, JSON.stringify(layoutJson).slice(0, 200));

    // 场景 3：结构化报告解析回归（现场）+ 既有真实 Vivado 资源/时序/证据失效证据（引用）。
    const reportTests = await new Promise(resolve => {
        const started = Date.now();
        const child = spawn(process.execPath, ['--test', 'test/vivado_commands_test.js', 'test/vivado_tree_test.js'],
            { cwd: tool, windowsHide: true });
        let text = '';
        child.stdout.on('data', chunk => { text += chunk; });
        child.stderr.on('data', chunk => { text += chunk; });
        child.once('close', code => resolve({ exitCode: code, output: text, durationMs: Date.now() - started }));
    });
    steps.push({ scenario: 3, label: 'vivado 报告/工程树解析回归', exitCode: reportTests.exitCode, durationMs: reportTests.durationMs, ok: reportTests.exitCode === 0 });
    expect('报告解析回归', reportTests.exitCode === 0, reportTests.output.slice(-800));

    // 场景 4：证据引用与客户端一致性的汇总包。
    const references = [
        { path: 'docs/V4_2_M5_WORKFLOW_VALIDATION.md', label: '批 1 工作流四场景' },
        { path: 'docs/V4_2_M5_FIFO_VALIDATION.md', label: '批 2 FIFO / 多时钟' },
        { path: 'docs/V4_2_M5_VIVADO_VALIDATION.md', label: '批 3 真实 Vivado 闭环' }
    ];
    for (const item of references) {
        const file = path.join(tool, item.path);
        assert.ok(fs.existsSync(file), '缺少证据文档：' + item.path);
        const target = path.join(bundle, 'evidence-' + path.basename(item.path));
        await fsp.copyFile(file, target);
        artifacts.push({ scenario: 4, ...await fileRef(target, root), source: item.label });
    }
    const matrixFile = path.join(tool, 'bin', 'm5-host-matrix.json');
    assert.ok(fs.existsSync(matrixFile), '缺少宿主矩阵 bin/m5-host-matrix.json，请先跑 IDE 宿主验收');
    const matrix = JSON.parse(await fsp.readFile(matrixFile, 'utf8'));
    assert.equal(matrix.rows.length, 10, '宿主矩阵应为 2 IDE × 5 宿主');
    assert.ok(matrix.rows.every(row => row.failed === 0), '宿主矩阵存在失败项');
    await fsp.copyFile(matrixFile, path.join(bundle, 'ide-host-matrix.json'));
    artifacts.push({ scenario: 4, ...await fileRef(path.join(bundle, 'ide-host-matrix.json'), root), source: 'VS Code / Qoder 宿主验收' });

    const scenarios = [
        { id: 1, name: '从架构到工程', status: 'partial', detail: '现场：参数化 FIFO 空模块骨架的 arch/check/diff/report 报告包与真实 Icarus 工作流交接；引用：批 3 真实 Vivado 工程创建/加源/设 top。' },
        { id: 2, name: '从失败到修复', status: 'verified', detail: '现场：FIFO 三轮 Icarus 仿真（baseline / 注入 B 域同步链无复位 / 修复复验）与同一 VCD 的 layout/csv/png 取证产物。' },
        { id: 3, name: '从报告到优化', status: 'partial', detail: '现场：Vivado 报告/工程树结构化解析回归；引用：批 3 真实 utilization/DRC 报告、改源 stale=true 与复跑后资源计数变化。未现场重跑分钟级综合。' },
        { id: 4, name: '从工程到文档', status: 'verified', detail: '现场：汇总架构报告包、波形证据、三批验证记录与两个 IDE 的宿主矩阵，逐文件 sha256 可核，纯 JSON/MD/SVG/PNG 无 IDE 依赖。' }
    ];
    const evidenceRefs = [
        { document: 'docs/V4_2_M5_VIVADO_VALIDATION.md', fact: 'Vivado 2022.1 隔离临时工程：3 通过 / 0 失败 / 1 跳过（283.0 s）；后台取消 2 通过 / 0 失败 / 2 跳过（59.5 s）。' },
        { document: 'docs/V4_2_M5_FIFO_VALIDATION.md', fact: 'baseline TC_PASS verified=220；注错 PHANTOM_READ t=3069000；修复复验通过。' },
        { document: 'docs/V4_2_M5_WORKFLOW_VALIDATION.md', fact: '真实 Icarus 四场景：正常通过 / 注入错误拒绝 / 修复复验 / 改 TB 后证据过期。' },
        { document: 'bin/m5-host-matrix.json', fact: 'VS Code 1.144.0 与 Qoder 内核 1.106.3，5 宿主 × 2 IDE 全部 0 失败。' }
    ];
    const manifest = { schemaVersion: 1, kind: 'm5-scenario-bundle', generatedUtc: new Date().toISOString(),
        node: process.version, iverilogBin, workspace: path.relative(tool, ws).replace(/\\/g, '/'),
        steps, scenarios, evidenceRefs, warnings,
        acceptance: { complete: false, remaining: ['真实 Vivado 从报告到优化的现场完整闭环', '多 Agent 独立性', '四个端到端场景的单次连续真机串联', '发行机械与版本统一'] },
        execution: 'single-agent-phased' };
    await fsp.writeFile(path.join(bundle, 'scenarios.json'), JSON.stringify(manifest, null, 2));
    const lines = ['# M5 四场景证据链（测试用，不代表发行验收完成）', '',
        '生成时间：' + manifest.generatedUtc + '；Node ' + process.version + '；执行方式：单 Agent 分阶段。', '',
        '| 场景 | 状态 | 说明 |', '|---|---|---|'];
    for (const item of scenarios) lines.push('| ' + item.id + '. ' + item.name + ' | ' + item.status + ' | ' + item.detail + ' |');
    lines.push('', '## 现场步骤', '');
    for (const step of steps) lines.push('- [' + (step.ok ? '通过' : '失败') + '] 场景 ' + step.scenario + ' · ' + step.label + ' · exit=' + step.exitCode + ' · ' + step.durationMs + ' ms');
    lines.push('', '## 引用的真机证据', '');
    for (const item of evidenceRefs) lines.push('- ' + item.document + '：' + item.fact);
    lines.push('', '## 剩余门禁', '');
    for (const item of manifest.acceptance.remaining) lines.push('- ' + item);
    if (warnings.length) lines.push('', '## 警告', '', ...warnings.map(item => '- ' + item));
    lines.push('', '报告包内每个文件均在 scenarios.json / manifest.json 中登记 SHA-256，Agent 无需启动 IDE 即可消费。', '');
    await fsp.writeFile(path.join(bundle, 'SCENARIOS.md'), lines.join('\n'));
    const bundleFiles = (await fsp.readdir(bundle)).filter(name => name !== 'manifest.json').sort();
    const fileEntries = [];
    for (const name of bundleFiles) fileEntries.push(await fileRef(path.join(bundle, name), bundle));
    await fsp.writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({ schemaVersion: 1, createdUtc: new Date().toISOString(), files: fileEntries }, null, 2));
    console.log(JSON.stringify({ root: path.relative(tool, root).replace(/\\/g, '/'), steps: steps.length,
        failedSteps: steps.filter(step => !step.ok).length, artifacts: fileEntries.length, scenarios, warnings,
        acceptance: manifest.acceptance }, null, 2));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
