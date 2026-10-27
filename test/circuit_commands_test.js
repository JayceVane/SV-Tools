'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// 只替代外部 Yosys，命令注册、宿主消息、Worker 和 ELK 均执行真实代码。
const runnerPath = require.resolve('../src/circuit/yosys-runner');
const runner = require(runnerPath);
const requests = new Map();
require.cache[runnerPath].exports = { ...runner, async runYosysCircuit(options) {
    const request = requests.get(options.sourceRoot);
    assert.ok(request, '未登记的命令夹具');
    request.generated.push(options);
    return { filePath: request.json, sourceRoot: options.sourceRoot };
} };
delete require.cache[require.resolve('../src/circuit')];
const { activateCircuitViewer } = require('../src/circuit');
require.cache[runnerPath].exports = runner;
const vivadoRunnerPath = require.resolve('../src/circuit/vivado-runner');
const vivadoRunner = require(vivadoRunnerPath);
require.cache[vivadoRunnerPath].exports = { ...vivadoRunner, async runVivadoCircuit(options) {
    const request = requests.get(path.dirname(options.projectPath));
    assert.ok(request, '未登记的 Vivado 命令夹具');
    request.vivadoGenerated.push(options);
    if (request.vivadoError) throw new Error(request.vivadoError);
    const filePath = path.join(request.root, 'vivado-' + request.vivadoGenerated.length + '.json');
    await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 1, engine: 'vivado', version: '2022.1',
        stage: 'elaborated-rtl', view: 'flat', top: options.top || request.projectTop,
        ports: [], cells: [], signals: [] }));
    return { filePath, sourceRoot: request.root };
} };
test.after(() => { require.cache[vivadoRunnerPath].exports = vivadoRunner; });
const disposable = () => ({ dispose() {} });
const uri = fsPath => ({ fsPath, scheme: 'file' });

async function waitForReleasedDirectory(directory) {
    const deadline = Date.now() + 5000;
    while (true) {
        const entries = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!entries || entries.includes('.svtools-task-complete.json')) return;
        assert.ok(Date.now() < deadline, '快照占用未在页面生命周期结束后释放');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-circuit-command-'));
    const rtl = path.join(root, options.fileName || 'top.sv'), json = path.join(root, 'top.json');
    const text = options.text || '// ------- RTL header -------\nmodule top(input a, output y); assign y=a; endmodule';
    await fs.writeFile(rtl, text);
    await fs.writeFile(json, JSON.stringify({ modules: { top: { ports: {
        a: { direction: 'input', bits: [2] }, y: { direction: 'output', bits: [2] }
    }, cells: {}, netnames: {} } } }));
    const commands = new Map(), generated = [], errors = [], context = { subscriptions: [] };
    const state = { root, rtl, json, commands, generated, errors, text, vivadoGenerated: [], picked: undefined, dialogs: 0, quickPicks: [],
        quickPick: options.quickPick, configTop: options.configTop === undefined ? 'top' : options.configTop,
        projectTop: options.projectTop || 'project_top', projectPath: options.noProject ? undefined : path.join(root, 'design.xpr'), panels: [], saves: 0, progress: [], retainedRuns: options.retainedRuns ?? 5 };
    const document = { uri: { ...uri(rtl), scheme: options.scheme || 'file' }, isDirty: !!options.dirty, getText: () => state.text,
        async save() { state.saves++; this.isDirty = false; return true; } };
    state.document = document;
    requests.set(root, state);
    const channel = { ...disposable(), append() {} };
    const vscode = {
        commands: { registerCommand(name, fn) { commands.set(name, fn); return disposable(); } },
        workspace: { getWorkspaceFolder: () => ({ uri: uri(root) }), workspaceFolders: [{ uri: uri(root) }],
            getConfiguration: () => ({ get: (key, fallback) => key === 'top' ? state.configTop : key === 'retainedRuns' ? state.retainedRuns : fallback }),
            openTextDocument: async file => file.fsPath === rtl ? document : ({ uri: file, isDirty: false, getText: () => text }) },
        window: { activeTextEditor: { document },
            createOutputChannel: () => channel, showErrorMessage: message => errors.push(message),
            showOpenDialog: async () => { state.dialogs++; return state.picked; },
            showQuickPick: async (items, settings) => {
                state.quickPicks.push({ items, settings });
                if (state.quickPick === null) return undefined;
                return items.find(item => item.value === state.quickPick) || items[0];
            },
            withProgress: (settings, fn) => {
                const callbacks = new Set(); state.progress.push(settings);
                const result = fn({}, { onCancellationRequested(callback) { callbacks.add(callback); return { dispose: () => callbacks.delete(callback) }; } });
                if (options.cancelScan && settings.title === '读取 RTL 顶层') queueMicrotask(() => { for (const callback of callbacks) callback(); });
                return result;
            },
            createWebviewPanel() {
                const messages = new Set(), closed = new Set();
                const panel = { webview: { postMessage: async () => true,
                    onDidReceiveMessage(fn) { messages.add(fn); return { dispose: () => messages.delete(fn) }; },
                    set html(value) { assert.match(value, /nonce=/); queueMicrotask(() => { for (const fn of messages) fn({ type: 'ready' }); }); }
                }, onDidDispose(fn) { closed.add(fn); return { dispose: () => closed.delete(fn) }; },
                    dispose() { for (const fn of [...closed]) fn(); } };
                state.panels.push(panel); return panel;
            }
        }, Uri: { file: uri }, ViewColumn: { Beside: 2 }, ProgressLocation: { Notification: 15 }
    };
    state.vscode = vscode;
    state.circuit = activateCircuitViewer(context, { vscode, vivado: { projectSelection: { current: async () => state.projectPath },
        resolveBinDir: () => path.join(root, 'Vivado', 'bin') } });
    t.after(async () => {
        for (const item of [...context.subscriptions].reverse()) item.dispose();
        requests.delete(root);
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('svtools-circuit-command-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    return state;
}

test('RTL 右键 URI 进入生成流程，文件头注释不能被当成 JSON', async t => {
    const f = await fixture(t);
    const binding = await f.commands.get('svtools.circuit.open')(uri(f.rtl));
    try {
        const result = await binding.loaded;
        assert.equal(result.ok, true, result.error);
        assert.equal(f.generated.length, 1);
        assert.deepEqual(f.generated[0].sources, [f.rtl]);
        assert.equal(f.generated[0].executable, 'bundled');
        assert.equal(result.design.provenance.stage, 'rtl');
        assert.equal(result.graph.edges.length, 1);
        assert.deepEqual(f.errors, []);
    } finally { binding.dispose(); }
});

test('刷新时已关闭的正文必须重新取得当前文档，不能读取旧文档对象',async t=>{
    const f=await fixture(t),binding=await f.circuit.fromSource(uri(f.rtl));
    assert.equal((await binding.loaded).ok,true);
    const text='module top(input a, output y); assign y=~a; endmodule';
    f.document.isClosed=true;f.document.getText=()=>{throw new Error('old document was closed');};
    f.vscode.workspace.openTextDocument=async()=>({uri:uri(f.rtl),isDirty:true,getText:()=>text});
    try{
        await binding.reload();assert.equal(f.generated.length,2);
        assert.equal(await fs.readFile(f.generated[1].sources[0],'utf8'),text);
        assert.ok(binding.getState().graph);
    }finally{binding.dispose();}
});

test('打开的脏正文电路快照跨后续生成保留，刷新和关闭才交还目录', async t => {
    const { pruneTaskDirectories } = require('../src/toolchains/task-retention');
    const { createSourceLocator, sourceHash } = require('../src/circuit/source-snapshots');
    const { fromYosys } = require('../src/circuit/adapters/yosys');
    const f = await fixture(t, { dirty: true, retainedRuns: 1, text: 'module top(input a, output y); assign y=a; endmodule' });
    const binding = await f.circuit.fromSource(uri(f.rtl));
    assert.equal((await binding.loaded).ok, true);
    const snapshot = f.generated[0].sources[0], directory = path.dirname(path.dirname(snapshot));
    const sourceBase = path.dirname(directory);
    const model = fromYosys({ modules: { top: { attributes: { src: f.rtl.replace(/\\/g, '/') + ':1.1' },
        ports: { a: { direction: 'input', bits: [2] }, y: { direction: 'output', bits: [2] } }, cells: {}, netnames: { y: { bits: [2] } } } } });
    const locator = createSourceLocator(model, [{ path: f.rtl, inputPath: snapshot, hash: sourceHash(f.text) }]);
    await locator.verify();
    try {
        for (let index = 0; index < 3; index++) {
            const other = await f.circuit.fromSource(uri(f.rtl));
            assert.equal((await other.loaded).ok, true); other.dispose();
        }
        await pruneTaskDirectories(sourceBase, 'source', 1);
        assert.equal(await fs.readFile(snapshot, 'utf8'), f.text);
        const module = model.modules[0], signal = module.signals.find(item => item.name === 'y');
        const source = await locator.locate(module.id, { objectId: signal.id });
        assert.equal(source.path, f.rtl); assert.equal(source.line, 1);
        await binding.reload();
        const replacement = f.generated.at(-1).sources[0];
        assert.notEqual(replacement, snapshot); assert.equal(await fs.readFile(replacement, 'utf8'), f.text);
        await waitForReleasedDirectory(directory);
        binding.dispose();
        await waitForReleasedDirectory(path.dirname(path.dirname(replacement)));
    } finally { locator.dispose(); binding.dispose(); }
});

test('JSON URI 仍直接导入，不调用 Yosys；命令面板取消导入不读取当前 RTL', async t => {
    const f = await fixture(t);
    const binding = await f.commands.get('svtools.circuit.open')(uri(f.json));
    try { assert.equal((await binding.loaded).ok, true); }
    finally { binding.dispose(); }
    assert.equal(f.generated.length, 0);
    assert.equal(await f.commands.get('svtools.circuit.open')(), undefined);
    assert.equal(f.dialogs, 1);
    assert.equal(f.generated.length, 0);
});

test('JSON 导入入口不混入 RTL 子菜单，JSON 编辑器有独立入口', () => {
    const { menus } = require('../package.json').contributes;
    assert.equal(menus['svtools.submenu'].some(item => item.command === 'svtools.circuit.open'), false);
    const item = menus['editor/context'].find(item => item.command === 'svtools.circuit.open');
    assert.ok(item);
    assert.match(item.when, /resourceExtname.*json/);
});

test('标题栏默认Yosys，RTL右键提供文件Vivado，工程面板保留工程top', () => {
    const { contributes } = require('../package.json');
    assert.ok(contributes.menus['editor/title'].some(item => item.command === 'svtools.circuit.fromSource'));
    assert.ok(!contributes.menus['editor/title'].some(item => item.command === 'svtools.circuit.fromVivadoFile'));
    assert.ok(contributes.menus['svtools.submenu'].some(item => item.command === 'svtools.circuit.fromVivadoFile' && /sv\|v/.test(item.when)));
    assert.ok(contributes.menus['view/title'].some(item => item.command === 'svtools.circuit.fromVivado'));
    assert.ok(contributes.menus['view/item/context'].some(item => item.command === 'svtools.circuit.fromVivado' && /topModule/.test(item.when)));
    assert.equal(contributes.commands.find(item => item.command === 'svtools.circuit.fromVivadoFile').icon, '$(circuit-board)');
    assert.equal(contributes.configuration.properties['svtools.circuit.yosysPath'].default, 'bundled');
    assert.equal(contributes.configuration.properties['svtools.circuit.frontend'].default, 'auto');
});

test('编辑器 Vivado 使用文件同名模块，工程入口保留工程 top，均走真实 Worker 与 ELK', async t => {
    const f = await fixture(t, { fileName: 'leaf.sv', configTop: 'project_top', text: 'module helper; endmodule\nmodule leaf; endmodule' });
    const current = await f.commands.get('svtools.circuit.fromVivadoFile')(uri(f.rtl));
    try {
        const loaded = await current.loaded; assert.equal(loaded.ok, true, loaded.error);
        assert.equal(loaded.design.provenance.engine, 'vivado'); assert.equal(loaded.design.provenance.hierarchy, 'flat');
        assert.equal(loaded.graph.name, 'leaf'); assert.equal(f.vivadoGenerated[0].top, 'leaf'); assert.equal(f.vivadoGenerated[0].sourcePath, f.rtl);
        assert.equal(f.quickPicks.length, 0);
    } finally { current.dispose(); }
    const project = await f.commands.get('svtools.circuit.fromVivado')();
    try {
        const loaded = await project.loaded; assert.equal(loaded.ok, true, loaded.error); assert.equal(loaded.graph.name, 'project_top');
        assert.equal(f.vivadoGenerated[1].top, undefined); assert.equal(f.vivadoGenerated[1].sourcePath, undefined); assert.deepEqual(f.errors, []);
    } finally { project.dispose(); }
});

test('文件名无同名模块时选择唯一真实模块，忽略配置和注释中的假模块', async t => {
    const f = await fixture(t, { fileName: 'different.sv', configTop: 'project_top',
        text: '// module fake; endmodule\n/* module pretend; endmodule */\nmodule actual_leaf; endmodule' });
    const binding = await f.commands.get('svtools.circuit.fromVivadoFile')();
    try { assert.equal((await binding.loaded).ok, true); assert.equal(f.vivadoGenerated[0].top, 'actual_leaf'); assert.equal(f.quickPicks.length, 0); }
    finally { binding.dispose(); }
});

test('多个真实模块由 QuickPick 选择，取消时不创建页面或调用工具', async t => {
    const f = await fixture(t, { fileName: 'many.sv', configTop: 'project_top', quickPick: 'lane_b',
        text: 'module lane_a; endmodule\ninterface ignored; endinterface\nmodule lane_b; endmodule' });
    const binding = await f.commands.get('svtools.circuit.fromVivadoFile')();
    try {
        assert.equal((await binding.loaded).ok, true); assert.equal(f.vivadoGenerated[0].top, 'lane_b');
        assert.deepEqual(f.quickPicks[0].items.map(item => item.label), ['lane_a', 'lane_b']);
    } finally { binding.dispose(); }
    f.quickPick = null; const panels = f.panels.length;
    assert.equal(await f.commands.get('svtools.circuit.fromVivadoFile')(), undefined);
    assert.equal(f.panels.length, panels); assert.equal(f.vivadoGenerated.length, 1); assert.deepEqual(f.errors, []);
});

test('未保存文件明确提示保存或使用内置 Yosys，不自动保存、不展示磁盘旧版', async t => {
    const f = await fixture(t, { dirty: true });
    assert.equal(await f.commands.get('svtools.circuit.fromVivadoFile')(), undefined);
    assert.equal(f.document.isDirty, true); assert.equal(f.saves, 0); assert.equal(f.panels.length, 0); assert.equal(f.vivadoGenerated.length, 0);
    assert.match(f.errors[0], /先保存.*RTL.*Vivado.*未保存.*内置 Yosys/);
    assert.equal(await fs.readFile(f.rtl, 'utf8'), f.text);
});

test('刷新再次检测 dirty 文档，避免先前保存状态让刷新使用旧正文', async t => {
    const f = await fixture(t), binding = await f.commands.get('svtools.circuit.fromVivadoFile')();
    try {
        assert.equal((await binding.loaded).ok, true); assert.equal(f.vivadoGenerated.length, 1);
        f.document.isDirty = true; f.text = 'module top; wire changed; endmodule';
        await binding.reload(); assert.equal(f.vivadoGenerated.length, 1); assert.equal(f.saves, 0);
        assert.match(f.errors.at(-1), /先保存.*RTL/);
    } finally { binding.dispose(); }
});

test('未命名文件与缺少工程明确提示，均不调用外部工具', async t => {
    const untitled = await fixture(t, { scheme: 'untitled' });
    assert.equal(await untitled.commands.get('svtools.circuit.fromVivadoFile')(), undefined); assert.match(untitled.errors[0], /先保存.*RTL/);
    assert.equal(untitled.vivadoGenerated.length, 0); assert.equal(untitled.panels.length, 0);
    const absent = await fixture(t, { noProject: true });
    assert.equal(await absent.commands.get('svtools.circuit.fromVivadoFile')(), undefined); assert.match(absent.errors[0], /Vivado.*选择工程/);
    assert.equal(absent.vivadoGenerated.length, 0); assert.equal(absent.panels.length, 0);
});

test('当前文件不含普通模块或不属于工程时明确失败，不悄悄展示工程 top', async t => {
    const empty = await fixture(t, { text: 'interface just_an_interface; endinterface' });
    assert.equal(await empty.commands.get('svtools.circuit.fromVivadoFile')(), undefined); assert.match(empty.errors[0], /当前文件.*模块/);
    assert.equal(empty.panels.length, 0); assert.equal(empty.vivadoGenerated.length, 0);
    const outside = await fixture(t); outside.vivadoError = '当前文件不在工程综合源中，请先加入工程，或使用内置 Yosys';
    const binding = await outside.commands.get('svtools.circuit.fromVivadoFile')();
    try { const result = await binding.loaded; assert.equal(result.ok, false); assert.match(result.error, /不在工程.*加入工程.*Yosys/); }
    finally { binding.dispose(); }
});

test('取消当前文件顶层扫描释放 Worker，不创建页面或运行 Vivado', async t => {
    const f = await fixture(t, { cancelScan: true });
    assert.equal(await f.commands.get('svtools.circuit.fromVivadoFile')(), undefined);
    assert.equal(f.progress[0].title, '读取 RTL 顶层'); assert.equal(f.panels.length, 0); assert.equal(f.vivadoGenerated.length, 0);
    assert.deepEqual(f.errors, []);
});


test('RTL命令的默认请求自动包含工作区子模块，而不是仅编译当前文件', async t => {
    const f = await fixture(t, { text: 'module top; half_adder child(); endmodule' });
    const library = path.join(f.root, 'arbitrary-name.sv'); await fs.writeFile(library, 'module half_adder; endmodule');
    f.vscode.workspace.findFiles = async () => [uri(library), uri(f.rtl)];
    const binding = await f.commands.get('svtools.circuit.fromSource')(uri(f.rtl));
    try { assert.equal((await binding.loaded).ok, true); assert.deepEqual(f.generated[0].sources, [library, f.rtl]); }
    finally { binding.dispose(); }
});
