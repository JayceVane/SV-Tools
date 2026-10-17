'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { extractDesignUnits, maskSourceText } = require('../workspace/sources');
const MAX_PATHS = 4096;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** @param {string} text @returns {{name:string,start:number,end:number}[]} 仅用源码索引选择顶层，不推导电路连接。 */
function topCandidates(text) {
    const masked = maskSourceText(text);
    return extractDesignUnits(text).filter(unit => /^\s*(?:module|macromodule)\b/.test(masked.slice(unit.start, unit.end)));
}

function configuredPaths(values, root) {
    if (!Array.isArray(values) || values.length > MAX_PATHS || values.some(value => typeof value !== 'string' || !value.trim())) {
        throw new Error('电路源文件或 include 目录配置无效');
    }
    return values.map(value => path.resolve(root, value));
}

/**
 * @param {{document:object,root:string,top:string,config:object,task:object,outputBase:string}} options
 * @returns {Promise<object>} 未保存正文写入任务快照，保留相对 include 与源码映射；不保存或改写用户文件。
 */
async function prepareSourceRequest({ document, root, top, config, task, outputBase, resolveSources }) {
    const filePath = document.uri.fsPath;
    let sources = configuredPaths(config.sources || [], root);
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!sources.some(file => key(file) === key(filePath))) sources.push(filePath);
    const configuredIncludes = configuredPaths(config.includeDirs || [], root);
    const current = { file: filePath, text: document.getText?.(), isDirty: document.isDirty };
    const context = resolveSources ? await resolveSources({ current, root, top, sources, isExplicit: !!config.sources?.length, includeDirs: configuredIncludes, task }) : { sources, documents: [current] };
    sources = context.sources;
    const includeDirs = [...new Set([path.dirname(filePath), ...configuredIncludes, ...sources.map(file => path.dirname(file))])];
    const buffers = new Map(context.documents.map(buffer => [key(path.resolve(buffer.file)), buffer]));
    const sourceMap = {}; let snapshotBytes = 0;
    for (let index = 0; index < sources.length; index++) {
        const original = sources[index], buffer = buffers.get(key(path.resolve(original)));
        if (!buffer?.isDirty) continue;
        snapshotBytes += Buffer.byteLength(buffer.text || '', 'utf8');
        if (snapshotBytes > 64 * 1024 * 1024) throw new Error('未保存 RTL 依赖快照总量超过64 MiB');
        if (typeof buffer.text !== 'string' || Buffer.byteLength(buffer.text, 'utf8') > MAX_BUFFER_BYTES) throw new Error('未保存 RTL 快照超过 16 MiB');
        const directory = path.join(await task.directory(outputBase, 'source'), String(index));
        await fs.mkdir(directory, { recursive: true });
        const snapshot = path.join(directory, path.basename(original));
        await fs.writeFile(snapshot, buffer.text, 'utf8'); sources[index] = snapshot; sourceMap[snapshot] = original;
    }
    return { sources, includeDirs, defines: config.defines || [], frontend: config.frontend || 'auto',
        top, sourceRoot: root, title: path.basename(filePath), sourceMap };
}
module.exports = { topCandidates, prepareSourceRequest };
