'use strict';
const { tclQuote } = require('../vivado/tclgen');

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
        'if {[catch {',
        '    source ' + tclQuote(exporterPath),
        '    svtools_circuit::exportProject ' + [projectPath, outputPath, top || '', sourcePath || ''].map(tclQuote).join(' '),
        '} errorMessage]} {',
        '    puts stderr "SVTOOLS_CIRCUIT_ERROR $errorMessage"',
        '    catch { close_project }',
        '    exit 1',
        '}',
        'puts "SVTOOLS_CIRCUIT_READY"',
        'exit 0',
        ''
    ].join('\n');
}

module.exports = { buildVivadoExportScript };
