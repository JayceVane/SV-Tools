'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { samePath } = require('./xpr');

function catalogHtml(webview, vscode, resources, labels = {}) {
    const nonce = randomBytes(24).toString('base64');
    const uri = file => webview.asWebviewUri(vscode.Uri.joinPath(resources, file));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
    <link rel="stylesheet" href="${uri('ip-view.css')}"><link rel="stylesheet" href="${uri('ip-catalog.css')}"></head><body>
    <header class="page-header"><div><h1>${labels.title || 'IP Catalog'}</h1><p id="catalog-project" class="muted"></p></div>
    <button id="catalog-refresh">刷新目录</button></header>
    <main class="catalog"><section class="catalog-browser" aria-label="浏览 IP"><div class="catalog-filters">
    <input type="search" id="catalog-search" aria-label="搜索 IP" placeholder="搜索 IP 名称、描述或 VLNV">
    <select id="catalog-category" aria-label="IP 分类"><option value="">全部分类</option></select>
    <select id="catalog-vendor" aria-label="IP 厂商"><option value="">全部厂商</option></select></div>
    <p id="catalog-count" class="muted"></p><div id="catalog-items" class="member-list"></div>
    <nav class="toolbar" aria-label="目录分页"><button id="catalog-prev">上一页</button><span id="catalog-page"></span><button id="catalog-next">下一页</button></nav></section>
    <section class="editor catalog-details" aria-label="IP 详细信息"><h2 id="catalog-name">选择一个 IP</h2><p id="catalog-vlnv" class="muted"></p>
    <p id="catalog-description"></p><p id="catalog-taxonomy" class="muted"></p>
    <button id="catalog-create" class="primary" disabled>${labels.action || '创建 IP'}</button></section></main>
    <footer><p id="catalog-status" role="status" aria-live="polite">正在读取 Vivado IP 目录…</p></footer>
    <script nonce="${nonce}" src="${uri('ip-catalog-client.js')}"></script></body></html>`;
}

function openCatalogPanels(context, vscode, { cached, refresh, create, title = 'IP Catalog', action = '创建 IP', windowTitle }) {
    const panels = new Set();
    context.subscriptions.push({ dispose() { for (const item of panels) item.panel.dispose(); } });
    return function open(xpr) {
        const existing = [...panels].find(item => samePath(item.xpr, xpr));
        if (existing) { existing.panel.reveal(); return; }
        const panel = vscode.window.createWebviewPanel('svtoolsIpCatalog', (windowTitle || title) + ' · ' + path.basename(xpr, '.xpr'), vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'vivado')] });
        const entry = { xpr, panel };
        panels.add(entry);
        let data, busy = false, closed = false, status = '';
        const publish = () => { if (!closed) void panel.webview.postMessage({ type: 'catalog', data, xpr, busy, status }); };
        async function load(force) {
            if (busy) return;
            busy = true;
            status = '正在读取 Vivado IP 目录…';
            publish();
            try {
                data = await cached(xpr);
                publish();
                if (force || !data || data.expires <= Date.now()) data = await refresh(xpr, () => !closed);
                status = data.items.length ? '' : '当前工程没有可见的 IP 定义。';
            } catch (error) { status = error.message; }
            finally { busy = false; publish(); }
        }
        panel.onDidDispose(() => { closed = true; panels.delete(entry); });
        panel.webview.onDidReceiveMessage(async message => {
            if (closed || !message || busy) return;
            if (message.action === 'ready' || message.action === 'refresh') await load(message.action === 'refresh');
            else if (message.action === 'create') {
                const item = data?.items.find(row => row.value === message.vlnv);
                if (!item) return;
                busy = true;
                status = '正在创建 IP…';
                publish();
                try { status = await create(xpr, item.value) || ''; }
                catch (error) { status = error.message; }
                finally { busy = false; publish(); }
            }
        });
        panel.webview.html = catalogHtml(panel.webview, vscode, vscode.Uri.joinPath(context.extensionUri, 'src', 'vivado'), { title, action });
    };
}

module.exports = { openCatalogPanels };
