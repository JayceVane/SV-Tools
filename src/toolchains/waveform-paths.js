'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');

/**
 * @param {{root:string,sourceFile:string,engine:string,top?:string}} options 工作区根；无工作区时由调用方传源码目录。
 * @returns {string} 稳定且区分源文件、顶层和引擎的默认VCD路径，不改变仿真cwd。
 */
function defaultVcdPath({ root, sourceFile, engine, top = '' }) {
    if (!root || !sourceFile || !/^[a-z][a-z0-9-]*$/i.test(engine)) throw new TypeError('默认波形路径需要根目录、源文件与有效引擎标识');
    let identity = path.relative(path.resolve(root), path.resolve(sourceFile)).replace(/\\/g, '/');
    if (process.platform === 'win32') identity = identity.toLowerCase();
    const digest = createHash('sha256').update(JSON.stringify([identity, top])).digest('hex').slice(0, 12);
    const name = (top || path.basename(sourceFile, path.extname(sourceFile))).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'wave';
    return path.join(root, '.svtools', 'vcd', name + '-' + digest + '-' + engine + '.vcd');
}
module.exports = { defaultVcdPath };
