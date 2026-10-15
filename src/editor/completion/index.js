'use strict';

const path = require('node:path');
const { parseDocument } = require('./syntax');
const SOURCE_GLOB = '**/*.{v,sv,vh,svh}';
const { SOURCE_EXCLUDE_GLOB: EXCLUDE_GLOB } = require('../../workspace/source-policy');
const keyOf = uri => uri.toString();

/** 工程语义缓存只读取 HDL 文本，脏文档始终优先；文件事件逐项失效。 */
function createCompletionIndex({ vscode, onError = console.warn }) {
    const records = new Map();
    let fileUris = [], pending = null, dirty = true, needsDiscovery = true, generation = 0, incomplete = false, discoveryIncomplete = false;
    const subscriptions = [];
    let includeSubscriptions = [];
    const config = () => vscode.workspace.getConfiguration('svtools.completion');
    const bounded = (name, fallback, min, max) => Math.max(min, Math.min(max, Number(config().get(name, fallback)) || fallback));
    const openDocuments = () => vscode.workspace.textDocuments || [];

    function update(document) {
        const key = keyOf(document.uri), previous = records.get(key);
        if (previous?.version === document.version && previous.document === document) return previous;
        const text = document.getText();
        const record = { uri: document.uri, model: parseDocument(text), document, version: document.version, bytes: Buffer.byteLength(text) };
        records.set(key, record);
        return record;
    }

    function invalidate(uri, discoverFiles = true) {
        generation++;
        if (uri) records.delete(keyOf(uri));
        else records.clear();
        dirty = true;
        needsDiscovery ||= discoverFiles;
    }

    function watch(pattern, target) {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        target.push(watcher.onDidCreate(uri => invalidate(uri)), watcher.onDidDelete(uri => invalidate(uri)), watcher.onDidChange(uri => invalidate(uri, false)), watcher);
    }

    function rebuildIncludeWatchers(patterns) {
        includeSubscriptions.forEach(subscription => subscription.dispose());
        includeSubscriptions = [];
        if (vscode.workspace.createFileSystemWatcher) for (const pattern of patterns.slice(1)) watch(pattern, includeSubscriptions);
    }

    async function discover(token) {
        const limit = bounded('maxFiles', 5000, 1, 50000);
        const patterns = [SOURCE_GLOB];
        for (const directory of config().get('includePaths', [])) {
            if (typeof directory !== 'string' || !directory.trim() || !vscode.RelativePattern) continue;
            for (const folder of vscode.workspace.workspaceFolders || []) {
                const expanded = directory.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
                const base = path.isAbsolute(expanded) ? expanded : path.resolve(folder.uri.fsPath, expanded);
                patterns.push(new vscode.RelativePattern(base, SOURCE_GLOB));
            }
        }
        rebuildIncludeWatchers(patterns);
        const found = new Map();
        incomplete = false;
        for (const pattern of patterns) {
            if (token?.isCancellationRequested) { incomplete = true; break; }
            try {
                const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, limit + 1, token);
                for (const uri of uris) found.set(keyOf(uri), uri);
            } catch (error) {
                incomplete = true;
                onError('补全索引扫描失败：' + error.message);
            }
        }
        if (found.size > limit) incomplete = true;
        discoveryIncomplete = incomplete;
        return [...found.values()].slice(0, limit);
    }

    async function scan(token) {
        const revision = generation;
        if (needsDiscovery) {
            fileUris = await discover(token);
            needsDiscovery = generation !== revision || !!token?.isCancellationRequested;
        }
        incomplete = discoveryIncomplete;
        const liveKeys = new Set(fileUris.map(keyOf));
        for (const document of openDocuments()) {
            if (['verilog', 'systemverilog'].includes(document.languageId)) {
                update(document); liveKeys.add(keyOf(document.uri));
            }
        }
        for (const key of records.keys()) if (!liveKeys.has(key)) records.delete(key);
        const maxBytes = bounded('maxTotalSourceMB', 32, 1, 1024) * 1024 * 1024;
        const maxFile = bounded('maxFileSizeKB', 2048, 1, 65536) * 1024;
        let bytes = [...records.values()].reduce((total, record) => total + record.bytes, 0);
        // 顺序读取保证预算严格可控；每批让出事件循环，取消与编辑事件可及时生效。
        for (let i = 0; i < fileUris.length; i++) {
            if (token?.isCancellationRequested || generation !== revision) { incomplete = true; break; }
            const uri = fileUris[i], key = keyOf(uri);
            if (records.has(key)) continue;
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.size > maxFile || bytes + stat.size > maxBytes) { incomplete = true; continue; }
                const data = await vscode.workspace.fs.readFile(uri);
                if (data.length > maxFile || bytes + data.length > maxBytes) { incomplete = true; continue; }
                const model = parseDocument(Buffer.from(data).toString('utf8'));
                if (generation !== revision) { incomplete = true; break; }
                records.set(key, { uri, model, bytes: data.length }); bytes += data.length;
            } catch (error) {
                incomplete = true;
                onError('补全索引读取 ' + key + ' 失败：' + error.message);
            }
            if (i % 16 === 15) await new Promise(resolve => setImmediate(resolve));
        }
        dirty = generation !== revision || !!token?.isCancellationRequested;
    }

    async function snapshot(document, token) {
        update(document);
        if (dirty && !pending) pending = scan(token).finally(() => { pending = null; });
        if (pending) await pending;
        const current = update(document);
        return { current, records: [...records.values()], fileUris, incomplete: incomplete || dirty };
    }

    function listen(name, handler) {
        if (vscode.workspace[name]) subscriptions.push(vscode.workspace[name](handler));
    }
    listen('onDidChangeTextDocument', event => {
        if (['verilog', 'systemverilog'].includes(event.document.languageId)) {
            records.delete(keyOf(event.document.uri)); generation++; dirty = true;
        }
    });
    listen('onDidCloseTextDocument', document => invalidate(document.uri, false));
    listen('onDidChangeWorkspaceFolders', () => invalidate());
    listen('onDidChangeConfiguration', event => {
        if (event.affectsConfiguration('svtools.completion')) invalidate();
    });
    if (vscode.workspace.createFileSystemWatcher) {
        watch(SOURCE_GLOB, subscriptions);
    }
    return { snapshot, update, invalidate, dispose() { subscriptions.concat(includeSubscriptions).forEach(subscription => subscription.dispose()); records.clear(); } };
}

module.exports = { createCompletionIndex, SOURCE_GLOB, EXCLUDE_GLOB };
