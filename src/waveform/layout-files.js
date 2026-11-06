'use strict';
const path = require('node:path');
const { validate, MAX_BYTES } = require('./layout-state');
const { assertExportTarget } = require('../workspace/export-target');

/** @param {{vscode:object,filePath:string}} deps @returns {{save:Function,load:Function,auto:Function}} 对话框边界与同名自动套用；写入只接受用户选定的本地布局文件。 */
function createLayoutFiles({ vscode, filePath }) {
    const filters = { 'SV Tools Wave Layout': ['svwave.json', 'json'] };
    /** 同名约定：VCD/FST 去扩展名后接 .svwave.json；保存对话框与自动套用共用，避免 FST 下两者错开。 */
    const defaultPath = () => filePath.replace(/\.(?:vcd|fst)$/i, '') + '.svwave.json';
    /** @param {object} layout @param {object} [target] 显式URI用于扩展API调用。@returns {Promise<boolean>} 取消返回false。 */
    async function save(layout, target) {
        validate(layout);
        const uri = target || await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultPath()), filters });
        if (!uri) return false;
        if (uri.scheme !== 'file' || path.resolve(uri.fsPath).toLowerCase() === path.resolve(filePath).toLowerCase()) throw new Error('请选择独立的本地布局文件，不能覆盖 VCD');
        if (path.extname(uri.fsPath).toLowerCase() !== '.json') throw new Error('布局文件扩展名必须是 .svwave.json 或 .json');
        await assertExportTarget(uri.fsPath, filePath);
        const bytes = Buffer.from(JSON.stringify(layout, null, 2) + '\n', 'utf8');
        if (bytes.length > MAX_BYTES) throw new Error('布局文件超过4 MiB预算');
        await vscode.workspace.fs.writeFile(uri, bytes); return true;
    }
    /** @param {object} [target] @returns {Promise<object|null>} 版本已验证的布局；取消返回null，读取错误传播。 */
    async function load(target) {
        const uri = target || (await vscode.window.showOpenDialog({ canSelectMany: false, filters }))?.[0];
        if (!uri) return null;
        if (uri.scheme !== 'file') throw new Error('请选择本地布局文件');
        if ((await vscode.workspace.fs.stat(uri)).size > MAX_BYTES) throw new Error('布局文件超过4 MiB预算');
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.length > MAX_BYTES) throw new Error('布局文件超过4 MiB预算');
        return validate(JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')));
    }
    /** 同名布局自动套用：波形同目录、去 .vcd/.fst 扩展名后接 .svwave.json；缺失/超限/格式错误一律返回 null（无同名布局是常态，不打扰默认视图）。 */
    async function auto() {
        const uri = vscode.Uri.file(defaultPath());
        try {
            if ((await vscode.workspace.fs.stat(uri)).size > MAX_BYTES) return null;
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.length > MAX_BYTES) return null;
            return validate(JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')));
        } catch { return null; }
    }
    return { save, load, auto };
}
module.exports = { createLayoutFiles };
