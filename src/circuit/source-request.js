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
async function prepareSourceRequest({ document, root, top, config, task, outputBase }) {
    const filePath = document.uri.fsPath;
    const sources = configuredPaths(config.sources || [], root);
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!sources.some(file => key(file) === key(filePath))) sources.push(filePath);
    const includeDirs = [...new Set([path.dirname(filePath), ...configuredPaths(config.includeDirs || [], root)])];
    const sourceMap = {};
    if (document.isDirty) {
        const text = document.getText();
        if (Buffer.byteLength(text, 'utf8') > MAX_BUFFER_BYTES) throw new Error('未保存 RTL 快照超过 16 MiB');
        const directory = await task.directory(outputBase, 'source');
        const snapshot = path.join(directory, path.basename(filePath));
        await fs.writeFile(snapshot, text, 'utf8');
        for (let index = 0; index < sources.length; index++) if (key(sources[index]) === key(filePath)) sources[index] = snapshot;
        sourceMap[snapshot] = filePath;
    }
    return { sources, includeDirs, defines: config.defines || [], frontend: config.frontend || 'auto',
        top, sourceRoot: root, title: path.basename(filePath), sourceMap };
}
module.exports = { topCandidates, prepareSourceRequest };
