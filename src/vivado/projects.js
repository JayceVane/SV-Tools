'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const SELECTION_KEY = 'svtools.vivado.selectedProject';
const MAX_PROJECTS = 1000;
const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

/**
 * 工程树与编辑器命令共用同一工程选择；显式选择优先，自动发现顺序稳定。
 * @param {{workspace:object,state:object,stat?:Function}} deps
 * @returns {{discover:Function,current:Function,select:Function}} 读取失败传播，删除的选择保留恢复提示。
 */
function createProjectSelection({ workspace, state, stat = fs.stat }) {
    let selected = state.get(SELECTION_KEY) || null, automatic = null, version = 0;
    async function exists(file) {
        try { return (await stat(file)).isFile(); }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }
    async function discover() {
        const found = await workspace.findFiles('**/*.xpr', '**/{node_modules,.svtools}/**', MAX_PROJECTS);
        const files = new Map(found.map(uri => [pathKey(uri.fsPath), uri.fsPath]));
        return [...files.values()].sort((a, b) => pathKey(a).localeCompare(pathKey(b)));
    }
    async function current() {
        if (selected) {
            const candidate = selected, generation = version;
            let valid;
            try { valid = await exists(candidate); }
            catch (error) { if (generation !== version) return current(); throw error; }
            if (generation !== version) return current();
            if (!valid) throw new Error('所选工程已不存在：' + candidate + '。请重新选择工程。');
            return selected;
        }
        if (!workspace.workspaceFolders?.length) return null;
        const inWorkspace = automatic && workspace.workspaceFolders.some(folder => {
            const relative = path.relative(folder.uri.fsPath, automatic);
            return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
        });
        if (inWorkspace && await exists(automatic)) return selected || automatic;
        const files = await discover();
        automatic = files[0] || null; return selected || automatic;
    }
    async function select(file) {
        if (!/\.xpr$/i.test(file) || !await exists(file)) throw new Error('无法打开工程：' + file);
        const candidate = path.resolve(file);
        await state.update(SELECTION_KEY, candidate); selected = candidate; version++; return candidate;
    }
    return { discover, current, select };
}
module.exports = { createProjectSelection };
