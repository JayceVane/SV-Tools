'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseXprText, inspectXprText } = require('../vivado/xpr');
const { isExcludedSourcePath } = require('../workspace/source-policy');
const MAX_FILES = 4096, MAX_CONFIG_BYTES = 2 * 1024 * 1024;
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

/** 无编辑器依赖的工程成员快照，界面与CLI使用相同文件集规则。 */
async function readProjectSnapshot(project, { workspaceRoot, withDocument = false } = {}) {
    if (!project || !['vivado', 'svtools'].includes(project.kind) || typeof project.path !== 'string') {
        throw new Error('工程身份无效');
    }
    const file = path.resolve(project.path);
    if (project.kind === 'vivado') {
        const handle = await fs.open(file, 'r');
        let bytes;
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
                throw new Error('XPR工程超过8MiB');
            }
            const buffer = Buffer.alloc(stat.size + 1), { bytesRead } = await handle.read(buffer,0,buffer.length,0);
            if (bytesRead !== stat.size) throw new Error('XPR工程读取期间发生变化');
            bytes = buffer.subarray(0,bytesRead);
        }
        finally {
            await handle.close();
        }
        if (bytes.length > 8 * 1024 * 1024) {
            throw new Error('XPR工程读取期间超出8MiB');
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const document = withDocument ? inspectXprText(text,file) : null;
        const parsed = document?.parsed || parseXprText(text,file);
        const root = workspaceRoot || parsed.dir;
        return { ...project, path: file, id: keyOf(file), root, name: path.basename(file, '.xpr'), sets: parsed.sets,
            top: parsed.sets.find(set => set.type === 'DesignSrcs')?.top || '', includeDirs: [], defines: [],
            key: createHash('sha256').update(bytes).digest('hex'), parsed, ...(document ? {document} : {}) };
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
        const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name));
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

module.exports = { readProjectSnapshot, readConfig, validateConfig, keyOf, inside, hdl, strings, MAX_FILES };
