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
const { summaryStrings } = require('./summary-strings');

const POLL_MS = 5000;

function html(webview, vscode, resources, strings) {
    const nonce = randomBytes(24).toString('base64');
    const uri = file => webview.asWebviewUri(vscode.Uri.joinPath(resources, file));
    return `<!doctype html><html lang="${strings.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
    <link rel="stylesheet" href="${uri('summary.css')}"></head><body>
    <div class="layout">
    <header class="titlebar">
        <div class="title"><h1 id="project">${strings.title}</h1><p id="directory" class="directory" hidden></p></div>
        <div class="tools">
            <label class="auto"><input id="auto" type="checkbox" checked> ${strings.auto}</label>
            <button id="refresh">${strings.refresh}</button>
            <button id="folder">${strings.folder}</button>
        </div>
    </header>
    <div class="snapshot-status"><p id="status" role="status" aria-live="polite">${strings.loading}</p><p id="updated"></p></div>
    <main id="content" hidden>
        <dl id="meta" class="facts" aria-label="${strings.facts}"></dl>
        <section id="cards" class="cards" aria-label="${strings.stages}"></section>
        <section class="analysis" aria-labelledby="analysis-title">
            <header class="section-heading"><h2 id="analysis-title">${strings.analysis}</h2><button id="generate" hidden>${strings.generate}</button></header>
            <div class="analysis-grid">
                <article class="surface analysis-wide" aria-labelledby="utilization-title">
                    <h3 id="utilization-title">${strings.utilization}</h3><div id="utilization"></div>
                </article>
                <article class="surface analysis-wide" aria-labelledby="timing-title">
                    <h3 id="timing-title">${strings.timing}</h3><div id="timing-source"></div><div id="timing" class="timing"></div>
                </article>
                <article class="surface" aria-labelledby="power-title">
                    <h3 id="power-title">${strings.power}</h3><div id="power"></div>
                </article>
                <article class="surface" aria-labelledby="drc-title">
                    <h3 id="drc-title">${strings.drc}</h3><div id="drc"></div>
                </article>
            </div>
        </section>
        <section class="surface" aria-labelledby="messages-title">
            <h2 id="messages-title">${strings.messages}</h2><dl id="messages" class="messages"></dl>
        </section>
        <section class="surface run-section" aria-labelledby="runs-title">
            <header class="section-heading"><h2 id="runs-title">${strings.runs}</h2><p id="run-count" class="muted"></p></header>
            <table id="run-table" class="runs"><thead><tr><th scope="col">${strings.run}</th><th scope="col">${strings.status}</th><th scope="col">${strings.progressTime}</th><th scope="col">${strings.artifacts}</th></tr></thead><tbody id="runs"></tbody></table>
            <p id="runs-empty" class="empty" hidden>${strings.emptyRuns}</p>
        </section>
    </main>
    </div>
    <script nonce="${nonce}" id="summary-strings" type="application/json">${JSON.stringify(strings)}</script>
    <script nonce="${nonce}" src="${uri('summary-client.js')}"></script></body></html>`;
}

function openSummaryPanels(context, vscode, { load, generate, openPath, log = () => {} }) {
    let entry = null, currentXpr = null;
    const strings = summaryStrings(vscode.env?.language);
    return {
        open(xpr) {
            if (entry) {
                entry.select(xpr);
                entry.panel.reveal();
                return;
            }
            currentXpr = xpr;
            const resources = vscode.Uri.joinPath(context.extensionUri, 'src', 'vivado');
            const panel = vscode.window.createWebviewPanel('svtoolsVivadoSummary', 'Vivado · ' + strings.title, vscode.ViewColumn.Active,
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
                    else if (data?.busy) post({ type: 'error', message: strings.busy, busy: true });
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
            async function generateReports() {
                const request = latest?.analysis?.generation;
                if (closed || loading || !request || !generate) return;
                clearTimeout(timer);
                const selected = currentXpr;
                loading = true;
                post({ type: 'generating' });
                let error;
                try { error = (await generate(selected, request))?.error; }
                catch (failure) { error = failure.message; }
                finally { loading = false; }
                await refresh();
                if (!closed && selected === currentXpr && error) post({ type: 'error', message: error });
            }
            panel.webview.onDidReceiveMessage(message => {
                if (closed || !message) return;
                if (message.action === 'ready') { ready = true; auto = message.auto !== false; void refresh(); return; }
                if (message.action === 'refresh') { void refresh(true); return; }
                if (message.action === 'generate') { void generateReports(); return; }
                if (message.action === 'auto') { auto = message.enabled !== false; schedule(); return; }
                if (message.action === 'openFolder') { void openPath(path.dirname(currentXpr)); return; }
                if (message.action === 'openReport' && ['utilization', 'timing', 'power', 'drc'].includes(message.kind)) {
                    const report = latest?.analysis?.results?.[message.kind];
                    const file = message.kind === 'utilization'
                        ? (['synthesis', 'implementation'].includes(message.stage) ? report?.[message.stage]?.file : undefined)
                        : report?.file;
                    if (file) void openPath(file);
                    return;
                }
                if (message.action === 'openRun' && ['log', 'directory'].includes(message.kind) &&
                    typeof message.run === 'string' && latest?.paths && Object.hasOwn(latest.paths, message.run)) {
                    const file = latest.paths[message.run][message.kind];
                    if (file) void openPath(file);
                }
            });
            panel.onDidChangeViewState(() => { if (panel.visible && auto) void refresh(); else clearTimeout(timer); });
            panel.onDidDispose(() => { closed = true; clearTimeout(timer); entry = null; });
            panel.webview.html = html(panel.webview, vscode, resources, strings);
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
