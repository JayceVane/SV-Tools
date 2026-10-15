'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createToolTaskManager } = require('./job');
const { createDiagnosticCapture } = require('./diagnostics');
const { processSucceeded, summarizeToolResult, resultFindings } = require('./result');
const { COMPILE_TIMEOUT_MS } = require('./compile-policy');
const { firstModuleName } = require('../vivado/tclgen');
const rules = require('./xvlog-rules');
const MAX_COMPILE_ROUNDS = 4, MAX_ELABORATE_ROUNDS = 6;
let defaultTasks;

/** 获取工具和源文本事实；未保存内容仅写入本次任务目录。 */
async function prepare(document, ctx, task) {
    const { vscode } = ctx, filePath = document.uri.fsPath, text = document.getText(), version = document.version;
    const configured = vscode.workspace.getConfiguration('svtools.vivado', document.uri).get('path');
    let binDir;
    try { binDir = (ctx.resolveBinDir || rules.resolveXvlogBinDir)(configured); }
    catch (error) { ctx.showToolchainError?.(error.message, 'svtools.vivado.path'); throw error; }
    const folder = vscode.workspace.getWorkspaceFolder?.(document.uri) || vscode.workspace.workspaceFolders?.[0];
    const base = folder?.uri.fsPath || os.tmpdir();
    const workDir = await task.directory(path.join(base, '.svtools', 'tasks'), 'xvlog');
    let lintTarget = filePath;
    if (document.isDirty) { lintTarget = path.join(workDir, path.basename(filePath)); await fs.writeFile(lintTarget, text); }
    task.throwIfCancelled();
    const options = vscode.workspace.getConfiguration('svtools.iverilog', document.uri);
    const includeDirs = [...new Set([path.dirname(filePath), ...(ctx.projectScope?.includePaths || []), ...(options.get('includePaths', []) || []).map(dir => path.resolve(folder?.uri.fsPath || path.dirname(filePath), dir))])];
    const libraryArgs = [], timescale = text.match(/`timescale\s+([0-9.]+[munpf]?s\s*\/\s*[0-9.]+[munpf]?s)/i);
    let uvmTimescale;
    if (rules.detectUvmUsage(text)) {
        libraryArgs.push('-L', 'UVM'); uvmTimescale = timescale ? timescale[1].replace(/\s+/g, '') : '1ns/1ps';
        const uvmDir = rules.findUvmIncludeDir(binDir); if (uvmDir) includeDirs.push(uvmDir);
    }
    return { task, document, ctx, binDir, workDir, filePath, lintTarget, libraryArgs, uvmTimescale,
        includeArgs: includeDirs.flatMap(dir => ['-i', dir]), top: ctx.top ?? firstModuleName(text), version };
}

/** 每个阶段独立捕获诊断；完整输出写盘，有界尾部只用于展示。 */
async function runStage(prep, tool, args) {
    prep.task.throwIfCancelled();
    const capture = createDiagnosticCapture({ parseLine: line => rules.parseVivadoDiagnostics(
        line.split(prep.lintTarget).join(prep.filePath), prep.workDir, prep.filePath), extractMissing: rules.extractMissingUnits });
    const override = prep.ctx.toolCommands?.[tool];
    const command = override?.command || path.join(prep.binDir, process.platform === 'win32' ? tool + '.bat' : tool);
    const result = await prep.task.run(command, [...(override?.args || []), ...args], {
        cwd: prep.workDir, stage: tool, timeoutMs: prep.ctx.timeoutMs ?? COMPILE_TIMEOUT_MS,
        onLine: capture.onLine, maxOutputChars: prep.ctx.maxOutputChars,
        onStdout: prep.ctx.output?.append, onStderr: prep.ctx.output?.append
    });
    return capture.snapshot(result);
}

async function compile(prep, files, incremental) {
    await fs.writeFile(path.join(prep.workDir, 'svtools.prj'), rules.buildPrjBody(files)); prep.task.throwIfCancelled();
    return runStage(prep, 'xvlog', ['--nolog', ...prep.libraryArgs, ...prep.includeArgs,
        ...(incremental ? ['--incr'] : []), '-prj', 'svtools.prj']);
}

async function dependencyIndex(prep) {
    if (prep.ctx.projectScope) return prep.ctx.projectScope.modules;
    const scan = await prep.ctx.scanWorkspaceSources(); prep.task.throwIfCancelled(); return scan.modules;
}

async function lint(prep) {
    const fileOnly = prep.ctx.vscode.workspace.getConfiguration('svtools.lint', prep.document.uri).get('currentFileOnly', true);
    let files = [prep.lintTarget], modules;
    if (!fileOnly) { modules = await dependencyIndex(prep); files = [...new Set([...modules.values()].filter(file => path.normalize(file) !== path.normalize(prep.filePath))), prep.lintTarget]; }
    let result;
    for (let round = 0; round < MAX_COMPILE_ROUNDS; round++) {
        result = await compile(prep, files, true);
        if (processSucceeded(result) || result.stopped || result.aborted || result.diagnosticsIncomplete || !result.missingUnits.size) break;
        modules ||= await dependencyIndex(prep);
        const additions = rules.resolveUnitFiles(result.missingUnits, modules, files);
        if (!additions.length) break; files = [...new Set([...additions, ...files])];
    }
    return result;
}

async function elaborate(prep) {
    const modules = await dependencyIndex(prep);
    let files = [...(prep.ctx.projectScope?.files || []).filter(file => path.normalize(file) !== path.normalize(prep.filePath)), prep.lintTarget], result;
    for (let round = 0; round < MAX_ELABORATE_ROUNDS; round++) {
        result = await compile(prep, files, false);
        if (result.stopped || result.aborted || result.diagnosticsIncomplete) break;
        if (processSucceeded(result) && !result.findings.some(finding => finding.severity === 'error')) {
            const elaborated = await runStage(prep, 'xelab', ['--nolog', '--snapshot', 'svtools_lint', ...prep.libraryArgs,
                ...(prep.uvmTimescale ? ['--timescale', prep.uvmTimescale] : []), 'work.' + prep.top]);
            result = { ...elaborated, findings: [...result.findings, ...elaborated.findings] };
        }
        if (result.stopped || result.aborted || result.diagnosticsIncomplete) break;
        const additions = rules.resolveUnitFiles(result.missingUnits, modules, files);
        if (!additions.length) break; files = [...new Set([...additions, ...files])];
    }
    return result;
}

function publish(document, ctx, task, result, status) {
    const findings = result?.findings || [];
    const summary = summarizeToolResult({ result, findings, mainFile: document.uri.fsPath, status,
        diagnosticsIncomplete: result?.diagnosticsIncomplete });
    if (task.isCurrent() && summary.status !== 'cancelled' && summary.status !== 'skipped') {
        ctx.applyDiagnostics(document, resultFindings(summary, findings, document.uri.fsPath), 'xvlog');
        ctx.channel.appendLine(`[${ctx.elaborate ? 'xvlog+xelab' : 'xvlog'}] ${summary.ok ? '通过' : summary.message}`);
        if (summary.logPath) ctx.channel.appendLine('完整日志：' + summary.logPath);
    }
    return { ...summary, logPaths: [...task.logPaths] };
}

/**
 * @param {object} document VS Code 文档。 @param {object} ctx 注入编辑器边界和可选 toolCommands。
 * @returns {Promise<object>} 明确的任务状态；取消不发布迟到诊断。
 */
async function execute(document, ctx) {
    const mainFile = document?.uri?.fsPath || '';
    if (!document || !ctx.isVerilogDocument(document) || document.uri.scheme !== 'file') return summarizeToolResult({ mainFile, status: 'skipped' });
    defaultTasks ||= createToolTaskManager();
    const task = ctx.task || defaultTasks.start('lint:' + document.uri.toString());
    try {
        await task.waitForPrevious(); const prep = await prepare(document, ctx, task);
        if (ctx.elaborate && !prep.top) return { ...publish(document, ctx, task, null, 'skipped'), message: '当前文件没有可详细化的 module' };
        const result = await (ctx.elaborate ? elaborate(prep) : lint(prep));
        if (document.version !== prep.version) task.cancel('文档内容已变化');
        if (task.signal.aborted) return publish(document, ctx, task, result, 'cancelled');
        return publish(document, ctx, task, result);
    } catch (error) {
        return publish(document, ctx, task, { ...task.lastResult, code: null, errorMessage: error.message }, error.code === 'TOOL_CANCELLED' || task.signal.aborted ? 'cancelled' : undefined);
    } finally {
        ctx.output?.flush();
        try { await task.finish(); } catch (error) { ctx.channel.appendLine('任务产物清理失败：' + error.message); }
    }
}
function lintWithXvlog(document, ctx) { return execute(document, ctx); }
function elaborateWithXvlog(document, ctx) { return execute(document, { ...ctx, elaborate: true }); }
module.exports = { lintWithXvlog, elaborateWithXvlog };
