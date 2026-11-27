'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const history = require('./note-history-store');
const sidecars = require('./note-anchor');
const { safePath } = require('./workflow-files');
const { createContainedDirectories } = require('./scaffold-paths');
const { parseDocument } = require('../editor/completion/syntax');
const { readAnchors } = require('../editor/design-notes');

const COMMAND = 'svtools.note.history';
const UNIT = new Set(['module', 'macromodule', 'interface', 'program', 'package', 'checker']);
const MAX_SOURCES = 4096;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const asRelative = (root, file) => path.relative(root, file).split(path.sep).join('/');
const collator = new Intl.Collator(undefined, { numeric: true });

function anchorsIn(text) {
    if (!text.includes('[note:')) return [];
    const source = parseDocument(text);
    const result = [];
    for (const marker of readAnchors(text, source.tokens).markers.values()) {
        if (!marker.id) continue;
        let scope = source.scopeAt(marker.offset);
        while (scope && !UNIT.has(scope.kind)) scope = source.scopes[scope.parent];
        result.push({ id: marker.id, title: marker.title, module: scope?.name || '', line: marker.line + 1 });
    }
    return result;
}

async function catalog({ vscode, folder, sourceCatalog, token }) {
    const { workspace } = vscode, root = folder.uri.fsPath;
    const found = await history.listNotes(root);
    const notes = new Map();
    for (const [id, exists] of found) notes.set(id, { id, exists, title: '', anchors: [], modules: [] });
    if (!notes.size) return { notes, incomplete: false };

    const { uris, truncated } = await sourceCatalog.discover({ root, preferProject: false, limit: MAX_SOURCES, token });
    const key = folder.uri.toString();
    const open = new Map(workspace.textDocuments.filter(doc => doc.uri.scheme === 'file').map(doc => [doc.uri.toString(), doc]));
    const sources = new Map(uris.map(uri => [uri.toString(), uri]));
    for (const doc of open.values()) {
        if (/\.(?:sv|v|svh|vh)$/i.test(doc.uri.fsPath) && workspace.getWorkspaceFolder(doc.uri)?.uri.toString() === key) {
            sources.set(doc.uri.toString(), doc.uri);
        }
    }
    let incomplete = truncated;
    const files = [...sources.values()];
    for (let index = 0; index < files.length && !token.isCancellationRequested; index += 8) {
        const batch = await Promise.all(files.slice(index, index + 8).map(async uri => {
            if (workspace.getWorkspaceFolder(uri)?.uri.toString() !== key) return [];
            try {
                const stat = await fs.stat(uri.fsPath);
                if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) { incomplete = true; return []; }
                const text = open.get(uri.toString())?.getText() ?? await fs.readFile(uri.fsPath, 'utf8');
                if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) { incomplete = true; return []; }
                const file = asRelative(root, uri.fsPath);
                return anchorsIn(text).map(anchor => ({ ...anchor, file }));
            } catch (error) {
                if (error.code !== 'ENOENT') incomplete = true;
                return [];
            }
        }));
        for (const anchor of batch.flat()) notes.get(anchor.id)?.anchors.push(anchor);
    }
    const overrides = new Map([...open.values()].filter(doc => doc.isDirty && workspace.getWorkspaceFolder(doc.uri)?.uri.toString() === key &&
        sidecars.HDL.test(doc.uri.fsPath)).map(doc => [asRelative(root, doc.uri.fsPath), doc.getText()]));
    const sourcePaths = files.map(uri => uri.fsPath), memo = new Map();
    for (const note of notes.values()) {
        if (token.isCancellationRequested) break;
        try {
            if (note.exists) {
                const text = await history.readNote(root, note.id);
                if (text !== undefined) note.title = history.titleOf(text, '');
                const metadata = await sidecars.readAnchor(root, note.id);
                if (metadata && !truncated) {
                    const anchor = await sidecars.resolve(root, metadata, { sources: sourcePaths, overrides, memo });
                    if (anchor.status === 'resolved') note.anchors.push({ file: anchor.path, line: anchor.line, module: anchor.module,
                        title: anchor.name || note.title });
                }
            } else {
                note.title = (await history.newestRevision(root, note.id))?.title;
            }
        } catch {
            incomplete = true;
        }
        note.title ||= note.anchors[0]?.title || note.id;
        note.modules = [...new Set(note.anchors.map(anchor => anchor.module).filter(Boolean))].sort(collator.compare);
    }
    return { notes, incomplete };
}

function html(webview, vscode, resourceRoot) {
    const resource = name => webview.asWebviewUri(vscode.Uri.joinPath(resourceRoot, name));
    const nonce = randomBytes(24).toString('base64');
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + webview.cspSource +
        '; script-src \'nonce-' + nonce + '\'"><link rel="stylesheet" href="' + resource('note-history.css') + '">' +
        '<title>文档历史</title></head><body><main>' +
        '<header><div><h1>文档历史</h1><p id="workspace"></p></div><button id="refresh" type="button">刷新</button></header>' +
        '<p id="status" role="status" aria-live="polite"></p>' +
        '<div class="layout"><nav aria-label="查找文档"><label for="search">查找文档</label>' +
        '<input id="search" type="search" placeholder="模块名、标题、路径或 ID" autocomplete="off">' +
        '<label for="module">模块</label><select id="module"></select><p id="results" role="status" aria-live="polite"></p>' +
        '<div id="notes" class="list" aria-label="文档列表"></div></nav>' +
        '<section class="detail" aria-label="版本记录"><h2 id="note-title">选择一篇文档</h2>' +
        '<p id="anchors"></p><div class="actions"><button id="current" type="button" disabled>打开当前稿</button>' +
        '<button id="checkpoint" type="button" disabled>保存检查点</button></div><p id="history-status" role="status" aria-live="polite"></p>' +
        '<div class="comparison" id="comparison" hidden><label for="compare-to">对比目标</label><select id="compare-to"></select>' +
        '<button id="diff" type="button" disabled>查看差异</button><button id="preview" type="button" disabled>打开版本</button>' +
        '<button id="restore" type="button" disabled>恢复为草稿</button></div>' +
        '<div class="restore-prompt" id="restore-prompt" hidden><p>恢复此版本前会为当前稿保存检查点。恢复后的内容可以在编辑器里核对。</p>' +
        '<button id="confirm-restore" type="button">确认恢复</button><button id="cancel-restore" type="button">取消</button></div>' +
        '<div id="versions" class="list" aria-label="版本列表"></div></section></div></main>' +
        '<script nonce="' + nonce + '" src="' + resource('note-history-client.js') + '"></script></body></html>';
}

function activateNoteHistory(context, { vscode, sourceCatalog, designNotes, linkedNotes }) {
    const { workspace, window, commands, Uri } = vscode;
    const panels = new Map(), pending = new Map();
    let output;
    const noteUri = (folder, id) => Uri.joinPath(folder.uri, history.notePath(id));
    const revisionUri = (folder, id, version) => history.revisionUri(vscode, folder.uri, id, version);
    const openDocument = uri => workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());

    function locateNote(uri) {
        const folder = uri.scheme === 'file' && workspace.getWorkspaceFolder(uri);
        const id = folder && history.noteId(asRelative(folder.uri.fsPath, uri.fsPath));
        if (id) return { folder, id };
    }

    function reportSaveError(id, error) {
        if (!output) {
            output = window.createOutputChannel('SV Tools 文档历史');
            context.subscriptions.push(output);
        }
        output.appendLine(id + ' · ' + error.message);
        window.showWarningMessage('SV Tools 未能保存笔记历史。详情见「SV Tools 文档历史」输出。');
    }

    function record(folder, id, content, kind, label) {
        const key = noteUri(folder, id).toString();
        const next = (pending.get(key) || Promise.resolve()).catch(() => {}).then(() => history.record(folder.uri.fsPath, id, content, kind, label));
        pending.set(key, next);
        return next.finally(() => { if (pending.get(key) === next) pending.delete(key); });
    }

    async function noteContent(folder, id) {
        const doc = openDocument(noteUri(folder, id));
        return doc?.isDirty ? doc.getText() : history.readNote(folder.uri.fsPath, id);
    }

    async function restore(folder, id, entry) {
        const root = folder.uri.fsPath, relative = history.notePath(id), uri = noteUri(folder, id);
        const before = await noteContent(folder, id);
        const edit = new vscode.WorkspaceEdit();
        if (before === undefined) {
            const file = await safePath(root, relative, { missing: true });
            await createContainedDirectories(path.dirname(file), await fs.realpath(root));
            edit.createFile(uri, { contents: Buffer.from(entry.content) });
        } else {
            await safePath(root, relative);
            const doc = await workspace.openTextDocument(uri);
            const editorVersion = doc.version;
            await record(folder, id, before, 'restore-backup', '恢复前');
            const current = await noteContent(folder, id);
            if (doc.isClosed || doc.version !== editorVersion || doc.getText() !== before || current !== before) {
                throw new Error('准备恢复期间，当前稿已变化。请重新对比。');
            }
            edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)), entry.content);
        }
        if (!await workspace.applyEdit(edit)) throw new Error('无法恢复笔记，当前稿可能已变化。');
        if (before === undefined) await record(folder, id, entry.content, 'save');
        await window.showTextDocument(await workspace.openTextDocument(uri), { viewColumn: vscode.ViewColumn.Beside });
    }

    function openPanel(folder, focusId) {
        const key = folder.uri.toString(), root = folder.uri.fsPath;
        const existing = panels.get(key);
        if (existing) { existing.reveal(focusId); return; }
        const resourceRoot = Uri.joinPath(context.extensionUri, 'src', 'design');
        const panel = window.createWebviewPanel('svtoolsNoteHistory', '文档历史', vscode.ViewColumn.Active,
            { enableScripts: true, localResourceRoots: [resourceRoot], retainContextWhenHidden: true });
        let itemId, loading, generation = 0, notes = new Map(), disposed = false, updating = false;
        const post = data => { if (!disposed) return panel.webview.postMessage(data); };
        const state = {
            reveal(id) {
                panel.reveal();
                if (id) {
                    focusId = id;
                    if (!loading) void refresh();
                }
            },
            async saved(id, content) {
                if (updating || loading) return;
                const note = notes.get(id);
                if (!note || !note.exists || history.titleOf(content, note.anchors[0]?.title || id) !== note.title) await refresh();
                else if (itemId === id) await showVersions(id);
            },
            dispose: () => panel.dispose()
        };
        panels.set(key, state);

        async function refresh() {
            loading?.cancel();
            const source = new vscode.CancellationTokenSource();
            loading = source;
            const revision = ++generation;
            await post({ type: 'loading' });
            try {
                const result = await catalog({ vscode, folder, sourceCatalog, token: source.token });
                if (source.token.isCancellationRequested) return;
                notes = result.notes;
                await post({ type: 'catalog', workspace: folder.name, incomplete: result.incomplete,
                    notes: [...notes.values()].sort((a, b) => collator.compare(a.title, b.title)),
                    focusId, selectionId: itemId });
                focusId = undefined;
            } catch (error) {
                if (revision === generation) await post({ type: 'error', message: error.message });
            } finally {
                if (loading === source) loading = undefined;
                source.dispose();
            }
        }

        async function showVersions(id) {
            const revision = ++generation;
            itemId = id;
            const { revisions, invalid } = await history.listRevisions(root, id);
            if (revision !== generation) return;
            await post({ type: 'versions', id, revisions, invalid });
        }

        async function receive(message) {
            if (message?.type === 'ready' || message?.type === 'refresh') { await refresh(); return; }
            const note = notes.get(message?.id);
            if (!note) return;
            const { id } = note;
            if (message.type === 'select') { await showVersions(id); return; }
            if (itemId !== id) return;
            const options = { viewColumn: vscode.ViewColumn.Beside, preview: true };
            if (message.type === 'current' && note.exists) {
                await safePath(root, history.notePath(id));
                await window.showTextDocument(await workspace.openTextDocument(noteUri(folder, id)), options);
            }
            if (message.type === 'checkpoint' && note.exists && !updating) {
                updating = true;
                try {
                    const label = (await window.showInputBox({ title: '保存笔记检查点', placeHolder: '例如：Agent 改写前',
                        validateInput(value) {
                            const length = value.trim().length;
                            if (!length) return '请输入检查点名称';
                            if (length > 100) return '名称最多 100 个字符';
                        } }))?.trim();
                    if (!label) return;
                    const content = await noteContent(folder, id);
                    if (content === undefined) throw new Error('当前稿已不存在，请刷新。');
                    await record(folder, id, content, 'checkpoint', label);
                    if (itemId === id && !loading) await showVersions(id);
                } finally { updating = false; }
            }
            if (!['preview', 'diff', 'restore'].includes(message.type) || typeof message.version !== 'string') return;
            const entry = await history.readRevision(root, id, message.version);
            const original = revisionUri(folder, id, entry.version);
            if (disposed || itemId !== id) return;
            if (message.type === 'preview') await window.showTextDocument(await workspace.openTextDocument(original), options);
            if (message.type === 'diff') {
                if (message.base === 'current') await safePath(root, history.notePath(id));
                else if (typeof message.base === 'string' && message.base !== entry.version) await history.readRevision(root, id, message.base);
                else return;
                const compare = message.base === 'current' ? noteUri(folder, id) : revisionUri(folder, id, message.base);
                const [left, right] = message.base === 'current' || entry.version < message.base ? [original, compare] : [compare, original];
                if (!disposed && itemId === id) await commands.executeCommand('vscode.diff', left, right, note.title + ' · 笔记对比', options);
            }
            if (message.type === 'restore' && !updating) {
                updating = true;
                try {
                    await restore(folder, id, entry);
                    if (entry.noteId === itemId && !loading) await refresh();
                } finally { updating = false; }
            }
        }

        const subscription = panel.webview.onDidReceiveMessage(message => {
            void receive(message).catch(error => post({ type: 'action-error', message: error.message }));
        });
        panel.onDidDispose(() => {
            disposed = true;
            loading?.cancel();
            subscription.dispose();
            panels.delete(key);
        });
        panel.webview.html = html(panel.webview, vscode, resourceRoot);
    }

    context.subscriptions.push(
        workspace.registerTextDocumentContentProvider(history.REVISION_SCHEME, {
            async provideTextDocumentContent(uri) {
                const folder = (workspace.workspaceFolders || []).find(item => item.uri.scheme === 'file' && item.uri.toString() === uri.query);
                const match = /^\/([^/]+)\/([^/]+)\.md$/.exec(uri.path);
                if (!folder || !match) return undefined;
                return (await history.readRevision(folder.uri.fsPath, match[1], match[2])).content;
            }
        }),
        workspace.onDidSaveTextDocument(document => {
            const note = locateNote(document.uri);
            if (!note) return;
            const { folder, id } = note;
            const content = document.getText();
            void record(folder, id, content, 'save')
                .then(() => panels.get(folder.uri.toString())?.saved(id, content)).catch(error => reportSaveError(id, error));
        }),
        workspace.onDidCreateFiles(({ files }) => {
            for (const uri of files) {
                const note = locateNote(uri);
                if (!note) continue;
                const { folder, id } = note;
                void history.readNote(folder.uri.fsPath, id).then(async content => {
                    if (content === undefined) return;
                    await record(folder, id, content, 'save');
                    await panels.get(folder.uri.toString())?.saved(id, content);
                }).catch(error => reportSaveError(id, error));
            }
        }),
        commands.registerCommand(COMMAND, async target => {
            const editor = window.activeTextEditor;
            const uri = target instanceof Uri ? target : editor?.document.uri;
            let folder = uri?.scheme === 'file' ? workspace.getWorkspaceFolder(uri) : undefined;
            const available = (workspace.workspaceFolders || []).filter(item => item.uri.scheme === 'file');
            if (!folder && available.length === 1) folder = available[0];
            if (!folder && available.length > 1) folder = await window.showWorkspaceFolderPick({ placeHolder: '选择文档历史所属工程' });
            if (!folder) {
                if (!available.length) window.showInformationMessage('请先打开工程文件夹。');
                return;
            }
            let id = uri?.scheme === 'file' ? history.noteId(asRelative(folder.uri.fsPath, uri.fsPath)) : undefined;
            if (!id && editor && editor.document.uri.toString() === uri?.toString()
                && ['verilog', 'systemverilog'].includes(editor.document.languageId)) {
                id = designNotes.markerAt(editor.document, editor.selection.active.line)?.id || linkedNotes?.idAt(editor.document, editor.selection.active);
            }
            openPanel(folder, id);
        }),
        { dispose() { for (const panel of panels.values()) panel.dispose(); } }
    );
}

module.exports = { activateNoteHistory, anchorsIn };
