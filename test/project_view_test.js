'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { projectHtml } = require('../src/project/view');
const { projectTree } = require('../src/project/tree-model');
const noop = () => ({ dispose() {
    } });
async function host(t) {
    const commands = new Map(), calls = [], sent = [], errors = [], subscriptions = [];
    let provider, receive, traceMode = 'selection';
    let project = { id: 'p1', name: 'local', kind: 'svtools', path: path.resolve('bin/local.json'), root: path.resolve('bin'), sets: [{ name: 'sources', type: 'DesignSrcs', top: 'top', files: [path.resolve('bin/top.sv')] }], key: '1', includeDirs: [], defines: [] };
    const listeners = new Set(), projects = { current: async () => project, onDidChange(fn) {
            listeners.add(fn);
            return noop();
        }, discover: async () => [], invalidate() {
            for (const fn of listeners)
                fn();
        }, remove: async (...args) => calls.push(['remove', ...args]), select: async () => {
        }, create: async () => {
        }, add: async () => {
        }, update: async () => {
        } };
    const vscode = { Uri: { file: fsPath => ({ fsPath, scheme: 'file' }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) }, window: { registerWebviewViewProvider(id, value) {
                assert.equal(id, 'svtools.vivado.projectTree');
                provider = value;
                return noop();
            }, showErrorMessage: error => errors.push(error), showQuickPick: async () => undefined }, ConfigurationTarget: {Workspace:2,Global:1}, workspace: { getConfiguration: () => ({ get: () => traceMode, update:async (_,value)=>{traceMode=value;} }), createFileSystemWatcher: () => ({ onDidChange: noop, onDidCreate: noop, onDidDelete: noop, dispose() {
                } }) }, commands: { registerCommand(id, callback) {
                commands.set(id, callback);
                return noop();
            }, executeCommand: async (...args) => calls.push(args) } };
    const context = { subscriptions, workspaceState: { get: () => ({}), update: async () => {
            } }, extensionUri: { fsPath: path.resolve('.') } };
    const filename = path.resolve(__dirname, '../src/project/index.js'), module = { exports: {} }, localRequire = createRequire(filename);
    const flow = { get: () => null, cancelFollow() {}, clear() {
        }, projectChanged() {
        }, dispose() {
        }, trace: async () => {
        }, setPinned() {
        } };
    const factory = new vm.Script('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})').runInThisContext();
    factory(name => name === './flow-controller' ? { createProjectFlowController: () => flow } : localRequire(name), module, module.exports);
    const api = module.exports.activateProjectView(context, { vscode, projects, vivado: { refreshProjectContext: async () => {
            }, projectTree: { refresh: async () => {
                } } }, sourceCatalog: {} });
    provider.resolveWebviewView({ webview: { asWebviewUri: uri => uri.fsPath, postMessage: value => sent.push(value), onDidReceiveMessage(fn) {
                receive = fn;
                return noop();
            } } });
    await api.refresh();
    t.after(() => {
        for (const disposable of subscriptions)
            disposable.dispose?.();
    });
    return { api, commands, calls, sent, errors, async message(data) {
            receive(data);
            await new Promise(resolve => setImmediate(resolve));
        }, setProject(value) {
            project = value;
            projects.invalidate();
        } };
}
test('仅一个工程Webview，菜单只允许宿主当前节点动作，过期节点不能操作任意文件', async (t) => {
    const h = await host(t), snapshot = h.sent.at(-1), file = snapshot.nodes[0].children[0];
    assert.equal(snapshot.project.name, 'local');
    assert.equal(file.label, 'top.sv');
    assert.ok(h.commands.has('svtools.project.trace'));
    await h.message({ action: 'command', revision: snapshot.revision, command: 'workbench.action.quit', nodeId: file.id });
    assert.equal(h.calls.length, 0);
    assert.ok(h.errors.some(error => error.includes('允许列表')));
    await h.message({ action: 'command', revision: snapshot.revision - 1, command: 'remove', nodeId: file.id });
    assert.equal(h.calls.length, 0);
    await h.message({ action: 'command', revision: snapshot.revision, command: 'remove', nodeId: 'arbitrary-file' });
    assert.equal(h.calls.length, 0);
    await h.message({ action: 'command', revision: snapshot.revision, command: 'remove', nodeId: file.id });
    assert.equal(h.calls[0][0], 'remove');
    assert.equal(h.calls[0][2], file.file);
});
test('空工程状态也发送恢复入口，工程文本不插入可执行HTML', async (t) => {
    const h = await host(t);
    h.setProject(null);
    await h.api.refresh();
    assert.equal(h.sent.at(-1).project, null);
    assert.deepEqual(h.sent.at(-1).nodes, []);
    const html = projectHtml({ asWebviewUri: () => '/client.js' }, '/extension', { Uri: { joinPath: () => '/script' } });
    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'nonce-/);
    assert.ok(!html.includes('unsafe-inline'));
    const client = fs.readFileSync(path.resolve(__dirname, '../src/project/client.js'), 'utf8');
    assert.ok(!client.includes('innerHTML'));
    assert.match(client, /label.textContent\s*=\s*node.label/);
});

test('工程菜单允许切换自动/手动追踪，并即时显示当前模式', async t => {
    const h = await host(t);
    assert.match(h.sent.at(-1).actions.find(action=>action.id==='traceTrigger').label,/自动追踪/);
    await h.message({action:'command',revision:h.sent.at(-1).revision,command:'traceTrigger'});
    assert.match(h.sent.at(-1).actions.find(action=>action.id==='traceTrigger').label,/手动追踪/);
    await h.message({action:'command',revision:h.sent.at(-1).revision,command:'traceTrigger'});
    assert.match(h.sent.at(-1).actions.find(action=>action.id==='traceTrigger').label,/自动追踪/);
    assert.deepEqual(h.errors,[]);
});
test('文件视图聚合角色，实例视图区分同文件多实例，信号不会成为树节点', () => {
    const file = path.resolve('bin/leaf.sv'), project = { root: path.dirname(file), sets: [{ name: 'sources', files: [file] }] }, nodes = [{ id: 'a', parentId: null, moduleName: 'leaf', label: 'u_a : leaf', source: { path: file }, names: ['u_a'], roles: ['internal', 'output'], details: [], declaration: { name: 'r_data', indices: [0] } }, { id: 'b', parentId: null, moduleName: 'leaf', label: 'u_b : leaf', source: { path: file }, names: ['u_b'], roles: ['input'], details: [] }];
    const files = projectTree(project, { flow: { nodes } });
    assert.deepEqual(files[0].children[0].flags.map(f => f.symbol), ['●', '→', '←']);
    const instances = projectTree(project, { projection: 'instances', flow: { nodes } });
    assert.equal(instances.length, 2);
    assert.notEqual(instances[0].id, instances[1].id);
    assert.ok(instances.every(n => !n.label.includes('r_data')));
});
