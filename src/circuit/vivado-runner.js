'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { runVivadoBatchTask } = require('../vivado/batch');
const { buildVivadoExportScript } = require('./vivado-export');
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

/** @param {string} output @returns {string|undefined} 读取ASCII错误协议，兼容旧版明文标记。 */
function readTclError(output) {
    const encoded = /^SVTOOLS_CIRCUIT_ERROR_UTF8 ((?:[0-9a-f]{2})+)$/im.exec(output);
    if (!encoded) return /^SVTOOLS_CIRCUIT_ERROR (.+)$/m.exec(output)?.[1];
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded[1], 'hex')); }
    catch (error) { return 'Vivado错误消息的UTF-8编码无效：' + error.message; }
}

/**
 * 在独立任务目录执行 Vivado RTL 详细化；sourcePath 必须是工程综合源，top 只覆盖本次运行。
 * @param {{task:object,executable:string,projectPath:string,outputBase:string,top?:string,sourcePath?:string,timeoutMs?:number,onOutput?:Function}} options
 * @returns {Promise<{filePath:string,sourceRoot:string}>} 调用者在 task.finish() 前读取产物。
 * @throws {Error} 任务取消、Vivado 失败、未生成文件或产物超出安全预算。
 */
async function runVivadoCircuit({ task, executable, projectPath, outputBase, top, sourcePath, timeoutMs = DEFAULT_TIMEOUT_MS, onOutput }) {
    if (!task || typeof executable !== 'string' || !executable || typeof projectPath !== 'string' || !projectPath || typeof outputBase !== 'string' || !outputBase) {
        throw new TypeError('Vivado 电路导出需要任务、可执行文件、XPR 和产物目录');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Vivado 电路导出超时必须为正数');
    if (top !== undefined && (typeof top !== 'string' || !top || /[\r\n\0]/.test(top))) throw new TypeError('Vivado 电路顶层无效');
    if (sourcePath !== undefined && (typeof sourcePath !== 'string' || !sourcePath || /[\r\n\0]/.test(sourcePath) || !top)) {
        throw new TypeError('Vivado 当前源文件需要有效路径及显式顶层');
    }
    await task.waitForPrevious();
    const project = path.resolve(projectPath);
    const projectStat = await fs.stat(project);
    if (!projectStat.isFile() || !/\.xpr$/i.test(project)) throw new Error('Vivado 工程必须是 XPR 文件');
    const source = sourcePath === undefined ? undefined : path.resolve(sourcePath);
    if (source && (!/\.(?:sv|v)$/i.test(source) || !(await fs.stat(source)).isFile())) throw new Error('Vivado 电路源文件必须是 Verilog/SystemVerilog 普通文件');
    const directory = await task.directory(outputBase, 'circuit-vivado');
    const filePath = path.join(directory, 'circuit.vivado.json');
    const scriptPath = path.join(directory, 'export-circuit.tcl');
    const script = buildVivadoExportScript({ projectPath: project, outputPath: filePath, exporterPath: path.join(__dirname, 'vivado-export.tcl'), top, sourcePath: source });
    await fs.writeFile(scriptPath, script, 'utf8');
    task.throwIfCancelled();
    const result = await runVivadoBatchTask({ task, executable,
        args: ['-mode', 'batch', '-nojournal', '-nolog', '-source', scriptPath],
        cwd: directory, scriptPath, timeoutMs, onOutput });
    task.throwIfCancelled();
    if (!result.ok) {
        // Tcl收尾的“Elaboration failed”会掩盖前面的模块、语法或端口错误。
        const concrete = result.issues.find(issue => issue.level === 'ERROR' && !/^\[Vivado_Tcl 4-5\]/.test(issue.text));
        const detail = concrete?.text || readTclError(result.stdout);
        throw new Error('Vivado 电路详细化失败：' + (detail || result.message) + (result.logPath ? '\n完整日志：' + result.logPath : ''));
    }
    let stat;
    try { stat = await fs.stat(filePath); }
    catch (error) { throw new Error('Vivado 未生成完整的电路 JSON：' + error.message); }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_EXPORT_BYTES) throw new Error('Vivado 电路 JSON 为空、无效或超过 64 MiB 预算');
    return { filePath, sourceRoot: path.dirname(project) };
}

module.exports = { runVivadoCircuit };
