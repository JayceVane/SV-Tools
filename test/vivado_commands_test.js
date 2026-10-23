'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');

// 只替代 batch 工具边界，命令接线、工程选择、树初始化及脚本写入使用真实实现。
const batchPath = require.resolve('../src/vivado/batch');
const batch = require(batchPath), runners = new Map();
require.cache[batchPath].exports = { ...batch, runVivadoBatchTask: async options => {
    const entry = [...runners].find(([root]) => options.scriptPath.startsWith(root + path.sep));
    assert.ok(entry, '未登记的 batch fixture'); return entry[1](options);
} };
delete require.cache[require.resolve('../src/vivado/index')];
const { activateVivado } = require('../src/vivado/index');
require.cache[batchPath].exports = batch;

const disposable = () => ({ dispose() {} });
const uri = file => ({ fsPath: file, scheme: 'file', toString: () => 'file:' + file });
const escapeXml = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const success = { code: 0, ok: true, status: 'success', ms: 1, issues: [], stdout: 'SVTOOLS_DONE', message: '' };

async function fixture(t, membership = []) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-vivado-command-'));
    const projectDir = path.join(root, 'actual', 'prj'), file = path.join(root, 'actual', 'src', 'current.sv');
    const xpr = path.join(projectDir, 'design.xpr'), other = path.join(projectDir, 'other.xpr'), bin = path.join(root, 'tool', 'bin');
    await fs.mkdir(projectDir, { recursive: true }); await fs.mkdir(path.dirname(file)); await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(file, 'module current; endmodule\n');
    await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'vivado.bat' : 'vivado'), 'fixture');
    const sets = [{ name: 'rtl_custom', type: 'DesignSrcs' }, { name: 'sim_custom', type: 'SimulationSrcs' }];
    const writeXpr = async (target = xpr, setList = sets) => fs.writeFile(target, '<Project><FileSets>' + setList.map(set => '<FileSet Name="' + set.name + '" Type="' + set.type + '">'
        + (membership.includes(set.name) ? '<File Path="' + escapeXml(file) + '"/>' : '') + '</FileSet>').join('') + '</FileSets></Project>');
    await writeXpr(); await writeXpr(other);
    t.after(async () => {
        runners.delete(root); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('svtools-vivado-command-')); await fs.rm(root, { recursive: true, force: true });
    });
    return { root, file, xpr, other, bin, sets, writeXpr };
}

async function harness(t, f, options = {}) {
    const commands = new Map(), contexts = new Map(), messages = [], logs = [], calls = [], picks = [];
    const doc = { fileName: f.file, uri: uri(f.file), isDirty: false, isUntitled: false, getText: () => 'module current; endmodule', save: async () => true };
    const wsRoot = options.workspaceRoot === undefined ? path.join(f.root, 'actual') : options.workspaceRoot;
    const folders = wsRoot ? [{ uri: uri(path.join(f.root, 'unrelated')), name: 'unrelated' }, { uri: uri(wsRoot), name: 'actual' }] : [];
    const h = { doc, commands, contexts, messages, logs, calls, picks, onPick: async choices => choices[0], onRun: async () => success };
    runners.set(f.root, async settings => {
        const body = await fs.readFile(settings.scriptPath, 'utf8'); calls.push({ path: settings.scriptPath, body });
        return h.onRun(settings, body);
    });
    class EventEmitter {
        constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
        fire(value) { for (const listener of this.listeners) listener(value); }
        dispose() { this.listeners.clear(); }
    }
    const channel = { append: text => logs.push(text), appendLine: text => logs.push(text), clear() {}, show() {}, dispose() {} };
    const vscode = { Uri: { file: uri }, EventEmitter, StatusBarAlignment: { Left: 0 },
        CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() {} },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
        ThemeIcon: class { constructor(id) { this.id = id; } }, RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
        window: { activeTextEditor: { document: doc }, createOutputChannel: () => channel, showOpenDialog: async () => h.onOpen ? h.onOpen() : [],
            createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
            createTreeView: (id, settings) => { h.provider = settings.treeDataProvider; return { reveal: async () => {}, dispose() {} }; },
            showWarningMessage: text => messages.push(text), showErrorMessage: text => { messages.push(text); return Promise.resolve(); },
            showInformationMessage: text => { messages.push(text); return Promise.resolve(); },
            showQuickPick: async (choices, settings) => { picks.push({ choices, settings }); return h.onPick(choices, settings); } },
        workspace: { workspaceFolders: folders, getWorkspaceFolder: resource => folders.find(folder => {
                const relative = path.relative(folder.uri.fsPath, resource.fsPath); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
            }), findFiles: async () => [], asRelativePath: file => path.relative(wsRoot || f.root, file),
            getConfiguration: () => ({ get: (key, fallback) => key === 'path' ? f.bin : key === 'timeoutMs' ? 3000 : fallback }),
            createFileSystemWatcher: () => ({ dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }),
            onDidChangeWorkspaceFolders: disposable, onDidSaveTextDocument: disposable },
        commands: { registerCommand(name, handler) { commands.set(name, handler); return disposable(); },
            executeCommand: async (name, ...args) => { if (name === 'setContext') contexts.set(args[0], args[1]); else return commands.get(name)?.(...args); } } };
    const state = new Map(options.noProject ? [] : [['svtools.vivado.selectedProject', f.xpr]]);
    const context = { subscriptions: [], workspaceState: { get: key => state.get(key), update: async (key, value) => state.set(key, value) } };
    h.api = activateVivado(context, { vscode });
    assert.ok(h.api.projectTree, '树初始化错误不能被测试吞掉'); await h.api.projectTree.ready;
    assert.equal(logs.some(text => text.includes('工程树初始化失败')), false);
    t.after(() => { for (const subscription of [...context.subscriptions].reverse()) subscription.dispose(); });
    return h;
}

const add = h => h.commands.get('svtools.vivado.addToFileset')();
const remove = h => h.commands.get('svtools.vivado.removeFromFileset')();

test('编辑器加入选择真实自定义文件集，脚本独立存储在所属工程文件夹', async t => {
    const f = await fixture(t), h = await harness(t, f);
    h.onPick = async choices => choices.find(choice => choice.value === 'sim_custom');
    assert.equal((await add(h)).code, 0);
    assert.deepEqual(h.picks[0].choices.map(choice => choice.value), ['rtl_custom', 'sim_custom']);
    assert.match(h.calls[0].body, /get_filesets sim_custom/); assert.ok(h.calls[0].body.includes(f.xpr.replace(/\\/g, '/')));
    assert.ok(h.calls[0].path.startsWith(path.join(f.root, 'actual', '.svtools', 'vivado', 'actions') + path.sep));
    assert.match(h.calls[0].path, /action-[^\\/]+[\\/]add_file\.tcl$/);
});

test('移出按 XPR 实际成员归属，源码目录也能属于自定义仿真集', async t => {
    const f = await fixture(t, ['sim_custom']), h = await harness(t, f);
    assert.equal((await remove(h)).code, 0); assert.equal(h.picks.length, 0);
    assert.match(h.calls[0].body, /get_filesets sim_custom/); assert.doesNotMatch(h.calls[0].body, /get_filesets sources_1/);
});

test('同文件跨多个真实文件集时，移出让用户明确选择目标', async t => {
    const f = await fixture(t, ['rtl_custom', 'sim_custom']), h = await harness(t, f);
    h.onPick = async choices => choices.find(choice => choice.value === 'rtl_custom');
    await remove(h); assert.deepEqual(h.picks[0].choices.map(choice => choice.value), ['rtl_custom', 'sim_custom']);
    assert.match(h.calls[0].body, /get_filesets rtl_custom/);
});

test('不在工程的文件移出不会运行，已在目标集的文件加入不会重复提交', async t => {
    const f = await fixture(t, ['rtl_custom']), h = await harness(t, f);
    await add(h); assert.equal(h.calls.length, 0); assert.ok(h.messages.some(text => text.includes('已在 rtl_custom')));
    await f.writeXpr(f.xpr, []); await remove(h); assert.equal(h.calls.length, 0);
    assert.ok(h.messages.some(text => text.includes('不在所选工程')));
});

test('选择文件集期间切换当前工程，取消旧操作且不创建动作脚本', async t => {
    const f = await fixture(t), h = await harness(t, f);
    h.onPick = async choices => { await h.api.projectSelection.select(f.other); return choices[0]; };
    const result = await add(h); assert.equal(result.status, 'cancelled'); assert.equal(h.calls.length, 0);
    assert.ok(h.messages.some(text => text.includes('工程已切换')));
    await assert.rejects(fs.stat(path.join(f.root, 'actual', '.svtools')), { code: 'ENOENT' });
});

test('选择后 XPR 删除目标文件集，取消动作而不提交旧快照', async t => {
    const f = await fixture(t), h = await harness(t, f);
    h.onPick = async choices => { await f.writeXpr(f.xpr, []); return choices[0]; };
    const result = await add(h); assert.equal(result.status, 'cancelled'); assert.equal(h.calls.length, 0);
    assert.ok(h.messages.some(text => text.includes('文件集或成员已变化')));
});

test('并发选择阶段只允许一个编辑器动作进入，第二个不会写脚本', async t => {
    const f = await fixture(t, ['sim_custom']), h = await harness(t, f), entered = deferred(), release = deferred();
    h.onPick = async choices => { entered.resolve(); await release.promise; return choices.find(choice => choice.value === 'rtl_custom'); };
    const first = add(h); await entered.promise;
    assert.equal((await remove(h)).error, 'busy'); assert.equal(h.calls.length, 0);
    release.resolve(); await first; assert.equal(h.calls.length, 1);
});

test('运行中增量动作不覆盖脚本，也不进入新的文件集选择', async t => {
    const f = await fixture(t, ['sim_custom']), h = await harness(t, f), entered = deferred(), release = deferred();
    h.onRun = async () => { entered.resolve(); await release.promise; return success; };
    const first = remove(h); await entered.promise;
    const original = await fs.readFile(h.calls[0].path, 'utf8');
    assert.equal((await add(h)).error, 'busy'); assert.equal(h.picks.length, 0); assert.equal(h.calls.length, 1);
    assert.equal(await fs.readFile(h.calls[0].path, 'utf8'), original); release.resolve(); await first;
});

test('连续增量操作创建不同动作目录，前次 Tcl 全文保持不变', async t => {
    const f = await fixture(t), h = await harness(t, f);
    await add(h); const previous = await fs.readFile(h.calls[0].path, 'utf8');
    await add(h); assert.equal(h.calls.length, 2); assert.notEqual(path.dirname(h.calls[0].path), path.dirname(h.calls[1].path));
    assert.equal(await fs.readFile(h.calls[0].path, 'utf8'), previous);
});

test('工作区外显式选择工程也可增量管理，不读取 workspaceFolders[0]', async t => {
    const f = await fixture(t, ['sim_custom']), h = await harness(t, f, { workspaceRoot: null });
    await remove(h); assert.equal(h.calls.length, 1);
    assert.ok(h.calls[0].path.startsWith(path.join(path.dirname(f.xpr), '.svtools', 'vivado', 'actions') + path.sep));
});

test('无工程及损坏工程显示错误，不运行脚本且树初始化完整', async t => {
    const f = await fixture(t), h = await harness(t, f, { workspaceRoot: null, noProject: true });
    await add(h); assert.equal(h.calls.length, 0); assert.ok(h.messages.some(text => text.includes('未找到 Vivado 工程')));
    await h.api.projectSelection.select(f.xpr); await fs.writeFile(f.xpr, '<Project>');
    const result = await remove(h); assert.equal(result.status, 'failed'); assert.equal(h.calls.length, 0);
    assert.ok(h.messages.some(text => text.includes('XPR')));
});

test('仿真使用真实 SimulationSrcs 文件集名称并先保存当前修改', async t => {
    const f = await fixture(t, ['sim_custom']), h = await harness(t, f); let saved = false;
    h.doc.isDirty = true; h.doc.save = async () => { saved = true; return true; };
    await h.api.simulateWithVivado(); assert.equal(saved, true); assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].body, /get_filesets sim_custom/);
    assert.doesNotMatch(h.calls[0].body, /(?:get_filesets|fileset) sim_1/);
    assert.match(h.calls[0].body, /launch_simulation -simset \$fs/);
});

test('缺少仿真集或保存失败时不生成仿真脚本', async t => {
    const f = await fixture(t), h = await harness(t, f);
    await f.writeXpr(f.xpr, [f.sets[0]]); await h.api.simulateWithVivado(); assert.equal(h.calls.length, 0);
    assert.ok(h.messages.some(text => text.includes('仿真文件集')));
    h.doc.isDirty = true; h.doc.save = async () => false; await h.api.simulateWithVivado(); assert.equal(h.calls.length, 0);
    assert.ok(h.messages.some(text => text.includes('源文件未保存')));
});
test('选择后已有成员被 GUI 移除，加入检查读取最新 XPR 而不误报已存在', async t => {
    const f = await fixture(t, ['rtl_custom']), h = await harness(t, f);
    h.onPick = async choices => {
        const otherFile = path.join(path.dirname(f.file), 'other.sv');
        await fs.writeFile(f.xpr, '<Project><FileSets><FileSet Name="rtl_custom" Type="DesignSrcs"><File Path="' + escapeXml(otherFile) + '"/></FileSet><FileSet Name="sim_custom" Type="SimulationSrcs"/></FileSets></Project>');
        return choices.find(choice => choice.value === 'rtl_custom');
    };
    await add(h); assert.equal(h.calls.length, 1); assert.match(h.calls[0].body, /get_filesets rtl_custom/);
    assert.equal(h.messages.some(text => text.includes('已在 rtl_custom')), false);
});

test('编辑器选择阶段与工程面板共用busy状态，停止后不提交脚本', async t => {
    const f = await fixture(t), h = await harness(t, f), picker = deferred();
    h.onPick = async () => picker.promise;
    const pending = add(h);
    while (!h.picks.length) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.contexts.get('svtools.vivado.busy'), true);
    await h.commands.get('svtools.vivado.tree.synthesize')(); assert.equal(h.calls.length, 0);
    await h.commands.get('svtools.vivado.tree.stop')(); picker.resolve({ value: 'rtl_custom' });
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.calls.length, 0);
    assert.equal(h.contexts.get('svtools.vivado.busy'), false);
});

test('面板选择阶段阻止编辑器写入，取消面板准备后不运行工具', async t => {
    const f = await fixture(t), h = await harness(t, f), picker = deferred();
    h.onPick = async () => picker.promise;
    const pending = h.commands.get('svtools.vivado.tree.addFile')({ nodeData: { kind: 'orphan', file: f.file, xpr: f.xpr } });
    while (!h.picks.length) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await add(h)).status, 'skipped'); assert.equal(h.calls.length, 0);
    await h.commands.get('svtools.vivado.tree.stop')(); picker.resolve({ value: 'rtl_custom' }); await pending;
    assert.equal(h.calls.length, 0); assert.equal(h.contexts.get('svtools.vivado.busy'), false);
});

test('顶层名扫描忽略注释字符串并支持module lifetime与美元符号', () => {
    const { firstModuleName } = require('../src/vivado/tclgen');
    assert.equal(firstModuleName('// module fake;\n/* module other; */\nmodule automatic real$top; initial $display("module fake2;"); endmodule'), 'real$top');
});

test('停止浏览选择后，文件对话框迟到返回不会切换工程', async t => {
    const f = await fixture(t), h = await harness(t, f), browser = deferred(); let opened = false;
    h.onPick = async choices => choices.find(choice => choice.browse);
    h.onOpen = async () => { opened = true; return browser.promise; };
    const pending = h.commands.get('svtools.vivado.tree.selectProject')();
    while (!opened) await new Promise(resolve => setTimeout(resolve, 5));
    await h.commands.get('svtools.vivado.tree.stop')(); browser.resolve([uri(f.other)]); await pending;
    assert.equal(await h.api.projectSelection.current(), f.xpr);
});


for (const outcome of ['success', 'failed', 'cancelled', 'throw']) {
    test(`Vivado 特殊 source/cwd 通过环境桥接且 ${outcome} 后清理`, { skip: process.platform !== 'win32' }, async t => {
        const f = await fixture(t), cwd = path.join(f.root, 'work%VIVADO_PROBE% !literal! & (project)');
        await fs.mkdir(cwd); const script = path.join(cwd, 'source.tcl'); await fs.writeFile(script, 'puts original\n');
        let bridge;
        const task = { run: async (executable, args, options) => {
            assert.equal(executable, 'vivado.bat'); bridge = args[args.indexOf('-source') + 1];
            assert.notEqual(bridge, script); assert.equal(path.dirname(bridge), options.cwd);
            assert.equal(options.env.SVTOOLS_VIVADO_SOURCE_PATH, script);
            assert.equal(options.env.SVTOOLS_VIVADO_SOURCE_CWD, cwd);
            assert.equal(await fs.readFile(bridge, 'utf8'), 'cd $::env(SVTOOLS_VIVADO_SOURCE_CWD)\nsource -encoding utf-8 $::env(SVTOOLS_VIVADO_SOURCE_PATH)\n');
            if (outcome === 'throw') throw Error('probe before process start');
            return { code: outcome === 'failed' ? 2 : outcome === 'cancelled' ? null : 0,
                aborted: outcome === 'cancelled', stopped: outcome === 'cancelled', output: '', elapsedMs: 1 };
        } };
        const run = () => batch.runVivadoBatchTask({ task, executable: 'vivado.bat', args: ['-mode', 'batch', '-source', script], cwd, scriptPath: script });
        if (outcome === 'throw') await assert.rejects(run(), /probe before process start/);
        else assert.equal((await run()).status, outcome);
        assert.ok(bridge); await assert.rejects(fs.stat(path.dirname(bridge)), { code: 'ENOENT' });
        assert.equal(await fs.readFile(script, 'utf8'), 'puts original\n');
    });
}

test('Vivado 不能保真的安装路径与额外参数明确拒绝，不执行第三方 BAT', { skip: process.platform !== 'win32' }, async () => {
    let runs = 0;
    const task = { run: async () => { runs++; throw Error('不应执行'); } };
    for (const [executable, extra] of [['vivado%PROBE%.bat', []], ['vivado.bat', ['-tclargs', '%PROBE%']], ['vivado.bat', ['-tclargs', '!PROBE!']]]) {
        await assert.rejects(batch.runVivadoBatchTask({ task, executable, args: ['-source', 'source.tcl', ...extra], scriptPath: 'source.tcl' }), /厂商脚本无法安全传递/);
    }
    assert.equal(runs, 0);
});
