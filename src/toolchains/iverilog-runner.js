'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarizeToolResult, resultFindings } = require('./result');
const { COMPILE_TIMEOUT_MS } = require('./compile-policy');
const { simulationWaveforms } = require('./simulation-waveforms');

/** 同目录只记录波形元数据，仿真后按实际变化识别产物，不用时间容差猜测。 */
function waveformSnapshot(directory, targets = []) {
    const snapshot = new Map(), files = new Set(targets);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(vcd|fst)$/i.test(entry.name)) continue;
        files.add(path.join(directory, entry.name));
    }
    for (const file of files) {
        try {
            const stat = fs.statSync(file, { bigint: true });
            if (stat.isFile()) snapshot.set(file, stat.size + ':' + stat.mtimeNs + ':' + stat.ctimeNs);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return snapshot;
}
function changedWaveforms(before, after) { return [...after.keys()].filter(file => after.get(file) !== before.get(file)); }

/**
 * Icarus 流程独立于 VS Code；外部边界提供配置、编译、诊断发布及波形打开。
 * @param {object} deps 工具和工作区适配器。 @returns {{lint:Function,simulate:Function}}
 */
function createIcarusRunner(deps) {
    const { getToolchain, scanSources, compile, buildCommonArgs, workspace, getConfig, resolvePaths, channel, output, publish } = deps;
    function taskRoot(document) {
        return path.join(workspace.getWorkspaceFolder(document.uri)?.uri.fsPath || os.tmpdir(), '.svtools', 'tasks');
    }
    function complete(task, document, result) {
        const summary = summarizeToolResult({ result, findings: result.findings || [], mainFile: document.uri.fsPath,
            diagnosticsIncomplete: result.diagnosticsIncomplete });
        if (task.isCurrent()) {
            publish(document, resultFindings(summary, result.findings || [], document.uri.fsPath), 'iverilog');
            channel.appendLine(summary.ok ? '[工具任务] 通过' : '[工具任务] ' + summary.message);
            if (summary.logPath) channel.appendLine('完整日志：' + summary.logPath);
        }
        return summary;
    }
    async function lint(task, document) {
        const filePath = document.uri.fsPath, fileDir = path.dirname(filePath), config = getConfig(document);
        const workDir = await task.directory(taskRoot(document), 'iverilog-lint');
        const toolchain = await getToolchain(task); task.throwIfCancelled();
        let target = filePath;
        if (document.isDirty) { target = path.join(workDir, path.basename(filePath)); await fs.promises.writeFile(target, document.getText()); }
        const dirs = deps.fileOnly(document) ? [] : (await scanSources()).dirs; task.throwIfCancelled();
        const args = ['-tnull', ...buildCommonArgs({ fileName: filePath, standard: config.get('standard'),
            includePaths: [fileDir, ...resolvePaths(config.get('includePaths'), fileDir, document.uri), ...dirs],
            libraryPaths: [fileDir, ...resolvePaths(config.get('libraryPaths'), fileDir, document.uri), ...dirs],
            extraArgs: ['-Y', '.sv', ...config.get('lintArgs', [])] })];
        const { result } = await compile(toolchain, args, [target], fileDir, { task, scanSources, timeoutMs: COMPILE_TIMEOUT_MS,
            mapLine: line => line.split(target).join(filePath) });
        task.throwIfCancelled(); return complete(task, document, result);
    }
    async function prepareSimulation(task, document) {
        const directory = await task.directory(taskRoot(document), 'iverilog-sim');
        const toolchain = await getToolchain(task); task.throwIfCancelled();
        const filePath = document.uri.fsPath, fileDir = path.dirname(filePath), config = getConfig(document);
        const extra = (await deps.expandFiles(config.get('simFiles', []))).filter(file => path.resolve(file) !== path.resolve(filePath));
        const dirs = (await scanSources()).dirs; task.throwIfCancelled();
        const vvpFile = path.join(directory, path.basename(filePath, path.extname(filePath)) + '.vvp');
        const args = buildCommonArgs({ fileName: filePath, standard: config.get('standard'),
            includePaths: [fileDir, ...resolvePaths(config.get('includePaths'), fileDir, document.uri), ...dirs],
            libraryPaths: [fileDir, ...resolvePaths(config.get('libraryPaths'), fileDir, document.uri), ...dirs],
            extraArgs: ['-Y', '.sv', ...config.get('lintArgs', [])] });
        const top = String(config.get('simTop') || '').trim(); if (top) args.push('-s', top);
        args.push('-o', vvpFile);
        if (document.isDirty) channel.appendLine('文件有未保存修改，本次仿真使用磁盘内容。');
        return { directory, toolchain, filePath, fileDir, config, vvpFile, args, files: [filePath, ...extra] };
    }
    function runtimeInvocation(prep) {
        const args = [...(prep.toolchain.vvpPrefix || []), '-n', ...prep.config.get('simArgs', []), prep.vvpFile];
        const stdbuf = prep.toolchain.cygwinDir && path.join(prep.toolchain.cygwinDir, 'stdbuf.exe');
        return process.platform === 'win32' && stdbuf && fs.existsSync(stdbuf)
            ? { command: stdbuf, args: ['-oL', prep.toolchain.vvp, ...args], wrappedProcessName: 'vvp.exe' }
            : { command: prep.toolchain.vvp, args };
    }
    async function simulate(task, document) {
        const prep = await prepareSimulation(task, document);
        channel.appendLine('==== 仿真：' + prep.filePath + ' ====');
        const { result: compiled, files } = await compile(prep.toolchain, prep.args, prep.files, prep.fileDir, {
            task, scanSources, timeoutMs: COMPILE_TIMEOUT_MS, onStdout: output.append, onStderr: output.append });
        task.throwIfCancelled();
        const compiledSummary = complete(task, document, compiled); if (!compiledSummary.ok) return compiledSummary;
        channel.appendLine('编译产物：' + prep.vvpFile);
        const includePaths = prep.args.flatMap((arg, index) => arg === '-I' ? [prep.args[index + 1]] : []);
        const waveforms = await simulationWaveforms({ files: files || prep.files, directory: prep.fileDir, includePaths, signal: task.signal });
        if (waveforms.uncertain) channel.appendLine('波形路径含动态表达式或未完整解析：本次仿真目录内已打开的波形将先关闭。');
        task.throwIfCancelled();
        const lease = await deps.prepareWaveforms?.({ ...waveforms, directory: prep.fileDir, sourceFile: prep.filePath });
        let before, result;
        try {
            task.throwIfCancelled();
            before = waveformSnapshot(prep.fileDir, waveforms.paths);
            const invocation = runtimeInvocation(prep);
            result = await task.run(invocation.command, invocation.args, { cwd: prep.fileDir, env: prep.toolchain.env,
                stage: 'running', wrappedProcessName: invocation.wrappedProcessName,
                timeoutMs: Number(prep.config.get('simTimeoutMs') || 0), onStdout: output.append, onStderr: output.append });
        } finally { await lease?.dispose(); }
        output.flush(); task.throwIfCancelled();
        const summary = complete(task, document, result);
        if (!summary.ok) return summary;
        const waves = changedWaveforms(before, waveformSnapshot(prep.fileDir, waveforms.paths));
        await deps.showWaveforms(task, waves, prep.config, prep.filePath); task.throwIfCancelled();
        return { ...summary, waves, vvpFile: prep.vvpFile };
    }
    return { lint, simulate };
}
module.exports = { createIcarusRunner, waveformSnapshot, changedWaveforms };
