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
const { samePath } = require('./xpr');

const POLL_MS = 5000;

function html(webview, vscode, resources) {
    const nonce = randomBytes(24).toString('base64');
    const uri = file => webview.asWebviewUri(vscode.Uri.joinPath(resources, file));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
    <link rel="stylesheet" href="${uri('summary.css')}"></head><body>
    <div class="layout">
    <header class="titlebar">
        <div class="title"><h1 id="project">工程概览</h1><p id="directory" class="directory" hidden></p></div>
        <div class="tools">
            <label class="auto"><input id="auto" type="checkbox" checked> 自动刷新</label>
            <button id="refresh">刷新</button>
            <button id="folder">工程目录</button>
        </div>
    </header>
    <div class="snapshot-status"><p id="status" role="status" aria-live="polite">正在读取工程状态…</p><p id="updated"></p></div>
    <main id="content" hidden>
        <dl id="meta" class="facts" aria-label="工程信息"></dl>
        <section id="cards" class="cards" aria-label="当前综合与布局布线"></section>
        <div class="insights">
            <section class="surface" aria-labelledby="timing-title">
                <header class="section-heading"><h2 id="timing-title">时序与功耗</h2><p id="timing-source" class="muted"></p></header>
                <div id="timing" class="timing"></div>
            </section>
            <section class="surface" aria-labelledby="messages-title">
                <h2 id="messages-title">会话消息</h2><dl id="messages" class="messages"></dl>
            </section>
        </div>
        <section class="surface run-section" aria-labelledby="runs-title">
            <header class="section-heading"><h2 id="runs-title">运行记录</h2><p id="run-count" class="muted"></p></header>
            <table id="run-table" class="runs"><thead><tr><th scope="col">运行</th><th scope="col">状态</th><th scope="col">进度 / 耗时</th><th scope="col">产物</th></tr></thead><tbody id="runs"></tbody></table>
            <p id="runs-empty" class="empty" hidden>当前工程还没有运行记录。</p>
        </section>
    </main>
    </div>
    <script nonce="${nonce}" src="${uri('summary-client.js')}"></script></body></html>`;
}

function openSummaryPanels(context, vscode, { load, openPath, log = () => {} }) {
    let entry = null, currentXpr = null;
    return {
        open(xpr) {
            if (entry) {
                entry.select(xpr);
                entry.panel.reveal();
                return;
            }
            currentXpr = xpr;
            const resources = vscode.Uri.joinPath(context.extensionUri, 'src', 'vivado');
            const panel = vscode.window.createWebviewPanel('svtoolsVivadoSummary', 'Vivado · 工程概览', vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
            let closed = false, ready = false, auto = true, loading = false, timer = null, latest = null;
            const post = message => { if (!closed && ready) void panel.webview.postMessage(message); };
            const schedule = () => {
                clearTimeout(timer);
                if (!auto || closed || !panel.visible) return;
                timer = setTimeout(() => { void refresh(); }, POLL_MS);
            };
            async function refresh(manual = false) {
                clearTimeout(timer);
                if (closed || !ready || loading) return;
                loading = true;
                const selected = currentXpr;
                if (manual) post({ type: 'loading' });
                try {
                    const data = await load(selected);
                    if (closed || selected !== currentXpr) return;
                    if (data?.error) post({ type: 'error', message: data.error });
                    else if (data?.busy) post({ type: 'error', message: 'Vivado 正在执行其他任务。', busy: true });
                    else if (data) {
                        latest = data;
                        post({ type: 'summary', data, at: Date.now() });
                    }
                } catch (error) {
                    if (!closed && selected === currentXpr) post({ type: 'error', message: error.message });
                } finally {
                    loading = false;
                    if (!closed && selected !== currentXpr) void refresh();
                    else schedule();
                }
            }
            panel.webview.onDidReceiveMessage(message => {
                if (closed || !message) return;
                if (message.action === 'ready') { ready = true; auto = message.auto !== false; void refresh(); return; }
                if (message.action === 'refresh') { void refresh(true); return; }
                if (message.action === 'auto') { auto = message.enabled !== false; schedule(); return; }
                if (message.action === 'openFolder') { void openPath(path.dirname(currentXpr)); return; }
                if (message.action === 'openRun' && ['log', 'directory'].includes(message.kind) &&
                    typeof message.run === 'string' && latest?.paths && Object.hasOwn(latest.paths, message.run)) {
                    const file = latest.paths[message.run][message.kind];
                    if (file) void openPath(file);
                }
            });
            panel.onDidChangeViewState(() => { if (panel.visible && auto) void refresh(); else clearTimeout(timer); });
            panel.onDidDispose(() => { closed = true; clearTimeout(timer); entry = null; });
            panel.webview.html = html(panel.webview, vscode, resources);
            entry = { panel, select(next) {
                if (!samePath(next, currentXpr)) {
                    currentXpr = next;
                    latest = null;
                    post({ type: 'reset' });
                }
                void refresh();
            } };
            log('[vivado] 打开工程概览：' + currentXpr);
        }
    };
}

module.exports = { openSummaryPanels, POLL_MS };
