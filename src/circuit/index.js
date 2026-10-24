'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { createToolTaskManager } = require('../toolchains/job');
const { createBufferedOutput } = require('../toolchains/channel');
const { runYosysCircuit } = require('./yosys-runner');
const { prepareSourceRequest } = require('./source-request');
const { createCircuitSourceResolver } = require('./source-context');
const { CircuitSession } = require('./session');
const { bindCircuitPanel } = require('./host');
const { createImageFiles } = require('../graphics/image-files');
const { createCircuitHtml } = require('./view');

/** @param {string} file @param {string[]} roots @returns {boolean} 用户选择的设计与工作区决定源码定位范围。 */
function insideRoots(file, roots) {
    return roots.some(root => {
        const relative = path.relative(path.resolve(root), path.resolve(file));
        return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    });
}

/** @param {object} context @param {{vivado:object,vscode?:object}} dependencies @returns {object} 注册电路数据入口及面板生命周期。 */
function activateCircuitViewer(context, { vivado, sourceCatalog, vscode = require('vscode') }) {
    const manager = createToolTaskManager();
    const resolveSources = createCircuitSourceResolver({ vscode, sourceCatalog });
    const channel = vscode.window.createOutputChannel('SV Tools · Circuit');
    const output = createBufferedOutput(channel);
    const panels = new Set();
    const scans = new Set();
    const rootOf = uri => vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || path.dirname(uri.fsPath);
    const settings = uri => vscode.workspace.getConfiguration('svtools.circuit', uri);
    const fail = error => {
        if (error.code === 'TOOL_CANCELLED') return;
        output.append(error.message + '\n'); output.flush();
        vscode.window.showErrorMessage('电路查看：' + error.message);
    };

    async function scanTop(document) {
        const text = document.getText();
        if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw new Error('RTL 顶层扫描超过 16 MiB，请配置电路 top');
        const session = new CircuitSession();
        scans.add(session);
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '读取 RTL 顶层', cancellable: true },
            async (_, token) => {
                const cancel = token.onCancellationRequested(() => session.dispose(Object.assign(new Error('顶层扫描已取消'), { code: 'TOOL_CANCELLED' })));
                try { return await session.request('topCandidates', { text }); }
                finally { cancel.dispose(); session.dispose(); scans.delete(session); }
            });
    }

    async function rtlDocument(uri) {
        const document = uri?.fsPath ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
        if (!document || document.uri.scheme !== 'file' || !/\.(?:sv|v)$/i.test(document.uri.fsPath)) {
            throw new Error('请先保存并打开 Verilog/SystemVerilog RTL 文件');
        }
        return document;
    }

    async function chooseFileTop(document) {
        const candidates = await scanTop(document);
        if (!candidates.length) throw new Error('当前文件没有可识别的模块，无法选择 Vivado 顶层');
        const fileName = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
        const sameName = candidates.find(candidate => candidate.name === fileName);
        if (sameName) return sameName.name;
        if (candidates.length === 1) return candidates[0].name;
        const chosen = await vscode.window.showQuickPick(candidates.map(candidate => ({ label: candidate.name, value: candidate.name })),
            { placeHolder: '选择当前文件中要查看的 Vivado 顶层模块' });
        return chosen?.value;
    }

    function requireSavedVivadoFile(document) {
        if (document.isDirty) throw new Error('请先保存当前 RTL，再用 Vivado 查看；未保存内容可使用内置 Yosys');
    }

    async function selectedVivadoProject() {
        const projectPath = await vivado.projectSelection.current();
        if (!projectPath) throw new Error('请先在 Vivado 面板选择工程');
        const bin = vivado.resolveBinDir();
        if (!bin) throw new Error('未找到 Vivado，请配置 svtools.vivado.path');
        return { projectPath, bin, root: rootOf(vscode.Uri.file(projectPath)) };
    }

    async function runJob(title, runner, signal) {
        const task = manager.start('circuit');
        const abort = () => task.cancel('电路页面已关闭或刷新');
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true },
            async (_, token) => {
                const cancellation = token.onCancellationRequested(() => task.cancel('用户取消电路生成'));
                try { await task.waitForPrevious(); return await runner(task); }
                finally {
                    signal?.removeEventListener('abort', abort);
                    cancellation.dispose(); output.flush(); await task.finish({ keepArtifacts: true });
                }
            });
    }

    function open(load, roots) {
        const panel = vscode.window.createWebviewPanel('svtoolsCircuit', '电路结构', vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
        const binding = bindCircuitPanel({ panel, load, imageFiles: createImageFiles({ vscode }), onError: fail, async onSource(source) {
            const realFile = await fs.realpath(source.path);
            const realRoots = await Promise.all(roots.map(root => fs.realpath(root)));
            if (!insideRoots(realFile, realRoots)) throw new Error('源码位置不在当前设计或工作区范围内');
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(realFile));
            const editor = await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.One });
            const line = Math.max(0, Math.min(document.lineCount - 1, source.line - 1));
            const column = Math.max(0, Math.min(document.lineAt(line).text.length, (source.column || 1) - 1));
            const position = new vscode.Position(line, column);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position));
        } });
        const handle = { ...binding, dispose() { binding.dispose(); panel.dispose(); } };
        panels.add(handle);
        panel.onDidDispose(() => panels.delete(handle));
        panel.webview.html = createCircuitHtml({ webview: panel.webview, extensionUri: context.extensionUri });
        return handle;
    }

    async function fromSource(uri) {
        const document = await rtlDocument(uri);
        const config = settings(document.uri);
        let top = config.get('top', '');
        if (!top) {
            const candidates = await scanTop(document);
            if (!candidates.length) throw new Error('当前文件没有可识别的普通模块名，请配置 svtools.circuit.top 和 sources');
            if (candidates.length === 1) top = candidates[0].name;
            else {
                const chosen = await vscode.window.showQuickPick(candidates.map(item => ({ label: item.name, value: item.name })),
                    { placeHolder: '选择要查看的 RTL 顶层模块' });
                if (!chosen) return;
                top = chosen.value;
            }
        }
        const root = rootOf(document.uri), outputBase = path.join(root, '.svtools', 'circuit');
        const roots = [root, path.dirname(document.uri.fsPath), ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath)];
        return open(({ signal }) => runJob('生成 RTL 电路 · Yosys', async task => {
            const options = await prepareSourceRequest({ document, root, top, task, outputBase, resolveSources,
                config: Object.fromEntries(['sources', 'includeDirs', 'defines', 'frontend'].map(key => [key, config.get(key)])) });
            for (const file of options.sources) if (!insideRoots(file, [root])) {
                if (!roots.includes(path.dirname(file))) roots.push(path.dirname(file));
            }
            for (const directory of options.includeDirs) if (!roots.includes(directory)) roots.push(directory);
            const result = await runYosysCircuit({ ...options, task, outputBase,
                executable: config.get('yosysPath', 'bundled'), timeoutMs: config.get('generationTimeout', 120) * 1000,
                onOutput: output.append });
            return { ...result, format: 'yosys', stage: 'rtl', top, title: options.title, sourceMap: options.sourceMap };
        }, signal), roots);
    }

    function openVivado({ projectPath, bin, root, document, top }) {
        const sourcePath = document?.uri.fsPath;
        const roots = [root, path.dirname(projectPath)];
        if (sourcePath) roots.push(path.dirname(sourcePath));
        return open(({ signal }) => runJob(document ? '生成当前文件电路 · Vivado RTL' : '生成工程电路 · Vivado RTL', async task => {
            // 刷新时再次检查，避免用户编辑后仍显示磁盘上的旧正文。
            if (document) requireSavedVivadoFile(document);
            const { runVivadoCircuit } = require('./vivado-runner');
            const result = await runVivadoCircuit({ task, projectPath, top, sourcePath,
                executable: path.join(bin, process.platform === 'win32' ? 'vivado.bat' : 'vivado'),
                outputBase: path.join(root, '.svtools', 'circuit'), timeoutMs: settings(document?.uri).get('generationTimeout', 120) * 1000,
                onOutput: output.append });
            return { ...result, format: 'vivado', title: sourcePath ? path.basename(sourcePath) + ' · ' + top : path.basename(projectPath) };
        }, signal), roots);
    }

    async function fromVivado() {
        return openVivado(await selectedVivadoProject());
    }

    async function fromVivadoFile(uri) {
        const document = await rtlDocument(uri);
        requireSavedVivadoFile(document);
        const project = await selectedVivadoProject();
        const top = await chooseFileTop(document);
        if (!top) return;
        return openVivado({ ...project, document, top });
    }

    async function openNetlist(uri) {
        if (!uri?.fsPath) uri = (await vscode.window.showOpenDialog({ canSelectMany: false,
            filters: { 'Yosys / SV Tools Vivado JSON': ['json'] }, title: '选择电路网表 JSON' }))?.[0];
        if (!uri) return;
        const root = rootOf(uri);
        return open(() => ({ filePath: uri.fsPath, sourceRoot: root,
            top: settings(uri).get('top', '') || undefined }), [root, path.dirname(uri.fsPath)]);
    }

    /** @param {object} [uri] 编辑器右键传入的资源；RTL 先生成，JSON 才直接导入。 */
    function openCircuit(uri) {
        return /\.(?:sv|v)$/i.test(uri?.fsPath || '') ? fromSource(uri) : openNetlist(uri);
    }

    function stop() {
        manager.cancelAll('用户停止电路生成');
        for (const scan of scans) scan.dispose(Object.assign(new Error('顶层扫描已取消'), { code: 'TOOL_CANCELLED' }));
        scans.clear();
    }
    const commands = { open: openCircuit, fromSource, fromVivado, fromVivadoFile, stop };
    for (const [name, action] of Object.entries(commands)) {
        context.subscriptions.push(vscode.commands.registerCommand('svtools.circuit.' + name,
            (...args) => Promise.resolve().then(() => action(...args)).catch(fail)));
    }
    context.subscriptions.push(channel, output, { dispose() {
        for (const panel of panels) panel.dispose();
        panels.clear(); stop(); manager.dispose().catch(fail);
    } });
    return { fromSource, fromVivado, fromVivadoFile, openNetlist };
}
module.exports = { activateCircuitViewer, insideRoots };
