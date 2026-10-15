'use strict';
const MAX_FINDINGS = 2000;
const MAX_MISSING_UNITS = 2000;
const MAX_DIAGNOSTIC_CHARS = 1048576;

/**
 * 逐行捕获结构化诊断与依赖，日志尾部截断不丢早期错误；超预算明确标记不完整。
 * @param {{parseLine:Function,extractMissing?:Function,maxFindings?:number,maxDiagnosticChars?:number}} options
 * @returns {{onLine:Function,snapshot:Function}} 每个编译阶段使用独立捕获器。
 */
function createDiagnosticCapture({ parseLine, extractMissing = () => [], maxFindings = MAX_FINDINGS, maxDiagnosticChars = MAX_DIAGNOSTIC_CHARS }) {
    const findings = new Map(), missingUnits = new Set(); let incomplete = false, characters = 0;
    function onLine(line, isStderr, meta = {}) {
        if (meta.truncated) incomplete = true;
        for (const finding of parseLine(line)) {
            const key = JSON.stringify([finding.file, finding.line, finding.column, finding.severity, finding.message]);
            if (findings.has(key)) continue;
            const size = key.length;
            if (findings.size < maxFindings && characters + size <= maxDiagnosticChars) { findings.set(key, finding); characters += size; }
            else incomplete = true;
        }
        for (const name of extractMissing(line)) {
            if (missingUnits.has(name)) continue;
            if (missingUnits.size < MAX_MISSING_UNITS && characters + name.length <= maxDiagnosticChars) { missingUnits.add(name); characters += name.length; }
            else incomplete = true;
        }
    }
    return { onLine, snapshot(result = {}) {
        return { ...result, findings: [...findings.values()], missingUnits,
            diagnosticsIncomplete: incomplete || !!result.lineTruncated };
    } };
}
module.exports = { createDiagnosticCapture };
