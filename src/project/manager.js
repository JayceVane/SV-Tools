'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const STATE_KEY = 'svtools.project.active';
const { readProjectSnapshot, readConfig, validateConfig, keyOf, inside, hdl, strings, MAX_FILES } = require('./model');
/**
 * 统一工程选择与成员快照；工具适配器继续拥有各自执行逻辑。
 * @param {{vscode:object,state:object,vivadoSelection:object}} dependencies
 * @returns {object} 工程发现、选择、成员修改、变化通知及Vivado兼容边界。
 */
function createProjectManager({ vscode, state, vivadoSelection, rename = fs.rename }) {
    let selected = state.get(STATE_KEY), revision = 0, disposed = false, mutations = Promise.resolve(), selections = Promise.resolve();
    const listeners = new Set();
    const changed = () => {
        revision++;
        for (const listener of listeners)
            listener();
    };
    const roots = () => (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    const descriptor = (kind, file) => ({ kind, path: path.resolve(file) });
    async function discover() {
        const result = (await vivadoSelection.discover()).map(file => descriptor('vivado', file));
        for (const root of roots()) {
            const directory = path.join(root, '.svtools', 'projects');
            let names;
            try {
                names = await fs.readdir(directory);
            }
            catch (error) {
                if (error.code === 'ENOENT') {
                    continue;
                }
                throw error;
            }
            for (const name of names.sort())
                if (/\.json$/i.test(name)) {
                    result.push(descriptor('svtools', path.join(directory, name)));
                }
        }
        if (selected && !result.some(item => keyOf(item.path) === keyOf(selected.path))) {
            result.push(selected);
        }
        if (result.length > 1000) {
            throw new Error('工程数量超过1000，请缩小工作区');
        }
        return result;
    }
    async function snapshot(project) {
        const workspaceRoot = project?.kind === 'vivado' && typeof project.path === 'string'
            ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path.resolve(project.path)))?.uri.fsPath : undefined;
        return readProjectSnapshot(project, { workspaceRoot });
    }
    async function current() {
        if (disposed) {
            throw new Error('工程服务已关闭');
        }
        const version = revision, automatic = selected ? null : await vivadoSelection.current(), candidate = selected || (automatic ? descriptor('vivado', automatic) : null);
        let result;
        try {
            result = candidate ? await snapshot(candidate) : null;
        }
        catch (error) {
            if (version !== revision) {
                return current();
            }
            throw error;
        }
        return version !== revision ? current() : result;
    }
    function select(project) {
        const operation = selections.then(async () => {
            const checked = await snapshot(project), next = descriptor(checked.kind, checked.path);
            if (next.kind === 'vivado') await vivadoSelection.select(next.path);
            await state.update(STATE_KEY, next);
            selected = next;
            changed();
            return checked;
        });
        // 队列只吸收前次失败以继续调度；调用方仍收到原始拒绝。
        selections = operation.catch(() => {});
        return operation;
    }
    async function write(file, config, create = false) {
        validateConfig(config);
        const root = roots().find(root => keyOf(path.dirname(file)) === keyOf(path.join(root, '.svtools', 'projects')));
        if (!root || !/\.json$/i.test(file)) {
            throw new Error('只能修改工作区.svtools/projects下的工程配置');
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        if (!inside(await fs.realpath(path.dirname(file)), await fs.realpath(root))) {
            throw new Error('工程配置目录不能通过链接指向工作区外部');
        }
        try {
            const stat = await fs.lstat(file);
            if (create || stat.isSymbolicLink() || stat.nlink > 1 || !stat.isFile()) {
                throw new Error('工程配置已存在或不是独立普通文件');
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
        const temporary = file + '.' + randomUUID() + '.tmp';
        await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
        try {
            if (create) {
                await fs.copyFile(temporary, file, constants.COPYFILE_EXCL);
                await fs.unlink(temporary);
            }
            else {
                for (let attempt = 0; ; attempt++) {
                    try { await rename(temporary,file); break; }
                    catch (error) {
                        if (process.platform !== 'win32' || !['EPERM','EACCES','EBUSY'].includes(error.code) || attempt >= 3) throw error;
                        // Windows索引器/杀毒软件可能短暂持有配置；保留原文件，有限重试原子替换。
                        await delay(25 * (attempt + 1));
                    }
                }
            }
        }
        catch (error) {
            await fs.unlink(temporary).catch(cleanup => {
                if (cleanup.code !== 'ENOENT') {
                    console.error(cleanup);
                }
            });
            throw error;
        }
        changed();
    }
    function serialize(action) {
        const result = mutations.then(action);
        mutations = result.catch(() => {
        });
        return result;
    }
    async function create(root, name) {
        if (!roots().some(item => keyOf(item) === keyOf(root)) || !/^[\w\u4e00-\u9fff-]{1,64}$/.test(name) || /^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) {
            throw new Error('工程名称或工作区无效');
        }
        const file = path.join(root, '.svtools', 'projects', name + '.json');
        return serialize(async () => {
            await write(file, { schemaVersion: 1, name, root: '../..', sources: [], simulation: [], folders: [], exclude: [], top: '', simTop: '', includeDirs: [], defines: [] }, true);
            return select(descriptor('svtools', file));
        });
    }
    function update(project, action) {
        return serialize(async () => {
            const current = await snapshot(project);
            if (current.kind !== 'svtools') {
                throw new Error('Vivado工程请使用Vivado文件管理命令');
            }
            await action(current.config, current.root);
            await write(current.path, current.config);
            return snapshot(project);
        });
    }
    const onDidChange = listener => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
    };
    const adapter = { discover: vivadoSelection.discover, current: async () => {
            const project = await current();
            return project?.kind === 'vivado' ? project.path : null;
        },
        select: file => select(descriptor('vivado', file)), onDidChange };
    return { current, snapshot, discover, select, create, update, onDidChange, vivadoSelection: adapter, invalidate: changed,
        async add(project, file, fileset = 'sources') {
            if (!['sources', 'simulation'].includes(fileset)) {
                throw new Error('工程文件集无效');
            }
            return update(project, async (config, root) => {
                const stat = await fs.stat(file), relative = path.relative(root, file);
                config.exclude = config.exclude.filter(entry => keyOf(path.resolve(root, entry)) !== keyOf(file));
                if (stat.isDirectory()) {
                    if (!config.folders.some(entry => keyOf(path.resolve(root, entry.path)) === keyOf(file) && entry.fileset === fileset)) {
                        config.folders.push({ path: relative || '.', fileset });
                    }
                }
                else if (stat.isFile() && hdl(file)) {
                    if (!config[fileset].some(entry => keyOf(path.resolve(root, entry)) === keyOf(file))) {
                        config[fileset].push(relative);
                    }
                }
                else {
                    throw new Error('请选择HDL文件或源码目录');
                }
            });
        },
        remove: (project, file) => update(project, (config, root) => {
            // 目录移出工程应覆盖整棵子树（显式成员与跟随目录都算），仅删除精确项会让刷新后的文件复活。
            const target = path.resolve(root, file), removed = entry => {
                const candidate = path.resolve(root, entry);
                return keyOf(candidate) === keyOf(target) || inside(candidate, target);
            };
            for (const set of ['sources', 'simulation'])
                config[set] = config[set].filter(entry => !removed(entry));
            config.folders = config.folders.filter(entry => !removed(entry.path));
            const relative = path.relative(root, file);
            if (relative && !config.exclude.includes(relative)) {
                config.exclude.push(relative);
            }
        }),
        move: (project, file, fileset) => update(project, (config,root) => {
            if (!['sources','simulation'].includes(fileset)) throw new Error('目标文件集无效');
            const relative = path.relative(root,file);
            for (const set of ['sources','simulation']) config[set] = config[set].filter(entry => keyOf(path.resolve(root,entry)) !== keyOf(file));
            if (!config.exclude.includes(relative)) config.exclude.push(relative);
            config[fileset].push(relative);
        }),
        dispose() {
            disposed = true;
            listeners.clear();
        } };
}
module.exports = { createProjectManager, validateConfig, keyOf, inside };
