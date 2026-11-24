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
const { LEVELS } = require('./summary-messages');

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
                    <h3 id="utilization-title" tabindex="-1">${strings.utilization}</h3><div id="utilization"></div>
                </article>
                <article class="surface analysis-wide" aria-labelledby="timing-title">
                    <h3 id="timing-title" tabindex="-1">${strings.timing}</h3><div id="timing-source"></div><div id="timing" class="timing"></div>
                </article>
                <article class="surface" aria-labelledby="power-title">
                    <h3 id="power-title">${strings.power}</h3><div id="power"></div>
                </article>
                <article class="surface" aria-labelledby="drc-title">
                    <h3 id="drc-title">${strings.drc}</h3><div id="drc"></div>
                </article>
            </div>
        </section>
        <section class="surface run-section" aria-labelledby="runs-title">
            <header class="section-heading"><h2 id="runs-title">${strings.runs}</h2><div class="run-tools"><p id="run-count" class="muted"></p><button id="toggle-runs">${strings.expandRuns}</button></div></header>
            <div id="runs" class="runs"></div>
            <p id="runs-empty" class="empty" hidden>${strings.emptyRuns}</p>
        </section>
        <section class="surface" aria-labelledby="messages-title">
            <h2 id="messages-title" tabindex="-1">${strings.messages}</h2>
            <div class="message-filters">
                <label>${strings.run}<select id="message-run"></select></label>
                <label>${strings.severity}<select id="message-level"></select></label>
                <label>${strings.searchMessages}<input type="search" id="message-search" placeholder="${strings.searchHint}"></label>
            </div>
            <p id="message-status" class="muted" role="status" aria-live="polite"></p>
            <ol id="messages" class="message-list"></ol>
            <div id="message-pages" class="message-pages" hidden><button id="message-prev">${strings.previous}</button><button id="message-next">${strings.next}</button></div>
        </section>
    </main>
    </div>
    <script nonce="${nonce}" id="summary-strings" type="application/json">${JSON.stringify(strings)}</script>
    <script nonce="${nonce}" src="${uri('summary-client.js')}"></script></body></html>`;
}

function openSummaryPanels(context, vscode, { load, generate, openPath, openDetail = file => openPath(file), runMessages, log = () => {} }) {
    let entry = null, currentXpr = null;
    const strings = summaryStrings(vscode.env?.language);
    return {
        open(xpr, section) {
            if (entry) {
                entry.panel.reveal();
                entry.select(xpr, section);
                return;
            }
            currentXpr = xpr;
            const resources = vscode.Uri.joinPath(context.extensionUri, 'src', 'vivado');
            const panel = vscode.window.createWebviewPanel('svtoolsVivadoSummary', 'Vivado · ' + strings.title, vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources] });
            let closed = false, ready = false, auto = true, loading = false, generating = false;
            let timer = null, latest = null, pendingSection = section, pendingGeneration = null;
            const post = message => { if (!closed && ready) void panel.webview.postMessage(message); };
            function focusSection() {
                if (!latest || !pendingSection) return;
                post({ type: 'focusReport', section: pendingSection });
                pendingSection = undefined;
            }
            const schedule = () => {
                clearTimeout(timer);
                if (!auto || closed || !panel.visible) return;
                timer = setTimeout(() => { void refresh(); }, POLL_MS);
            };
            async function refresh(manual = false) {
                clearTimeout(timer);
                if (closed || !ready || loading || generating) return;
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
                        focusSection();
                    }
                } catch (error) {
                    if (!closed && selected === currentXpr) post({ type: 'error', message: error.message });
                } finally {
                    loading = false;
                    if (!closed && selected !== currentXpr) void refresh();
                    else if (pendingGeneration) {
                        const pending = pendingGeneration;
                        pendingGeneration = null;
                        void generateReports(pending.request, pending.onReady);
                    } else schedule();
                }
            }
            async function generateReports(request, onReady) {
                if (closed || generating || !request || !generate) return;
                if (loading) { pendingGeneration = { request, onReady }; return; }
                clearTimeout(timer);
                const selected = currentXpr;
                generating = true;
                post({ type: 'generating' });
                let error;
                try { error = (await generate(selected, request))?.error; }
                catch (failure) { error = failure.message; }
                finally { generating = false; }
                await refresh();
                if (closed || selected !== currentXpr) return;
                if (error) post({ type: 'error', message: error });
                else onReady?.();
            }
            panel.webview.onDidReceiveMessage(message => {
                if (closed || !message) return;
                if (message.action === 'ready') { ready = true; auto = message.auto !== false; void refresh(); return; }
                if (message.action === 'refresh') { void refresh(true); return; }
                if (message.action === 'generate') { void generateReports(latest?.analysis?.generation); return; }
                if (message.action === 'auto') { auto = message.enabled !== false; schedule(); return; }
                if (message.action === 'openFolder') { void openPath(path.dirname(currentXpr)); return; }
                if (message.action === 'listMessages' && runMessages && latest?.paths && Number.isSafeInteger(message.request)) {
                    const run = typeof message.run === 'string' && Object.hasOwn(latest.paths, message.run) ? message.run : '';
                    const level = LEVELS.includes(message.level) ? message.level : '';
                    post({ type: 'runMessages', request: message.request, ...runMessages.page(latest.paths,
                        { run, level, search: message.search, offset: message.offset }) });
                    return;
                }
                if (message.action === 'openMessage' && runMessages && latest?.paths && typeof message.run === 'string') {
                    const location = runMessages.location(latest.paths, message.run, message.line);
                    if (location) void openPath(location.file, location.line);
                    return;
                }
                if (message.action === 'openDetail' && ['synthesis', 'implementation'].includes(message.stage) &&
                    ['hierarchy', 'logicLevels'].includes(message.kind)) {
                    const { stage, kind } = message;
                    const detailFor = () => latest?.analysis?.details?.[stage]?.[kind];
                    const detail = detailFor();
                    if (detail?.file) void openDetail(detail.file, strings[kind], detail.request.run);
                    else if (detail?.request) void generateReports(detail.request, () => {
                        const updated = detailFor();
                        if (updated?.file && updated.request.identity === detail.request.identity) {
                            void openDetail(updated.file, strings[kind], updated.request.run);
                        } else post({ type: 'error', message: strings.generationFailed });
                    });
                    return;
                }
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
            entry = { panel, select(next, section) {
                pendingSection = section;
                if (!samePath(next, currentXpr)) {
                    currentXpr = next;
                    latest = null;
                    pendingGeneration = null;
                    post({ type: 'reset' });
                } else if (latest && section) {
                    focusSection();
                    return;
                }
                focusSection();
                void refresh();
            } };
            log('[vivado] 打开工程概览：' + currentXpr);
        }
    };
}

module.exports = { openSummaryPanels, POLL_MS };
