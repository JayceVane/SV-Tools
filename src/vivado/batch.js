'use strict';
const { createDiagnosticCapture } = require('../toolchains/diagnostics');
const { summarizeToolResult } = require('../toolchains/result');
const { extractVivadoIssues } = require('./tclgen');
const MAX_MARKER_CHARS = 65536;

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
    const result = await task.run(executable, args, { cwd, stage: 'vivado', timeoutMs, maxOutputChars,
        onStdout: onOutput, onStderr: onOutput, onLine(line, isStderr, meta) {
            capture.onLine(line, isStderr, meta);
            if (!/^SVTOOLS_[A-Z0-9_]+/.test(line)) return;
            if (markerChars + line.length <= MAX_MARKER_CHARS) { markers.push(line); markerChars += line.length; }
            else markerOverflow = true;
        } });
    const captured = capture.snapshot(result);
    const summary = summarizeToolResult({ result, mainFile: scriptPath, findings: captured.findings,
        diagnosticsIncomplete: captured.diagnosticsIncomplete || markerOverflow });
    return { ...summary, code: summary.ok ? 0 : result.code === 0 ? -1 : result.code, exitCode: result.code,
        ms: result.elapsedMs, error: summary.ok ? null : summary.message,
        issues: captured.findings.map(finding => ({ level: finding.level, text: finding.message })),
        stdout: [...markers, result.output].join('\n') };
}
module.exports = { runVivadoBatchTask };
