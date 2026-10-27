'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
/**
 * 同一工作区的Vivado执行共用一个历史预算；生成脚本和日志由同一个ToolTask拥有。
 * @param {object} job 有取消检查和目录生命周期的工具任务。
 * @param {string|{anchor:string,name:string,body:string,validate?:Function}} input 用户Tcl路径或待生成动作。
 * @param {{workspace:object,uri:Function}} host 工作区归属与URI边界。
 * @returns {Promise<{scriptPath:string,cwd:string,directory:string}>} 用户脚本不移动，生成动作以任务目录为cwd。
 * @throws {Error} 非法脚本描述、取消、工程上下文变化或文件写入失败。
 */
async function prepareVivadoScript(job, input, { workspace, uri }) {
    const generated = typeof input !== 'string';
    if (generated && (!input || typeof input.anchor !== 'string' || !path.isAbsolute(input.anchor)
        || typeof input.name !== 'string' || !/^[a-z0-9_][a-z0-9_.-]*\.tcl$/i.test(input.name)
        || typeof input.body !== 'string' || input.validate !== undefined && typeof input.validate !== 'function')) {
        throw new TypeError('无效的Vivado生成脚本名或描述');
    }
    const anchor = path.resolve(generated ? input.anchor : input);
    job.throwIfCancelled();
    if (generated) {
        await input.validate?.();
    }
    job.throwIfCancelled();
    const base = workspace.getWorkspaceFolder(uri(anchor))?.uri.fsPath || path.dirname(anchor);
    const directory = await job.directory(path.join(base, '.svtools', 'vivado', 'tasks'), 'vivado');
    const scriptPath = generated ? path.join(directory, input.name) : anchor;
    if (generated) {
        await fs.writeFile(scriptPath, input.body, { encoding: 'utf8', flag: 'wx' });
        await input.validate?.();
        job.throwIfCancelled();
    }
    return { scriptPath, cwd: generated ? directory : path.dirname(scriptPath), directory };
}
module.exports = { prepareVivadoScript };
