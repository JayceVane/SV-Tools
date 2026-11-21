'use strict';

/**
 * Copyright (c) 2025 JayceVane (JayceVane@163.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Vivado 工程概览面板：轮询读取 run 状态，不启动任何构建任务。

const path = require('node:path');
const { randomBytes } = require('node:crypto');

const POLL_MS = 5000;

function html(webview, vscode, resources) {
    const nonce = randomBytes(24).toString('base64');
    const uri = file => webview.asWebviewUri(vscode.Uri.joinPath(resources, file));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
    <link rel="stylesheet" href="${uri('summary.css')}"></head><body>
    <header class="titlebar">
        <div class="title"><h1 id="project">Vivado 工程概览</h1><p id="meta"></p></div>
        <div class="tools">
            <label class="auto"><input id="auto" type="checkbox" checked> 自动刷新</label>
            <button id="refresh">刷新</button>
            <button id="folder">工程目录</button>
        </div>
    </header>
    <main>
        <section id="cards" class="cards" aria-label="综合与实现状态"></section>
        <section class="panel"><h2>运行</h2>
            <table class="runs"><thead><tr><th>Run</th><th>类型</th><th>状态</th><th>进度</th><th>当前步骤</th><th>耗时</th><th>策略</th><th></th></tr></thead>
            <tbody id="runs"></tbody></table>
            <p id="runs-empty" class="muted" hidden>当前工程还没有运行记录。</p>
        </section>
        <section class="panel"><h2>时序与功耗</h2><div id="timing" class="timing"></div></section>
        <section class="panel"><h2>消息</h2><div id="messages" class="messages"></div></section>
    </main>
    <p id="status" role="status" aria-live="polite"></p>
    <script nonce="${nonce}" src="${uri('summary-client.js')}"></script></body></html>`;
}

function openSummaryPanels(context, vscode, { load, openPath, log = () => {} }) {
    let entry = null;
    return {
        open(xpr) {
            if (entry) { entry.panel.reveal(); entry.refresh(); return; }
            const resources = vscode.Uri.joinPath(context.extensionUri, 'src', 'vivado');
            const panel = vscode.window.createWebviewPanel('svtoolsVivadoSummary', 'Vivado · 工程概览', vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
            let closed = false, ready = false, auto = true, loading = false, timer = null;
            const post = message => { if (!closed && ready) void panel.webview.postMessage(message); };
            const schedule = () => {
                clearTimeout(timer);
                if (!auto || closed || !panel.visible) return;
                timer = setTimeout(() => { void refresh(); }, POLL_MS);
            };
            async function refresh() {
                clearTimeout(timer);
                if (closed || loading) return schedule();
                loading = true;
                try {
                    const data = await load(xpr);
                    if (closed) return;
                    if (data?.error) post({ type: 'error', message: data.error });
                    else if (data?.busy) post({ type: 'error', message: 'Vivado 正在执行其他任务，已在完成后继续刷新。', busy: true });
                    else if (data) post({ type: 'summary', data, at: Date.now() });
                } catch (error) {
                    if (!closed) post({ type: 'error', message: error.message });
                } finally {
                    loading = false;
                    schedule();
                }
            }
            panel.webview.onDidReceiveMessage(message => {
                if (closed || !message) return;
                if (message.action === 'ready') { ready = true; void refresh(); return; }
                if (message.action === 'refresh') { void refresh(); return; }
                if (message.action === 'auto') { auto = message.enabled !== false; schedule(); return; }
                if (message.action === 'openLog' && typeof message.path === 'string') { void openPath(message.path); return; }
                if (message.action === 'openFolder') { void openPath(path.dirname(xpr)); }
            });
            panel.onDidChangeViewState(() => { if (panel.visible) void refresh(); else clearTimeout(timer); });
            panel.onDidDispose(() => { closed = true; clearTimeout(timer); entry = null; });
            panel.webview.html = html(panel.webview, vscode, resources);
            entry = { panel, refresh };
            log('[vivado] 打开工程概览：' + xpr);
        }
    };
}

module.exports = { openSummaryPanels, POLL_MS };
