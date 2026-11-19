'use strict';

const { randomBytes } = require('node:crypto');
const { resolveContext, buildArchitectureBook, assertBookCurrent } = require('./architecture-model');
const { layoutDiagram, renderDiagram } = require('./architecture-diagram');
const { exportArchitecture } = require('./architecture-export');

function panelHtml(webview, vscode, root) {
    const uri = name => webview.asWebviewUri(vscode.Uri.joinPath(root, name));
    const nonce = randomBytes(24).toString('base64');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <title>架构查看器</title><link rel="stylesheet" href="${uri('architecture.css')}"></head>
    <body class="architecture-view"><header class="viewer-header"><div><h1>架构查看器</h1><p id="snapshot" class="subtle"></p></div>
    <div class="tools"><button id="refresh" type="button">重新读取</button><button id="export-html" type="button" disabled>导出 HTML</button><button id="export-pdf" type="button" disabled>导出 PDF</button></div></header>
    <p id="status" class="status" role="status" aria-live="polite">正在读取工程…</p>
    <main id="viewer" hidden><nav class="breadcrumbs" id="breadcrumbs" aria-label="当前层级"></nav>
    <div class="workspace"><nav id="chapters" class="chapters" aria-label="模块章节"></nav>
    <div class="work-area"><section id="graph-content" aria-labelledby="page-title">
        <header class="page-header"><div><h2 id="page-title"></h2><p id="page-meta" class="subtle"></p></div>
            <div class="tools" aria-label="架构图模式"><button id="overview" type="button" aria-pressed="false">简图</button><button id="detailed" type="button" aria-pressed="false">完整连线</button><button id="fit" type="button" aria-pressed="true">适应宽度</button></div></header>
        <div id="graph-legend" class="legend" hidden><span><i class="forward"></i>上游</span><span><i class="reverse"></i>下游</span><span><i class="neutral"></i>共享 / 方向待确认</span><span>点击实例或连线查看详情</span></div>
        <div class="diagram-scroll fitted" id="graph" tabindex="0" aria-label="架构连线图"></div><div id="labels"></div>
        <section id="inspector" class="inspector" aria-label="模块和连接详情"></section>
        <div id="page-checks"></div>
    </section><section id="interface-view" class="connection-view" aria-labelledby="connection-title" hidden>
        <button id="back" type="button">返回架构图</button><h2 id="connection-title" tabindex="-1"></h2><div id="connection-body"></div>
    </section></div></div></main>
    <script nonce="${nonce}" src="${uri('architecture-details.js')}"></script><script nonce="${nonce}" src="${uri('architecture-client.js')}"></script></body></html>`;
}

function activateArchitectureViewer(context, { vscode, projects }) {
    const panels = new Map();
    const resources = vscode.Uri.joinPath(context.extensionUri, 'src', 'design');

    async function chooseInput() {
        const project = await projects.current();
        if (project) return { workspace: project.root, project: project.path };
        const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
        const active = vscode.window.activeTextEditor?.document.uri;
        const folder = active?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(active);
        if (folder || folders.length === 1) return { workspace: (folder || folders[0]).uri.fsPath };
        if (folders.length > 1) {
            const chosen = await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择要查看的架构工作区' });
            return chosen && { workspace: chosen.uri.fsPath };
        }
        vscode.window.showInformationMessage('请先打开包含设计源码的工程目录。');
    }

    async function chooseSnapshot(input) {
        let snapshot;
        while (!snapshot) {
            try { snapshot = await resolveContext(input); }
            catch (error) {
                const project = error.code === 'AMBIGUOUS_PROJECT';
                if (!project && error.code !== 'AMBIGUOUS_FILESET') throw error;
                const choices = error.details.candidates.filter(item => project || item.type === 'DesignSrcs').map(item => project
                    ? { label: item.path, value: item.path } : { label: item.name, description: item.top || '', value: item.name });
                if (!choices.length) throw error;
                const chosen = await vscode.window.showQuickPick(choices, { placeHolder: project ? '选择架构工程' : '选择设计文件集' });
                if (!chosen) return;
                input = { ...input, [project ? 'project' : 'fileset']: chosen.value };
            }
        }
        if (snapshot.context.top) return { snapshot, input };
        const modules = [...new Set(snapshot.context.units.filter(unit => unit.kind === 'module').map(unit => unit.name))];
        if (!modules.length) throw new Error('当前文件集没有可用的模块声明。');
        const top = modules.length === 1 ? modules[0] : await vscode.window.showQuickPick(modules, { placeHolder: '选择架构顶层模块' });
        if (!top) return;
        input = { ...input, top };
        return { snapshot: await resolveContext(input), input };
    }

    async function open() {
        const workspace = await chooseInput();
        if (!workspace) return;
        const chosen = await chooseSnapshot(workspace);
        if (!chosen) return;
        const { snapshot: initial, input } = chosen;
        const key = JSON.stringify([initial.context.id, initial.context.top]);
        const previous = panels.get(key);
        if (previous) { previous.reveal(); return; }
        const panel = vscode.window.createWebviewPanel('svtoolsArchitectureViewer', '架构 · ' + initial.context.top, vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
        panels.set(key, panel);
        let current, initialSnapshot = initial, generation = 0, closed = false, exporting = false;
        const layouts = new Map();
        panel.onDidDispose(() => { closed = true; panels.delete(key); layouts.clear(); });
        const post = message => !closed && panel.webview.postMessage(message);
        async function refresh() {
            const version = ++generation;
            current = undefined;
            layouts.clear();
            await post({ type: 'loading' });
            try {
                const snapshot = initialSnapshot || await resolveContext({ ...input, top: initial.context.top });
                initialSnapshot = undefined;
                const loaded = await buildArchitectureBook(snapshot);
                if (!closed && version === generation) {
                    current = loaded;
                    await post({ type: 'book', book: loaded.book });
                }
            } catch (error) {
                if (version === generation) await post({ type: 'error', message: error.message });
            }
        }
        panel.webview.onDidReceiveMessage(async message => {
            if (message?.type === 'refresh' || message?.type === 'ready') {
                if (message.type === 'ready' && current) return post({ type: 'book', book: current.book });
                return refresh();
            }
            const loaded = current;
            if (!loaded || message?.revision !== loaded.book.revision) return;
            try {
                if (message.type === 'layout') {
                    const page = loaded.book.pages.find(item => item.id === message.page);
                    if (!page || !['overview', 'detailed'].includes(message.mode) || !Number.isSafeInteger(message.request)) return;
                    const key = page.id + ':' + message.mode;
                    if (!layouts.has(key)) layouts.set(key, layoutDiagram(page, message.mode));
                    let diagram;
                    try { diagram = await layouts.get(key); }
                    catch (error) { layouts.delete(key); throw error; }
                    if (loaded !== current) return;
                    await post({ type: 'layout', request: message.request, revision: loaded.book.revision, page: page.id,
                        html: renderDiagram(diagram, page, true), edges: diagram.edges.map(edge => ({ id: edge.id, links: edge.links, from: edge.from, to: edge.to })),
                        cards: diagram.cards.map(card => ({ id: card.id, nodes: card.nodes.map(node => node.id), link: card.link })) });
                } else if (message.type === 'source') {
                    const site = loaded.sourceLocations.get(message.source);
                    if (!site) return;
                    await assertBookCurrent(loaded);
                    if (loaded !== current || closed) return;
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(site.path));
                    const captured = loaded.snapshot.contents.get(site.path).text;
                    if (doc.getText().replace(/^\uFEFF/u, '') !== captured.replace(/^\uFEFF/u, '')) throw new Error('源码与结构快照内容有差异，请保存后重新读取。');
                    const start = new vscode.Position(site.line - 1, site.column - 1);
                    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: new vscode.Range(start, start) });
                } else if (message.type === 'export' && !exporting && ['html', 'pdf'].includes(message.format)) {
                    exporting = true;
                    let file;
                    try {
                        await post({ type: 'exporting', busy: true });
                        file = await exportArchitecture(loaded, message.format);
                    } finally {
                        exporting = false;
                        await post({ type: 'exporting', busy: false });
                    }
                    const openFile = await vscode.window.showInformationMessage('架构章节已导出到 ' + file, '打开文件');
                    if (openFile) await vscode.env.openExternal(vscode.Uri.file(file));
                }
            } catch (error) {
                if (loaded === current) await post({ type: 'error', request: message.request, message: error.message });
            }
        });
        panel.webview.html = panelHtml(panel.webview, vscode, resources);
    }

    context.subscriptions.push(vscode.commands.registerCommand('svtools.design.architecture', async () => {
        try { await open(); }
        catch (error) { vscode.window.showErrorMessage('架构查看器：' + error.message); }
    }), { dispose() { for (const panel of panels.values()) panel.dispose(); } });
}

module.exports = { activateArchitectureViewer };
