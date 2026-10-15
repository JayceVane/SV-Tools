'use strict';
const path = require('node:path');

/** @param {object|undefined} result @returns {boolean} 必须正常退出；取消和基础设施失败不算通过。 */
function processSucceeded(result) {
    return !!result && result.code === 0 && !result.errorMessage && !result.logError && !result.timedOut && !result.stopped && !result.aborted;
}

/**
 * 主文件诊断数量与整个任务成败分别表达，依赖错误同样使任务失败。
 * @param {{result?:object,findings?:object[],mainFile:string,status?:string,diagnosticsIncomplete?:boolean}} input
 * @returns {{ok:boolean,status:string,errorCount:number,warningCount:number,totalErrorCount:number,message:string,logPath:string|null}}
 */
function summarizeToolResult({ result, findings = [], mainFile, status, diagnosticsIncomplete = false }) {
    const main = findings.filter(finding => path.normalize(finding.file) === path.normalize(mainFile));
    const errorCount = main.filter(finding => finding.severity === 'error').length;
    const totalErrorCount = findings.filter(finding => finding.severity === 'error').length;
    const cancelled = status === 'cancelled' || result?.aborted || (result?.stopped && !result.timedOut && !result.errorMessage && !result.logError);
    const ok = !status && processSucceeded(result) && !totalErrorCount && !diagnosticsIncomplete;
    const taskStatus = cancelled ? 'cancelled' : status || (ok ? 'success' : 'failed');
    let message = '';
    if (taskStatus === 'cancelled') message = '任务已取消';
    else if (taskStatus === 'skipped') message = '未执行工具检查';
    else if (!ok) message = result?.errorMessage || result?.logError || (result?.timedOut ? '工具执行超时' : '')
        || (diagnosticsIncomplete ? '诊断超过安全预算，不能确认检查通过' : '')
        || (totalErrorCount ? `工程存在 ${totalErrorCount} 个错误` : '')
        || (result ? '工具退出码：' + result.code : '工具检查未启动');
    return { ok, status: taskStatus, errorCount, warningCount: main.length - errorCount, totalErrorCount,
        message, logPath: result?.logPath || null };
}

/** 未解析到源码错误的工具失败仍在 Problems 中说明原因，不伪装成成功。 */
function resultFindings(summary, findings, mainFile) {
    return summary.status === 'failed' && !summary.totalErrorCount ? [...findings, {
        file: mainFile, line: 1, column: null, severity: 'error', source: 'toolchain',
        message: summary.message + (summary.logPath ? '\n完整日志：' + summary.logPath : '')
    }] : findings;
}
module.exports = { processSucceeded, summarizeToolResult, resultFindings };
