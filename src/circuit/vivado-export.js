'use strict';
const { tclQuote } = require('../vivado/tclgen');

/**
 * 生成只读 RTL 详细化入口；导出器随扩展分发，所有新产物写入调用者的任务目录。
 * @param {{projectPath:string,outputPath:string,exporterPath:string}} options
 * @returns {string} 遇到 Tcl 错误时以非零退出码结束，不发布不完整 JSON。
 */
function buildVivadoExportScript({ projectPath, outputPath, exporterPath }) {
    for (const value of [projectPath, outputPath, exporterPath]) {
        if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw new TypeError('Vivado 电路导出路径无效');
    }
    return [
        'if {[catch {',
        '    source ' + tclQuote(exporterPath),
        '    svtools_circuit::exportProject ' + tclQuote(projectPath) + ' ' + tclQuote(outputPath),
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
