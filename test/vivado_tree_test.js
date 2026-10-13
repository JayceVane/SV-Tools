'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { buildProjectTree, referencedUnits } = require('../src/vivado/tree-model');
const { createProjectSelection } = require('../src/vivado/projects');
const { parseXpr } = require('../src/vivado/xpr');

class Emitter {
    constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
}
const uri = file => ({ fsPath: file, scheme: 'file', toString: () => file });
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-tree-contract-'));
    const files = Object.fromEntries(['top.sv', 'child.sv', 'other.sv'].map(name => [name, path.join(root, name)]));
    await fs.writeFile(files['top.sv'], 'module top; child u_child(); endmodule');
    await fs.writeFile(files['child.sv'], 'module child; endmodule'); await fs.writeFile(files['other.sv'], 'module other; endmodule');
    const xpr = path.join(root, 'design.xpr');
    await fs.writeFile(xpr, '<Project><FileSets><FileSet Name="sources_1" Type="DesignSrcs"><File Path="$PPRDIR/top.sv"/><File Path="$PPRDIR/child.sv"/><Config><Option Name="TopModule" Val="top"/></Config></FileSet><FileSet Name="sim_1" Type="SimulationSrcs"></FileSet></FileSets></Project>');
    t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('svtools-tree-contract-')); await fs.rm(root, { recursive: true, force: true }); });
    return { root, files, xpr };
}
async function harness(f, options = {}) {
    const commands = new Map(), notifications = [], picks = [], watchers = [], subscriptions = [], updates = [];
    const workspaceEvents = new Map(); let cached = [], provider, tree, disposed = false;
    const noOp = () => ({ dispose() {} });
    const vscode = { EventEmitter: Emitter, TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, ThemeIcon: class { constructor(id) { this.id = id; } }, Uri: { file: uri },
        RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
        window: {
            createTreeView(id, config) {
                provider = config.treeDataProvider;
                const read = async () => { cached = await provider.getChildren(); updates.push(cached); };
                read(); provider.onDidChangeTreeData?.(() => { if (!disposed) read(); });
                tree = { dispose() { disposed = true; }, async reveal(node) { assert.equal(typeof provider.getParent, 'function'); } }; return tree;
            },
            showQuickPick: async choices => { picks.push(choices); return options.pick ? options.pick(choices) : choices[0]; }, showTextDocument: async doc => doc,
            showInformationMessage: text => notifications.push(text), showWarningMessage: text => notifications.push(text), showErrorMessage: text => notifications.push(text)
        },
        workspace: { workspaceFolders: [{ uri: uri(f.root) }], getWorkspaceFolder: () => ({ uri: uri(f.root) }), asRelativePath: file => path.relative(f.root, file),
            findFiles: async () => Object.values(f.files).map(uri), openTextDocument: async target => ({ uri: target }),
            createFileSystemWatcher() { const change = new Emitter(), create = new Emitter(), remove = new Emitter(); const watcher = { onDidChange: change.event, onDidCreate: create.event, onDidDelete: remove.event, change, create, remove, dispose: noOp }; watchers.push(watcher); return watcher; },
            onDidChangeWorkspaceFolders: callback => { workspaceEvents.set('folders', callback); return noOp(); },
            onDidSaveTextDocument: callback => { workspaceEvents.set('save', callback); return noOp(); }
        },
        commands: { registerCommand(name, callback) { commands.set(name, callback); return noOp(); }, executeCommand: async (...args) => { notifications.push(args); return options.onCommand?.(...args); } } };
    // 加载真实生产文件，仅替换 VS Code 边界，便于锁定旧版本缺少事件的回归。
    const filename = path.resolve(__dirname, '../src/vivado/projectTree.js'), module = { exports: {} }, localRequire = createRequire(filename);
    const factory = new vm.Script('(function(require,module,exports,__dirname){' + await fs.readFile(filename, 'utf8') + '\n})', { filename }).runInThisContext();
    factory(name => name === 'vscode' ? vscode : localRequire(name), module, module.exports, path.dirname(filename));
    const api = module.exports.activateProjectTree({ subscriptions }, { vscode, findProjectXpr: options.findProjectXpr || (async () => f.xpr),
        log: text => notifications.push(text), out: { show() {} }, isRunning: () => !!options.busy,
        runScript: options.runScript || (async () => ({ code: 0, status: 'success', stdout: '' })), selectProject: options.selectProject || (async () => {}),
        scanWorkspaceSources: async () => ({ modules: new Map([['top', f.files['top.sv']], ['child', f.files['child.sv']]]) }) });
    if (api?.ready && !options.skipReady) await api.ready;
    else await delay(30);
    await delay(0);
    const cleanup = () => { api?.dispose?.(); for (const disposable of subscriptions) disposable.dispose?.(); };
    return { api, commands, notifications, picks, watchers, workspaceEvents, provider, tree, cached: () => cached, updates, dispose: cleanup };
}

test('异步首次构建会通知树重新读取，工程面板不会停留在初始空列表', async t => {
    const f = await fixture(t), h = await harness(f);
    try { assert.equal(typeof h.provider.onDidChangeTreeData, 'function'); assert.ok(h.cached().length); assert.ok(h.updates.length >= 2); }
    finally { h.dispose(); }
});

function flatten(nodes) { return nodes.flatMap(node => [node, ...flatten(node.children || [])]); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function waitFor(predicate) { const deadline = Date.now() + 3000; while (!predicate()) { assert.ok(Date.now() < deadline); await delay(5); } }

test('刷新保留稳定节点ID，父节点合同支持全部展开', async t => {
    const f = await fixture(t), h = await harness(f);
    try {
        const ids = flatten(h.cached()).map(node => node.id); await h.api.refresh(); await delay(0);
        assert.deepEqual(flatten(h.cached()).map(node => node.id), ids);
        const root = h.cached()[0], child = root.children[0]; assert.equal(h.provider.getParent(child), root);
        await h.commands.get('svtools.vivado.tree.expandAll')();
    } finally { h.dispose(); }
});

test('无工程和读取失败均显示内容，之后刷新可恢复真实工程', async t => {
    const f = await fixture(t); let selected = null, failure = false;
    const h = await harness(f, { findProjectXpr: async () => { if (failure) throw new Error('discovery failed'); return selected; } });
    try {
        assert.match(h.cached()[0].label, /没有 Vivado/); failure = true; await h.api.refresh(); await delay(0);
        assert.match(h.cached()[0].label, /discovery failed/); selected = f.xpr; failure = false; await h.api.refresh(); await delay(0);
        assert.equal(h.cached()[0].contextValue, 'project');
    } finally { h.dispose(); }
});

test('快速刷新只提交最新快照；释放后迟到请求不再更新树', async t => {
    const f = await fixture(t), old = deferred(); let calls = 0, selected = f.xpr;
    const h = await harness(f, { skipReady: true, findProjectXpr: () => ++calls === 1 ? old.promise : Promise.resolve(selected) });
    try {
        selected = null; const latest = h.api.refresh(); h.api.refresh(); old.resolve(f.xpr); await latest; await delay(0);
        assert.equal(calls, 2); assert.match(h.cached()[0].label, /没有 Vivado/);
        const blocked = deferred(); const other = await harness(f, { skipReady: true, findProjectXpr: () => blocked.promise });
        const count = other.updates.length; other.dispose(); blocked.resolve(f.xpr); await other.api.ready; await delay(0);
        assert.equal(other.updates.length, count);
    } finally { h.dispose(); }
});

test('XPR创建/删除监听触发更新，不只监听内容变化', async t => {
    const f = await fixture(t); let selected = null;
    const h = await harness(f, { findProjectXpr: async () => selected });
    try {
        selected = f.xpr; h.watchers[0].create.fire(uri(f.xpr)); await delay(360); await h.api.refresh();
        assert.equal(h.cached()[0].contextValue, 'project'); selected = null;
        h.watchers[0].remove.fire(uri(f.xpr)); await delay(360); assert.match(h.cached()[0].label, /没有 Vivado/);
    } finally { h.dispose(); }
});

test('右键未加入文件直接使用所选文件，仅询问真实工程文件集', async t => {
    const f = await fixture(t); let script;
    const h = await harness(f, { runScript: async file => {
        script = await fs.readFile(file, 'utf8'); const text = await fs.readFile(f.xpr, 'utf8');
        await fs.writeFile(f.xpr, text.replace('<Config>', '<File Path="$PPRDIR/other.sv"/><Config>'));
        return { code: 0, status: 'success', stdout: '' };
    } });
    try {
        const node = flatten(h.cached()).find(item => item.contextValue === 'orphan');
        await h.commands.get('svtools.vivado.tree.addFile')(node);
        assert.ok(script.includes('other.sv')); assert.equal(h.picks.length, 1); assert.equal(h.picks[0][0].value, 'sources_1');
        assert.ok(flatten(h.cached()).some(item => item.nodeData?.file === f.files['other.sv'] && item.contextValue === 'file'));
    } finally { h.dispose(); }
});

test('忙碌与连续写操作不会再次选文件或覆盖正在使用的脚本', async t => {
    const f = await fixture(t), pending = deferred(); let runs = 0;
    const options = { busy: true, runScript: async () => { runs++; return pending.promise; } }, h = await harness(f, options);
    try {
        const node = flatten(h.cached()).find(item => item.contextValue === 'orphan'), add = h.commands.get('svtools.vivado.tree.addFile');
        await add(node); assert.equal(runs, 0); assert.equal(h.picks.length, 0); options.busy = false;
        const first = add(node); await waitFor(() => runs === 1); await add(node);
        assert.equal(runs, 1); assert.equal(h.picks.length, 1); pending.resolve({ code: 1, status: 'failed' }); await first;
        assert.ok(h.notifications.some(message => typeof message === 'string' && message.includes('等待')));
    } finally { pending.resolve({ code: 1 }); h.dispose(); }
});

test('切换工程后旧节点命令被拒绝，避免写入另一工程', async t => {
    const f = await fixture(t), alternate = path.join(f.root, 'alternate.xpr'); await fs.copyFile(f.xpr, alternate);
    let selected = f.xpr, runs = 0;
    const h = await harness(f, { findProjectXpr: async () => selected, runScript: async () => { runs++; return { code: 0 }; } });
    try {
        const node = flatten(h.cached()).find(item => item.contextValue === 'file'); selected = alternate;
        await h.commands.get('svtools.vivado.tree.removeFile')(node); assert.equal(runs, 0);
        assert.ok(h.notifications.some(message => typeof message === 'string' && message.includes('工程已切换')));
        assert.equal(h.cached()[0].label, 'alternate');
    } finally { h.dispose(); }
});

test('工程模型只包含XPR成员，注释字符串不会制造层级，循环引用有明确终点', async t => {
    const f = await fixture(t); await fs.writeFile(f.files['top.sv'], 'module top; // other u_other();\n initial $display("other u_bad();"); child #(.N(fun(2))) u_child[2:0](); endmodule');
    await fs.writeFile(f.files['child.sv'], 'module child; top u_cycle(); endmodule');
    const snapshot = await buildProjectTree(parseXpr(f.xpr), { workspaceFiles: Object.values(f.files) });
    const nodes = flatten(snapshot.roots); assert.ok(nodes.some(node => node.label === 'top（循环引用）'));
    assert.equal(nodes.filter(node => node.nodeData?.module === 'other').length, 0);
    assert.ok(nodes.some(node => node.nodeData?.file === f.files['other.sv'] && node.contextValue === 'orphan'));
    assert.deepEqual(referencedUnits('import pkg::*; child #(.N(f(2))) a[2:0](); child fake; /* other x(); */', new Set(['pkg', 'child', 'other'])), ['pkg', 'child']);
});

test('自定义文件集、缺失源码和重复单元保持可见并报告，ID在重复层级中仍唯一', async t => {
    const f = await fixture(t); await fs.writeFile(f.files['other.sv'], 'module child; endmodule');
    const missing = path.join(f.root, 'missing.sv');
    const snapshot = await buildProjectTree({ path: f.xpr, dir: f.root, part: 'part', sets: [{ name: 'rtl_custom', type: 'DesignSrcs', top: 'top', files: [...Object.values(f.files), missing] }] });
    assert.ok(snapshot.issues.some(issue => issue.includes('重复设计单元'))); assert.ok(snapshot.issues.some(issue => issue.includes('missing.sv')));
    const nodes = flatten(snapshot.roots), ids = nodes.map(node => node.id); assert.equal(new Set(ids).size, ids.length);
    assert.ok(nodes.some(node => node.label.startsWith('rtl_custom'))); assert.ok(nodes.some(node => node.nodeData?.file === missing && node.icon === 'warning'));
});

test('工程选择发现包含所有目录，自动选择稳定且显式选择持久化', async t => {
    const f = await fixture(t), alternate = path.join(f.root, 'aaa.xpr'); await fs.copyFile(f.xpr, alternate);
    const stored = new Map(); let candidates = [f.xpr], calls = [];
    const workspace = { workspaceFolders: [{ uri: uri(f.root) }], findFiles: async (...args) => { calls.push(args); return candidates.map(uri); } };
    const state = { get: key => stored.get(key), update: async (key, value) => stored.set(key, value) };
    const selection = createProjectSelection({ workspace, state }); assert.equal(await selection.current(), f.xpr);
    candidates = [f.xpr, alternate, f.xpr]; assert.equal(await selection.current(), f.xpr);
    assert.deepEqual(await selection.discover(), [alternate, f.xpr]); assert.ok(!calls[0][1].includes('vivado_prj'));
    await selection.select(alternate); assert.equal(await selection.current(), alternate);
    assert.equal(await createProjectSelection({ workspace, state }).current(), alternate);
    await fs.unlink(alternate); await assert.rejects(selection.current(), /已不存在/);
});

test('同文件的其他模块依赖不混入顶层预览，仿真引用禁止作为集成员管理', async t => {
    const f = await fixture(t);
    await fs.writeFile(f.files['top.sv'], 'module top; endmodule\nmodule unused; child u_child(); endmodule\n');
    const parsed = parseXpr(f.xpr); parsed.sets[1].top = 'top';
    const snapshot = await buildProjectTree(parsed), designHierarchy = snapshot.roots[0].children[1].children[0];
    assert.equal(flatten(designHierarchy.children).filter(node => node.label === 'child').length, 0);
    const reference = flatten(snapshot.roots).find(node => node.nodeData?.isReference);
    assert.equal(reference.contextValue, 'referenceModule'); assert.equal(reference.nodeData.fileset, 'sources_1');
    const h = await harness(f); try {
        await h.commands.get('svtools.vivado.tree.removeFile')(reference); assert.ok(h.notifications.some(message => typeof message === 'string' && message.includes('仅为引用')));
    } finally { h.dispose(); }
});

test('高扇出图的层级预算包含所有节点，达到上限只显示一个提示', async t => {
    const f = await fixture(t), files = Array.from({ length: 120 }, (_, index) => path.join(f.root, 'unit' + index + '.sv'));
    const readFile = async file => 'module unit' + files.indexOf(file) + ';\n' + files.map((_, index) => 'unit' + index + ' i' + index + '();').join('\n') + '\nendmodule';
    const snapshot = await buildProjectTree({ path: f.xpr, dir: f.root, sets: [{ name: 'sources_1', type: 'DesignSrcs', top: 'unit0', files }] }, { readFile, stat: async () => ({ size: 10000 }) });
    const hierarchy = snapshot.roots[0].children[1].children[0], nodes = flatten(hierarchy.children);
    assert.ok(nodes.length <= 5000); assert.equal(nodes.filter(node => node.label.includes('达到上限')).length, 1);
});

test('单文件及累计字节预算在读源码之前生效，文件清单保留', async t => {
    const f = await fixture(t), files = Array.from({ length: 18 }, (_, index) => path.join(f.root, index + '.sv')); let reads = 0;
    const snapshot = await buildProjectTree({ path: f.xpr, dir: f.root, sets: [{ name: 'sources_1', type: 'DesignSrcs', top: '', files }] }, {
        stat: async file => ({ size: files.indexOf(file) === 0 ? 5 * 1024 * 1024 : 4 * 1024 * 1024 }), readFile: async () => { reads++; return 'module tiny; endmodule'; }
    });
    assert.equal(reads, 16); assert.ok(snapshot.issues.some(issue => issue.includes('字节预算')));
    assert.equal(flatten(snapshot.roots).filter(node => node.contextValue === 'file').length, 18);
});

test('旧工程stat迟到失败不会覆盖已经选择的新工程', async t => {
    const f = await fixture(t), alternate = path.join(f.root, 'new.xpr'), blocked = deferred(); let oldCalls = 0;
    const values = new Map([['svtools.vivado.selectedProject', f.xpr]]);
    const selection = createProjectSelection({ workspace: {}, state: { get: key => values.get(key), update: async (key, value) => values.set(key, value) },
        stat: file => file === f.xpr && ++oldCalls === 1 ? blocked.promise : Promise.resolve({ isFile: () => true }) });
    const old = selection.current(); await selection.select(alternate); blocked.resolve({ isFile: () => false });
    assert.equal(await old, alternate);
});

test('工程详细化使用当前工程成员和真实top；标题栏停止路由到xelab任务', async t => {
    const f = await fixture(t), pending = deferred(); let started = false, stops = 0;
    const h = await harness(f, { onCommand: async (command, doc, options) => {
        if (command === 'svtools.xvlog.elaborate') {
            assert.equal(options.top, 'top'); assert.deepEqual(new Set(options.projectScope.files), new Set([f.files['top.sv'], f.files['child.sv']]));
            assert.ok(!options.projectScope.modules.has('other')); started = true; return pending.promise;
        }
        if (command === 'svtools.lint.stop') { stops++; assert.equal(doc.uri.fsPath, f.files['top.sv']); pending.resolve({ status: 'cancelled' }); }
    } });
    try {
        const task = h.commands.get('svtools.vivado.tree.quickElaborate')(h.cached()[0]); await waitFor(() => started);
        await h.commands.get('svtools.vivado.tree.stop')(); await task; assert.equal(stops, 1);
    } finally { pending.resolve({ status: 'cancelled' }); h.dispose(); }
});

test('GUI已把文件移到别的集时，旧节点不会回退到新集删除或移动', async t => {
    const f = await fixture(t); let runs = 0;
    const h = await harness(f, { runScript: async () => { runs++; return { code: 0 }; } });
    try {
        const old = flatten(h.cached()).find(node => node.contextValue === 'file' && node.nodeData.file === f.files['child.sv']);
        const text = await fs.readFile(f.xpr, 'utf8');
        await fs.writeFile(f.xpr, text.replace('<File Path="$PPRDIR/child.sv"/>', '').replace('<FileSet Name="sim_1" Type="SimulationSrcs">', '<FileSet Name="sim_1" Type="SimulationSrcs"><File Path="$PPRDIR/child.sv"/>'));
        await h.commands.get('svtools.vivado.tree.removeFile')(old); await h.commands.get('svtools.vivado.tree.moveToSim')(old);
        assert.equal(runs, 0); assert.ok(parseXpr(f.xpr).sets.find(set => set.name === 'sim_1').files.some(file => file === f.files['child.sv']));
    } finally { h.dispose(); }
});

test('目标集在选择过程中被GUI删除，移动操作取消且不先移出源文件', async t => {
    const f = await fixture(t);
    const text = await fs.readFile(f.xpr, 'utf8');
    await fs.writeFile(f.xpr, text.replace('<FileSet Name="sim_1" Type="SimulationSrcs"></FileSet>', '<FileSet Name="sim_deleted" Type="SimulationSrcs"></FileSet><FileSet Name="sim_keep" Type="SimulationSrcs"></FileSet>'));
    let runs = 0;
    const h = await harness(f, { pick: async choices => {
        const current = await fs.readFile(f.xpr, 'utf8'); await fs.writeFile(f.xpr, current.replace('<FileSet Name="sim_deleted" Type="SimulationSrcs"></FileSet>', ''));
        return choices.find(choice => choice.value === 'sim_deleted');
    }, runScript: async () => { runs++; return { code: 0 }; } });
    try {
        const node = flatten(h.cached()).find(item => item.contextValue === 'file'); await h.commands.get('svtools.vivado.tree.moveToSim')(node);
        assert.equal(runs, 0); assert.ok(parseXpr(f.xpr).sets.find(set => set.name === 'sources_1').files.length === 2);
    } finally { h.dispose(); }
});

test('多仿真集快捷详细化保留选中集，不编译另一仿真集的测试台', async t => {
    const f = await fixture(t), tbA = path.join(f.root, 'tb_a.sv'), tbB = path.join(f.root, 'tb_b.sv');
    await fs.writeFile(tbA, 'module tb_a; top u_top(); endmodule'); await fs.writeFile(tbB, 'module tb_b; top u_top(); endmodule');
    const text = await fs.readFile(f.xpr, 'utf8');
    await fs.writeFile(f.xpr, text.replace('<FileSet Name="sim_1" Type="SimulationSrcs"></FileSet>', '<FileSet Name="sim_a" Type="SimulationSrcs"><File Path="$PPRDIR/tb_a.sv"/><Config><Option Name="TopModule" Val="tb_a"/></Config></FileSet><FileSet Name="sim_b" Type="SimulationSrcs"><File Path="$PPRDIR/tb_b.sv"/><Config><Option Name="TopModule" Val="tb_b"/></Config></FileSet>'));
    let invoked = false;
    const h = await harness(f, { pick: async choices => choices.find(choice => choice.set?.name === 'sim_a'), onCommand: async (command, doc, options) => {
        if (command !== 'svtools.xvlog.elaborate') return;
        invoked = true; assert.equal(options.top, 'tb_a'); assert.equal(doc.uri.fsPath, tbA);
        assert.ok(options.projectScope.files.includes(tbA)); assert.ok(!options.projectScope.files.includes(tbB));
    } });
    try { await h.commands.get('svtools.vivado.tree.quickElaborate')(h.cached()[0]); assert.equal(invoked, true); }
    finally { h.dispose(); }
});
