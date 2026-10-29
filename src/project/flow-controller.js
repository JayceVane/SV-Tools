'use strict';
const path = require('node:path');
const { CircuitSession } = require('../circuit/session');
const { sourceHash, sourceMatches } = require('../circuit/source-snapshots');
const { createSourceWatch } = require('../circuit/source-watch');
const { traceContext } = require('./trace-context');
/**
 * 工程追踪独立拥有一个惰性静态RTL Worker；不创建工具任务、临时网表或电路面板。
 * @param {{vscode:object,projects:object,onChange:Function}} dependencies
 * @returns {object} 显式追踪、有效定位和生命周期边界。
 */
function createProjectFlowController({ vscode, projects, onChange }) {
    let session, result, generation = 0, disposed = false, controller, selectedProject, pinned = false, identity, selectionGeneration = 0, activeContext;
    let pendingSelection, following, automaticSequence = 0;
    const cancelFollow = () => {
        automaticSequence++;
        pendingSelection = undefined;
    };
    const watch = createSourceWatch({ vscode, onStale() {
            clear('源码发生变化，请重新追踪');
        } });
    function clear(message, preserveSelection = false) {
        if (!preserveSelection) {
            cancelFollow();
        }
        generation++;
        selectionGeneration++;
        identity = undefined;
        controller?.abort();
        controller = undefined;
        session?.dispose();
        session = undefined;
        result = undefined;
        pinned = false;
        selectedProject = undefined;
        activeContext = undefined;
        watch.replace([]);
        onChange({ flow: null, message, busy: false });
    }
    async function trace(uri, { editor = vscode.window.activeTextEditor, automatic = false, isCurrent = () => true } = {}) {
        if (!editor || editor.document.uri.scheme !== 'file' || !/\.(sv|v|svh|vh)$/i.test(editor.document.uri.fsPath)) {
            throw new Error('请在RTL编辑器中选中信号');
        }
        if (uri?.fsPath && path.resolve(uri.fsPath) !== path.resolve(editor.document.uri.fsPath)) {
            throw new Error('请在该文件的编辑器中选择信号');
        }
        const document = editor.document, text = document.getText(), offset = document.offsetAt(editor.selection.isEmpty ? editor.selection.active : editor.selection.start);
        if (document.isDirty) {
            throw new Error('请先保存源码，再追踪工程信号走向');
        }
        const project = await projects.current();
        if (!project) {
            throw new Error('请先创建或选择工程');
        }
        if (!project.sets.some(set => set.files.some(file => path.resolve(file).toLowerCase() === path.resolve(document.uri.fsPath).toLowerCase()))) {
            throw new Error('当前源码不在活动工程中，请先添加文件或切换工程');
        }
        const members = new Set(project.sets.flatMap(set => set.files.map(file => path.resolve(file).toLowerCase())));
        if ((vscode.workspace.textDocuments || []).some(buffer => buffer.isDirty && buffer.uri.scheme === 'file' && members.has(path.resolve(buffer.uri.fsPath).toLowerCase()))) {
            throw new Error('请先保存工程中未保存的源文件，再生成工程信号走向');
        }
        if (!isCurrent() || disposed) {
            return;
        }
        clear(undefined, automatic);
        activeContext = { id: project.id, key: project.key };
        const version = generation;
        session = new CircuitSession({ workerFile: path.join(__dirname, 'rtl-worker.js') });
        const worker = session;
        const requestController = new AbortController();
        controller = requestController;
        const signal = requestController.signal;
        const throwIfCancelled = () => {
            if (signal.aborted) {
                throw Object.assign(new Error('工程追踪已取消'), { code: 'TOOL_CANCELLED' });
            }
        };
        const abort = () => worker.dispose(Object.assign(new Error('工程追踪已取消'), { code: 'TOOL_CANCELLED' }));
        signal.addEventListener('abort', abort, { once: true });
        try {
            const selection = await worker.request('traceSelection', { text, offset });
            const context = traceContext(project, document.uri.fsPath);
            if (version !== generation || !isCurrent()) {
                return;
            }
            onChange({ flow: null, message: '正在分析工程信号走向…', busy: true });
            const analyze = async (_, token) => {
                const cancellation = token.onCancellationRequested(() => {
                    requestController.abort();
                });
                try {
                    throwIfCancelled();
                    const config = vscode.workspace.getConfiguration('svtools.circuit', document.uri);
                    const design = await worker.request('loadRTL', { files: context.files, tops: context.tops, target: { ...selection, path: document.uri.fsPath },
                        includeDirs: [...project.includeDirs, ...config.get('includeDirs', []).map(directory => path.resolve(project.root, directory))], defines: [...project.defines, ...config.get('defines', [])] });
                    const sourceSnapshots = design.sourceSnapshots;
                    watch.replace(sourceSnapshots);
                    throwIfCancelled();
                    const loadedIdentity = { designId: design.id, revision: design.revision };
                    const candidates = await worker.request('traceCandidates', { ...loadedIdentity, target: { ...selection, path: document.uri.fsPath, sourceHash: sourceHash(text) } });
                    if (candidates.truncated) {
                        throw new Error('信号实例超过预算，请缩小工程顶层');
                    }
                    if (!candidates.candidates.length) {
                        throw new Error((candidates.reason || '静态模型未解析所选信号') + '\n' + design.issues.slice(1, 5).join('\n'));
                    }
                    if (automatic && candidates.candidates.length > 1) {
                        throw new Error('所选信号有多个实例，请右键“在工程中追踪信号”选择实例上下文');
                    }
                    const candidate = candidates.candidates.length === 1 ? candidates.candidates[0] : (await vscode.window.showQuickPick(candidates.candidates.map(candidate => ({ label: candidate.label, description: candidate.moduleName, candidate })), { title: '选择信号所属实例' }))?.candidate;
                    if (!candidate) {
                        return;
                    }
                    if (selection.dynamicSelect) {
                        throw new Error('动态下标无法确定具体位，请选择信号声明或常量切片');
                    }
                    const flow = await worker.request('projectFlow', { ...loadedIdentity, moduleId: candidate.moduleId, instancePath: candidate.instancePath,
                        origin: { objectId: candidate.objectId, ...(selection.indices ? { indices: selection.indices } : {}) } });
                    throwIfCancelled();
                    if (version !== generation || disposed || !isCurrent()) {
                        return;
                    }
                    const current = await projects.current();
                    if (version !== generation || current?.id !== project.id || current.key !== project.key) {
                        throw new Error('工程已切换或成员已变化，请重新追踪');
                    }
                    for (const snapshot of sourceSnapshots)
                        if (!await sourceMatches(snapshot.path, snapshot.hash)) {
                            throw new Error('源码在分析期间变化，请保存后重试');
                        }
                    if (document.isClosed || sourceHash(document.getText()) !== sourceHash(text)) {
                        throw new Error('选中源码已变化，请重新选择');
                    }
                    if (version !== generation || disposed || !isCurrent()) {
                        return;
                    }
                    selectedProject = project.id;
                    identity = loadedIdentity;
                    result = { ...flow, sourceSnapshots, projectId: project.id, top: design.top, contextKey: JSON.stringify(context), contextKind: context.kind, rootFallback: design.fallback, pinned, traceId: Date.now() + ':' + version };
                    onChange({ flow: result, busy: false, message: flow.truncated ? '结果达到预算，详见提示' : undefined });
                }
                finally {
                    cancellation.dispose();
                }
            };
            if (automatic) {
                await analyze(null, { onCancellationRequested: () => ({ dispose() {
                        } }) });
            }
            else {
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '分析工程信号走向 · 静态RTL', cancellable: true }, analyze);
            }
        }
        catch (error) {
            if (version === generation && !disposed) {
                clear(undefined, automatic);
                throw error;
            }
        }
        finally {
            signal.removeEventListener('abort', abort);
            if (version === generation && !disposed && !result) {
                clear(undefined, automatic);
            }
            if (version === generation && !disposed) {
                onChange({ busy: false });
            }
        }
    }
    async function followSelection(editor, isCurrent) {
        if (pinned || !isCurrent()) {
            return;
        }
        const project = await projects.current();
        if (!isCurrent()) {
            return;
        }
        if (!result || !session || project?.id !== result.projectId || activeContext?.key !== project?.key
            || JSON.stringify(traceContext(project, editor.document.uri.fsPath)) !== result.contextKey) {
            return trace(undefined, { editor, automatic: true, isCurrent });
        }
        if (editor.document.isDirty) {
            onChange({ message: '保存源码后重新选择信号以追踪' });
            return;
        }
        const snapshot = result.sourceSnapshots.find(item => path.resolve(item.path).toLowerCase() === path.resolve(editor.document.uri.fsPath).toLowerCase());
        if (!snapshot) {
            return trace(undefined, { editor, automatic: true, isCurrent });
        }
        const text = editor.document.getText();
        if (sourceHash(text) !== snapshot.hash) {
            clear('源码已变化，请重新追踪');
            return;
        }
        const version = generation, sequence = ++selectionGeneration, worker = session, previous = result;
        let target;
        try {
            target = await worker.request('traceSelection', { text, offset: editor.document.offsetAt(editor.selection.start) });
        }
        catch (error) {
            if (sequence === selectionGeneration && version === generation && isCurrent()) {
                onChange({ message: '该选择不能唯一映射到模块信号，请右键重新追踪' });
            }
            return;
        }
        if (sequence !== selectionGeneration || version !== generation || target.dynamicSelect || !isCurrent()) {
            return;
        }
        if (!await worker.request('containsTarget', { ...identity, target: { ...target, path: editor.document.uri.fsPath } })) {
            if (isCurrent()) {
                return trace(undefined, { editor, automatic: true, isCurrent });
            }
            return;
        }
        const candidates = await worker.request('traceCandidates', { ...identity, target: { ...target, path: editor.document.uri.fsPath, sourceHash: snapshot.hash } });
        if (sequence !== selectionGeneration || version !== generation || !isCurrent()) {
            return;
        }
        const same = candidates.candidates.filter(item => JSON.stringify(item.instancePath) === JSON.stringify(previous.origin.instancePath));
        const candidate = same.length === 1 ? same[0] : candidates.candidates.length === 1 ? candidates.candidates[0] : null;
        if (!candidate || candidates.truncated) {
            onChange({ message: '所选信号有多个实例或静态连接不确定，仍显示此前追踪；请右键选择上下文' });
            return;
        }
        const next = await worker.request('projectFlow', { ...identity, moduleId: candidate.moduleId, instancePath: candidate.instancePath, origin: { objectId: candidate.objectId, ...(target.indices ? { indices: target.indices } : {}) } });
        if (sequence !== selectionGeneration || version !== generation || disposed || pinned || !isCurrent()) {
            return;
        }
        if (editor.document.isClosed || editor.document.isDirty || sourceHash(editor.document.getText()) !== snapshot.hash) {
            clear('源码已变化，请保存后重新选择信号');
            return;
        }
        result = { ...previous, ...next, pinned, traceId: Date.now() + ':' + sequence };
        onChange({ flow: result, message: undefined });
    }
    function follow(editor) {
        const sequence = ++automaticSequence;
        pendingSelection = undefined;
        if (disposed || pinned || !editor || editor.document.uri.scheme !== 'file' || !/\.(sv|v|svh|vh)$/i.test(editor.document.uri.fsPath)
            || editor.selection.isEmpty || !/^\s*[A-Za-z_$][\w$]*(?:\s*\[\s*-?\d+(?:\s*:\s*-?\d+)?\s*\])?\s*$/.test(editor.document.getText(editor.selection))) {
            return following;
        }
        pendingSelection = { editor: { document: editor.document, selection: editor.selection }, sequence };
        return drainSelections();
    }
    function drainSelections() {
        if (!following) {
            following = (async () => {
                while (pendingSelection && !disposed) {
                    const next = pendingSelection;
                    pendingSelection = undefined;
                    const isCurrent = () => next.sequence === automaticSequence && !disposed && !pinned;
                    try {
                        await followSelection(next.editor, isCurrent);
                    }
                    catch (error) {
                        if (isCurrent() && error.code !== 'TOOL_CANCELLED') {
                            onChange({ message: error.message, busy: false });
                        }
                    }
                }
            })().finally(() => {
                following = undefined;
                if (pendingSelection && !disposed) {
                    return drainSelections();
                }
            });
        }
        return following;
    }
    return { trace, clear, follow, cancelFollow, projectChanged(current) {
            if (activeContext && (current?.id !== activeContext.id || current.key !== activeContext.key)) {
                clear('工程上下文已变化，重新追踪后显示标记');
            }
        }, get: () => result, setPinned(value) {
            cancelFollow();
            pinned = !!value;
            selectionGeneration++;
            if (result) {
                result.pinned = pinned;
            }
            onChange({ flow: result });
        },
        async locate(source) {
            if (!result || !source?.path || selectedProject !== (await projects.current())?.id) {
                throw new Error('追踪结果已失效');
            }
            const snapshot = result.sourceSnapshots.find(item => path.resolve(item.path).toLowerCase() === path.resolve(source.path).toLowerCase());
            if (!snapshot || !await sourceMatches(source.path, snapshot.hash)) {
                clear('源码已变化，请重新追踪');
                throw new Error('源码已变化，不能使用旧位置');
            }
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source.path));
            if (sourceHash(document.getText()) !== snapshot.hash) {
                clear('源码已变化，请重新追踪');
                throw new Error('编辑器正文与追踪快照不同');
            }
            const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
            const position = new vscode.Position(Math.max(0, (source.line || 1) - 1), Math.max(0, (source.column || 1) - 1));
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position));
        },
        dispose() {
            disposed = true;
            clear();
            watch.dispose();
        } };
}
module.exports = { createProjectFlowController };
