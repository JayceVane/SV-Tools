'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');

/**
 * @param {{root:string,sourceFile:string,engine:string,top?:string,dumpFile?:string}} options 工作区根；无工作区时由调用方传源码目录，dumpFile区分显式输出。
 * @returns {string} 稳定且区分源文件、顶层、引擎与显式输出的VCD路径，不改变仿真cwd。
 */
function defaultVcdPath({ root, sourceFile, engine, top = '', dumpFile }) {
    if (!root || !sourceFile || !/^[a-z][a-z0-9-]*$/i.test(engine)) throw new TypeError('默认波形路径需要根目录、源文件与有效引擎标识');
    const identity = file => {
        const relative = path.relative(path.resolve(root), path.resolve(file)).replace(/\\/g, '/');
        return process.platform === 'win32' ? relative.toLowerCase() : relative;
    };
    const parts = [identity(sourceFile), top];
    if (dumpFile) parts.push(identity(dumpFile));
    const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
    const label = dumpFile ? path.basename(dumpFile, path.extname(dumpFile)) : top || path.basename(sourceFile, path.extname(sourceFile));
    const name = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'wave';
    return path.join(root, '.svtools', 'vcd', name + '-' + digest + '-' + engine + '.vcd');
}
module.exports = { defaultVcdPath };
