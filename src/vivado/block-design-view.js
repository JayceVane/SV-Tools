'use strict';

const { randomBytes } = require('node:crypto');
const { samePath } = require('./xpr');

function html(webview, vscode, resources) {
    const nonce = randomBytes(24).toString('base64');
    const uri = file => webview.asWebviewUri(vscode.Uri.joinPath(resources, file));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
    <link rel="stylesheet" href="${uri('block-design.css')}"></head><body>
    <header><h1 id="name">Block Design</h1><p id="path"></p>
    <div id="tools" class="tools" aria-label="设计操作">
        <button data-action="refresh">刷新</button><button data-action="validate">校验并更新</button><button data-action="assign">自动分配地址</button>
        <button data-action="generate">生成产物</button><button data-action="wrapper">生成并加入 HDL Wrapper</button><button data-action="export">导出 Tcl</button>
        <button data-action="remove-design">移出工程</button>
    </div></header>
    <p id="status" role="status" aria-live="polite"></p>
    <main id="main" hidden>
        <div class="layout">
            <section aria-labelledby="blocks-title">
                <div class="section-header"><h2 id="blocks-title">模块与端口</h2><label>层级 <select id="level"></select></label></div>
                <button id="add-cell" data-action="add-cell">添加模块</button>
                <button data-action="add-port">添加顶层端口</button>
                <div id="blocks" class="blocks"></div>
            </section>
            <aside aria-label="连接和选中对象">
                <div id="selection"></div>
                <h2>连接</h2><ul id="nets" class="list"></ul>
            </aside>
        </div>
        <details id="address-section" hidden><summary>地址映射</summary>
            <table><thead><tr><th>主地址空间</th><th>段</th><th>起始地址</th><th>范围</th></tr></thead><tbody id="addresses"></tbody></table>
        </details>
    </main>
    <script nonce="${nonce}" src="${uri('block-design-client.js')}"></script></body></html>`;
}

const general = new Set(['refresh', 'add-port', 'assign', 'validate', 'generate', 'wrapper', 'export', 'remove-design']);
function resolveSelection(model, message) {
    const itemAt = (list, index) => Number.isInteger(index) ? list[index] : undefined;
    const cell = itemAt(model.cells, message.cell);
    const endpoint = itemAt(model.endpoints, message.endpoint);
    const net = itemAt(model.nets, message.net);
    const level = itemAt(model.cells, message.level);
    // Webview 只传索引，宿主从当前工程快照取得 Vivado 对象名。
    if (general.has(message.action)) return {};
    if (message.action === 'add-cell') return message.cell === undefined ? {} : cell?.type === 'hier' && { cell };
    if (message.action === 'config' && cell && cell.type !== 'hier') return { cell };
    if (message.action === 'config-port' && endpoint?.kind.endsWith('port')) return { endpoint };
    if (message.action === 'remove') {
        if (cell) return { cell };
        if (net) return { net };
        if (endpoint?.kind.endsWith('port')) return { endpoint };
    }
    if (message.action === 'externalize' && endpoint?.kind.endsWith('pin') && endpoint.cell.lastIndexOf('/') === 0)
        return { endpoint };
    if (endpoint && ['connect', 'disconnect'].includes(message.action)) {
        const parent = id => id.slice(0, id.lastIndexOf('/'));
        const current = net ? parent(net.id) : level?.id || '';
        const netContainsEndpoint = net?.endpoints.includes(endpoint.id) && endpoint.kind.startsWith('interface_') === net.kind.startsWith('interface_');
        if (message.action === 'disconnect') return netContainsEndpoint && { endpoint, net };
        if (net && !netContainsEndpoint || message.net !== undefined && !net || message.level !== undefined && level?.type !== 'hier') return;
        if (endpoint.cell === current || endpoint.cell && parent(endpoint.cell) === current) return { endpoint, net, level: current };
    }
}

function openBlockDesignPanels(context, vscode, invoke) {
    const panels = new Set();
    context.subscriptions.push({ dispose() { for (const entry of panels) entry.panel.dispose(); } });
    function open(target, state) {
        const existing = [...panels].find(entry => samePath(entry.target.xpr, target.xpr) && samePath(entry.target.file, target.file));
        if (existing) {
            existing.replace(state);
            existing.panel.reveal();
            return;
        }
        const resources = vscode.Uri.joinPath(context.extensionUri, 'src', 'vivado');
        const panel = vscode.window.createWebviewPanel('svtoolsBlockDesign', 'BD · ' + state.model.name, vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
        let revision = 0, busy = false, closed = false;
        const post = message => { if (!closed) void panel.webview.postMessage(message); };
        const replace = (next, message) => {
            state = next;
            post({ type: 'snapshot', revision: ++revision, model: state.model, file: target.file, message });
        };
        const entry = { panel, target, replace };
        panels.add(entry);
        panel.onDidDispose(() => { closed = true; panels.delete(entry); });
        panel.webview.onDidReceiveMessage(async message => {
            if (closed || !message) return;
            if (message.action === 'ready') {
                replace(state);
                return;
            }
            if (busy || message.revision !== revision) return;
            const selection = resolveSelection(state.model, message);
            if (!selection) return;
            busy = true;
            post({ type: 'busy', busy: true });
            try {
                const result = await invoke(target, state, message.action, selection);
                if (result?.close) panel.dispose();
                else if (result?.model) replace(result, result.message || (message.action === 'refresh' ? undefined : 'Vivado 已保存操作结果'));
                else if (result?.message || result?.error) post({ type: 'status', message: result.message || result.error });
            } catch (error) {
                post({ type: 'status', message: error.message });
            } finally {
                busy = false;
                post({ type: 'busy', busy: false });
            }
        });
        panel.webview.html = html(panel.webview, vscode, resources);
    }
    return { open };
}

module.exports = { openBlockDesignPanels, resolveSelection };
