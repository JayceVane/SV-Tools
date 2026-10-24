'use strict';
const path = require('node:path');
const { SOURCE_EXCLUDE_GLOB, isExcludedSourcePath } = require('./source-policy');
const SOURCE_GLOB = '**/*.{v,sv,vh,svh}', MAX_FILES = 50000, TTL_MS = 10000, MAX_ROOTS = 32;
const keyOf = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

/**
 * 共享源码清单，不共享工具语义：调用者继续拥有解析、正文与资源预算。
 * @param {{vscode:object,getPreferred?:Function,now?:Function}} deps
 * @returns {{discover:Function,invalidate:Function,onDidChange:Function,dispose:Function}} 有界路径缓存及变更通知。
 */
function createSourceCatalog({ vscode, getPreferred, now = Date.now }) {
    const cache = new Map(), listeners = new Set(), subscriptions = [];
    let generation = 0, disposed = false;
    function refreshContext(change = { kind: 'context' }) { for (const listener of listeners) listener(change); }
    function invalidate(change) {
        if (change?.kind !== 'change' || /\.xpr$/i.test(change.uri?.fsPath || '')) { generation++; cache.clear(); }
        refreshContext(change);
    }
    function onDidChange(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }
    async function discover({ root, file, extensions = ['sv','v','svh','vh'], limit = MAX_FILES, token, force = false, preferProject = true } = {}) {
        if (disposed) throw new Error('源码清单服务已关闭');
        if (force) invalidate();
        const preferred = preferProject && getPreferred ? await getPreferred({ root, file: file || vscode.window?.activeTextEditor?.document.uri.fsPath }) : null;
        let uris, truncated = false;
        if (preferred) {
            uris = preferred.files.map(file => vscode.Uri.file(file));
        } else {
            const key = root ? keyOf(root) : '$workspace', revision = generation;
            let entry = cache.get(key);
            if (!entry || entry.expiresAt <= now()) {
                const pattern = root && vscode.RelativePattern ? new vscode.RelativePattern(root, SOURCE_GLOB) : SOURCE_GLOB;
                entry = { expiresAt: now() + TTL_MS };
                // 取消只影响等待方；共用发现不会被另一消费者的 token 终止。
                entry.pending = Promise.resolve(vscode.workspace.findFiles(pattern, SOURCE_EXCLUDE_GLOB, MAX_FILES + 1)).catch(error => {
                    if (cache.get(key) === entry) cache.delete(key); throw error;
                });
                cache.set(key, entry);
                if (cache.size > MAX_ROOTS) cache.delete(cache.keys().next().value);
            }
            uris = await entry.pending; truncated = uris.length > MAX_FILES || generation !== revision;
        }
        const allowed = new Set(extensions.map(extension => '.' + extension.toLowerCase())), found = new Map();
        for (const uri of uris) if (!isExcludedSourcePath(uri.fsPath) && allowed.has(path.extname(uri.fsPath).toLowerCase())) found.set(keyOf(uri.fsPath), uri);
        const budget = Math.min(MAX_FILES, Math.max(1, limit));
        return { uris: token?.isCancellationRequested ? [] : [...found.values()].slice(0, budget),
            truncated: truncated || found.size > budget || !!token?.isCancellationRequested, provenance: preferred ? 'project' : 'workspace', roots: preferred?.roots };
    }
    if (vscode.workspace.createFileSystemWatcher) {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{v,sv,vh,svh,xpr}');
        for (const event of ['onDidCreate','onDidChange','onDidDelete']) subscriptions.push(watcher[event](uri => invalidate({ uri, kind: event === 'onDidCreate' ? 'create' : event === 'onDidDelete' ? 'delete' : 'change' })));
        subscriptions.push(watcher);
    }
    for (const event of ['onDidChangeWorkspaceFolders','onDidChangeConfiguration']) if (vscode.workspace[event]) subscriptions.push(vscode.workspace[event](() => invalidate()));
    if (vscode.window?.onDidChangeActiveTextEditor) subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => refreshContext()));
    return { discover, invalidate, refreshContext, onDidChange, dispose() { disposed = true; generation++; cache.clear(); listeners.clear(); subscriptions.forEach(subscription => subscription.dispose()); } };
}
module.exports = { createSourceCatalog, SOURCE_GLOB };
