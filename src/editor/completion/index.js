'use strict';

const path = require('node:path');
const { parseDocument } = require('./syntax');
const SOURCE_GLOB = '**/*.{v,sv,vh,svh}';
const { SOURCE_EXCLUDE_GLOB: EXCLUDE_GLOB, isExcludedSourcePath } = require('../../workspace/source-policy');
const keyOf = uri => uri.toString();

/** 工程语义缓存只读取 HDL 文本，脏文档始终优先；文件事件逐项失效。 */
function createCompletionIndex({ vscode, onError = console.warn, sourceCatalog }) {
    const records = new Map();
    let fileUris = [], pending = null, dirty = true, needsDiscovery = true, generation = 0, incomplete = false, discoveryIncomplete = false, projectScoped = false;
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
        if (!isExcludedSourcePath(document.uri.fsPath)) records.set(key, record);
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
        const changed = (uri, kind) => {
            invalidate(uri, kind !== 'change');
            // RelativePattern 可能位于工作区外，必须同时使共享路径清单失效。
            sourceCatalog?.invalidate({ uri, kind });
        };
        target.push(watcher.onDidCreate(uri => changed(uri, 'create')), watcher.onDidDelete(uri => changed(uri, 'delete')),
            watcher.onDidChange(uri => changed(uri, 'change')), watcher);
    }

    function rebuildIncludeWatchers(patterns) {
        includeSubscriptions.forEach(subscription => subscription.dispose());
        includeSubscriptions = [];
        if (vscode.workspace.createFileSystemWatcher) for (const pattern of patterns.slice(1)) watch(pattern, includeSubscriptions);
    }

    async function discover(token, document) {
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
        incomplete = false; projectScoped = false;
        for (const pattern of patterns) {
            if (token?.isCancellationRequested) { incomplete = true; break; }
            try {
                const shared = sourceCatalog ? await sourceCatalog.discover({ root: typeof pattern === 'string' ? undefined : pattern.baseUri?.fsPath || pattern.base,
                    limit, token, file: document?.uri.fsPath, preferProject: typeof pattern === 'string' }) : null;
                if (shared?.truncated) incomplete = true;
                if (typeof pattern === 'string') projectScoped = shared?.provenance === 'project';
                const uris = shared ? shared.uris : await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, limit + 1, token);
                for (const uri of uris) if (!isExcludedSourcePath(uri.fsPath)) found.set(keyOf(uri), uri);
            } catch (error) {
                incomplete = true;
                onError('补全索引扫描失败：' + error.message);
            }
        }
        if (found.size > limit) incomplete = true;
        discoveryIncomplete = incomplete;
        return [...found.values()].slice(0, limit);
    }

    async function scan(token, document) {
        const revision = generation;
        if (needsDiscovery) {
            fileUris = await discover(token, document);
            needsDiscovery = generation !== revision || !!token?.isCancellationRequested;
        }
        incomplete = discoveryIncomplete;
        const liveKeys = new Set(fileUris.map(keyOf));
        for (const document of openDocuments()) {
            if (['verilog', 'systemverilog'].includes(document.languageId) && !isExcludedSourcePath(document.uri.fsPath) && (!projectScoped || liveKeys.has(keyOf(document.uri)))) {
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
        // 文件事件可能在异步读取中抵达；最多重试两次，持续编辑时仍明确返回不完整状态。
        for (let attempt = 0; attempt < 3; attempt++) {
            if (dirty && !pending) pending = scan(token, document).finally(() => { pending = null; });
            if (pending) await pending;
            if (!dirty || token?.isCancellationRequested) break;
        }
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
    if (sourceCatalog) subscriptions.push(sourceCatalog.onDidChange(change => {
        if (change?.uri && /\.(?:sv|v|svh|vh)$/i.test(change.uri.fsPath)) invalidate(change.uri, change.kind !== 'change');
        else invalidate();
    }));
    return { snapshot, update, invalidate, dispose() { subscriptions.concat(includeSubscriptions).forEach(subscription => subscription.dispose()); records.clear(); } };
}

module.exports = { createCompletionIndex, SOURCE_GLOB, EXCLUDE_GLOB };
