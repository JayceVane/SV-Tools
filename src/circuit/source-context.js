'use strict';
const path = require('node:path');
const { CircuitSession } = require('./session');
const { SOURCE_EXCLUDE_GLOB } = require('../workspace/source-policy');
const { MAX_SCAN_FILES, MAX_SCAN_BYTES } = require('./source-dependencies');

/** @param {{vscode:object}} dependencies @returns {function} 将VS Code文件发现与可取消Worker依赖解析适配到源请求。 */
function createCircuitSourceResolver({ vscode }) {
    return async ({ current, root, top, sources, isExplicit, includeDirs, task }) => {
        task.throwIfCancelled();
        const documents = (vscode.workspace.textDocuments || []).filter(document => document.isDirty && document.uri.scheme === 'file' && /\.(?:sv|v)$/i.test(document.uri.fsPath))
            .map(document => ({ file: document.uri.fsPath, text: document.getText(), isDirty: true }));
        const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
        const overlays = new Map(documents.map(document => [key(document.file), document])); overlays.set(key(current.file), current);
        if (isExplicit || !vscode.workspace.findFiles) return { sources, documents: [...overlays.values()].filter(document => sources.some(file => key(file) === key(document.file))) };
        const scoped = [...overlays.values()].filter(document => { const relative = path.relative(root, document.file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); });
        if (scoped.reduce((sum, document) => sum + Buffer.byteLength(document.text, 'utf8'), 0) > MAX_SCAN_BYTES) throw new Error('未保存依赖正文超过32 MiB，请先保存或显式配置 sources');
        const session = new CircuitSession(), cancellation = vscode.CancellationTokenSource ? new vscode.CancellationTokenSource() : null;
        const abort = () => { cancellation?.cancel(); session.dispose(Object.assign(new Error('电路依赖扫描已取消'), { code: 'TOOL_CANCELLED' })); };
        task.signal?.addEventListener('abort', abort, { once: true });
        try {
            task.throwIfCancelled();
            const pattern = vscode.RelativePattern ? new vscode.RelativePattern(root, '**/*.{sv,v}') : '**/*.{sv,v}';
            const files = await vscode.workspace.findFiles(pattern, SOURCE_EXCLUDE_GLOB, MAX_SCAN_FILES + 1, cancellation?.token);
            task.throwIfCancelled();
            const resolved = await session.request('sourceClosure', { root, files: files.map(uri => uri.fsPath), current: current.file, top, includeDirs,
                documents: scoped.map(document => ({ file: document.file, text: document.text })) });
            task.throwIfCancelled();
            return { sources: resolved, documents: scoped.filter(document => resolved.some(file => key(file) === key(document.file))) };
        } finally { task.signal?.removeEventListener('abort', abort); cancellation?.dispose(); session.dispose(); }
    };
}
module.exports = { createCircuitSourceResolver };
