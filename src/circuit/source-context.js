'use strict';
const path = require('node:path');
const { CircuitSession } = require('./session');
const { maskSourceText } = require('../workspace/sources');
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
        function selectedDocuments(files) {
            const selected = [...overlays.values()].filter(document => files.some(file => key(file) === key(document.file)));
            // 搬移依赖正文会改变局部include的搜索起点；无法复刻该上下文时必须明确拒绝。
            for (const document of selected) if (document.isDirty && key(document.file) !== key(current.file) && /`include\b/.test(maskSourceText(document.text))) {
                throw new Error('依赖文件尚未保存且包含 include，请先保存以保留头文件解析上下文：' + document.file);
            }
            return selected;
        }
        if (isExplicit || !vscode.workspace.findFiles) return { sources, documents: selectedDocuments(sources) };
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
            return { sources: resolved, documents: selectedDocuments(resolved) };
        } finally { task.signal?.removeEventListener('abort', abort); cancellation?.dispose(); session.dispose(); }
    };
}
module.exports = { createCircuitSourceResolver };
