'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { parseXprText } = require('../vivado/xpr');
const { isExcludedSourcePath } = require('../workspace/source-policy');
const STATE_KEY = 'svtools.project.active', MAX_FILES = 4096, MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const keyOf = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const inside = (file, root) => {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const hdl = file => /\.(?:sv|v|svh|vh)$/i.test(file);
const strings = value => Array.isArray(value) && value.length <= MAX_FILES && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 4096 && !/[\0\r\n]/.test(item));
/** @param {string} file 配置路径。 @returns {Promise<object>} 有界且严格的UTF-8配置读取。 */
async function readConfig(file) {
    const handle = await fs.open(file, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
            throw new Error('工程配置必须为不超过2MiB的普通文件');
        }
        const buffer = Buffer.alloc(stat.size + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== stat.size) {
            throw new Error('工程配置读取期间发生变化，请重试');
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)).replace(/^\uFEFF/, ''));
    }
    finally {
        await handle.close();
    }
}
/** @param {object} config 配置数据。 @returns {object} 不接受执行脚本或任意配置目标。 */
function validateConfig(config) {
    if (!config || config.schemaVersion !== 1 || typeof config.name !== 'string' || !config.name.trim() || config.name.length > 128
        || typeof config.root !== 'string' || !config.root || !['sources', 'simulation', 'includeDirs', 'defines', 'exclude'].every(field => strings(config[field]))
        || !Array.isArray(config.folders) || config.folders.length > MAX_FILES || config.folders.some(entry => !entry || !strings([entry.path]) || !['sources', 'simulation'].includes(entry.fileset))
        || !['top', 'simTop'].every(field => typeof config[field] === 'string' && config[field].length <= 1024 && !/[\0\r\n]/.test(config[field]))) {
        throw new Error('SV Tools工程配置无效，要求schemaVersion=1');
    }
    return config;
}
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
        if (!project || !['vivado', 'svtools'].includes(project.kind) || typeof project.path !== 'string') {
            throw new Error('工程身份无效');
        }
        const file = path.resolve(project.path);
        if (project.kind === 'vivado') {
            const handle = await fs.open(file, 'r');
            let bytes;
            try {
                if ((await handle.stat()).size > 8 * 1024 * 1024) {
                    throw new Error('XPR工程超过8MiB');
                }
                bytes = await handle.readFile();
            }
            finally {
                await handle.close();
            }
            if (bytes.length > 8 * 1024 * 1024) {
                throw new Error('XPR工程读取期间超出8MiB');
            }
            const parsed = parseXprText(new TextDecoder('utf-8', { fatal: true }).decode(bytes), file);
            const root = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath || parsed.dir;
            return { ...project, path: file, id: keyOf(file), root, name: path.basename(file, '.xpr'), sets: parsed.sets,
                top: parsed.sets.find(set => set.type === 'DesignSrcs')?.top || '', includeDirs: [], defines: [],
                key: createHash('sha256').update(bytes).digest('hex'), parsed };
        }
        const config = validateConfig(await readConfig(file)), root = path.resolve(path.dirname(file), config.root);
        const exclude = new Set(config.exclude.map(entry => keyOf(path.resolve(root, entry))));
        const lists = { sources: new Map(), simulation: new Map() };
        let visits = 0;
        function add(member, fileset, explicit = false) {
            if (hdl(member) && !isExcludedSourcePath(member) && (explicit || !exclude.has(keyOf(member)))) {
                lists[fileset].set(keyOf(member), member);
            }
            if (lists.sources.size + lists.simulation.size > MAX_FILES) {
                throw new Error('工程成员超过4096文件，请缩小跟随目录');
            }
        }
        for (const fileset of ['sources', 'simulation'])
            for (const member of config[fileset])
                add(path.resolve(root, member), fileset, true);
        async function walk(directory, fileset, depth = 0) {
            if (depth > 32) {
                throw new Error('工程目录超过32层');
            }
            const entries = await fs.readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                if (++visits > 50000) {
                    throw new Error('工程目录扫描超过50000项，请选择更具体的目录');
                }
                const member = path.join(directory, entry.name);
                if (entry.isSymbolicLink() || isExcludedSourcePath(member)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    // 被移出的目录必须整棵剪枝：add() 的文件级排除无法阻止刷新或目录内新增文件重新进入工程。
                    if (!exclude.has(keyOf(member))) {
                        await walk(member, fileset, depth + 1);
                    }
                }
                else if (entry.isFile()) {
                    add(member, fileset);
                }
            }
        }
        for (const folder of config.folders)
            await walk(path.resolve(root, folder.path), folder.fileset);
        const sets = [{ name: 'sources', type: 'DesignSrcs', top: config.top, files: [...lists.sources.values()] },
            { name: 'simulation', type: 'SimulationSrcs', top: config.simTop, files: [...lists.simulation.values()] }];
        return { ...project, path: file, id: keyOf(file), root, name: config.name, config, sets, top: config.top,
            includeDirs: config.includeDirs.map(entry => path.resolve(root, entry)), defines: config.defines,
            key: createHash('sha256').update(JSON.stringify([config, sets])).digest('hex') };
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
