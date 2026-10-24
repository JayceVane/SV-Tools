'use strict';
const path = require('node:path');
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

/**
 * @param {{sourceRoot?:string,sourceMap?:object,sourceDirectories?:object[]}} options 源根、任务快照及工具目录映射。
 * @returns {(file:string)=>string} 只做路径映射，不读写文件；优先精确快照，再匹配最具体目录。
 */
function createSourcePathMapper({ sourceRoot = process.cwd(), sourceMap = {}, sourceDirectories = [] } = {}) {
    const root = path.resolve(sourceRoot);
    const replacements = new Map(Object.entries(sourceMap).map(([from, to]) => [pathKey(path.resolve(from)), to]));
    const directories = sourceDirectories.map(directory => ({ from: path.resolve(directory.from), to: directory.to }))
        .sort((a, b) => b.from.length - a.from.length);
    return file => {
        if (/^<.*>$/.test(file)) return file;
        const absolute = path.resolve(root, file), exact = replacements.get(pathKey(absolute));
        if (exact) return exact;
        for (const directory of directories) {
            const relative = path.relative(directory.from, absolute);
            if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
            const mapped = path.join(directory.to, relative);
            return replacements.get(pathKey(path.resolve(mapped))) || mapped;
        }
        return absolute;
    };
}
module.exports = { createSourcePathMapper };
