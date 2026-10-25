'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_RETAINED_RUNS = 100;

/**
 * 任务目录封顶：按修改时间只保留 base 下最新的 keep 个 `<kind>-*` 直接子目录。
 * 单个目录删除失败只记录并继续，不中断其余清理；base 不存在视为无事可做。
 * @param {string} base 任务目录的父目录。
 * @param {string} kind 任务目录类型前缀（如 xvlog、run）。
 * @param {number} keep 保留数量，1–100；0=关闭由调用方处理。
 * @param {{protect?:Set<string>}} [options] 活动任务占用的目录永不删除。
 * @returns {Promise<string[]>} 实际删除的目录路径。
 * @throws {RangeError} keep 或 kind 无效。
 */
async function pruneTaskDirectories(base, kind, keep, { protect } = {}) {
    if (!Number.isSafeInteger(keep) || keep < 1 || keep > MAX_RETAINED_RUNS) throw new RangeError('任务目录保留数量必须为1–' + MAX_RETAINED_RUNS);
    if (!/^[a-z][a-z0-9-]*$/i.test(kind)) throw new Error('无效的任务目录类型');
    const root = path.resolve(base), prefix = kind + '-';
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const candidates = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        const full = path.resolve(root, entry.name);
        if (protect?.has(full)) continue;
        try { candidates.push({ full, mtimeMs: (await fs.stat(full)).mtimeMs }); }
        catch (error) { if (error.code !== 'ENOENT') console.error('统计任务目录失败(' + full + ')：' + error.message); }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const removed = [];
    for (const candidate of candidates.slice(keep)) {
        try { await fs.rm(candidate.full, { recursive: true, force: true }); removed.push(candidate.full); }
        catch (error) { console.error('删除过期任务目录失败(' + candidate.full + ')：' + error.message); }
    }
    return removed;
}

module.exports = { pruneTaskDirectories, MAX_RETAINED_RUNS };
