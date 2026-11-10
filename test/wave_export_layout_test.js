'use strict';
// wave export --format layout：CLI 产物 → 查看器同名布局的闭环，以及写入身份与路径边界。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { run } = require('../src/cli/main');
const { openTrace } = require('../src/agent/wave');
const S = require('../src/waveform/layout-state');
const M = require('../src/waveform/model');
const { createLayoutFiles } = require('../src/waveform/layout-files');

const TRACE = `$timescale 1 ns $end
$scope module tb $end
$var wire 1 ! clk $end $var wire 8 # q [7:0] $end
$upscope $end $enddefinitions $end
#0 $dumpvars 0! b0 # $end
#10 1! b1 #
#20 0! b11 #
`;

async function tempDir(t, prefix) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}
async function fixture(t) {
    const directory = await tempDir(t, 'svtools-layout-');
    await fs.writeFile(path.join(directory, 'trace.vcd'), TRACE);
    return directory;
}
const args = (directory, extra = []) => ['wave', 'export', '--workspace', directory, '--file', 'trace.vcd', '--signals', 'clk,q', ...extra];
/** 只读的同名布局探测替身；URI 与真实文件系统直连，避免重写 fs 语义。 */
function vscodeStub() {
    return { Uri: { file: target => ({ fsPath: target }) },
        workspace: { fs: { stat: async uri => fs.stat(uri.fsPath), readFile: async uri => fs.readFile(uri.fsPath) } } };
}

test('默认同名布局导出：v1 契约、产物哈希、查看器可恢复且能自动读取', async t => {
    const directory = await fixture(t);
    const response = await run(args(directory, ['--format', 'layout', '--from', '10', '--to', '20', '--at', '15', '--at-b', '20']));
    const out = response.output;
    assert.equal(response.exitCode, 0, JSON.stringify(out.diagnostics));
    assert.equal(out.data.format, 'layout');
    assert.equal(out.data.tracks, 2);
    assert.match(out.data.viewer, /自动套用/);
    const artifact = out.artifacts.find(item => item.kind === 'layout');
    assert.equal(artifact.path, path.join(directory, 'trace.svwave.json'), '默认落在波形同目录');
    const text = await fs.readFile(artifact.path, 'utf8');
    const layout = JSON.parse(text);
    assert.equal(artifact.sha256, createHash('sha256').update(text).digest('hex'));
    assert.equal(artifact.bytes, Buffer.byteLength(text));
    assert.equal(layout.kind, 'svtools-wave-layout');
    assert.equal(layout.version, 1);
    assert.deepEqual(layout.view, { start: 10, span: 10 });
    assert.equal(layout.cursorA, 15);
    assert.equal(layout.cursorB, 20);
    assert.deepEqual(layout.collapsedGroups, []);
    assert.equal(S.validate(layout), layout);
    assert.equal(layout.tracks.every(track => track.visible === true && Number.isSafeInteger(track.signal.width)), true);

    // 闭环：同一份 VCD 声明身份在查看器侧能按 path/range/width 恢复，不依赖 VCD id。
    const trace = await openTrace({ workspace: directory, file: 'trace.vcd' });
    try {
        const vars = M.prepareSignals(trace.meta.vars);
        const signals = new Map(vars.map(signal => [M.signalKey(signal), signal]));
        const restored = S.restore(layout, signals, { endTime: trace.meta.endTime, secondsPerTick: 1e-9 });
        assert.deepEqual(restored.missing, []);
        assert.equal(restored.selected.length, 2);
        assert.equal(restored.cursorA, 15);
    } finally { trace.close(); }

    // 宿主的同名探测：VCD 与 FST 去扩展名后都指向同一份 .svwave.json。
    for (const name of ['trace.vcd', 'trace.fst']) {
        const files = createLayoutFiles({ vscode: vscodeStub(), filePath: path.join(directory, name) });
        assert.deepEqual((await files.auto()).tracks, layout.tracks, name + ' 同名布局可读');
    }
    const missing = createLayoutFiles({ vscode: vscodeStub(), filePath: path.join(directory, 'other.vcd') });
    assert.equal(await missing.auto(), null, '无同名布局时静默返回 null');
});

test('保存对话框默认名与自动套用同名一致（含 FST）', async () => {
    for (const name of ['trace.vcd', 'trace.fst']) {
        let suggested;
        const files = createLayoutFiles({ filePath: path.join('/p', name),
            vscode: { Uri: { file: target => ({ fsPath: target }) },
                window: { showSaveDialog: async options => { suggested = options.defaultUri.fsPath; return null; } },
                workspace: { fs: {} } } });
        assert.equal(await files.save(S.capture({ signals: new Map(), selected: [], view: { start: 0, span: 10 }, cursorA: 0, cursorB: null })), false);
        assert.equal(suggested, path.join('/p', 'trace.svwave.json'));
    }
});

test('--out/--force/--title、FILE_EXISTS、链接别名与目录逃逸防护', async t => {
    const directory = await fixture(t);
    const base = args(directory, ['--out', 'shots', '--format', 'layout']);
    const first = await run(base);
    assert.equal(first.exitCode, 0, JSON.stringify(first.output));
    const file = first.output.artifacts[0].path;
    assert.equal(file, path.join(directory, 'shots', 'trace.svwave.json'));
    assert.match(first.output.data.viewer, /手动/, '--out 到别处不能承诺自动套用');
    const text = await fs.readFile(file, 'utf8');

    const again = await run(base);
    assert.equal(again.output.diagnostics[0].code, 'FILE_EXISTS');
    assert.equal(await fs.readFile(file, 'utf8'), text, '未 --force 不改动已有布局');

    const forced = await run([...base, '--force', '--title', 'demo']);
    assert.equal(forced.exitCode, 0, JSON.stringify(forced.output));
    assert.equal(path.basename(forced.output.artifacts[0].path), 'demo.svwave.json');

    // --force 覆盖不能跟随已存在的硬链接写出目录外。
    const outside = path.join(directory, 'outside.txt');
    await fs.writeFile(outside, 'keep');
    await fs.link(outside, path.join(directory, 'shots', 'linked.svwave.json'));
    const linked = await run(args(directory, ['--out', 'shots', '--format', 'layout', '--title', 'linked', '--force']));
    assert.equal(linked.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    assert.equal(await fs.readFile(outside, 'utf8'), 'keep', '目录外的链接目标未被改写');

    const escape = await run(args(directory, ['--out', '../escape', '--format', 'layout']));
    assert.equal(escape.output.diagnostics[0].code, 'INVALID_ARGUMENT', '--out 逃逸工作区被拒绝');
    const bogus = await run(args(directory, ['--out', 'shots', '--format', 'bogus']));
    assert.equal(bogus.output.diagnostics[0].code, 'INVALID_ARGUMENT', '拼错的格式不能静默产出 SVG');
});

test('波形在工作区外时默认同名输出被拒绝，并要求显式 --out', async t => {
    const workspace = await fixture(t);
    const outside = await tempDir(t, 'svtools-layout-out-');
    await fs.writeFile(path.join(outside, 'trace.vcd'), TRACE);
    const rejected = await run(['wave', 'export', '--workspace', workspace, '--file', path.join(outside, 'trace.vcd'),
        '--signals', 'clk', '--format', 'layout']);
    assert.equal(rejected.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    assert.match(rejected.output.diagnostics[0].message, /波形文件不在工作区内/);
    const explicit = await run(['wave', 'export', '--workspace', workspace, '--file', path.join(outside, 'trace.vcd'),
        '--signals', 'clk', '--format', 'layout', '--out', 'layouts']);
    assert.equal(explicit.exitCode, 0, JSON.stringify(explicit.output));
    assert.equal(explicit.output.artifacts[0].path, path.join(workspace, 'layouts', 'trace.svwave.json'));
});

test('布局提示取决于查看器实际查找的路径', async t => {
    const directory = await fixture(t);
    const viewer = createLayoutFiles({ vscode: vscodeStub(), filePath: path.join(directory, 'trace.vcd') });
    const renamed = await run(args(directory, ['--format', 'layout', '--title', 'review']));
    assert.equal(renamed.exitCode, 0);
    assert.match(renamed.output.data.viewer, /手动打开/);
    assert.equal(await viewer.auto(), null);
    const samePath = await run(args(directory, ['--format', 'layout', '--out', '.']));
    assert.equal(samePath.exitCode, 0);
    assert.match(samePath.output.data.viewer, /自动套用/);
    assert.ok(await viewer.auto());
});
