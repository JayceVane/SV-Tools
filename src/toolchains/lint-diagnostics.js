'use strict';
const path = require('node:path');
const { isGeneratedSourcePath } = require('../workspace/source-policy');
const MAX_CHANGED_FILES = 10000;
const fileKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

/** 诊断按物理文件索引；保留任务所有权与依赖关系，源码失效不再遗留其他 owner 的旧结果。 */
function createLintDiagnostics({ vscode, collection, currentFileOnly }) {
    const owners = new Map(), buckets = new Map(), dependents = new Map(), changed = new Map();
    let revision = 0, historyFloor = 0;
    function render(files) {
        for (const file of files) {
            const bucket = buckets.get(fileKey(file)), entries = new Map();
            for (const [ownerKey, findings] of bucket?.owners || []) {
                const owner = owners.get(ownerKey);
                for (const finding of findings) {
                    let line = Math.max(0, finding.line - 1), column = Math.max(0, (finding.column || 1) - 1);
                    const ownFile = fileKey(owner.document.uri.fsPath) === fileKey(file);
                    if (ownFile) line = Math.min(line, Math.max(0, owner.document.lineCount - 1));
                    const range = ownFile && !finding.column ? owner.document.lineAt(line).range
                        : new vscode.Range(line, column, line, column + 1);
                    const diagnostic = new vscode.Diagnostic(range, finding.message,
                        finding.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
                    diagnostic.source = finding.source || owner.source;
                    entries.set(JSON.stringify([line, column, finding.message, finding.severity, diagnostic.source]), diagnostic);
                }
            }
            collection.set(vscode.Uri.file(bucket?.file || file), [...entries.values()]);
        }
    }
    function unlink(key, forget) {
        const owner = owners.get(key), files = new Set();
        if (!owner) return files;
        for (const file of owner.visible.keys()) {
            const bucket = buckets.get(fileKey(file)); files.add(file);
            bucket?.owners.delete(key);
            if (!bucket?.owners.size) buckets.delete(fileKey(file));
        }
        owner.visible.clear();
        if (forget) {
            for (const file of owner.dependencies) {
                const roots = dependents.get(file); roots?.delete(key);
                if (!roots?.size) dependents.delete(file);
            }
            owners.delete(key);
        }
        return files;
    }
    function publish(document, findings, source, { sourceFiles = [], since = revision, logPath, documentVersion } = {}) {
        const mainFile = document.uri.fsPath, key = document.uri.toString(), mainKey = fileKey(mainFile);
        const usable = findings.filter(finding => !isGeneratedSourcePath(finding.file));
        const dependencies = new Set([mainKey, ...sourceFiles.filter(file => !isGeneratedSourcePath(file)).map(fileKey), ...usable.map(finding => fileKey(finding.file))]);
        if (since < historyFloor || [...dependencies].some(file => (changed.get(file) || 0) > since
            && !(file === mainKey && documentVersion !== undefined && documentVersion === document.version))) return false;
        const files = unlink(key, true), visible = new Map(); files.add(mainFile);
        for (const finding of findings) if (isGeneratedSourcePath(finding.file)) files.add(finding.file);
        const selected = currentFileOnly(document) ? usable.filter(finding => fileKey(finding.file) === mainKey) : [...usable];
        const hiddenErrors = usable.filter(finding => finding.severity === 'error' && fileKey(finding.file) !== mainKey).length;
        if (currentFileOnly(document) && hiddenErrors && !selected.some(finding => finding.severity === 'error')) selected.push({
            file: mainFile, line: 1, severity: 'error', source,
            message: `依赖文件存在 ${hiddenErrors} 个错误，请查看完整日志` + (logPath ? '：' + logPath : '')
        });
        for (const finding of selected) {
            const file = fileKey(finding.file) === mainKey ? mainFile : path.normalize(finding.file);
            if (!visible.has(file)) visible.set(file, []);
            visible.get(file).push(finding); files.add(file);
        }
        owners.set(key, { document, source, dependencies, visible });
        for (const file of dependencies) {
            if (!dependents.has(file)) dependents.set(file, new Set());
            dependents.get(file).add(key);
        }
        for (const [file, values] of visible) {
            if (!buckets.has(fileKey(file))) buckets.set(fileKey(file), { file, owners: new Map() });
            buckets.get(fileKey(file)).owners.set(key, values);
        }
        render(files); return true;
    }
    function invalidate(file) {
        const identity = fileKey(file), files = new Set([file]), documents = [];
        changed.delete(identity); changed.set(identity, ++revision);
        if (changed.size > MAX_CHANGED_FILES) {
            const oldest = changed.keys().next().value;
            historyFloor = changed.get(oldest); changed.delete(oldest);
        }
        for (const key of dependents.get(identity) || []) {
            documents.push(owners.get(key).document);
            for (const affected of unlink(key, false)) files.add(affected);
        }
        render(files); return documents;
    }
    function remove(document) {
        const files = unlink(document.uri.toString(), true); files.add(document.uri.fsPath); render(files);
    }
    const documentsFor = file => [...(dependents.get(fileKey(file)) || [])].map(key => owners.get(key).document);
    return { publish, invalidate, remove, documentsFor, revision: () => revision };
}

module.exports = { createLintDiagnostics, fileKey };
