'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_PATHS = 4096;

/**
 * 将显式源文件和 include 目录映射到稳定的 WASI 路径；不复制或改写用户源文件。
 * @param {{directory:string,sourceRoot:string,sources:string[],includeDirs?:string[]}} options
 * @returns {Promise<object>} 供脚本构建使用的路径、子进程启动信息及反向源码映射。
 */
async function prepareBundledYosys({ directory, sourceRoot, sources, includeDirs = [] }) {
    for (const values of [sources, includeDirs]) {
        if (!Array.isArray(values) || values.length > MAX_PATHS
            || values.some(value => typeof value !== 'string' || !value || value.length > 32768 || /[\r\n\0]/.test(value))) {
            throw new Error('内置 Yosys 的源文件或 include 路径配置无效');
        }
    }
    if (!sources.length) throw new Error('内置 Yosys 至少需要一个源文件');
    const assets = path.resolve(__dirname, '../../bin/vendor/yosys');
    try { await fs.access(path.join(assets, 'yosys.wasm')); await fs.access(path.join(assets, 'share')); }
    catch (error) { throw new Error('内置 Yosys 资源缺失，请重新安装完整 VSIX；开发环境请执行 npm run build:circuit。' + error.message); }
    const root = await fs.realpath(sourceRoot), taskRoot = await fs.realpath(directory);
    const preopens = { '/task': taskRoot }, sourceDirectories = [{ from: '/task', to: taskRoot }];
    const sourceFolders = new Map();
    const inputs = [];
    for (const file of sources) {
        const absolute = path.resolve(sourceRoot, file), folder = path.dirname(absolute);
        if (!sourceFolders.has(folder)) {
            const guest = '/source' + sourceFolders.size;
            sourceFolders.set(folder, guest);
            preopens[guest] = await fs.realpath(folder);
            sourceDirectories.push({ from: guest, to: folder });
        }
        inputs.push(sourceFolders.get(folder) + '/' + path.basename(absolute));
    }
    const includes = [];
    for (const [index, folder] of includeDirs.entries()) {
        const guest = '/include' + index, absolute = path.resolve(sourceRoot, folder);
        preopens[guest] = await fs.realpath(absolute);
        sourceDirectories.push({ from: guest, to: absolute });
        includes.push(guest);
    }
    // 根目录最后加入，避免反向映射先吞掉更具体的 /source、/include 与 /task。
    preopens['/'] = root;
    sourceDirectories.push({ from: '/', to: root });
    const configPath = path.join(directory, 'yosys-wasi.json');
    await fs.writeFile(configPath, JSON.stringify({ args: ['yosys', '-Q', '-T', '-s', '/task/circuit.ys'], preopens }), 'utf8');
    return { sources: inputs, includeDirs: includes, inputPath: '/task/sources.sv', outputPath: '/task/circuit.json',
        command: process.execPath, args: [path.join(__dirname, 'yosys-wasi.js'), configPath], sourceDirectories };
}

module.exports = { prepareBundledYosys };
