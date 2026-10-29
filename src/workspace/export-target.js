'use strict';
const fs = require('node:fs/promises');

/**
 * @param {string} target 本地导出目标。
 * @param {string} [source] 需要保护的输入文件。
 * @returns {Promise<void>} 新文件或独立普通文件可保存；链接、别名或非普通文件抛错。
 */
async function assertExportTarget(target, source) {
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
        throw new Error('导出目标必须是独立普通文件，不能写入链接或多重硬链接文件');
    }
    if (!source) return;
    let original;
    try { original = await fs.realpath(source); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const destination = await fs.realpath(target);
    const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
    if (key(original) === key(destination)) throw new Error('请选择独立导出文件，不能覆盖源文件的路径别名');
}
module.exports = { assertExportTarget };
