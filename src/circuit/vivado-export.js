'use strict';
const { tclQuote } = require('../vivado/tclgen');
const MAX_ERROR_CHARS = 2000;

/** @param {string} value @returns {string} 用ASCII脚本传递UTF-8文字，避免Windows Tcl默认代码页误读。 */
function tclUtf8Literal(value) {
    if (/[^\x00-\x7f]/.test(value)) {
        return '[encoding convertfrom utf-8 [binary format H* ' + Buffer.from(value.replace(/\\/g, '/'), 'utf8').toString('hex') + ']]';
    }
    return tclQuote(value);
}

/**
 * 生成只读 RTL 详细化入口；导出器随扩展分发，所有新产物写入调用者的任务目录。
 * @param {{projectPath:string,outputPath:string,exporterPath:string,top?:string,sourcePath?:string}} options
 * @returns {string} 遇到 Tcl 错误时以非零退出码结束，不发布不完整 JSON。
 */
function buildVivadoExportScript({ projectPath, outputPath, exporterPath, top, sourcePath }) {
    for (const value of [projectPath, outputPath, exporterPath]) {
        if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw new TypeError('Vivado 电路导出路径无效');
    }
    for (const value of [top, sourcePath]) {
        if (value !== undefined && (typeof value !== 'string' || !value || /[\r\n\0]/.test(value))) throw new TypeError('Vivado 电路顶层或源文件无效');
    }
    if (sourcePath && !top) throw new TypeError('指定 Vivado 源文件时必须显式指定顶层');
    return [
        'fconfigure stdout -encoding utf-8 -translation lf',
        'fconfigure stderr -encoding utf-8 -translation lf',
        'if {[catch {',
        '    source -encoding utf-8 ' + tclUtf8Literal(exporterPath),
        '    svtools_circuit::exportProject ' + [projectPath, outputPath, top || '', sourcePath || ''].map(tclUtf8Literal).join(' '),
        '} errorMessage]} {',
        '    binary scan [encoding convertto utf-8 [string range $errorMessage 0 ' + (MAX_ERROR_CHARS - 1) + ']] H* errorHex',
        '    puts stderr "SVTOOLS_CIRCUIT_ERROR_UTF8 $errorHex"',
        '    puts stderr "SVTOOLS_CIRCUIT_ERROR $errorMessage"',
        '    catch { close_project }',
        '    exit 1',
        '}',
        'puts "SVTOOLS_CIRCUIT_READY"',
        'exit 0',
        ''
    ].join('\n');
}

module.exports = { buildVivadoExportScript, tclUtf8Literal };
