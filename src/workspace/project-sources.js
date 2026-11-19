'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseXprText, samePath } = require('../vivado/xpr');
const inside = (file, root) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

function projectSources(project, root, file) {
    if (root && !inside(root, project.root) && !inside(project.root, root)) return null;
    const filesets = project.sets.filter(set => ['DesignSrcs', 'SimulationSrcs'].includes(set.type));
    const owners = file ? filesets.filter(set => set.files.some(member => samePath(member, file))) : [];
    if (file && !owners.length && (!/\.(vcd|fst)$/i.test(file) || !inside(file, project.root))) return null;
    const matching = owners.filter(set => set.type === 'SimulationSrcs');
    // An empty HDL list must let consumers fall back to workspace discovery.
    const files = [...new Set(filesets.filter(set => set.type === 'DesignSrcs' || matching.length !== 1 || matching.includes(set))
        .flatMap(set => set.files).filter(member => /\.(?:sv|v|svh|vh)$/i.test(member)))];
    if (!files.length) return null;
    const macroSets = owners.map(set => [...new Set((set.defines || []).map(define => define.split('=')[0]))].sort().join('\0'));
    return { key: project.key, files, roots: [...new Set([project.root, ...files.map(file => path.dirname(file))])],
        includeDirs: project.includeDirs || [], defines: [...(project.defines || []), ...(owners[0]?.defines || [])],
        ambiguousDefines: macroSets.some(macros => macros !== macroSets[0]) };
}

/** @param {{vscode:object,projectSelection:object}} deps @returns {Function} 当前工程成员适配；有多个仿真集且无法定位时保留全部，避免猜测。 */
function createProjectSourceProvider({ vscode, projectSelection, projects }) {
    let cached;
    return async ({ root, file, findContainingVivado = false }) => {
        if (projects) {
            const active = await projects.current();
            const scope = active && projectSources(active, root, file);
            if (scope || !findContainingVivado || !file) return scope;
            const candidates = (await projectSelection.discover())
                .filter(xpr => !samePath(xpr, active?.path) && inside(file, path.dirname(xpr)))
                .sort((a, b) => path.dirname(b).length - path.dirname(a).length);
            for (const xpr of candidates) {
                const candidate = await projects.snapshot({ kind: 'vivado', path: xpr });
                const scope = projectSources(candidate, root, file);
                if (scope) return scope;
            }
            return null;
        }
        const xpr = await projectSelection.current(); if (!xpr) return null;
        const stat = await fs.stat(xpr), key = xpr + ':' + stat.mtimeMs + ':' + stat.size;
        if (stat.size > 8 * 1024 * 1024) throw new Error('工程源码上下文的XPR超过8 MiB');
        if (cached?.key !== key) cached = { key, project: parseXprText(new TextDecoder('utf-8', { fatal:true }).decode(await fs.readFile(xpr)), xpr) };
        const project = cached.project, folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(xpr))?.uri.fsPath || project.dir;
        if (root && !inside(xpr, root) && !inside(root, folder)) return null;
        return projectSources({ ...project, key, root: folder }, undefined, file);
    };
}
module.exports = { createProjectSourceProvider };
