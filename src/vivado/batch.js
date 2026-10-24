'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDiagnosticCapture } = require('../toolchains/diagnostics');
const { summarizeToolResult } = require('../toolchains/result');
const { extractVivadoIssues } = require('./tclgen');
const MAX_MARKER_CHARS = 65536;

/** 厂商 BAT 内部的 CALL/delayed expansion 不能接收原始 %/!；只向其交付安全桥接路径。 */
async function withVivadoInvocation({ executable, args, cwd, scriptPath }, action) {
    if (process.platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(executable)) return action({ args, cwd });
    if (/[%!]/.test(executable)) throw new Error('Vivado 批处理安装路径含 % 或 !，厂商脚本无法安全传递；请使用不含这些字符的安装路径');
    const sourceIndex = args.findIndex((value, index) => index > 0 && args[index - 1] === '-source' && value === scriptPath);
    if (args.some((value, index) => index !== sourceIndex && /[%!]/.test(value))) {
        throw new Error('Vivado 批处理的非 source 参数含 % 或 !，厂商脚本无法安全传递；请调整这些参数');
    }
    const originalCwd = cwd || process.cwd();
    if (!/[%!]/.test(scriptPath) && !/[&^%!]/.test(originalCwd)) return action({ args, cwd });
    if (sourceIndex < 0) throw new Error('Vivado 特殊路径缺少可桥接的 -source 脚本，已停止运行');
    const base = path.resolve(os.tmpdir());
    const directory = await fs.mkdtemp(path.join(base, 'svtools-vivado-bridge-'));
    try {
        if (/[&^%!]/.test(directory)) throw new Error('系统临时目录含 Vivado 批处理无法安全传递的字符，请将 TEMP 指向安全目录');
        const bridge = path.join(directory, 'source.tcl');
        await fs.writeFile(bridge, 'cd $::env(SVTOOLS_VIVADO_SOURCE_CWD)\nsource -encoding utf-8 $::env(SVTOOLS_VIVADO_SOURCE_PATH)\n', { flag: 'wx' });
        const forwarded = [...args]; forwarded[sourceIndex] = bridge;
        return await action({ args: forwarded, cwd: directory, env: { ...process.env,
            SVTOOLS_VIVADO_SOURCE_CWD: originalCwd, SVTOOLS_VIVADO_SOURCE_PATH: scriptPath } });
    } finally {
        if (path.dirname(directory) !== base || !path.basename(directory).startsWith('svtools-vivado-bridge-')) throw new Error('Vivado 桥接清理路径越界');
        await fs.rm(directory, { recursive: true, force: true });
    }
}

/**
 * Vivado 的 ERROR 与实际退出码共同判定成败；项目操作标记不依赖日志尾部。
 * @param {{task:object,executable:string,args:string[],cwd:string,scriptPath:string,timeoutMs?:number,onOutput?:Function,maxOutputChars?:number}} options
 * @returns {Promise<object>} 保留兼容 code/issues/stdout，同时提供明确 status、exitCode 和日志路径。
 */
async function runVivadoBatchTask({ task, executable, args, cwd, scriptPath, timeoutMs, onOutput, maxOutputChars }) {
    const capture = createDiagnosticCapture({ parseLine: line => extractVivadoIssues(line).map(issue => ({
        file: scriptPath, line: 1, severity: issue.level === 'ERROR' ? 'error' : 'warning', message: issue.text, level: issue.level
    })) });
    const markers = []; let markerChars = 0, markerOverflow = false;
    const result = await withVivadoInvocation({ executable, args, cwd, scriptPath }, invocation =>
        task.run(executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, stage: 'vivado', timeoutMs, maxOutputChars,
            onStdout: onOutput, onStderr: onOutput, onLine(line, isStderr, meta) {
                capture.onLine(line, isStderr, meta);
                if (!/^SVTOOLS_[A-Z0-9_]+/.test(line)) return;
                if (markerChars + line.length <= MAX_MARKER_CHARS) { markers.push(line); markerChars += line.length; }
                else markerOverflow = true;
            } }));
    const captured = capture.snapshot(result);
    const summary = summarizeToolResult({ result, mainFile: scriptPath, findings: captured.findings,
        diagnosticsIncomplete: captured.diagnosticsIncomplete || markerOverflow });
    return { ...summary, code: summary.ok ? 0 : result.code === 0 ? -1 : result.code, exitCode: result.code,
        ms: result.elapsedMs, error: summary.ok ? null : summary.message,
        issues: captured.findings.map(finding => ({ level: finding.level, text: finding.message })),
        stdout: [...markers, result.output].join('\n') };
}
module.exports = { runVivadoBatchTask };
