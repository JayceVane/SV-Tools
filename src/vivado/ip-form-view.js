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
// IP 定制对话框：按 XGUI 的页面/分组呈现参数，控件由参数类型与 -widget 决定。

const { randomBytes } = require('node:crypto');
const { buildForm } = require('./ip-form');

function html(webview, vscode, resources) {
    const nonce = randomBytes(24).toString('base64');
    const uri = file => webview.asWebviewUri(vscode.Uri.joinPath(resources, file));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
    <link rel="stylesheet" href="${uri('ip-form.css')}"></head><body>
    <header class="titlebar">
        <div class="title"><h1 id="name">IP 定制</h1><p id="subtitle"></p></div>
        <div class="tools"><span id="changed" class="changed"></span><button id="revert">撤销修改</button></div>
    </header>
    <main>
        <nav class="tree" aria-label="参数页面">
            <label for="search">搜索参数</label>
            <input id="search" type="search" placeholder="名称、说明或当前值">
            <div id="pages"></div>
        </nav>
        <section id="form" class="form" aria-label="IP 参数"></section>
    </main>
    <footer>
        <p id="status" role="status" aria-live="polite"></p>
        <div class="tools"><button id="close">关闭</button><button id="apply" class="primary">应用</button></div>
    </footer>
    <script nonce="${nonce}" src="${uri('ip-form-client.js')}"></script></body></html>`;
}

function openIpFormPanels(context, vscode, { load, apply, evaluate }) {
    const panels = new Set();
    context.subscriptions.push({ dispose() { for (const entry of panels) entry.panel.dispose(); } });
    return function open({ key, title = 'IP 定制', subtitle = '' }) {
        const existing = [...panels].find(entry => entry.key === key);
        if (existing) { existing.panel.reveal(); void existing.reload(); return; }
        const resources = vscode.Uri.joinPath(context.extensionUri, 'src', 'vivado');
        const panel = vscode.window.createWebviewPanel('svtoolsIpForm', title, vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
        let revision = 0, busy = false, closed = false, ready = false, info = null, status = '';
        let pendingEvaluation = null, evaluating = false;
        const entry = { key, panel, reload };
        // 连续修改只保留最后一次待求值，避免逐键回问 Vivado。
        async function runEvaluations() {
            if (evaluating || !evaluate) return;
            evaluating = true;
            try {
                while (pendingEvaluation) {
                    const { seq, values } = pendingEvaluation;
                    pendingEvaluation = null;
                    try {
                        const result = await evaluate(key, values);
                        if (closed || result?.error) continue;
                        post({ type: 'state', seq, disabled: result.disabled || [],
                            hidden: result.hidden || { pages: [], groups: [], params: [] } });
                    } catch { /* 单次求值失败时保留上一次状态 */ }
                }
            } finally { evaluating = false; }
        }
        const post = message => { if (ready && !closed) void panel.webview.postMessage(message); };
        const publish = () => post({ type: 'form', revision: ++revision, info,
            form: info ? buildForm(info.parameters, info.notes) : null, busy, status });
        async function reload() {
            if (busy || closed) return;
            busy = true; status = '正在读取 Vivado 参数…'; publish();
            try {
                const next = await load(key);
                if (closed) return;
                if (!next || next.error) throw new Error(next?.error || '参数读取失败');
                info = next; status = '';
            } catch (error) { status = error.message; }
            finally { busy = false; publish(); }
        }
        panel.webview.onDidReceiveMessage(async message => {
            if (closed || !message) return;
            if (message.action === 'evaluate' && evaluate) {
                pendingEvaluation = { seq: message.seq || 0, values: message.values || [] };
                void runEvaluations();
                return;
            }
            if (busy) return;
            if (message.action === 'ready') { ready = true; await reload(); return; }
            if (message.action === 'refresh') { await reload(); return; }
            if (message.action === 'close') { panel.dispose(); return; }
            if (message.action === 'apply') {
                busy = true; status = 'Vivado 正在应用参数…'; publish();
                try {
                    const result = await apply(key, message.edits);
                    if (result?.error) status = result.error;
                    else { info = result?.info || info; status = result?.message || '参数已应用'; post({ type: 'applied' }); }
                } catch (error) { status = error.message; }
                finally { busy = false; publish(); }
            }
        });
        panel.onDidDispose(() => { closed = true; panels.delete(entry); });
        panels.add(entry);
        panel.webview.html = html(panel.webview, vscode, resources);
        return entry;
    };
}

module.exports = { openIpFormPanels };
