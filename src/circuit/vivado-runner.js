'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { runVivadoBatchTask } = require('../vivado/batch');
const { buildVivadoExportScript } = require('./vivado-export');
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

/**
 * 在独立任务目录执行 Vivado RTL 详细化，并返回完整、非空的真实对象 JSON。
 * @param {{task:object,executable:string,projectPath:string,outputBase:string,timeoutMs?:number,onOutput?:Function}} options
 * @returns {Promise<{filePath:string,sourceRoot:string}>} 调用者在 task.finish() 前读取产物。
 * @throws {Error} 任务取消、Vivado 失败、未生成文件或产物超出安全预算。
 */
async function runVivadoCircuit({ task, executable, projectPath, outputBase, timeoutMs = DEFAULT_TIMEOUT_MS, onOutput }) {
    if (!task || typeof executable !== 'string' || !executable || typeof projectPath !== 'string' || !projectPath || typeof outputBase !== 'string' || !outputBase) {
        throw new TypeError('Vivado 电路导出需要任务、可执行文件、XPR 和产物目录');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Vivado 电路导出超时必须为正数');
    await task.waitForPrevious();
    const project = path.resolve(projectPath);
    const projectStat = await fs.stat(project);
    if (!projectStat.isFile() || !/\.xpr$/i.test(project)) throw new Error('Vivado 工程必须是 XPR 文件');
    const directory = await task.directory(outputBase, 'circuit-vivado');
    const filePath = path.join(directory, 'circuit.vivado.json');
    const scriptPath = path.join(directory, 'export-circuit.tcl');
    const script = buildVivadoExportScript({ projectPath: project, outputPath: filePath, exporterPath: path.join(__dirname, 'vivado-export.tcl') });
    await fs.writeFile(scriptPath, script, 'utf8');
    task.throwIfCancelled();
    const result = await runVivadoBatchTask({ task, executable,
        args: ['-mode', 'batch', '-nojournal', '-nolog', '-source', scriptPath],
        cwd: directory, scriptPath, timeoutMs, onOutput });
    task.throwIfCancelled();
    if (!result.ok) {
        const detail = /^SVTOOLS_CIRCUIT_ERROR (.+)$/m.exec(result.stdout)?.[1];
        throw new Error('Vivado 电路详细化失败：' + (detail || result.message) + (result.logPath ? '\n完整日志：' + result.logPath : ''));
    }
    let stat;
    try { stat = await fs.stat(filePath); }
    catch (error) { throw new Error('Vivado 未生成完整的电路 JSON：' + error.message); }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_EXPORT_BYTES) throw new Error('Vivado 电路 JSON 为空、无效或超过 64 MiB 预算');
    return { filePath, sourceRoot: path.dirname(project) };
}

module.exports = { runVivadoCircuit };
