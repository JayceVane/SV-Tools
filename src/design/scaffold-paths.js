'use strict';

// design scaffold 的输出目录创建/清理：逐级 mkdir，逐级 lstat+realpath 校验，拒绝沿 symlink/junction 逃逸。
const fs = require('node:fs/promises');
const path = require('node:path');

/** @param {string} target 路径。 @param {string} root 工作区真实路径。 @returns {boolean} target 是否位于 root 内。 */
function inside(target, root) {
    const relative = path.relative(root, target);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** @param {string} target 路径。 @returns {Promise<string>} 最近已存在祖先的真实路径。 */
async function nearestRealPath(target) {
    let probe = target;
    while (true) {
        try {
            return await fs.realpath(probe);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const parent = path.dirname(probe);
            if (parent === probe) throw error;
            probe = parent;
        }
    }
}

/** @param {string} target 路径。 @returns {Promise<string[]>} 尚不存在的祖先目录（叶到根）。 */
async function missingDirectories(target) {
    const missing = [];
    let probe = target;
    while (true) {
        try {
            await fs.lstat(probe);
            return missing;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            missing.push(probe);
            const parent = path.dirname(probe);
            if (parent === probe) return missing;
            probe = parent;
        }
    }
}

/** @param {string} message 消息。 @returns {Error} 带 OUTSIDE_WORKSPACE 码的错误。 */
function outsideError(message) {
    const error = new Error(message);
    error.code = 'OUTSIDE_WORKSPACE';
    return error;
}

/**
 * 从最近已存在祖先开始逐级创建目录；每级创建后 lstat 拒绝 symlink/junction，realpath 必须在工作区内。
 * 任一步失败时只清理本轮确认创建的目录（清理本身也逐级校验，不沿链接删除）。
 * @param {string} target 目标目录。 @param {string} workspace 工作区。 @returns {Promise<{created:string[], realDirectory:string}>} 创建的目录（根到叶）。
 */
async function createContainedDirectories(target, workspace) {
    const realWorkspace = await fs.realpath(workspace);
    const nearest = await nearestRealPath(target);
    if (!inside(nearest, realWorkspace)) {
        throw outsideError('--out 通过符号链接逃逸出工作区');
    }
    const chain = (await missingDirectories(target)).reverse();
    const created = [];
    try {
        for (const directory of chain) {
            let made = false;
            try {
                await fs.mkdir(directory);
                made = true;
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    throw error;
                }
            }
            const stat = await fs.lstat(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw outsideError('--out 路径包含符号链接或非目录：' + directory);
            }
            const realDirectory = await fs.realpath(directory);
            if (!inside(realDirectory, realWorkspace)) {
                throw outsideError('--out 通过符号链接逃逸出工作区');
            }
            if (made) {
                created.push(directory);
            }
        }
        const finalStat = await fs.lstat(target);
        if (finalStat.isSymbolicLink() || !finalStat.isDirectory()) {
            const error = new Error('--out 必须是目录：' + target);
            error.code = 'OUT_NOT_DIRECTORY';
            throw error;
        }
        const realDirectory = await fs.realpath(target);
        if (!inside(realDirectory, realWorkspace)) {
            throw outsideError('--out 通过符号链接逃逸出工作区');
        }
        return { created, realDirectory };
    } catch (error) {
        await cleanupDirectories(created, workspace);
        throw error;
    }
}

/**
 * 清理本轮创建的目录：逆序逐目录 lstat 拒绝链接、realpath 必须仍在工作区内才 rmdir。
 * @param {string[]} directories 已确认创建的目录（根到叶）。 @param {string} workspace 工作区。 @returns {Promise<void>} 清理完成。
 */
async function cleanupDirectories(directories, workspace) {
    if (!directories.length) {
        return;
    }
    let realWorkspace;
    try {
        realWorkspace = await fs.realpath(workspace);
    } catch {
        return;
    }
    for (const directory of [...directories].reverse()) {
        try {
            const stat = await fs.lstat(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                continue;
            }
            const realDirectory = await fs.realpath(directory);
            if (!inside(realDirectory, realWorkspace)) {
                continue;
            }
            await fs.rmdir(directory);
        } catch {
            // 目录非空、已被并发替换/删除时跳过，不沿链接操作。
        }
    }
}

module.exports = { createContainedDirectories, cleanupDirectories };
