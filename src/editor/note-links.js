'use strict';

const path = require('node:path');
const anchors = require('../design/note-anchor');
const notes = require('../design/note-service');
const history = require('../design/note-history-store');
const { SOURCE_GLOB } = require('../workspace/source-catalog');
const { SOURCE_EXCLUDE_GLOB, isExcludedSourcePath } = require('../workspace/source-policy');

const SELECTORS = [{ language: 'verilog', scheme: 'file' }, { language: 'systemverilog', scheme: 'file' }];
const OPEN = 'svtools.note.openLinked';
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

function activateNoteLinks(context, vscode) {
    const { window, workspace, languages, commands, Uri, Range, MarkdownString, Hover, ThemeColor } = vscode;
    const decoration = window.createTextEditorDecorationType({ after: { color: new ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 1em' } });
    const cache = new Map();
    // findFiles 的结果按工作区缓存，只在源码增删/重命名时失效；扫描本身改由保存触发。
    const files = new Map();
    let pending;
    let generation = 0;
    let disposed = false;

    async function scan() {
        const current = generation;
        const editors = window.visibleTextEditors;
        const byFolder = new Map();
        for (const { document } of editors) {
            const folder = workspace.getWorkspaceFolder(document.uri);
            if (folder && anchors.HDL.test(document.fileName)) byFolder.set(folder.uri.toString(), folder);
        }
        const next = new Map();
        for (const folder of byFolder.values()) {
            const root = folder.uri.fsPath;
            const rows = (await notes.inventory(root)).filter(note => note.anchor);
            if (current !== generation) return;
            if (!rows.length) continue;
            let paths = files.get(root);
            if (!paths) {
                paths = await workspace.findFiles(new vscode.RelativePattern(folder, SOURCE_GLOB), SOURCE_EXCLUDE_GLOB);
                if (current !== generation) return;
                files.set(root, paths);
            }
            const overrides = new Map(workspace.textDocuments.filter(doc => doc.uri.scheme === 'file' && doc.isDirty &&
                workspace.getWorkspaceFolder(doc.uri)?.uri.toString() === folder.uri.toString() && anchors.HDL.test(doc.fileName))
                .map(doc => [relative(root, doc.uri.fsPath), doc.getText()]));
            const sources = paths.map(uri => uri.fsPath);
            const memo = new Map();
            for (const note of rows) {
                if (current !== generation) return;
                const location = await anchors.resolve(root, note.anchor, { sources, overrides, memo });
                if (location.status !== 'resolved') continue;
                const key = Uri.joinPath(folder.uri, location.path).toString();
                if (!next.has(key)) next.set(key, []);
                next.get(key).push({ ...location, id: note.id, title: note.title });
            }
        }
        if (disposed || current !== generation) return;
        cache.clear();
        for (const [key, value] of next) cache.set(key, value);
        for (const editor of editors) {
            editor.setDecorations(decoration, (cache.get(editor.document.uri.toString()) || []).map(item => {
                const start = editor.document.positionAt(item.start);
                const range = editor.document.lineAt(start.line).range;
                return { range, renderOptions: { after: { contentText: '▸ Note · ' + item.title.slice(0, 64) } } };
            }));
        }
    }

    function schedule() {
        generation++;
        clearTimeout(pending);
        cache.clear();
        for (const editor of window.visibleTextEditors) editor.setDecorations(decoration, []);
        pending = setTimeout(() => void scan().catch(error => console.warn('SV Tools note links:', error.message)), 180);
    }

    async function create(symbol) {
        const editor = window.activeTextEditor;
        const document = editor?.document;
        const folder = document && workspace.getWorkspaceFolder(document.uri);
        if (!folder || !anchors.HDL.test(document.fileName)) return;
        if (document.isDirty) return window.showInformationMessage('请保存 HDL 源码后再添加笔记锚点。');
        try {
            const version = document.version;
            const title = await window.showInputBox({ title: '设计笔记标题', value: symbol ? '具名块说明' : '代码说明',
                validateInput: value => value.trim() && value.length <= 120 ? undefined : '请输入最多 120 个字符的标题' });
            if (title === undefined) return;
            if (document.version !== version) throw new Error('源码已更改，请重新选择锚点');
            const { start, end, active } = editor.selection;
            const anchor = anchors.anchorAt(relative(folder.uri.fsPath, document.uri.fsPath), document.getText(),
                document.offsetAt(symbol ? active : start), document.offsetAt(symbol ? active : end), symbol);
            const id = notes.makeId();
            await notes.add(folder.uri.fsPath, id, '# ' + title.trim() + '\n', { anchor });
            schedule();
            await showNote(folder, id);
        } catch (error) { window.showErrorMessage('SV Tools · ' + error.message); }
    }

    async function showNote(folder, id) {
        const uri = Uri.joinPath(folder.uri, history.notePath(id));
        return window.showTextDocument(await workspace.openTextDocument(uri), { viewColumn: vscode.ViewColumn.Beside });
    }

    const watcher = workspace.createFileSystemWatcher('**/docs/design-notes/*.svnote.*');
    const sources = workspace.createFileSystemWatcher(SOURCE_GLOB);
    const sourceChanged = uri => { if (!isExcludedSourcePath(uri.fsPath)) schedule(); };
    // 源码文件增删/重命名会改变 findFiles 结果：先失效缓存再重扫。
    const sourceListChanged = uri => { files.clear(); sourceChanged(uri); };
    context.subscriptions.push(decoration, watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule),
        sources, sources.onDidCreate(sourceListChanged), sources.onDidDelete(sourceListChanged), sources.onDidChange(sourceChanged),
        window.onDidChangeVisibleTextEditors(schedule), workspace.onDidRenameFiles(() => { files.clear(); schedule(); }),
        // 锚点只依赖已保存文本（未保存文档另有 overrides），保存时重扫即可，不再每次击键扫全工作区。
        workspace.onDidSaveTextDocument(document => { if (anchors.HDL.test(document.fileName)) schedule(); }),
        commands.registerCommand('svtools.note.linkSelection', () => create(false)),
        commands.registerCommand('svtools.note.linkBlock', () => create(true)),
        commands.registerCommand(OPEN, async (uri, id) => {
            if (typeof uri !== 'string' || typeof id !== 'string') return;
            const folder = workspace.getWorkspaceFolder(Uri.parse(uri));
            if (!folder) return;
            try { await showNote(folder, id); } catch (error) { window.showErrorMessage('SV Tools · ' + error.message); }
        }),
        languages.registerHoverProvider(SELECTORS, {
            async provideHover(document, position, cancellation) {
                const items = cache.get(document.uri.toString()) || [];
                const offset = document.offsetAt(position);
                const matched = items.filter(item => item.start <= offset && offset < item.end || document.positionAt(item.start).line === position.line);
                if (!matched.length) return;
                const folder = workspace.getWorkspaceFolder(document.uri);
                if (!folder) return;
                const content = [];
                for (const item of matched) {
                    const note = await history.readNote(folder.uri.fsPath, item.id);
                    if (cancellation.isCancellationRequested || note === undefined) continue;
                    const preview = new MarkdownString(note.slice(0, 16384));
                    preview.baseUri = Uri.joinPath(folder.uri, history.notePath(item.id));
                    const open = new MarkdownString('[打开设计笔记](command:' + OPEN + '?' +
                        encodeURIComponent(JSON.stringify([document.uri.toString(), item.id])) + ')');
                    open.isTrusted = { enabledCommands: [OPEN] };
                    content.push(preview, open);
                }
                if (content.length) return new Hover(content, new Range(document.positionAt(matched[0].start), document.positionAt(matched[0].end)));
            }
        }), { dispose() { disposed = true; clearTimeout(pending); } });
    schedule();
    return { idAt(document, position) {
        const offset = document.offsetAt(position);
        const matched = (cache.get(document.uri.toString()) || []).filter(item => item.start <= offset && offset < item.end);
        return matched.length === 1 ? matched[0].id : undefined;
    } };
}

module.exports = { activateNoteLinks };
