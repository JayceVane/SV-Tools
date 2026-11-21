'use strict';

const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { samePath } = require('./xpr');
const { layoutSchematic, parentOf, isInterface } = require('./block-design-layout');

function html(webview, vscode, resources) {
    const nonce = randomBytes(24).toString('base64');
    const uri = file => webview.asWebviewUri(vscode.Uri.joinPath(resources, file));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
    <link rel="stylesheet" href="${uri('block-design.css')}"></head><body>
    <header class="titlebar">
        <div class="title"><h1 id="name">Block Design</h1><p id="path"></p></div>
        <div id="tools" class="tools" aria-label="设计操作">
            <button data-action="refresh">刷新</button><button data-action="validate">校验并更新</button>
            <button data-action="assign">自动分配地址</button><button data-action="generate">生成产物</button>
            <details class="more"><summary>更多操作</summary><div class="tools">
                <button data-action="wrapper">生成并加入 HDL Wrapper</button><button data-action="export">导出 Tcl</button>
                <button data-action="remove-design">移出工程</button>
            </div></details>
        </div>
    </header>
    <main id="main" hidden>
        <section class="schematic" aria-labelledby="blocks-title">
            <div class="canvas-tools" aria-label="原理图操作">
                <div class="tools"><h2 id="blocks-title">原理图</h2><button id="level-up" title="返回上一级" aria-label="返回上一级">↑</button>
                    <select id="level" aria-label="设计层级"></select></div>
                <div class="tools zoom-tools" aria-label="视图缩放">
                    <button id="zoom-out" title="缩小" aria-label="缩小">−</button><button id="zoom-reset" title="重置到 100%">100%</button>
                    <button id="zoom-in" title="放大" aria-label="放大">+</button><button id="zoom-fit">适合窗口</button>
                </div>
                <div class="tools">
                    <button id="add-cell" data-action="add-cell">添加模块</button>
                    <button data-action="add-port">添加顶层端口</button>
                    <button id="wire-mode" aria-pressed="false" title="依次选择两个同类端点">连线</button>
                    <button id="interface-members" aria-pressed="false" title="展开或收起接口的成员信号">接口信号</button>
                    <button id="inspector-toggle" aria-expanded="true" aria-controls="inspector">检查器</button>
                </div>
            </div>
            <div id="canvas" class="canvas" tabindex="0" aria-label="Block Design 画布，拖动空白处平移，按 Ctrl 或 Command 并滚轮缩放">
                <div id="drawing" class="drawing"></div>
                <p id="canvas-message" class="canvas-message" hidden></p>
            </div>
            <div class="canvas-footer"><span><i class="legend-interface"></i> 接口</span><span><i class="legend-bus"></i> 总线</span><span><i></i> 信号</span><span id="wire-hint"></span><span id="counts"></span></div>
        </section>
        <aside id="inspector" aria-label="原理图检查器">
            <div id="selection"></div>
            <div class="tools object-tabs" role="group" aria-label="对象分类">
                <button id="show-nets" aria-pressed="true">连接</button><button id="show-objects" aria-pressed="false">模块与端口</button>
            </div>
            <input id="filter" type="search" aria-label="筛选连接或对象" placeholder="筛选…">
            <ul id="objects" class="list"></ul>
            <details id="address-section" hidden><summary>地址映射</summary>
                <table><thead><tr><th>主地址空间</th><th>段</th><th>起始地址</th><th>范围</th></tr></thead><tbody id="addresses"></tbody></table>
            </details>
        </aside>
    </main>
    <p id="status" role="status" aria-live="polite"></p>
    <script nonce="${nonce}" src="${uri('block-design-canvas.js')}"></script>
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
        const current = net ? parentOf(net.id) : level?.id || '';
        const netContainsEndpoint = net?.endpoints.includes(endpoint.id) && isInterface(endpoint) === isInterface(net);
        if (message.action === 'disconnect') return netContainsEndpoint && { endpoint, net };
        if (net && !netContainsEndpoint || message.net !== undefined && !net || message.level !== undefined && level?.type !== 'hier') return;
        const inLevel = item => item.cell === current || item.cell && parentOf(item.cell) === current;
        if (!inLevel(endpoint)) return;
        const destination = itemAt(model.endpoints, message.destination);
        if (message.destination !== undefined && (!destination || destination.id === endpoint.id ||
            isInterface(destination) !== isInterface(endpoint) || !inLevel(destination))) return;
        return { endpoint, net, level: current, destination };
    }
}

function openBlockDesignPanels(context, vscode, invoke) {
    const panels = new Set();
    context.subscriptions.push({ dispose() { for (const entry of panels) entry.panel.dispose(); } });
    function open(target, state) {
        const existing = [...panels].find(entry => samePath(entry.target.xpr, target.xpr) && samePath(entry.target.file, target.file));
        if (existing) {
            existing.panel.reveal();
            if (state?.model) existing.replace(state);
            else void existing.reload(false);
            return;
        }
        const resources = vscode.Uri.joinPath(context.extensionUri, 'src', 'vivado');
        const panel = vscode.window.createWebviewPanel('svtoolsBlockDesign', 'BD · ' + (state?.model.name || path.basename(target.file, '.bd')), vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
        let revision = 0, busy = false, closed = false, ready = false;
        const layouts = new Map();
        const post = message => { if (!closed && ready) void panel.webview.postMessage(message); };
        const replace = (next, message) => {
            state = next;
            layouts.clear();
            post({ type: 'snapshot', revision: ++revision, model: state.model, preview: state.preview === true, file: target.file, message });
        };
        async function reload(force) {
            if (busy || closed || !ready) return;
            busy = true;
            post({ type: 'busy', busy: true });
            try {
                const first = !force && await invoke(target, state, 'preview');
                if (first?.model && first !== state) replace(first, first.preview ? '已保存的结构预览 · 正在由 Vivado 核对' : undefined);
                if (force || !first?.model || first.preview) {
                    const next = await invoke(target, state, 'refresh', {}, () => !closed);
                    if (!next?.model) throw new Error(next?.error || 'Vivado 读取已取消');
                    replace(next);
                }
            } catch (error) {
                post({ type: 'status', message: (state?.preview ? '已保存的结构预览 · ' : '') + error.message });
            } finally {
                busy = false;
                post({ type: 'busy', busy: false });
            }
        }
        const entry = { panel, target, replace, reload };
        panels.add(entry);
        panel.onDidDispose(() => { closed = true; panels.delete(entry); });
        panel.webview.onDidReceiveMessage(async message => {
            if (closed || !message) return;
            if (message.action === 'ready') {
                ready = true;
                if (state?.model) replace(state);
                else await reload(false);
                return;
            }
            if (message.action === 'refresh') { await reload(true); return; }
            if (message.action === 'layout' && state?.model && message.revision === revision) {
                const { level, request, expandedInterfaces } = message;
                if (!Number.isSafeInteger(request) || level !== '' && !state.model.cells.some(cell => cell.type === 'hier' && cell.id === level)) return;
                const version = revision;
                const result = { revision: version, level, request };
                const key = level + '\0' + (expandedInterfaces === true);
                try {
                    if (!layouts.has(key)) {
                        if (layouts.size >= 8) layouts.delete(layouts.keys().next().value);
                        layouts.set(key, layoutSchematic(state.model, level, { expandedInterfaces: expandedInterfaces === true }));
                    }
                    const layout = await layouts.get(key);
                    if (version === revision) post({ type: 'layout', ...result, layout });
                } catch (error) {
                    if (version === revision) {
                        layouts.delete(key);
                        post({ type: 'layout', ...result, error: error.message });
                    }
                }
                return;
            }
            if (busy || !state?.model || state.preview || message.revision !== revision) return;
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
