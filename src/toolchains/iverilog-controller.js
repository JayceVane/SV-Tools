'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createToolTaskManager } = require('./job');
const { createIcarusRunner } = require('./iverilog-runner');
const { createBufferedOutput } = require('./channel');
const { summarizeToolResult, resultFindings } = require('./result');
const { lintWithXvlog, elaborateWithXvlog, resetXvlogCache } = require('./xvlog');
const { scanWorkspaceSources, invalidateWorkspaceSources } = require('../workspace/sources');
const { GENERATED_SOURCE_EXCLUDE_GLOB, isGeneratedSourcePath } = require('../workspace/source-policy');
const LANGUAGE_IDS = ['verilog', 'systemverilog', 'system-verilog'];

/** @param {object} context @param {object} deps 工具规则与可注入的编辑器边界。 @returns {object} 命令流程和释放入口。 */
function activateIverilog(context, deps) {
    const vscode = deps.vscode || require('vscode');
    const channel = vscode.window.createOutputChannel('SystemVerilog Tools · Icarus Verilog');
    const diagnostics = vscode.languages.createDiagnosticCollection('svtools-iverilog');
    const output = createBufferedOutput(channel), debounce = new Map(), owners = new Map();
    let activeSim = null, disposed = false, toolchainErrorShown = false;
    const simBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    const elaborateBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
    const engineBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2);
    const tasks = createToolTaskManager({ startProcess: deps.startProcess, onChange() { if (!disposed) updateStatusBar(); } });
    const scanSources = deps.scanWorkspaceSources || scanWorkspaceSources;
    const invalidateSources = deps.invalidateWorkspaceSources || invalidateWorkspaceSources;
    const getConfig = document => vscode.workspace.getConfiguration('svtools.iverilog', document?.uri);
    const currentEngine = document => vscode.workspace.getConfiguration('svtools.lint', document?.uri).get('engine', 'iverilog');
    const isVerilogDocument = document => !!document && LANGUAGE_IDS.includes(document.languageId) && !isGeneratedSourcePath(document.uri?.fsPath);
    const lintKey = document => 'lint:' + document.uri.toString();
    const runner = createIcarusRunner({ workspace: vscode.workspace, getConfig, scanSources,
        getToolchain: async task => {
            try { return await deps.resolveToolchain(task); }
            catch (error) { if (!task.signal.aborted) showToolchainError(error.message); throw error; }
        }, compile: deps.compileWithModuleResolution, buildCommonArgs: deps.buildCommonArgs,
        resolvePaths, channel, output, publish: applyDiagnostics, expandFiles,
        prepareWaveforms: options => deps.waveViewer?.prepareForSimulation?.(options),
        fileOnly: document => vscode.workspace.getConfiguration('svtools.lint', document.uri).get('currentFileOnly', true), showWaveforms });

    function resolvePaths(paths, fallback, uri) {
        const base = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || fallback;
        return (paths || []).map(value => path.resolve(base, value));
    }
    function publishFiles(files) {
        for (const file of files) {
            if (isGeneratedSourcePath(file)) { diagnostics.set(vscode.Uri.file(file), []); continue; }
            const entries = new Map();
            for (const owner of owners.values()) for (const finding of owner.findings) {
                if (path.normalize(finding.file) !== file) continue;
                const line = Math.max(0, finding.line - 1);
                const range = owner.document?.uri.fsPath === finding.file
                    ? owner.document.lineAt(Math.min(line, owner.document.lineCount - 1)).range : new vscode.Range(line, 0, line, 0);
                const diagnostic = new vscode.Diagnostic(range, finding.message,
                    finding.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
                diagnostic.source = finding.source || owner.source;
                entries.set(JSON.stringify([line, finding.message, finding.severity, diagnostic.source]), diagnostic);
            }
            diagnostics.set(vscode.Uri.file(file), [...entries.values()]);
        }
    }
    function applyDiagnostics(document, findings, source = 'iverilog') {
        const key = document.uri.toString(), previous = owners.get(key);
        const sourceFindings = findings.filter(finding => !isGeneratedSourcePath(finding.file));
        owners.set(key, { document, findings: sourceFindings, source });
        publishFiles(new Set([document.uri.fsPath, ...(previous?.findings || []).map(f => path.normalize(f.file)), ...findings.map(f => path.normalize(f.file))]));
    }
    function removeDiagnostics(document) {
        const previous = owners.get(document.uri.toString()); owners.delete(document.uri.toString());
        publishFiles(new Set([document.uri.fsPath, ...(previous?.findings || []).map(f => path.normalize(f.file))]));
    }
    function showToolchainError(message, setting = 'svtools.iverilog.path') {
        if (toolchainErrorShown) return; toolchainErrorShown = true;
        Promise.resolve(vscode.window.showErrorMessage(message, '打开设置')).then(choice => {
            toolchainErrorShown = false;
            if (choice === '打开设置') vscode.commands.executeCommand('workbench.action.openSettings', setting);
        }).catch(error => { toolchainErrorShown = false; channel.appendLine(error.message); });
    }
    async function expandFiles(patterns) {
        const files = [];
        for (const pattern of patterns || []) {
            const uris = await vscode.workspace.findFiles(pattern, GENERATED_SOURCE_EXCLUDE_GLOB, 500); files.push(...uris.filter(uri => !isGeneratedSourcePath(uri.fsPath)).map(uri => uri.fsPath));
        }
        return [...new Set(files)];
    }
    async function showWaveforms(task, waves, config, sourceFile) {
        task.throwIfCancelled(); if (!waves.length) return;
        const vcd = waves.find(file => /\.vcd$/i.test(file)), viewer = String(config.get('waveViewer') || '').trim();
        if (vcd && !viewer && config.get('autoOpenWaveform', true)) await deps.waveViewer?.openWaveform(vcd, { sourceFile });
        task.throwIfCancelled();
        const choice = vscode.window.showInformationMessage('仿真波形已生成：' + path.basename(waves[0]),
            ...(vcd && !viewer ? ['打开波形'] : []), ...(viewer ? ['外部查看器打开'] : []), '在资源管理器中显示');
        Promise.resolve(choice).then(async selected => {
            if (task.signal.aborted) return;
            if (selected === '打开波形' && vcd) await deps.waveViewer?.openWaveform(vcd, { sourceFile });
            else if (selected === '外部查看器打开' && viewer) {
                const child = spawn(viewer, [vcd || waves[0]], { detached: true, stdio: 'ignore', windowsHide: true });
                child.once('error', error => vscode.window.showErrorMessage('启动波形查看器失败：' + error.message)); child.unref();
            } else if (selected === '在资源管理器中显示') await vscode.commands.executeCommand('revealFileInOs', vscode.Uri.file(waves[0]));
        }).catch(error => channel.appendLine('打开仿真产物失败：' + error.message));
    }
    function stopSimulation(reason = '用户停止') { activeSim?.cancel(reason); }
    function updateStatusBar() {
        const document = vscode.window.activeTextEditor?.document, visible = isVerilogDocument(document);
        if (!visible) { simBar.hide(); elaborateBar.hide(); engineBar.hide(); return; }
        const engine = currentEngine(document); engineBar.command = 'svtools.lint.selectEngine';
        engineBar.text = '$(zap) ' + engine; engineBar.tooltip = '切换 lint 引擎'; engineBar.show();
        elaborateBar.command = 'svtools.xvlog.elaborate'; elaborateBar.text = '$(inspect) xelab';
        if (engine === 'xvlog') elaborateBar.show(); else elaborateBar.hide();
        simBar.command = activeSim ? 'svtools.iverilog.stopSimulation' : 'svtools.iverilog.simulate';
        const labels = { preparing: '准备', compiling: '编译', running: '仿真', probe: '探测', cancelling: '停止中' };
        simBar.text = activeSim ? '$(debug-stop) ' + (labels[activeSim.state] || activeSim.state) + ' · 停止' : '$(play) iverilog 仿真';
        simBar.tooltip = activeSim ? '停止当前任务，包括编译阶段' : '编译并运行当前 testbench'; simBar.show();
    }
    async function execute(document, kind = 'lint', options = {}) {
        const mainFile = document?.uri?.fsPath || '';
        if (!disposed && isGeneratedSourcePath(mainFile)) {
            clearDebounce(document); tasks.cancel(lintKey(document), '跳过工具生成目录'); removeDiagnostics(document);
            return { ...summarizeToolResult({ mainFile, status: 'skipped' }), message: '跳过工具生成目录中的文档，请在原始RTL文件执行检查' };
        }
        if (disposed || !isVerilogDocument(document) || document.uri.scheme !== 'file') {
            const message = '请先打开已保存的 Verilog/SystemVerilog 文档';
            if (!disposed && kind === 'simulation') vscode.window.showWarningMessage(message);
            return { ...summarizeToolResult({ mainFile, status: 'skipped' }), message };
        }
        const task = tasks.start(kind === 'simulation' ? 'simulation' : lintKey(document));
        task.documentUri = document.uri;
        if (kind === 'simulation') { activeSim = task; channel.show(true); updateStatusBar(); }
        try {
            await task.waitForPrevious(); task.throwIfCancelled();
            if (kind === 'simulation') return await runner.simulate(task, document);
            if (kind === 'elaborate' || currentEngine(document) === 'xvlog') {
                return await (kind === 'elaborate' ? elaborateWithXvlog : lintWithXvlog)(document, {
                    vscode, channel, output, applyDiagnostics, isVerilogDocument, scanWorkspaceSources: scanSources, task, showToolchainError,
                    toolCommands: deps.xvlogTools, resolveBinDir: deps.resolveXvlogBinDir, top: options.top, projectScope: options.projectScope });
            }
            return await runner.lint(task, document);
        } catch (error) {
            const summary = summarizeToolResult({ mainFile, result: { ...task.lastResult, code: null, errorMessage: error.message },
                status: task.signal.aborted || error.code === 'TOOL_CANCELLED' ? 'cancelled' : undefined });
            if (task.isCurrent()) { applyDiagnostics(document, resultFindings(summary, [], mainFile), 'toolchain'); channel.appendLine(summary.message); }
            else if (!disposed && kind === 'simulation' && activeSim === task) {
                channel.appendLine('仿真任务已取消：' + (task.reason || summary.message));
                if (summary.logPath) channel.appendLine('已接收输出的日志：' + summary.logPath);
            }
            return summary;
        } finally {
            output.flush();
            try { await task.finish({ keepArtifacts: kind === 'simulation' }); } catch (error) { channel.appendLine('清理任务失败：' + error.message); }
            if (activeSim === task) activeSim = null; if (!disposed) updateStatusBar();
        }
    }
    function reportSummary(summary, label) {
        const message = summary.status === 'success' ? `${label}：通过，${summary.warningCount} 个警告`
            : `${label}：${summary.message || summary.status}`;
        vscode.window.setStatusBarMessage(message, 5000); return summary;
    }
    function clearDebounce(document) {
        const key = document.uri.toString(), timer = debounce.get(key); if (timer) clearTimeout(timer); debounce.delete(key);
    }
    function fireLint(document) { execute(document).catch(error => channel.appendLine('检查任务失败：' + error.message)); }
    const subscribe = (name, callback) => vscode.workspace[name](callback);
    context.subscriptions.push(channel, diagnostics, simBar, elaborateBar, engineBar,
        subscribe('onDidOpenTextDocument', document => { if (getConfig(document).get('lintOnOpen')) fireLint(document); }),
        subscribe('onDidChangeTextDocument', event => {
            const document = event.document; if (!event.contentChanges.length || !isVerilogDocument(document)) return;
            tasks.cancel(lintKey(document), '文档内容已变化'); clearDebounce(document);
            if (!getConfig(document).get('lintOnChange')) return;
            const timer = setTimeout(() => { debounce.delete(document.uri.toString()); fireLint(document); }, Math.max(100, Number(getConfig(document).get('lintDebounceMs')) || 800));
            debounce.set(document.uri.toString(), timer);
        }),
        subscribe('onDidSaveTextDocument', document => { if (getConfig(document).get('lintOnSave')) { clearDebounce(document); fireLint(document); } }),
        subscribe('onDidCloseTextDocument', document => { clearDebounce(document); tasks.cancel(lintKey(document), '文档已关闭'); removeDiagnostics(document); }),
        subscribe('onDidChangeConfiguration', event => {
            if (!['svtools.iverilog', 'svtools.lint', 'svtools.vivado'].some(name => event.affectsConfiguration(name))) return;
            tasks.cancelAll('工具配置已变化'); deps.resetToolchain(); resetXvlogCache(); updateStatusBar();
            for (const document of vscode.workspace.textDocuments) fireLint(document);
        }),
        subscribe('onDidCreateFiles', invalidateSources), subscribe('onDidDeleteFiles', invalidateSources), subscribe('onDidRenameFiles', invalidateSources),
        vscode.window.onDidChangeActiveTextEditor(updateStatusBar),
        vscode.commands.registerCommand('svtools.iverilog.lint', async () => { deps.resetToolchainFailure(); return reportSummary(await execute(vscode.window.activeTextEditor?.document), currentEngine(vscode.window.activeTextEditor?.document)); }),
        vscode.commands.registerCommand('svtools.iverilog.simulate', () => execute(vscode.window.activeTextEditor?.document, 'simulation')),
        vscode.commands.registerCommand('svtools.iverilog.stopSimulation', () => stopSimulation()),
        vscode.commands.registerCommand('svtools.lint.stop', requested => {
            const document = requested?.uri ? requested : vscode.window.activeTextEditor?.document;
            if (document) tasks.cancel(lintKey(document), '用户停止检查');
        }),
        vscode.commands.registerCommand('svtools.xvlog.elaborate', async (requestedDocument, options = {}) => {
            const document = requestedDocument?.uri ? requestedDocument : vscode.window.activeTextEditor?.document;
            return reportSummary(await execute(document, 'elaborate', options), 'xelab');
        }),
        vscode.commands.registerCommand('svtools.lint.selectEngine', async () => {
            const engine = currentEngine(vscode.window.activeTextEditor?.document);
            const pick = await vscode.window.showQuickPick(['iverilog', 'xvlog'].map(value => ({ label: value, value })), { placeHolder: '选择 lint 引擎' });
            if (pick && pick.value !== engine) await vscode.workspace.getConfiguration('svtools.lint').update('engine', pick.value,
                vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
        }));
    async function dispose() {
        if (disposed) return; disposed = true;
        for (const timer of debounce.values()) clearTimeout(timer); debounce.clear(); tasks.cancelAll();
        output.dispose(); await tasks.dispose();
    }
    context.subscriptions.push({ dispose });
    for (const document of vscode.workspace.textDocuments) if (getConfig(document).get('lintOnOpen')) fireLint(document);
    updateStatusBar();
    return { lintDocument: document => execute(document), runSimulation: document => execute(document, 'simulation'), stopSimulation, dispose };
}
module.exports = { activateIverilog };
