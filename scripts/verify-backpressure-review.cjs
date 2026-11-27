'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify, parseArgs } = require('node:util');
const { findIverilogBinDir, findCygwinBinDir, buildChildEnv } = require('../src/toolchains/iverilog');
const { fingerprint, MAX_ARTIFACT } = require('../src/design/workflow-files');
const { loadReview, revealObservation, loadReviewSample } = require('../src/design/review-model');
const { buildArchitectureBook, resolveContext, resolveReviewFocus } = require('../src/design/architecture-model');

const runProcess = promisify(execFile);
const repo = path.resolve(__dirname, '..');
const sources = ['pipe.sv', 'tb.sv'];
const ref = (file, label, line) => ({ file, label, line });

async function run() {
    const { values } = parseArgs({ options: { iverilog: { type: 'string' }, cygwin: { type: 'string' } } });
    const bin = findIverilogBinDir(values.iverilog);
    assert.ok(bin, 'Icarus 不可用，请使用 --iverilog <bin> 指定安装位置');
    const tool = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
    const env = { ...buildChildEnv(findCygwinBinDir(values.cygwin, bin)), IVERILOG_DUMPER: 'vcd' };
    await fs.mkdir(path.join(repo, 'bin'), { recursive: true });
    const root = await fs.mkdtemp(path.join(repo, 'bin', 'backpressure-review-'));
    const execute = (name, args, cwd = root) => runProcess(tool(name), args, { cwd, env, timeout: 20000, windowsHide: true });
    const write = (file, value) => fs.writeFile(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    const file = async filePath => {
        const { path, sha256 } = await fingerprint(root, filePath, MAX_ARTIFACT);
        return { path, sha256 };
    };
    for (const source of sources) await fs.copyFile(path.join(repo, 'example', 'backpressure-review', source), path.join(root, source));
    const inputs = await Promise.all(sources.map(file));
    const compilerArgs = ['-g2012', '-s', 'tb', '-o', 'case.vvp', ...sources];
    const compiled = await execute('iverilog', compilerArgs);
    await write('compile.log', compiled.stdout + compiled.stderr);
    const compileLog = await file('compile.log');
    const files = [{ id: 'rtl', ...inputs[0] }, { id: 'tb', ...inputs[1] }];
    const variants = [], results = [];
    for (const [id, args, expectedHits] of [['a', [], 0], ['b', ['+STALL'], 3]]) {
        const folder = path.join(root, id);
        await fs.mkdir(folder);
        const runtimeArgs = ['../case.vvp', ...args];
        const simulation = await execute('vvp', runtimeArgs, folder);
        await write(`${id}/simulation.log`, simulation.stdout + simulation.stderr);
        const pass = simulation.stdout.match(/^PASS received=(\d+) stalled_edges=(\d+) hold_checks=(\d+) sample_ps=(\d+)$/mu);
        assert.ok(pass, simulation.stdout);
        const [, received, stalledEdges, holdChecks, at] = pass;
        assert.deepEqual([+received, +stalledEdges, +holdChecks], [2, expectedHits, expectedHits]);
        const log = await file(`${id}/simulation.log`), wave = await file(`${id}/trace.vcd`);
        await write(`${id}/run.json`, { schemaVersion: 1, runId: id, simulator: 'Icarus Verilog', entry: 'tb.sv',
            commands: { compile: compilerArgs, simulate: runtimeArgs }, inputs, artifacts: [compileLog, log, wave] });
        files.push({ id: `${id}-run`, ...await file(`${id}/run.json`) }, { id: `${id}-log`, ...log }, { id: `${id}-wave`, ...wave });
        variants.push({ id, label: `运行 ${id.toUpperCase()}`, inputs: ['rtl', 'tb'], run: `${id}-run` });
        results.push({ id, received: +received, stalledEdges: +stalledEdges, holdChecks: +holdChecks, at,
            logLine: simulation.stdout.split(/\r?\n/u).findIndex(line => line === pass[0]) + 1 });
    }
    const observations = coverage => results.map(({ id, received, holdChecks, at, logLine }) => ({
        variant: id, status: coverage && !holdChecks ? 'not_triggered' : 'passed',
        text: coverage ? `全用例 PASS。背压保持检查执行 ${holdChecks} 次。` : `全用例 PASS，按顺序收到 ${received} 个预期字节。`,
        refs: [ref(`${id}-log`, '查看检查计数', logLine), ref(`${id}-run`, '查看运行记录'),
            { file: `${id}-wave`, label: '跳到计数汇总采样点', sample: { at: `${at} ps`, signals: ['tb.received', 'tb.stalled_edges', 'tb.hold_checks'] } }]
    }));
    const testbench = (await fs.readFile(path.join(root, 'tb.sv'), 'utf8')).split(/\r?\n/u);
    const line = text => testbench.findIndex(source => source.includes(text)) + 1;
    const architecture = { top: 'review_pipe', file: 'rtl', instances: ['u_pipe'] };
    await write('svtools.review.json', { schemaVersion: 1, title: '背压保持 · 通过与未触发复核', files, rules: [{
        id: 'hold-under-stall', title: 'PASS 能否证明背压保持', module: 'pipe', group: '接口时序', variants,
        contract: '输出 valid 为 1 且下游 ready 为 0 时，下一拍必须保持 valid 和数据，直到接收。',
        mechanism: '输出槽在接收前保留数据。测试只在上一拍 valid 且未接收时执行保持检查。',
        stimulus: '两次运行发送相同的 A5、3C。用 +STALL 控制第一笔事务是否等待下游。',
        checker: '固定序列检查接收字节与顺序，另计数 valid && !ready 和实际执行的保持检查。',
        events: [{ id: 'delivery', title: '字节是否按顺序交付', expected: '最终恰好接收两个字节，依次为 A5、3C。',
            architecture: { ...architecture, links: ['out_data'] },
            flow: [{ label: '字节比较', detail: '在 valid && ready 的采样沿与固定序列比较。', active: true }],
            refs: [ref('tb', '定位接收检查', line('case (received)'))], observations: observations(false) },
        { id: 'coverage', title: '背压保持检查是否执行', expected: '先从激励推导等待拍数。保持检查需要上一拍 valid 为 1 且 ready 为 0。',
            architecture: { ...architecture, links: ['out_ready', 'out_valid'] },
            flow: [{ label: '触发前提', detail: '在每个上升沿记录是否发生 valid && !ready。' },
                { label: '保持检查', detail: '下一拍检查 valid 与数据，并累计执行次数。', active: true }],
            refs: [ref('rtl', '查看输出槽'), ref('tb', '定位保持检查', line('if (previous_stall)'))], observations: observations(true) }]
    }] });
    const review = await loadReview(root);
    const { book } = await buildArchitectureBook(await resolveContext({ workspace: root, top: architecture.top }));
    const focused = review.snapshot.rules[0].events.map(event => resolveReviewFocus(book, event.architecture));
    assert.deepEqual(focused.map(focus => [focus.nodes.length, focus.links.length]), [[1, 1], [1, 2]]);
    const checked = [];
    for (const observation of review.observations.values()) {
        const actual = await revealObservation(root, observation);
        assert.equal(actual.status, observation.status, JSON.stringify(actual));
        const link = review.links.get(actual.refs.find(item => item.hasSample).token);
        const sample = await loadReviewSample(root, link);
        const result = results.find(result => `${result.id}-wave` === link.file.id);
        assert.ok(result);
        assert.equal(sample.values['tb.hold_checks'].signed, String(result.holdChecks));
        assert.equal(sample.values['tb.received'].signed, String(result.received));
        assert.equal(sample.values['tb.stalled_edges'].signed, String(result.stalledEdges));
        checked.push({ status: actual.status, sample });
    }
    await write('verification.json', { results, checked });
    await fs.copyFile(path.join(repo, 'example', 'backpressure-review', 'TASK.md'), path.join(root, 'TASK.md'));
    console.log(root);
}

run().catch(error => { console.error(error.stdout || '', error.stderr || '', error); process.exitCode = 1; });
