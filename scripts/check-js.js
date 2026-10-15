'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const rootDir = path.resolve(__dirname, '..');

/** @param {string} directory @returns {string[]} 仓库 JS 源文件，跳过依赖和构建产物。 */
function sourceFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return ['node_modules', 'target'].includes(entry.name) ? [] : sourceFiles(fullPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
    });
}
const files = [path.join(rootDir, 'extension.js'), ...['src', 'scripts', 'test'].flatMap(dir => sourceFiles(path.join(rootDir, dir)))];
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0 || result.error) {
        if (result.error) console.error(result.error.message);
        process.exit(result.status || 1);
    }
}
console.log(`JS 语法检查通过：${files.length} 个文件`);
