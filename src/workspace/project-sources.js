'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseXprText, samePath } = require('../vivado/xpr');
const inside = (file, root) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

/** @param {{vscode:object,projectSelection:object}} deps @returns {Function} 当前工程成员适配；有多个仿真集且无法定位时保留全部，避免猜测。 */
function createProjectSourceProvider({ vscode, projectSelection, projects }) {
    let cached;
    return async ({ root, file }) => {
        const active = projects ? await projects.current() : null;
        if (active) {
            const filesets = active.sets.filter(set => ['DesignSrcs','SimulationSrcs'].includes(set.type));
            const member = file && filesets.some(set => set.files.some(member => samePath(member,file)));
            if (root && !inside(root,active.root) && !inside(active.root,root)) return null;
            if (file && !member && (!/\.vcd$/i.test(file) || !inside(file,active.root))) return null;
            const matching = filesets.filter(set => set.type === 'SimulationSrcs' && set.files.some(member => samePath(member,file || '')));
            const files = [...new Set(filesets.filter(set => set.type === 'DesignSrcs' || matching.length !== 1 || matching.includes(set)).flatMap(set => set.files))];
            return {key:active.key,files,roots:[...new Set([active.root,...files.map(file => path.dirname(file))])]};
        }
        const xpr = await projectSelection.current(); if (!xpr) return null;
        const stat = await fs.stat(xpr), key = xpr + ':' + stat.mtimeMs + ':' + stat.size;
        if (stat.size > 8 * 1024 * 1024) throw new Error('工程源码上下文的XPR超过8 MiB');
        if (cached?.key !== key) cached = { key, project: parseXprText(new TextDecoder('utf-8', { fatal:true }).decode(await fs.readFile(xpr)), xpr) };
        const project = cached.project, folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(xpr))?.uri.fsPath || project.dir;
        if (root && !inside(xpr, root) && !inside(root, folder)) return null;
        const hdl = project.sets.filter(set => ['DesignSrcs','SimulationSrcs'].includes(set.type));
        const member = file && hdl.some(set => set.files.some(member => samePath(member,file)));
        if (file && !member && (!/\.vcd$/i.test(file) || !inside(file,folder))) return null;
        const simulation = hdl.filter(set => set.type === 'SimulationSrcs');
        const matching = file ? simulation.filter(set => set.files.some(member => samePath(member,file))) : [];
        const chosen = matching.length === 1 ? matching : simulation;
        const sets = hdl.filter(set => set.type === 'DesignSrcs' || chosen.includes(set));
        const files = [...new Set(sets.flatMap(set => set.files).filter(file => /\.(?:sv|v|svh|vh)$/i.test(file)))];
        if (!files.length) return null;
        return { key, files, roots: [...new Set([folder, ...files.map(file => path.dirname(file))])] };
    };
}
module.exports = { createProjectSourceProvider };
