'use strict';

const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { MANIFEST, loadReview, verifiedFile, verifiedNote, verifyObservationLink, revealObservation, loadReviewSample } = require('./review-model');
const history = require('./note-history-store');
const { findDesignNote, pinFromEditor } = require('./review-pin');

function reviewHtml(webview, vscode, extensionUri) {
    const resource = name => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'design', name));
    const nonce = randomBytes(24).toString('base64');
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('review.css')}"><title>设计讲解</title></head>
<body><main>
    <header class="page-header"><h1 id="title">设计讲解</h1><button id="refresh" type="button">重新读取</button></header>
    <p id="status" role="status" aria-live="polite">正在读取设计讲解…</p>
    <div id="content" class="layout" hidden>
        <nav aria-label="待核对的行为"><h2>待核对的行为</h2><div id="rules"></div></nav>
        <article id="review" aria-labelledby="rule-title">
            <div id="module" class="module-name"></div>
            <h2 id="rule-title"></h2>
            <div id="frozen-note" class="frozen-note" hidden></div>
            <p id="contract" class="contract"></p>
            <p id="mechanism"></p>
            <section id="change-review" aria-labelledby="changes-title" hidden>
                <h3 id="changes-title">候选变更与复核重点</h3>
                <div id="changes"></div>
            </section>
            <section aria-labelledby="event-title">
                <div class="event-header"><h3 id="event-title">按事件查看</h3><div class="step-buttons">
                    <button id="previous" type="button">上一步</button><button id="next" type="button">下一步</button>
                </div></div>
                <div id="steps" class="steps" aria-label="事件列表"></div>
                <ol id="flow" class="flow" aria-label="当前事件相关环节"></ol>
                <div id="step-links" class="evidence-links"></div>
                <section id="interface-review" aria-labelledby="interfaces-title" hidden>
                    <h4 id="interfaces-title">此处涉及的模块约定</h4>
                    <div id="interfaces"></div>
                </section>
            </section>
            <section class="verification" aria-labelledby="verification-title">
                <h3 id="verification-title">从用例推导结果</h3>
                <dl><dt>激励</dt><dd id="stimulus"></dd><dt>检查方法</dt><dd id="checker"></dd>
                    <dt>此时预期</dt><dd id="expected"></dd></dl>
                <ul id="expected-values" class="expected-values" aria-label="本事件的预期值" hidden></ul>
                <button id="reveal" type="button" aria-controls="observed" aria-expanded="false">查看实际结果</button>
                <div id="observed" class="observed" aria-live="polite" hidden></div>
            </section>
        </article>
    </div>
</main><script nonce="${nonce}" src="${resource('review-client.js')}"></script></body></html>`;
}

function activateReviewView(context, { vscode, projects, waveViewer, showArchitecture }) {
    const panels = new Map();
    async function chooseRoot() {
        const project = await projects.current();
        if (project?.root) return project.root;
        const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
        if (folders.length === 1) return folders[0].uri.fsPath;
        if (folders.length) {
            const chosen = await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择设计讲解所属工作区' });
            return chosen?.uri.fsPath;
        }
        vscode.window.showInformationMessage('请先打开包含 ' + MANIFEST + ' 的工程目录。');
    }

    async function openSourceDiff(root, diff, active, viewColumn) {
        const files = [diff.before, diff.after];
        const docs = await Promise.all(files.map(async file => {
            const verified = await verifiedFile(root, file);
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(verified));
            await verifiedFile(root, file);
            return doc;
        }));
        if (!active()) return;
        if (docs.some(doc => doc.isDirty)) throw new Error('候选文件有未保存的更改，保存或还原后再查看差异。');
        const options = { viewColumn, preview: true };
        if (diff.afterLine !== undefined) {
            if (diff.afterLine > docs[1].lineCount) throw new Error('变更后的源码行已不存在。');
            const position = new vscode.Position(diff.afterLine - 1, 0);
            options.selection = new vscode.Range(position, position);
        }
        await vscode.commands.executeCommand('vscode.diff', docs[0].uri, docs[1].uri, diff.title, options);
    }

    function open(root, focus) {
        root = path.resolve(root);
        const existing = panels.get(root);
        if (existing) { existing.reveal(focus); return; }
        const resourceRoot = vscode.Uri.joinPath(context.extensionUri, 'src', 'design');
        const panel = vscode.window.createWebviewPanel('svtoolsDesignReview', '设计讲解', vscode.ViewColumn.Active,
            { enableScripts: true, localResourceRoots: [resourceRoot], retainContextWhenHidden: true });
        panels.set(root, {
            reveal(selection) { panel.reveal(); if (selection) { focus = selection; void refresh(); } },
            dispose: () => panel.dispose()
        });
        let current, revision = 0, architectureRequest = 0, disposed = false;
        const linkColumn = () => panel.viewColumn !== undefined && panel.viewColumn < vscode.ViewColumn.Nine
            ? panel.viewColumn + 1 : vscode.ViewColumn.Beside;
        const post = data => {
            if (!disposed) return panel.webview.postMessage(data);
        };
        async function refresh() {
            const version = ++revision;
            current = undefined;
            await post({ type: 'loading', revision: version });
            try {
                const loaded = await loadReview(root);
                if (disposed || version !== revision) return;
                current = loaded;
                const focusRule = focus?.ruleId ?? (focus?.noteId
                    ? loaded.snapshot.rules.findLast(rule => rule.note?.id === focus.noteId)?.id : undefined);
                const message = focus?.noteId && !focusRule ? '当前 Note 尚未关联设计讲解中的定版记录。' : '';
                const focusEvent = focus?.eventId;
                focus = undefined;
                await post({ type: 'review', revision: version, ...loaded.snapshot, focusRule, focusEvent, message });
            } catch (error) {
                if (version !== revision) return;
                await post({ type: 'load-error', revision: version, text: error.code === 'ENOENT' ?
                    '在工程根目录添加 ' + MANIFEST + '，然后重新读取。' : error.message });
            }
        }
        async function receive(message) {
            if (disposed) return;
            if (message?.type === 'ready' || message?.type === 'refresh') { await refresh(); return; }
            const version = revision;
            if (current && message?.revision === version && message.type === 'architecture') {
                const request = ++architectureRequest;
                const active = () => !disposed && version === revision && request === architectureRequest;
                const rule = current.snapshot.rules.find(rule => rule.id === message.rule);
                const event = rule?.events.find(event => event.id === message.event);
                try {
                    const shown = await showArchitecture?.(root, event?.architecture, message.reveal === true, active);
                    if (shown && message.reveal === true && event?.architecture && active())
                        await post({ type: 'architecture-ready', revision: version });
                } catch (error) {
                    if (active()) await post({ type: 'link-error', revision: version, error: error.message });
                }
                return;
            }
            if (!current || message?.revision !== version || typeof message.token !== 'string'
                || !Number.isSafeInteger(message.interaction)) return;
            const metadata = { revision: version, token: message.token, interaction: message.interaction };
            if (message.type === 'observation') {
                const request = current.observations.get(message.token);
                if (!request) return;
                const response = await revealObservation(root, request);
                if (version === revision)
                    await post({ type: 'observation', ...metadata, ...response });
                return;
            }
            try {
                if (message.type === 'note') {
                    const note = current.notes.get(message.token);
                    if (!note) return;
                    await verifiedNote(root, note);
                    const uri = history.revisionUri(vscode, vscode.Uri.file(root), note.id, note.version);
                    const document = await vscode.workspace.openTextDocument(uri);
                    await verifiedNote(root, note);
                    if (!disposed && version === revision) await vscode.window.showTextDocument(document, { viewColumn: linkColumn(), preview: true });
                    return;
                }
                if (message.type === 'diff') {
                    const diff = current.diffs.get(message.token);
                    if (diff) await openSourceDiff(root, diff, () => !disposed && version === revision, linkColumn());
                    return;
                }
                const link = current.links.get(message.token);
                if (!link || !['open', 'sample'].includes(message.type)) return;
                if (message.type === 'sample') {
                    if (!link.sample) return;
                    const sample = await loadReviewSample(root, link);
                    if (version === revision)
                        await post({ type: 'sample', ...metadata, ...sample });
                    return;
                }
                await verifyObservationLink(root, link);
                const file = await verifiedFile(root, link.file);
                if (disposed || version !== revision) return;
                if (link.supportsWave) {
                    const binding = await waveViewer.openWaveform(file, { viewColumn: linkColumn() });
                    if (link.sample && version === revision && !disposed) {
                        await verifyObservationLink(root, link);
                        if (version !== revision || disposed) return;
                        const metadata = binding.getMetadata();
                        if (!metadata) throw new Error('波形尚未加载。');
                        const model = require('../waveform/model');
                        const at = model.parseTime(link.sample.at, metadata.secondsPerTick);
                        if (at === null || at > metadata.endTime) throw new Error('采样点超出波形范围。');
                        const requested = new Set(link.sample.signals);
                        const keys = model.prepareSignals(metadata.vars).flatMap(signal => {
                            const key = model.signalKey(signal);
                            if (requested.has(signal.path)) return [key];
                            return (signal.bitPaths || []).flatMap((member, index) => requested.has(member)
                                ? [JSON.stringify(['$bit', key, signal.width - index - 1])] : []);
                        });
                        await binding.revealSignals({ keys, at });
                    }
                } else {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                    if (disposed || version !== revision) return;
                    if (link.line !== undefined && doc.isDirty) throw new Error('文件有未保存的更改，保存或还原后再核对行号。');
                    if (link.line !== undefined && link.line > doc.lineCount) throw new Error('源码或日志行已不存在。');
                    const pos = link.line === undefined ? undefined : new vscode.Position(link.line - 1, 0);
                    await vscode.window.showTextDocument(doc, { viewColumn: linkColumn(), preview: true,
                        ...(pos ? { selection: new vscode.Range(pos, pos) } : {}) });
                }
            } catch (error) {
                if (version !== revision) return;
                const observation = current.links.get(message.token)?.observation;
                if (error.issues && observation) {
                    await post({ type: 'observation', ...metadata, token: observation.token,
                        status: 'unavailable', refs: [], text: error.message, issues: error.issues });
                } else {
                    await post({ type: message.type === 'sample' ? 'sample' : 'link-error', ...metadata, error: error.message });
                }
            }
        }
        const listener = panel.webview.onDidReceiveMessage(message => {
            void receive(message).catch(error => vscode.window.showErrorMessage('设计讲解：' + error.message));
        });
        panel.onDidDispose(() => { disposed = true; panels.delete(root); listener.dispose(); });
        panel.webview.html = reviewHtml(panel.webview, vscode, context.extensionUri);
    }
    context.subscriptions.push(vscode.commands.registerCommand('svtools.design.review', async () => {
        try {
            const root = await chooseRoot();
            if (root) open(root);
        } catch (error) {
            vscode.window.showErrorMessage('设计讲解：' + error.message);
        }
    }), vscode.commands.registerCommand('svtools.note.review', async target => {
        const note = findDesignNote(vscode, target);
        if (!note) {
            vscode.window.showInformationMessage('请打开工程中的设计笔记，再核对定版。');
            return;
        }
        open(note.root, { noteId: note.id });
    }), vscode.commands.registerCommand('svtools.note.pinReview', async target => {
        const note = findDesignNote(vscode, target);
        if (!note) {
            vscode.window.showInformationMessage('请打开工程中的设计笔记，再创建评审定版。');
            return;
        }
        try {
            const ruleId = await pinFromEditor(vscode, note);
            if (ruleId) open(note.root, { ruleId });
        } catch (error) {
            vscode.window.showErrorMessage('无法创建评审定版 · ' + error.message);
        }
    }), { dispose() { for (const panel of panels.values()) panel.dispose(); } });
    return { open };
}

module.exports = { activateReviewView };
