'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { createToolTaskManager } = require('../src/toolchains/job');
const { summarizeToolResult } = require('../src/toolchains/result');
const { createDiagnosticCapture } = require('../src/toolchains/diagnostics');
const { createBufferedOutput } = require('../src/toolchains/channel');
const { lintWithXvlog, elaborateWithXvlog } = require('../src/toolchains/xvlog');
const { runVivadoBatchTask } = require('../src/vivado/batch');
const { activateIverilog } = require('../src/toolchains/iverilog');
const defaults = require('../package.json').contributes.configuration.properties;

/** 协议工具是真实 Node 子进程；它测试驱动边界，不冒充厂商编译器。 */
const DRIVER = `const fs=require('node:fs'),path=require('node:path');
const tool=process.argv[2],mode=process.argv[3];
const rest=process.argv.slice(4),prj=path.join(process.cwd(),'svtools.prj');
let file=rest.at(-1),source='';
if(tool==='xvlog'&&fs.existsSync(prj))file=fs.readFileSync(prj,'utf8').match(/"([^"]+)"/)[1];
if(file&&fs.existsSync(file))source=fs.readFileSync(file,'utf8');
if(mode==='slow'||source.includes('SLOW')){fs.writeFileSync('compile-started','yes');console.log('ready');setTimeout(()=>{console.log('ERROR: [VRFC 1] late failure ['+file+':1]');process.exit(2)},3000);return;}
if(mode==='dep'){if(tool==='iverilog'){console.error(path.join(process.cwd(),'dependency.sv')+':4: error: broken dependency');process.exitCode=1;}
else console.log('ERROR: [VRFC 1] broken dependency ['+path.join(process.cwd(),'dependency.sv')+':4]');}
if(mode==='early'){console.log('ERROR: [VRFC 1] early error ['+file+':2]');process.stdout.write('noise '.repeat(100000)+'\\n');}
if(mode==='exit'){console.log('unrecognized tool failure');process.exit(7);}
if(mode==='inspect')console.log('INPUT '+JSON.stringify({cwd:process.cwd(),source}));
if(tool==='iverilog'){const index=rest.indexOf('-o');if(index>=0)fs.writeFileSync(rest[index+1],'compiled');}
if(tool==='vvp'){if(mode==='argcheck'){const input=rest.findIndex(arg=>arg.endsWith('.vvp'));const extended=rest.slice(input+1);console.log('RUNTIME '+JSON.stringify({flags:rest.slice(0,input),input:rest[input],extended,trace:extended.includes('+trace'),seed:extended.find(arg=>arg.startsWith('+seed='))?.slice(6)}));}fs.writeFileSync('vvp-started','yes');if(mode==='wave'||mode==='runtimefailwave')fs.writeFileSync('run.vcd','$timescale 1ns $end $var wire 1 ! clk $end $enddefinitions $end #0 0!');if(mode==='runtimefailwave')process.exitCode=3;}
if(tool==='vivado'){console.log('SVTOOLS_TEST_MARKER preserved');if(mode==='error')console.log('ERROR: real failure despite exit zero');process.stdout.write('noise '.repeat(1000)+'\\n');}
`;

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-toolchain-contract-'));
    const driver = path.join(root, 'protocol.js'), file = path.join(root, 'main.sv');
    await fs.writeFile(driver, DRIVER); await fs.writeFile(file, 'module main; endmodule\n');
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('svtools-toolchain-contract-')); await fs.rm(root, { recursive: true, force: true });
    });
    return { root, driver, file };
}
function uri(file) { return { fsPath: file, scheme: 'file', toString: () => 'file:' + file }; }
function document(file, text = 'module main; endmodule') {
    return { uri: uri(file), languageId: 'systemverilog', version: 1, isDirty: true, lineCount: 2,
        getText: () => text, lineAt: line => ({ range: { start: { line }, end: { line } } }) };
}
function configuration(namespace, overrides = {}) {
    return { get(name, fallback) { return Object.hasOwn(overrides, name) ? overrides[name] : defaults[namespace + '.' + name]?.default ?? fallback; } };
}
function xvlogContext(f, mode = 'ok', overrides = {}) {
    const published = [], lines = [];
    const ctx = { vscode: { workspace: {
        workspaceFolders: [{ uri: uri(f.root) }], getWorkspaceFolder: () => ({ uri: uri(f.root) }),
        getConfiguration: namespace => configuration(namespace)
    } }, channel: { appendLine: text => lines.push(text) }, output: { append: text => lines.push(text), flush() {} },
    applyDiagnostics: (doc, findings) => published.push(findings), isVerilogDocument: () => true,
    scanWorkspaceSources: async () => ({ modules: new Map() }), resolveBinDir: () => f.root,
    toolCommands: Object.fromEntries(['xvlog', 'xelab'].map(tool => [tool, { command: process.execPath, args: [f.driver, tool, mode] }])), ...overrides };
    return { ctx, published, lines };
}
async function waitFor(predicate) {
    const deadline = Date.now() + 5000;
    while (!await predicate()) { assert.ok(Date.now() < deadline, '子进程未进入预期阶段'); await delay(10); }
}

for (const [mode, expected] of [['ok', 'success'], ['dep', 'failed'], ['exit', 'failed'], ['early', 'failed']]) {
    test('xvlog真实协议进程判定：' + mode, async t => {
        const f = await fixture(t), h = xvlogContext(f, mode, { maxOutputChars: 32 });
        const summary = await lintWithXvlog(document(f.file), h.ctx);
        assert.equal(summary.status, expected); assert.equal(summary.ok, expected === 'success');
        if (mode === 'dep') { assert.equal(summary.errorCount, 0); assert.equal(summary.totalErrorCount, 1); }
        if (mode === 'exit') { assert.equal(summary.totalErrorCount, 0); assert.match(h.published[0][0].message, /退出码/); }
        if (mode === 'early') assert.match(h.published[0][0].message, /early error/);
        assert.ok(summary.logPath); const log = await fs.readFile(summary.logPath, 'utf8');
        if (mode === 'early') assert.ok(log.length > 500000);
    });
}

test('xvlog启动失败和超时均是failed，不会显示零错误通过', async t => {
    const f = await fixture(t);
    const missing = xvlogContext(f, 'ok', { toolCommands: { xvlog: { command: path.join(f.root, 'missing-tool') } } });
    assert.equal((await lintWithXvlog(document(f.file), missing.ctx)).status, 'failed');
    const timed = xvlogContext(f, 'slow', { timeoutMs: 20 });
    const summary = await lintWithXvlog(document(f.file), timed.ctx);
    assert.equal(summary.status, 'failed'); assert.match(summary.message, /超时/);
});

test('工具定位失败不返回通过，也不启动检查', async t => {
    const f = await fixture(t), h = xvlogContext(f, 'ok', { resolveBinDir() { throw new Error('installation missing'); } });
    const summary = await lintWithXvlog(document(f.file), h.ctx);
    assert.equal(summary.ok, false); assert.equal(summary.status, 'failed'); assert.match(summary.message, /installation missing/);
    assert.equal(summary.logPaths.length, 0);
});

test('xelab失败保留失败状态；无module明确skipped', async t => {
    const f = await fixture(t), h = xvlogContext(f);
    h.ctx.toolCommands.xelab.args = [f.driver, 'xelab', 'exit'];
    const summary = await elaborateWithXvlog(document(f.file), h.ctx);
    assert.equal(summary.status, 'failed'); assert.equal(summary.logPaths.length, 2);
    const skipped = await elaborateWithXvlog(document(f.file, 'package util; endpackage'), h.ctx);
    assert.equal(skipped.status, 'skipped'); assert.equal(skipped.ok, false); assert.equal(skipped.logPaths.length, 0);
});

test('并发xvlog脏缓冲区有独立目录、源文件及prj，内容不相互覆盖', async t => {
    const f = await fixture(t), h = xvlogContext(f, 'inspect');
    const a = document(path.join(f.root, 'a', 'same.sv'), 'module alpha; endmodule');
    const b = document(path.join(f.root, 'b', 'same.sv'), 'module beta; endmodule');
    const results = await Promise.all([lintWithXvlog(a, h.ctx), lintWithXvlog(b, h.ctx)]);
    assert.ok(results.every(result => result.ok)); assert.notEqual(path.dirname(results[0].logPath), path.dirname(results[1].logPath));
    assert.match(await fs.readFile(results[0].logPath, 'utf8'), /module alpha/);
    assert.match(await fs.readFile(results[1].logPath, 'utf8'), /module beta/);
    for (const result of results) assert.deepEqual(await fs.readdir(path.dirname(result.logPath)), [path.basename(result.logPath)]);
});

test('新的xvlog任务取消旧进程，旧检查不发布迟到诊断', async t => {
    const f = await fixture(t), h = xvlogContext(f), doc = document(f.file, 'module main; // SLOW\nendmodule');
    const old = lintWithXvlog(doc, h.ctx); await waitFor(() => h.lines.some(line => line.includes('ready')));
    doc.getText = () => 'module main; endmodule'; doc.version++;
    const latest = lintWithXvlog(doc, h.ctx), results = await Promise.all([old, latest]);
    assert.equal(results[0].status, 'cancelled'); assert.equal(results[1].status, 'success');
    assert.equal(h.published.length, 1); assert.deepEqual(h.published[0], []);
});

test('摘要结合退出状态与所有依赖；超预算和非零无诊断不能成功', () => {
    const mainFile = path.join(os.tmpdir(), 'main.sv'), findings = [{ file: path.join(os.tmpdir(), 'dep.sv'), severity: 'error' }];
    assert.equal(summarizeToolResult({ result: { code: 0 }, mainFile, findings }).ok, false);
    assert.equal(summarizeToolResult({ result: { code: 7 }, mainFile }).status, 'failed');
    assert.equal(summarizeToolResult({ result: { code: 0, stopped: true, timedOut: true }, mainFile }).status, 'failed');
    assert.equal(summarizeToolResult({ result: { code: 0 }, mainFile, diagnosticsIncomplete: true }).ok, false);
    assert.equal(summarizeToolResult({ result: { code: 0, aborted: true }, mainFile }).status, 'cancelled');
});

test('逐行诊断预算拒绝确认通过，单条超长诊断同样明确不完整', () => {
    const capture = createDiagnosticCapture({ maxFindings: 1, parseLine: text => [{ file: 'main.sv', line: 1, severity: 'error', message: text }] });
    capture.onLine('first', true); capture.onLine('second', true);
    assert.equal(capture.snapshot().findings.length, 1); assert.equal(capture.snapshot().diagnosticsIncomplete, true);
    const truncated = createDiagnosticCapture({ parseLine: () => [] }); truncated.onLine('fragment', false, { truncated: true });
    assert.equal(truncated.snapshot().diagnosticsIncomplete, true);
    const large = createDiagnosticCapture({ maxDiagnosticChars: 100, parseLine: text => [{ file: 'main.sv', severity: 'error', message: text }] });
    large.onLine('e'.repeat(200), true); assert.equal(large.snapshot().diagnosticsIncomplete, true); assert.equal(large.snapshot().findings.length, 0);
});

test('任务隔离目录和取消准备阶段；排队取消不会启动第三个进程', async t => {
    const f = await fixture(t), manager = createToolTaskManager();
    const first = manager.start('first'), second = manager.start('second'), queued = manager.start('queued');
    const firstDir = await first.directory(f.root), secondDir = await second.directory(f.root), queuedDir = await queued.directory(f.root);
    assert.notEqual(firstDir, secondDir);
    const command = ['-e', 'console.log("ready");setInterval(()=>{},1000)'];
    let ready = 0;
    const one = first.run(process.execPath, command, { onLine: () => ready++ });
    const two = second.run(process.execPath, command, { onLine: () => ready++ });
    await waitFor(() => ready === 2);
    const waiting = queued.run(process.execPath, ['-e', 'throw new Error("must not spawn")']);
    queued.cancel(); await assert.rejects(waiting, error => error.code === 'TOOL_CANCELLED');
    assert.deepEqual(await fs.readdir(queuedDir), []);
    first.cancel(); second.cancel(); await Promise.all([one, two]);
    await Promise.all([first.finish(), second.finish(), queued.finish()]); await manager.dispose();
});

test('输出通道批量刷新并限制显示量；长日志不会无限累计待刷新文本', () => {
    let text = '', clears = 0, writes = 0;
    const channel = { append(value) { text += value; writes++; }, appendLine(value) { text += value + '\n'; }, clear() { text = ''; clears++; } };
    const output = createBufferedOutput(channel, { maxQueuedChars: 100, maxVisibleChars: 300 });
    output.append('a'.repeat(5000) + 'END'); output.flush(); output.dispose();
    assert.ok(clears > 0); assert.ok(text.length < 400); assert.ok(text.endsWith('END')); assert.ok(writes <= 51);
});

test('Vivado退出0但早期ERROR仍失败；早期项目标记在大量输出后仍保留', async t => {
    const f = await fixture(t), manager = createToolTaskManager(), task = manager.start('vivado'); await task.directory(f.root);
    const result = await runVivadoBatchTask({ task, executable: process.execPath, args: [f.driver, 'vivado', 'error'],
        cwd: f.root, scriptPath: f.file, maxOutputChars: 32 });
    assert.equal(result.exitCode, 0); assert.equal(result.code, -1); assert.equal(result.status, 'failed');
    assert.match(result.stdout, /SVTOOLS_TEST_MARKER preserved/); assert.equal(result.issues[0].level, 'ERROR');
    await task.finish(); await manager.dispose();
});

function editorHarness(f, getToolchain, options = {}) {
    const handlers = new Map(), commands = new Map(), messages = [], waves = [], bars = [], problems = new Map();
    const doc = document(f.file), config = { lintOnOpen: false, lintOnSave: false, lintOnChange: false, ...options.config };
    const disposable = () => ({ dispose() {} });
    const channel = { append: text => messages.push(text), appendLine: text => messages.push(text), clear() { messages.length = 0; }, show() {}, dispose() {} };
    const vscode = { Uri: { file: uri }, StatusBarAlignment: { Left: 0 }, DiagnosticSeverity: { Error: 0, Warning: 1 },
        ConfigurationTarget: { Workspace: 1, Global: 2 }, Range: class { constructor(...args) { this.args = args; } },
        Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
        languages: { createDiagnosticCollection: () => ({ set(uri, findings) { problems.set(uri.fsPath, findings); }, dispose() {} }) },
        window: { activeTextEditor: { document: doc }, createOutputChannel: () => channel,
            createStatusBarItem() { const bar = { show() {}, hide() {}, dispose() {} }; bars.push(bar); return bar; },
            onDidChangeActiveTextEditor: disposable, showInformationMessage: () => new Promise(() => {}),
            showErrorMessage: text => { messages.push(text); return Promise.resolve(); }, setStatusBarMessage: text => messages.push(text) },
        workspace: { textDocuments: options.documents || [doc], workspaceFolders: [{ uri: uri(f.root) }], getWorkspaceFolder: () => ({ uri: uri(f.root) }),
            getConfiguration: (namespace, resource) => configuration(namespace, namespace === 'svtools.iverilog' ? { ...config, ...options.configForUri?.(resource) } : {}), findFiles: async () => [] },
        commands: { registerCommand(name, handler) { commands.set(name, handler); return disposable(); }, executeCommand: async () => {} } };
    for (const name of ['onDidOpenTextDocument','onDidChangeTextDocument','onDidSaveTextDocument','onDidCloseTextDocument','onDidChangeConfiguration','onDidCreateFiles','onDidDeleteFiles','onDidRenameFiles']) {
        vscode.workspace[name] = handler => { handlers.set(name, handler); return disposable(); };
    }
    const api = activateIverilog({ subscriptions: [] }, { vscode, resolveToolchain: getToolchain, startProcess: options.startProcess,
        xvlogTools: options.xvlogTools, resolveXvlogBinDir: options.resolveXvlogBinDir,
        scanWorkspaceSources: async () => ({ dirs: [], modules: new Map() }), waveViewer: options.waveViewer || { openWaveform: async file => waves.push(file) } });
    return { api, doc, config, handlers, commands, messages, waves, bars, problems };
}
function protocolToolchain(f, mode) {
    return { iverilog: process.execPath, compilePrefix: [f.driver, 'iverilog', mode],
        vvp: process.execPath, vvpPrefix: [f.driver, 'vvp', 'wave'], env: process.env, cygwinDir: null };
}

test('不同资源配置并发探测时，迟到结果不污染另一个配置的缓存', async t => {
    const f = await fixture(t), directories = [path.join(f.root, 'tool-a'), path.join(f.root, 'tool-b')];
    const compiler = process.platform === 'win32' ? 'iverilog.exe' : 'iverilog';
    const runtime = process.platform === 'win32' ? 'vvp.exe' : 'vvp';
    for (const directory of directories) {
        await fs.mkdir(directory); await fs.writeFile(path.join(directory, compiler), ''); await fs.writeFile(path.join(directory, runtime), '');
    }
    const calls = [], launch = require('../src/toolchains/process').startProcess;
    const h = editorHarness(f, undefined, {
        configForUri: resource => ({ path: directories[resource?.fsPath === f.file ? 0 : 1] }),
        startProcess(command, args, settings) {
            calls.push({ command, probe: args.includes('-V') });
            const source = args.includes('-V')
                ? `setTimeout(()=>console.log('Icarus Verilog version 13.0 fixture'),${command.includes('tool-a') ? 450 : 20})` : '';
            return launch(process.execPath, ['-e', source], settings);
        }
    });
    try {
        const first = h.api.lintDocument(h.doc); await waitFor(() => calls.some(call => call.command.includes('tool-a')));
        const other = document(path.join(f.root, 'other.sv'));
        assert.equal((await h.api.lintDocument(other)).ok, true); assert.equal((await first).ok, true);
        assert.equal((await h.api.lintDocument(other)).ok, true);
        assert.equal(calls.filter(call => call.probe && call.command.includes('tool-b')).length, 1);
        assert.equal(calls.at(-1).command, path.join(directories[1], compiler));
    } finally { await h.api.dispose(); }
});

test('显式工程xelab不依赖lint引擎，使用指定top与成员且可单独停止', async t => {
    const f = await fixture(t);
    const makeOptions = mode => ({ resolveXvlogBinDir: () => f.root,
        xvlogTools: Object.fromEntries(['xvlog', 'xelab'].map(tool => [tool, { command: process.execPath, args: [f.driver, tool, mode] }])) });
    const h = editorHarness(f, async () => { throw new Error('不应调用Icarus探测'); }, makeOptions('ok'));
    try {
        const result = await h.commands.get('svtools.xvlog.elaborate')(h.doc, { top: 'chosen', projectScope: { files: [f.file], modules: new Map(), includePaths: [f.root] } });
        assert.equal(result.status, 'success'); assert.ok(result.logPaths.at(-1).endsWith('xelab.log'));
    } finally { await h.api.dispose(); }
    const slow = editorHarness(f, async () => { throw new Error('不应调用Icarus探测'); }, makeOptions('slow'));
    try {
        const task = slow.commands.get('svtools.xvlog.elaborate')(slow.doc, { top: 'chosen', projectScope: { files: [f.file], modules: new Map(), includePaths: [] } });
        await waitFor(() => slow.messages.some(line => line.includes('ready'))); await slow.commands.get('svtools.lint.stop')(slow.doc);
        assert.equal((await task).status, 'cancelled');
    } finally { await slow.api.dispose(); }
});

test('编辑器停止命令覆盖编译阶段，不启动vvp、不自动打开残留波形', async t => {
    const f = await fixture(t), h = editorHarness(f, async () => protocolToolchain(f, 'slow'));
    const pending = h.api.runSimulation(h.doc); await waitFor(() => h.messages.some(line => line.includes('ready')));
    assert.equal(h.bars[0].command, 'svtools.iverilog.stopSimulation');
    await h.commands.get('svtools.iverilog.stopSimulation')();
    const summary = await pending; assert.equal(summary.status, 'cancelled'); assert.deepEqual(h.waves, []);
    await assert.rejects(fs.stat(path.join(f.root, 'vvp-started')), { code: 'ENOENT' }); await h.api.dispose();
});

test('连续仿真取代旧编译，新任务成功结束且无需等待产物通知被关闭', async t => {
    const f = await fixture(t); let calls = 0;
    const h = editorHarness(f, async () => protocolToolchain(f, ++calls === 1 ? 'slow' : 'ok'));
    const old = h.api.runSimulation(h.doc); await waitFor(() => h.messages.some(line => line.includes('ready')));
    const latest = h.api.runSimulation(h.doc), results = await Promise.all([old, latest]);
    assert.equal(results[0].status, 'cancelled'); assert.equal(results[1].status, 'success');
    assert.equal(h.waves.length, 1); assert.ok(results[1].vvpFile.includes('iverilog-sim-'));
    assert.equal(h.bars[0].command, 'svtools.iverilog.simulate'); await h.api.dispose();
});

test('编辑内容变化立即取消lint；关闭文档释放诊断和进程', async t => {
    const f = await fixture(t), h = editorHarness(f, async () => protocolToolchain(f, 'slow'));
    const pending = h.api.lintDocument(h.doc);
    await waitFor(async () => { try { await fs.stat(path.join(f.root, 'compile-started')); return true; } catch { return false; } });
    h.doc.version++; h.handlers.get('onDidChangeTextDocument')({ document: h.doc, contentChanges: [{}] });
    h.handlers.get('onDidCloseTextDocument')(h.doc);
    assert.equal((await pending).status, 'cancelled'); assert.deepEqual(h.problems.get(f.file), []);
    await h.api.dispose();
});

test('诊断按触发文档维护，修复或关闭一个文档不抹掉另一个文档的依赖错误', async t => {
    const f = await fixture(t); let calls = 0;
    const h = editorHarness(f, async () => protocolToolchain(f, ++calls <= 2 ? 'dep' : 'ok'));
    const other = document(path.join(f.root, 'other.sv'), 'module other; endmodule');
    const first = await h.api.lintDocument(h.doc), second = await h.api.lintDocument(other);
    assert.equal(first.ok, false); assert.equal(first.errorCount, 0); assert.equal(second.totalErrorCount, 1);
    assert.equal(h.problems.get(path.join(f.root, 'dependency.sv')).length, 1);
    assert.equal((await h.api.lintDocument(h.doc)).ok, true);
    assert.equal(h.problems.get(path.join(f.root, 'dependency.sv')).length, 1);
    h.handlers.get('onDidCloseTextDocument')(other);
    assert.deepEqual(h.problems.get(path.join(f.root, 'dependency.sv')), []); await h.api.dispose();
});

test('扩展释放覆盖正在编译的任务，不遗留进程或继续打开波形', async t => {
    const f = await fixture(t), h = editorHarness(f, async () => protocolToolchain(f, 'slow'));
    const pending = h.api.runSimulation(h.doc); await waitFor(() => h.messages.some(line => line.includes('ready')));
    const closing = h.api.dispose(); assert.equal((await pending).status, 'cancelled'); await closing;
    assert.deepEqual(h.waves, []);
});

test('最近生成但本次未改的波形不会被当成本次仿真产物', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.root, 'run.vcd'), 'old waveform');
    const h = editorHarness(f, async () => ({ ...protocolToolchain(f, 'ok'), vvpPrefix: [f.driver, 'vvp', 'nowave'] }));
    const summary = await h.api.runSimulation(h.doc);
    assert.equal(summary.status, 'success'); assert.deepEqual(summary.waves, []); assert.deepEqual(h.waves, []);
    await h.api.dispose();
});

test('运行失败保留日志且不自动打开部分波形', async t => {
    const f = await fixture(t);
    const h = editorHarness(f, async () => ({ ...protocolToolchain(f, 'ok'), vvpPrefix: [f.driver, 'vvp', 'runtimefailwave'] }));
    const summary = await h.api.runSimulation(h.doc);
    assert.equal(summary.status, 'failed'); assert.match(summary.message, /3/); assert.deepEqual(h.waves, []);
    assert.ok(summary.logPath); await h.api.dispose();
});


test('电路快照的启动、打开、编辑、保存和配置重查均不启动工具，旧误报可清除', async t => {
    const f = await fixture(t), generated = document(path.join(f.root, '.svtools', 'circuit', 'yosys-test', 'sources.sv'));
    let probes = 0;
    const h = editorHarness(f, async () => { probes++; throw new Error('生成文件不应启动工具'); },
        { documents: [generated], config: { lintOnOpen: true, lintOnSave: true, lintOnChange: true, lintDebounceMs: 100 } });
    try {
        h.problems.set(generated.uri.fsPath, ['old generated diagnostic']);
        h.problems.set(f.file, ['real source diagnostic']);
        h.handlers.get('onDidOpenTextDocument')(generated);
        h.handlers.get('onDidChangeTextDocument')({ document: generated, contentChanges: [{}] });
        h.handlers.get('onDidSaveTextDocument')(generated);
        h.handlers.get('onDidChangeConfiguration')({ affectsConfiguration: () => true });
        assert.equal((await h.api.lintDocument(generated)).status, 'skipped');
        assert.equal((await h.api.runSimulation(generated)).status, 'skipped');
        await delay(150);
        assert.equal(probes, 0); assert.deepEqual(h.problems.get(generated.uri.fsPath), []);
        assert.deepEqual(h.problems.get(f.file), ['real source diagnostic']);
    } finally { await h.api.dispose(); }
});
test('直接xvlog入口也跳过生成文档，不探测工具或建立编译任务', async t => {
    const f = await fixture(t), generated = document(path.join(f.root, '.svtools', 'circuit', 'sources.sv'));
    let probes = 0;
    const h = xvlogContext(f, 'ok', { resolveBinDir: () => { probes++; throw new Error('不应探测'); } });
    const result = await lintWithXvlog(generated, h.ctx);
    assert.equal(result.status, 'skipped'); assert.equal(probes, 0);
});


test('诊断发布过滤生成文件，但保留同一编译任务中的真实源码错误', async t => {
    const f = await fixture(t);
    await fs.writeFile(f.driver, `const path=require('node:path');
console.error(path.join(process.cwd(),'.svtools','circuit','sources.sv')+':1: error: internal snapshot');
console.error(path.join(process.cwd(),'node_modules','sv-lib','real.sv')+':2: error: actual RTL error');
process.exitCode=1;
`);
    const h = editorHarness(f, async () => ({ ...protocolToolchain(f, 'ok'), compilePrefix: [f.driver] }));
    try {
        const result = await h.api.lintDocument(h.doc);
        assert.equal(result.status, 'failed'); assert.equal(result.totalErrorCount, 2);
        assert.deepEqual(h.problems.get(path.join(f.root, '.svtools', 'circuit', 'sources.sv')), []);
        const real = h.problems.get(path.join(f.root, 'node_modules', 'sv-lib', 'real.sv'));
        assert.equal(real.length, 1); assert.match(real[0].message, /actual RTL error/);
    } finally { await h.api.dispose(); }
});


for (const cancel of [false, true]) {
    test(`仿真等待波形释放且写入保护在结束后撤销，等待期间取消=${cancel}`, async t => {
        const f=await fixture(t); let release, entered=false, ended=false;
        const gate=new Promise(resolve=>{release=resolve;});
        const h=editorHarness(f,async()=>protocolToolchain(f,'ok'),{waveViewer:{
            async prepareForSimulation(options){assert.equal(options.sourceFile,f.file);entered=true;await gate;return{dispose(){ended=true;}};},
            async openWaveform(){assert.equal(ended,true);}
        }});
        try {
            const running=h.api.runSimulation(h.doc);await waitFor(()=>entered);
            await assert.rejects(fs.stat(path.join(f.root,'vvp-started')),{code:'ENOENT'});
            if(cancel)h.api.stopSimulation();release();
            assert.equal((await running).status,cancel?'cancelled':'success');assert.equal(ended,true);
            if(cancel)await assert.rejects(fs.stat(path.join(f.root,'vvp-started')),{code:'ENOENT'});
        } finally {release();await h.api.dispose();}
    });
}

test('波形释放失败阻止vvp写入，编译失败不关闭现有波形',async t=>{
    for(const compileMode of ['ok','exit']){
        const f=await fixture(t);let closing=0;
        const h=editorHarness(f,async()=>protocolToolchain(f,compileMode),{waveViewer:{
            async prepareForSimulation(){closing++;throw new Error('wave worker still running');}
        }});
        try{
            const result=await h.api.runSimulation(h.doc);assert.equal(result.status,'failed');
            assert.equal(closing,compileMode==='ok'?1:0);
            await assert.rejects(fs.stat(path.join(f.root,'vvp-started')),{code:'ENOENT'});
        }finally{await h.api.dispose();}
    }
});


test('运行失败或超时都撤销波形写入保护，不自动打开部分波形',async t=>{
    for(const mode of ['runtimefailwave','slow']){
        const f=await fixture(t);let released=false,opened=false;
        const h=editorHarness(f,async()=>({...protocolToolchain(f,'ok'),vvpPrefix:[f.driver,'vvp',mode]}),{
            config:{simTimeoutMs:mode==='slow'?30:0},waveViewer:{
                async prepareForSimulation(){return{dispose(){released=true;}};},async openWaveform(){opened=true;}
            }});
        try{assert.equal((await h.api.runSimulation(h.doc)).status,'failed');assert.equal(released,true);assert.equal(opened,false);}
        finally{await h.api.dispose();}
    }
});


test('Icarus 实际 runner 把 plusargs 和波形 extended 参数交付给仿真程序', async t => {
    const f = await fixture(t), values = ['+trace', '+seed=73', '-fst', '-lxt', '-lxt2', '-none', '-vcd-none', '-vcd-off', '-fst-none', '-sdf-warn', '-sdf-info', '-sdf-verbose', '-dumpfile=trace with space'];
    const h = editorHarness(f, async () => ({ ...protocolToolchain(f, 'ok'), vvpPrefix: [f.driver, 'vvp', 'argcheck'] }), { config: { simArgs: values } });
    try {
        const result = await h.api.runSimulation(h.doc); assert.equal(result.ok, true);
        const output = await fs.readFile(result.logPath, 'utf8'), runtime = JSON.parse(output.match(/^RUNTIME (.+)$/m)[1]);
        assert.equal(runtime.trace, true); assert.equal(runtime.seed, '73');
        assert.deepEqual(runtime.flags, ['-n']); assert.deepEqual(runtime.extended, values);
        assert.equal(runtime.input, result.vvpFile); assert.equal(await fs.readFile(result.vvpFile, 'utf8'), 'compiled');
    } finally { await h.api.dispose(); }
});

test('Icarus 实际 runner 兼容 CLI 分离/附着/组合选项，-- 后按原顺序传 extended 参数', async t => {
    const f = await fixture(t), log = path.join(f.root, 'runtime with space.log');
    const values = ['+trace', '-i', '-l', log, '+seed=73', '-M', '-', '-msystem', '-vlattached.log', '-Mmodule path', '-Nq', '--', '-lcustom', 'literal'];
    const h = editorHarness(f, async () => ({ ...protocolToolchain(f, 'ok'), vvpPrefix: [f.driver, 'vvp', 'argcheck'] }), { config: { simArgs: values } });
    try {
        const result = await h.api.runSimulation(h.doc); assert.equal(result.ok, true);
        const runtime = JSON.parse((await fs.readFile(result.logPath, 'utf8')).match(/^RUNTIME (.+)$/m)[1]);
        assert.deepEqual(runtime.flags, ['-n', '-i', '-l', log, '-M', '-', '-msystem', '-vlattached.log', '-Mmodule path', '-Nq']);
        assert.deepEqual(runtime.extended.slice(0, -1), ['+trace', '+seed=73', '-lcustom', 'literal']);
        assert.equal(path.dirname(runtime.extended.at(-1).slice('-dumpfile='.length)), path.join(f.root, '.svtools', 'vcd'));
        assert.equal(runtime.trace, true); assert.equal(runtime.seed, '73');
    } finally { await h.api.dispose(); }
});

test('Icarus默认VCD在工作区.svtools/vcd，源码子目录仍是运行cwd，目标进入写入屏障', async t => {
    const f = await fixture(t); let prepared;
    const sourceDir = path.join(f.root, 'sim'); await fs.mkdir(sourceDir);
    f.file = path.join(sourceDir, 'main.sv');
    await fs.writeFile(f.file, 'module main; initial begin $dumpvars(0,main); #1; $finish; end endmodule\n');
    const h = editorHarness(f, async () => ({ ...protocolToolchain(f, 'ok'), vvpPrefix: [f.driver, 'vvp', 'argcheck'] }), {
        waveViewer: { async prepareForSimulation(options) { prepared = options; return { dispose() {} }; }, openWaveform() {} }
    });
    try {
        const result = await h.api.runSimulation(h.doc); assert.equal(result.ok, true);
        const runtime = JSON.parse((await fs.readFile(result.logPath, 'utf8')).match(/^RUNTIME (.+)$/m)[1]);
        const target = runtime.extended.find(value => value.startsWith('-dumpfile=')).slice(10);
        assert.equal(path.dirname(target), path.join(f.root, '.svtools', 'vcd')); assert.equal(path.extname(target), '.vcd');
        assert.ok(prepared.paths.includes(target)); assert.ok((await fs.stat(path.dirname(target))).isDirectory());
        assert.equal(await fs.readFile(path.join(sourceDir, 'vvp-started'), 'utf8'), 'yes');
        assert.equal(await fs.readFile(f.file, 'utf8'), 'module main; initial begin $dumpvars(0,main); #1; $finish; end endmodule\n');
    } finally { await h.api.dispose(); }
});

test('Icarus 运行参数缺少 CLI 值时不启动 vvp，也不先关闭现有波形', async t => {
    const f = await fixture(t); let releases = 0;
    const h = editorHarness(f, async () => protocolToolchain(f, 'ok'), { config: { simArgs: ['-l'] },
        waveViewer: { async prepareForSimulation() { return { async dispose() { releases++; } }; }, openWaveform() {} } });
    try {
        const result = await h.api.runSimulation(h.doc); assert.equal(result.status, 'failed');
        assert.ok(h.messages.some(line => typeof line === 'string' && line.includes('simArgs') && line.includes('-l')));
        await assert.rejects(fs.stat(path.join(f.root, 'vvp-started')), { code: 'ENOENT' });
        assert.equal(releases, 0);
    } finally { await h.api.dispose(); }
});


test('vvp 默认dumpfile覆盖参与真实runner的关闭屏障及输出发现', async t => {
    const f = await fixture(t), capture = path.join(f.root, 'custom wave.vcd'); let prepared;
    await fs.writeFile(f.file, 'module main; initial begin $dumpvars(0,main); #1; $finish; end endmodule\n');
    const h = editorHarness(f, async () => ({ ...protocolToolchain(f, 'ok'), vvpPrefix: [f.driver, 'vvp', 'argcheck'] }), {
        config: { simArgs: ['-dumpfile=' + capture] }, waveViewer: {
            async prepareForSimulation(options) { prepared = options; return { dispose() {} }; }, openWaveform() {}
        }
    });
    try {
        assert.equal((await h.api.runSimulation(h.doc)).ok, true);
        assert.ok(prepared.paths.includes(capture), JSON.stringify(prepared));
        assert.ok(!prepared.paths.includes(path.join(f.root, 'dump.vcd')));
    } finally { await h.api.dispose(); }
});

test('任务目录封顶只删本类型旧目录，保留最新keep个，protect目录不动', async t => {
    const { pruneTaskDirectories } = require('../src/toolchains/task-retention');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-retention-')), base = path.join(root, 'tasks');
    const stamp = async (directory, index) => { const time = new Date(Date.now() + index * 10000); await fs.utimes(directory, time, time); };
    for (let index = 0; index < 5; index++) {
        const directory = path.join(base, 'xvlog-' + index);
        await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, index + '.log'), 'log');
        await stamp(directory, index);
    }
    await fs.mkdir(path.join(base, 'vivado-keep'));
    await fs.writeFile(path.join(base, 'loose-file.log'), 'not a directory');
    const oldest = path.join(base, 'xvlog-0');
    const removed = await pruneTaskDirectories(base, 'xvlog', 3, { protect: new Set([path.resolve(oldest)]) });
    assert.deepEqual(removed, [path.join(base, 'xvlog-1')]);
    assert.deepEqual((await fs.readdir(base)).sort(), ['loose-file.log', 'vivado-keep', 'xvlog-0', 'xvlog-2', 'xvlog-3', 'xvlog-4']);
    assert.deepEqual(await pruneTaskDirectories(path.join(base, 'missing'), 'xvlog', 3), []);
    await assert.rejects(pruneTaskDirectories(base, 'xvlog', 0), RangeError);
    await fs.rm(root, { recursive: true, force: true });
});

test('任务结束后自动封顶到配置数量；keep=0关闭清理', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-retention-mgr-')), base = path.join(root, 'tasks');
    const capped = createToolTaskManager({ retention: { keep: () => 2 } });
    for (let index = 0; index < 4; index++) {
        const task = capped.start('run' + index);
        await task.directory(base, 'xvlog'); await task.finish();
        await delay(20);
    }
    await waitFor(async () => (await fs.readdir(base)).length === 2);
    const remaining = (await fs.readdir(base)).sort();
    assert.equal(remaining.length, 2);
    assert.ok(remaining.every(name => name.startsWith('xvlog-')));
    await capped.dispose();
    const keepAll = createToolTaskManager({ retention: { keep: 0 } });
    for (let index = 0; index < 3; index++) {
        const task = keepAll.start('stay' + index);
        await task.directory(base, 'xvlog'); await task.finish();
    }
    await delay(120);
    assert.equal((await fs.readdir(base)).length, 5);
    await keepAll.dispose();
    await fs.rm(root, { recursive: true, force: true });
});
