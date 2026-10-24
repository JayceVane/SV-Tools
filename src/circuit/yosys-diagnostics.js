'use strict';
const { createSourcePathMapper } = require('./source-paths');
const MAX_ERROR_CHARS = 2000;
const SOURCE_ERROR = /^(.+?):([1-9]\d*)(?::([1-9]\d*))?:\s*((?:fatal\s+)?error):\s*(.*)$/i;
const TOOL_ERROR = /^(?:ERROR:|fatal error:|内置 Yosys：)/i;
const MISSING_DEFINITION = /undeclared identifier|unknown (?:module|package|type)|(?:module|package|type) .+ (?:not found|not declared)|could not find.*(?:module|package)/i;

/**
 * @param {object} [options] 与网表源位置共享的路径映射。
 * @returns {{onLine:function,getError:function}} 逐行接收有界摘要；源码错误优先于通用收尾，完整日志由任务保留。
 */
function createYosysDiagnostics(options) {
    const mapPath = createSourcePathMapper(options);
    let sourceError = null, toolError = null;
    function onLine(value) {
        const line = String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
        const match = SOURCE_ERROR.exec(line);
        if (match && !sourceError) {
            const [, file, row, column, severity, message] = match;
            sourceError = `${mapPath(file)}:${row}${column ? ':' + column : ''}: ${severity}: ${message}`.slice(0, MAX_ERROR_CHARS);
        } else if (!toolError && TOOL_ERROR.test(line)) toolError = line.slice(0, MAX_ERROR_CHARS);
    }
    function getError() { return sourceError || toolError; }
    return { onLine, getError };
}

/** @param {string} detail 已选错误摘要。 @param {string} frontend 本次实际前端。 @returns {string} 针对已知问题的配置提示。 */
function yosysErrorHint(detail, frontend) {
    if (frontend === 'verilog' && /syntax error|unexpected TOK_|Unsupported SystemVerilog/i.test(detail)) {
        return '\n当前为 Yosys 旧 Verilog 前端；SystemVerilog 可使用内置 auto 或支持 read_slang 的 slang 前端。';
    }
    if (MISSING_DEFINITION.test(detail)) {
        return '\n若定义在其他文件，请按依赖顺序配置 svtools.circuit.sources（package 在使用它的文件之前），并在模块中 import 包或使用 package::名称；includeDirs 不会自动读入源文件。';
    }
    return '';
}
module.exports = { MAX_ERROR_CHARS, createYosysDiagnostics, yosysErrorHint };
