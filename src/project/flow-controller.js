'use strict';
const path = require('node:path');
const { CircuitSession } = require('../circuit/session');
const { prepareSourceRequest } = require('../circuit/source-request');
const { createCircuitSourceResolver } = require('../circuit/source-context');
const { runYosysCircuit } = require('../circuit/yosys-runner');
const { sourceHash, snapshotSources, sourceMatches } = require('../circuit/source-snapshots');
const { createSourceWatch } = require('../circuit/source-watch');
const { createToolTaskManager } = require('../toolchains/job');
/**
 * 工程追踪独立拥有一个惰性Worker和生成任务；不创建电路面板或运行ELK。
 * @param {{vscode:object,projects:object,sourceCatalog:object,onChange:Function}} dependencies
 * @returns {object} 显式追踪、有效定位和生命周期边界。
 */
function createProjectFlowController({ vscode, projects, sourceCatalog, onChange }) {
    const tasks = createToolTaskManager(), resolveSources = createCircuitSourceResolver({ vscode, sourceCatalog });
    const output = vscode.window.createOutputChannel('SV Tools · Project');
    let session, result, generation = 0, disposed = false, controller, selectedProject, pinned = false, identity, selectionGeneration = 0, activeContext;
    const watch = createSourceWatch({ vscode, onStale() {
            clear('源码发生变化，请重新追踪');
        } });
    function clear(message) {
        generation++;
        selectionGeneration++;
        identity = undefined;
        controller?.abort();
        controller = undefined;
        session?.dispose();
        session = undefined;
        result = undefined;
        selectedProject = undefined;
        activeContext = undefined;
        watch.replace([]);
        onChange({ flow: null, message });
    }
    async function trace(uri) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file' || !/\.(sv|v)$/i.test(editor.document.uri.fsPath)) {
            throw new Error('请在RTL编辑器中选中信号');
        }
        if (uri?.fsPath && path.resolve(uri.fsPath) !== path.resolve(editor.document.uri.fsPath)) {
            throw new Error('请在该文件的编辑器中选择信号');
        }
        const document = editor.document, text = document.getText(), offset = document.offsetAt(editor.selection.active);
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
        clear();
        activeContext = { id: project.id, key: project.key };
        const version = generation;
        session = new CircuitSession();
        const worker = session;
        controller = new AbortController();
        const signal = controller.signal;
        const task = tasks.start('project-flow'), abort = () => task.cancel('工程追踪已取消');
        signal.addEventListener('abort', abort, { once: true });
        try {
            const selection = await worker.request('traceSelection', { text, offset });
            let top = project.top;
            if (!top) {
                top = await vscode.window.showInputBox({ title: '选择工程追踪顶层', prompt: '输入包含当前信号实例的工程顶层；父级透传只在此顶层内追踪', value: selection.moduleName,
                    validateInput: value => /^[A-Za-z_$][\w$]*$/.test(value) ? undefined : '请输入普通模块标识符' });
            }
            if (!top || version !== generation) {
                return;
            }
            onChange({ flow: null, message: '正在分析工程信号走向…', busy: true });
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '分析工程信号走向 · Yosys', cancellable: true }, async (_, token) => {
                const cancellation = token.onCancellationRequested(() => {
                    abort();
                    worker.dispose();
                });
                try {
                    await task.waitForPrevious();
                    task.throwIfCancelled();
                    const config = vscode.workspace.getConfiguration('svtools.circuit', document.uri), outputBase = path.join(project.root, '.svtools', 'circuit');
                    const files = project.sets.filter(set => set.type === 'DesignSrcs').flatMap(set => set.files).filter(file => /\.(sv|v)$/i.test(file));
                    const options = await prepareSourceRequest({ document, root: project.root, top, task, outputBase, resolveSources,
                        config: { sources: files, includeDirs: [...project.includeDirs, ...config.get('includeDirs', [])], defines: [...project.defines, ...config.get('defines', [])], frontend: config.get('frontend', 'auto') } });
                    const sourceSnapshots = await snapshotSources(options);
                    watch.replace(sourceSnapshots);
                    const generated = await runYosysCircuit({ ...options, task, outputBase, executable: config.get('yosysPath', 'bundled'), timeoutMs: config.get('generationTimeout', 120) * 1000, onOutput: chunk => output.append(chunk) });
                    task.throwIfCancelled();
                    const design = await worker.request('load', { ...generated, top, sourceMap: options.sourceMap, sourceSnapshots });
                    const loadedIdentity = { designId: design.id, revision: design.revision };
                    const candidates = await worker.request('traceCandidates', { ...loadedIdentity, target: { ...selection, path: document.uri.fsPath, sourceHash: sourceHash(text) } });
                    if (candidates.truncated) {
                        throw new Error('信号实例超过预算，请缩小工程顶层');
                    }
                    if (!candidates.candidates.length) {
                        throw new Error(candidates.reason || '工具未保留所选信号');
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
                    task.throwIfCancelled();
                    if (version !== generation || disposed) {
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
                    if (version !== generation || disposed) {
                        return;
                    }
                    selectedProject = project.id;
                    identity = loadedIdentity;
                    result = { ...flow, sourceSnapshots, projectId: project.id, top, pinned, traceId: Date.now() + ':' + version };
                    task.retainDirectories(signal);
                    onChange({ flow: result, busy: false, message: flow.truncated ? '结果达到预算，详见提示' : undefined });
                }
                finally {
                    cancellation.dispose();
                }
            });
        }
        catch (error) {
            if (version === generation && !disposed) {
                clear();
                throw error;
            }
        }
        finally {
            signal.removeEventListener('abort', abort);
            await task.finish({ keepArtifacts: true });
            if (version === generation && !disposed && !result) {
                clear();
            }
            if (version === generation && !disposed) {
                onChange({ busy: false });
            }
        }
    }
    async function follow(editor) {
        if (!result || pinned || !session || editor.selection.isEmpty || editor.document.isDirty) {
            return;
        }
        const snapshot = result.sourceSnapshots.find(item => path.resolve(item.path).toLowerCase() === path.resolve(editor.document.uri.fsPath).toLowerCase());
        if (!snapshot) {
            return;
        }
        const text = editor.document.getText();
        if (sourceHash(text) !== snapshot.hash) {
            clear('源码已变化，请重新追踪');
            return;
        }
        const version = generation, sequence = ++selectionGeneration, worker = session, previous = result;
        let target;
        try {
            target = await worker.request('traceSelection', { text, offset: editor.document.offsetAt(editor.selection.active) });
        }
        catch (error) {
            if (sequence === selectionGeneration && version === generation) {
                onChange({ message: '该选择不能唯一映射到模块信号，请右键重新追踪' });
            }
            return;
        }
        if (sequence !== selectionGeneration || version !== generation || target.dynamicSelect) {
            return;
        }
        const candidates = await worker.request('traceCandidates', { ...identity, target: { ...target, path: editor.document.uri.fsPath, sourceHash: snapshot.hash } });
        if (sequence !== selectionGeneration || version !== generation) {
            return;
        }
        const same = candidates.candidates.filter(item => JSON.stringify(item.instancePath) === JSON.stringify(previous.origin.instancePath));
        const candidate = same.length === 1 ? same[0] : candidates.candidates.length === 1 ? candidates.candidates[0] : null;
        if (!candidate || candidates.truncated) {
            onChange({ message: '所选信号有多个实例或未被工具保留，请右键选择追踪上下文' });
            return;
        }
        const next = await worker.request('projectFlow', { ...identity, moduleId: candidate.moduleId, instancePath: candidate.instancePath, origin: { objectId: candidate.objectId, ...(target.indices ? { indices: target.indices } : {}) } });
        if (sequence !== selectionGeneration || version !== generation || disposed || pinned) {
            return;
        }
        result = { ...next, sourceSnapshots: previous.sourceSnapshots, projectId: previous.projectId, top: previous.top, pinned, traceId: Date.now() + ':' + sequence };
        onChange({ flow: result, message: undefined });
    }
    return { trace, clear, follow, projectChanged(current) {
            if (activeContext && (current?.id !== activeContext.id || current.key !== activeContext.key)) {
                clear('工程上下文已变化，重新追踪后显示标记');
            }
        }, get: () => result, setPinned(value) {
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
            output.dispose();
            tasks.dispose().catch(error => console.error(error));
        } };
}
module.exports = { createProjectFlowController };
