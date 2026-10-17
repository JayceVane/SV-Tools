'use strict';
const path = require('node:path');

// 索引排除依赖与工具产物；诊断只排除工具产物，保留显式依赖源码的错误。
const DIRECTORIES = [
    { name: '.git', generated: false }, { name: 'node_modules', generated: false },
    { name: '.svtools', generated: true }, { name: '.Xil', generated: true }
];
const sourceNames = DIRECTORIES.map(item => item.name);
const generatedNames = DIRECTORIES.filter(item => item.generated).map(item => item.name);
const excludedNames = new Set(sourceNames.map(name => name.toLowerCase()));
const generatedDirectoryNames = new Set(generatedNames.map(name => name.toLowerCase()));
const SOURCE_EXCLUDE_GLOB = '**/{' + sourceNames.join(',') + '}/**';
const GENERATED_SOURCE_EXCLUDE_GLOB = '**/{' + generatedNames.join(',') + '}/**';

function containsDirectory(filePath, names) {
    const normalized = path.posix.normalize(String(filePath || '').replace(/\\/g, '/'));
    return normalized.split('/').slice(0, -1).some(name => names.has(name.toLowerCase()));
}

/** @param {string|undefined} filePath 文件路径。 @returns {boolean} 是否排除工作区索引；只匹配完整目录段，兼容两种分隔符及大小写。 */
function isExcludedSourcePath(filePath) { return containsDirectory(filePath, excludedNames); }

/** @param {string|undefined} filePath 文件路径。 @returns {boolean} 是否位于工具生成目录，不自动lint或发布其诊断；真实依赖源码不受影响。 */
function isGeneratedSourcePath(filePath) { return containsDirectory(filePath, generatedDirectoryNames); }

module.exports = { SOURCE_EXCLUDE_GLOB, GENERATED_SOURCE_EXCLUDE_GLOB, isExcludedSourcePath, isGeneratedSourcePath };
