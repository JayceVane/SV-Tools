'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { projectHtml } = require('./view');
const { projectTree } = require('./tree-model');
const { createProjectFlowController } = require('./flow-controller');
const { topCandidates } = require('../circuit/source-request');
const { buildProjectTree } = require('../vivado/tree-model');
const VIEW_ID = 'svtools.vivado.projectTree';
const LOCAL_ACTIONS = [{ id: 'setTop', label: '设置工程顶层…' }, { id: 'setSimTop', label: '设置仿真顶层…' }, { id: 'remove', label: '移出工程（保留磁盘文件）' },
    {id:'moveToSim',label:'移入仿真集'}, {id:'moveToSources',label:'移入设计集'}];
const VIVADO_ACTIONS = ['setTopSynth', 'setTopSim', 'moveToSim', 'moveToSources', 'removeFile', 'elaborate'];
const VIVADO_LABELS = ['设置综合顶层…', '设置仿真顶层…', '移入仿真集', '移入设计集', '移出工程', '详细化模块…'];
const RUN_ACTIONS = [
    { id: 'synthesize', label: '综合', icon: 'synthesize', group: 'build' },
    { id: 'implement', label: '布局布线', icon: 'implement', group: 'build' },
    { id: 'bitstream', label: '生成 Bitstream', icon: 'bitstream', group: 'build' },
    { id: 'stop', label: '停止任务', icon: 'stop', group: 'build' },
    { id: 'reportSynth', label: '综合报告', icon: 'report', group: 'reports' },
    { id: 'reportImplUtil', label: '资源报告', icon: 'report', group: 'reports' },
    { id: 'reportTiming', label: '时序报告', icon: 'report', group: 'reports' }
];
/**
 * 单一侧边栏；页面只传节点令牌和允许的动作，文件路径与工程身份由宿主持有。
 * @param {object} context 扩展上下文。
 * @param {{vscode:object,projects:object,vivado:object}} dependencies
 * @returns {object} 刷新、显式追踪及销毁。
 */
function activateProjectView(context, { vscode, projects, vivado }) {
    let view, project, nodes = [], revision = 0, refreshGeneration = 0, disposed = false, message, busy = false, timer, selectionTimer;
    const nodeIndex = new Map(), projections = new Map(), expandedState = context.workspaceState.get('svtools.project.views', {});
    const traceTrigger = () => vscode.workspace.getConfiguration('svtools.project', vscode.window.activeTextEditor?.document.uri).get('traceTrigger', 'selection');
    const report = error => {
        if (error.code === 'TOOL_CANCELLED') {
            return;
        }
        message = error.message;
        vscode.window.showErrorMessage('SV Tools 工程：' + error.message);
        send();
    };
    const flow = createProjectFlowController({ vscode, projects, onChange(change) {
            if (disposed) {
                return;
            }
            if ('message' in change) {
                message = change.message;
            }
            if ('busy' in change) {
                busy = change.busy;
            }
            void refresh().catch(report);
        } });
    function actionsFor(node) {
        if (!project || !node.file || node.kind === 'set') {
            return [];
        }
        if (node.kind === 'folder') {
            return project.kind === 'svtools' ? [LOCAL_ACTIONS[2]] : [];
        }
        if (project.kind === 'svtools') {
            return LOCAL_ACTIONS;
        }
        return VIVADO_ACTIONS.map((name, index) => ({ id: name, label: VIVADO_LABELS[index] }));
    }
    function actionList() {
        if (!project) return [];
        return [{ id: 'trace', label: '追踪编辑器所选信号' }, { id: 'traceTrigger', label: traceTrigger() === 'selection' ? '✓ 自动追踪 · 切换为手动触发' : '手动追踪 · 切换为选择即触发' }, {id:'expandAll',label:'全部展开'}, {id:'collapseAll',label:'全部收起'},
            ...(project?.kind === 'vivado' ? RUN_ACTIONS : [{ id: 'edit', label: '编辑工程配置（顶层、宏、include目录）' }])];
    }
    function send() {
        if (!view || disposed) {
            return;
        }
        const currentFlow = flow.get(), projection = projections.get(project?.id) || expandedState[project?.id]?.projection || 'files';
        void view.webview.postMessage({ type: 'snapshot', revision, project: project ? { id: project.id, name: project.name, kind: project.kind } : null, nodes, projection,
            tracing: !!currentFlow, traceId: currentFlow?.traceId, traceRoot: currentFlow ? `${currentFlow.contextKind === 'simulation' ? '仿真' : '设计'}追踪根：${currentFlow.top}${currentFlow.rootFallback ? '（所选模块）' : ''}` : '', pinned: currentFlow?.pinned, busy, message,
            actions: actionList().filter(action => !action.group), toolActions: project?.kind === 'vivado' ? RUN_ACTIONS : [], issues: currentFlow?.issues ||
                (projection === 'instances' ? ['源码引用预览；执行信号追踪后显示静态RTL连接中可确定的实例层级'] : []) });
    }
    async function refresh() {
        const version = ++refreshGeneration;
        let current;
        try {
            current = await projects.current();
        } catch (error) {
            if (!disposed && version === refreshGeneration) {
                project = null;
                nodes = [];
                nodeIndex.clear();
                revision++;
                message = error.message;
                flow.projectChanged(null);
                send();
            }
            return;
        }
        if (disposed || version !== refreshGeneration) {
            return;
        }
        project = current;
        const projection = projections.get(project?.id) || expandedState[project?.id]?.projection || 'files';
        let next = projectTree(project, { projection, flow: flow.get() });
        if (project && projection === 'instances' && !flow.get()) {
            const preview = await buildProjectTree(project.parsed || { path: project.path, dir: project.root, sets: project.sets }, { workspaceFiles: [] });
            if (disposed || version !== refreshGeneration) {
                return;
            }
            function convert(node) {
                return { id: node.id, label: node.label, kind: node.nodeData?.kind === 'module' ? 'instance' : 'set', file: node.nodeData?.file,
                    module: node.nodeData?.module, fileset: node.nodeData?.fileset, tooltip: node.tooltip, flags: [], children: (node.children || []).map(convert) };
            }
            next = preview.roots[0].children.filter(node => node.children.some(child => child.id.endsWith('/hierarchy'))).flatMap(node => node.children.filter(child => child.id.endsWith('/hierarchy')).map(convert));
            if (!next.length) {
                message = '请设置工程顶层，或从编辑器发起信号追踪';
            }
        }
        if (disposed || version !== refreshGeneration) {
            return;
        }
        nodes = next;
        nodeIndex.clear();
        const stack = [...nodes];
        while (stack.length) {
            const node = stack.pop();
            node.actions = actionsFor(node);
            nodeIndex.set(node.id, node);
            stack.push(...node.children);
        }
        revision++;
        send();
    }
    async function create() {
        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) {
            throw new Error('请先打开一个工作区文件夹');
        }
        const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title: '选择工程所在工作区' }))?.folder;
        if (!folder) {
            return;
        }
        const name = await vscode.window.showInputBox({ title: '新建 SV Tools 工程', prompt: '名称使用字母、数字、汉字、下划线或横线，最多64个字符', value: 'rtl-project' });
        if (name) {
            await projects.create(folder.uri.fsPath, name);
        }
    }
    async function choose(onlyLocal = false) {
        const discovered = await projects.discover(), items = [];
        for (const descriptor of discovered) {
            if (onlyLocal && descriptor.kind !== 'svtools') {
                continue;
            }
            items.push({ label: path.basename(descriptor.path, path.extname(descriptor.path)), description: (descriptor.kind === 'vivado' ? 'Vivado' : 'SV Tools') + ' · ' + descriptor.path, descriptor });
        }
        const choice = await vscode.window.showQuickPick([...items, { label: '新建 SV Tools 工程…', create: true }, ...(!onlyLocal ? [{ label: '打开 Vivado .xpr 工程…', browse: true }] : [])], { title: onlyLocal ? '添加到 SV Tools 工程' : '切换工程', matchOnDescription: true });
        if (choice?.create) {
            await create();
            return projects.current();
        }
        let selected = choice?.descriptor;
        if (choice?.browse) {
            const file = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Vivado Project': ['xpr'] } }))?.[0];
            if (file) {
                selected = { kind: 'vivado', path: file.fsPath };
            }
        }
        if (selected) {
            await projects.select(selected);
            return projects.current();
        }
    }
    async function add(uri, toOther = false) {
        const target = toOther ? await choose(true) : await projects.current();
        if (!target) {
            if (!uri) {
                await create();
                return;
            }
            throw new Error('请先创建或选择SV Tools工程');
        }
        if (target.kind === 'vivado') {
            if (toOther) {
                throw new Error('请选择SV Tools工程');
            }
            await vscode.commands.executeCommand('svtools.vivado.tree.addFile', uri ? { file: uri.fsPath } : undefined);
            await refresh();
            return;
        }
        const uris = uri ? [uri] : await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: true, title: '添加HDL文件或跟随源码目录' });
        for (const file of uris || [])
            await projects.add(target, file.fsPath);
        await refresh();
    }
    async function moduleOf(node) {
        if (node.module) {
            return node.module;
        }
        const stat = await fs.stat(node.file);
        if (stat.size > 4 * 1024 * 1024) {
            throw new Error('文件超过4MiB，请在配置中设置顶层');
        }
        const choices = topCandidates(await fs.readFile(node.file, 'utf8'));
        if (!choices.length) {
            throw new Error('该文件没有模块声明');
        }
        return choices.length === 1 ? choices[0].name : (await vscode.window.showQuickPick(choices.map(item => ({ label: item.name })), { title: '选择模块' }))?.label;
    }
    async function execute(command, nodeId) {
        const node = nodeId ? nodeIndex.get(nodeId) : null, allowed = node ? node.actions : actionList();
        if (!allowed.some(action => action.id === command)) {
            throw new Error('工程动作不在当前节点允许列表中');
        }
        const target = project;
        if (command === 'traceTrigger') {
            flow.cancelFollow();
            clearTimeout(selectionTimer);
            const config = vscode.workspace.getConfiguration('svtools.project', vscode.window.activeTextEditor?.document.uri);
            await config.update('traceTrigger', traceTrigger() === 'selection' ? 'manual' : 'selection', vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
            send();
            return;
        }
        if (command === 'expandAll' || command === 'collapseAll') return expand(command === 'expandAll');
        if (command === 'trace') {
            return trace();
        }
        if (command === 'edit') {
            return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target.path));
        }
        if (target.kind === 'svtools') {
            if (command === 'moveToSim' || command === 'moveToSources') {
                await projects.move(target,node.file,command === 'moveToSim'?'simulation':'sources');
            }
            if (command === 'remove') {
                await projects.remove(target, node.file);
            }
            else if (command === 'setTop' || command === 'setSimTop') {
                const top = await moduleOf(node);
                if (top) {
                    if ((await projects.current())?.id !== target.id) {
                        throw new Error('工程已切换，请重新选择');
                    }
                    await projects.update(target, config => {
                        config[command === 'setTop' ? 'top' : 'simTop'] = top;
                    });
                }
            }
        }
        else {
            const name = ['setTopSynth', 'setTopSim', 'elaborate'].includes(command) ? await moduleOf(node) : node?.module;
            if (['setTopSynth', 'setTopSim', 'elaborate'].includes(command) && !name) {
                return;
            }
            if ((await projects.current())?.id !== target.id) {
                throw new Error('工程已切换，请重新选择');
            }
            await vscode.commands.executeCommand('svtools.vivado.tree.' + command, node ? { nodeData: { file: node.file, module: name, fileset: node.fileset, xpr: target.path } } : { nodeData: { xpr: target.path } });
        }
        await refresh();
    }
    async function trace(uri) {
        await flow.trace(uri);
        await vscode.commands.executeCommand(VIEW_ID + '.focus');
        await refresh();
    }
    function expand(value) {
        if (view && !disposed) void view.webview.postMessage({type:'expansion',expand:value});
    }
    async function receive(data) {
        if (disposed || !data || typeof data.action !== 'string') {
            return;
        }
        if (data.action === 'ready') {
            if (data.state && typeof data.state === 'object' && JSON.stringify(data.state).length <= 16384) {
                Object.assign(expandedState, data.state);
            }
            await refresh();
            return;
        }
        if (data.revision !== revision) {
            send();
            return;
        }
        if (data.action === 'choose') {
            await choose();
        }
        else if (data.action === 'add') {
            await add();
        }
        else if (data.action === 'refresh') {
            flow.clear('正在刷新工程，旧追踪标记已失效');
            await vivado.projectTree?.refresh();
            await refresh();
        }
        else if (data.action === 'projection' && ['files', 'instances'].includes(data.projection)) {
            projections.set(project?.id, data.projection);
            expandedState[project?.id] = { projection: data.projection };
            await context.workspaceState.update('svtools.project.views', expandedState);
            await refresh();
        }
        else if (data.action === 'pin') {
            flow.setPinned(!flow.get()?.pinned);
        }
        else if (data.action === 'clear') {
            flow.clear();
        }
        else if (data.action === 'command') {
            await execute(data.command, data.nodeId);
        }
        else if (data.action === 'open') {
            const node = nodeIndex.get(data.nodeId);
            if (!node?.file) {
                return;
            }
            if (node.kind === 'folder') {
                return;
            }
            if (node.source && flow.get()) {
                await flow.locate(node.source);
            }
            else {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(node.file));
            }
        }
    }
    const provider = { resolveWebviewView(webviewView) {
            view = webviewView;
            view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'project')] };
            view.webview.html = projectHtml(view.webview, context.extensionUri, vscode);
            context.subscriptions.push(view.webview.onDidReceiveMessage(data => void receive(data).catch(report)));
            void refresh().catch(report);
        } };
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }));
    const register = (id, action) => context.subscriptions.push(vscode.commands.registerCommand('svtools.project.' + id, (...args) => Promise.resolve().then(() => action(...args)).catch(report)));
    register('choose', choose);
    register('create', create);
    register('add', uri => add(uri));
    register('addToProject', uri => add(uri, true));
    register('trace', trace);
    register('refresh', refresh);
    register('expandAll', () => expand(true));
    if (vivado.projectTree?.onDidChangeTreeData) context.subscriptions.push(vivado.projectTree.onDidChangeTreeData(() => void refresh().catch(report)));
    context.subscriptions.push(projects.onDidChange(() => {
        void (async () => {
            const current = await projects.current();
            if (disposed) {
                return;
            }
            flow.projectChanged(current);
            await vivado.refreshProjectContext();
            await refresh();
        })().catch(async error => {
            flow.projectChanged(null);
            await refresh();
            report(error);
        });
    }));
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sv,v,svh,vh,xpr,json}');
    const changed = uri => {
        if (/\.svtools[\\/]projects[\\/][^\\/]+\.json$/i.test(uri.fsPath) || /\.(sv|v|svh|vh|xpr)$/i.test(uri.fsPath) && !/[\\/]\.svtools[\\/]/.test(uri.fsPath)) {
            clearTimeout(timer);
            timer = setTimeout(() => projects.invalidate(), 250);
        }
    };
    context.subscriptions.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
    if (vscode.window.onDidChangeTextEditorSelection) {
        context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
            clearTimeout(selectionTimer);
            flow.cancelFollow();
            if (traceTrigger() === 'selection') {
                const editor = { document: event.textEditor.document, selection: event.textEditor.selection };
                selectionTimer = setTimeout(() => void Promise.resolve(flow.follow(editor)).catch(report), 300);
            }
        }));
    }
    if (vscode.workspace.onDidChangeConfiguration) {
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('svtools.project.traceTrigger')) {
                clearTimeout(selectionTimer);
                flow.cancelFollow();
                send();
            }
        }));
    }
    const dispose = () => {
        disposed = true;
        refreshGeneration++;
        clearTimeout(timer);
        clearTimeout(selectionTimer);
        flow.dispose();
    };
    context.subscriptions.push({ dispose });
    return { refresh, trace, dispose, setPinned:flow.setPinned, getSnapshot: () => ({ project, nodes, revision, flow: flow.get() }) };
}
module.exports = { activateProjectView };
