'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_RETAINED_RUNS = 100;
const COMPLETED_MARKER = '.svtools-task-complete.json';
const MARKER_FORMAT = 'svtools-task-complete-v1';
const MAX_MARKER_BYTES = 1024;
const pruning = new Map();

function validateKind(kind) {
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(kind)) throw new TypeError('无效的任务目录类型');
}

/** @typedef {{path:string,retain:()=>TaskDirectoryLease,dispose:()=>Promise<void>}} TaskDirectoryLease */

/**
 * @param {string} base 任务目录的父目录。 @param {string} kind 受控阶段名。
 * @returns {Promise<TaskDirectoryLease>} 新目录和初始占用；最后一次释放后不可再借用。
 * @throws {Error} 目录创建或完成标记写入失败。
 */
async function createTaskDirectory(base, kind) {
    validateKind(kind);
    const root = path.resolve(base);
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, kind + '-'));
    let references = 0, isComplete = false;
    function retain() {
        if (isComplete) throw new Error('已交还的任务目录不能重新占用');
        references++;
        let disposal;
        return { path: directory, retain, dispose() {
            if (!disposal) disposal = (async () => {
                if (--references !== 0) return;
                // 仅发布不可逆的终态；创建中的目录、活动任务及跨宿主占用均无此标记。
                isComplete = true;
                await fs.writeFile(path.join(directory, COMPLETED_MARKER), JSON.stringify({
                    format: MARKER_FORMAT, directory: path.basename(directory)
                }), { encoding: 'utf8', flag: 'wx' });
            })();
            return disposal;
        } };
    }
    return retain();
}

async function isCompleted(directory) {
    let handle;
    try {
        handle = await fs.open(path.join(directory, COMPLETED_MARKER), 'r');
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return false;
        const marker = JSON.parse(await handle.readFile('utf8'));
        return marker?.format === MARKER_FORMAT && marker.directory === path.basename(directory);
    } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) console.error('读取任务完成标记失败(' + directory + ')：' + error.message);
        return false;
    } finally { await handle?.close(); }
}

/**
 * 任务目录封顶：只扫描具有本协议完成标记的直接子目录，按修改时间保留最新 keep 个。
 * 未标记目录不推测归属或进程存活，旧版本、活动任务和异常退出目录均保守跳过。
 * 单个目录删除失败只记录并继续，不中断其余清理；base 不存在视为无事可做。
 * @param {string} base 任务目录的父目录。
 * @param {string} kind 任务目录类型前缀（如 xvlog、run）。
 * @param {number} keep 保留数量，1–100；0=关闭由调用方处理。
 * @param {{protect?:Set<string>}} [options] 可选的额外保护目录；活动目录由完成协议自动排除。
 * @returns {Promise<string[]>} 实际删除的目录路径。
 * @throws {RangeError|TypeError} keep 或 kind 无效。
 */
async function pruneTaskDirectories(base, kind, keep, { protect } = {}) {
    if (!Number.isSafeInteger(keep) || keep < 1 || keep > MAX_RETAINED_RUNS) throw new RangeError('任务目录保留数量必须为1–' + MAX_RETAINED_RUNS);
    validateKind(kind);
    const root = path.resolve(base), key = root + ':' + kind;
    const scan = () => pruneCompletedDirectories(root, kind, keep, protect);
    const work = (pruning.get(key) || Promise.resolve()).then(scan, scan);
    pruning.set(key, work);
    const forget = () => { if (pruning.get(key) === work) pruning.delete(key); };
    work.then(forget, forget);
    return work;
}

async function pruneCompletedDirectories(root, kind, keep, protect) {
    const prefix = kind + '-';
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const candidates = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        const full = path.resolve(root, entry.name);
        if (path.dirname(full) !== root) throw new Error('任务清理路径越界');
        if (protect?.has(full)) continue;
        if (!await isCompleted(full)) continue;
        try { candidates.push({ full, mtimeMs: (await fs.stat(full)).mtimeMs }); }
        catch (error) { if (error.code !== 'ENOENT') console.error('统计任务目录失败(' + full + ')：' + error.message); }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const removed = [];
    for (const candidate of candidates.slice(keep)) {
        try { await fs.rm(candidate.full, { recursive: true, force: true }); removed.push(candidate.full); }
        catch (error) {
            // 其它宿主也可能刚刚删除同一个终态目录；只报告仍然存在的失败目标。
            const missing = await fs.lstat(candidate.full).then(() => false, statError => statError.code === 'ENOENT');
            if (!missing) console.error('删除过期任务目录失败(' + candidate.full + ')：' + error.message);
        }
    }
    return removed;
}

module.exports = { createTaskDirectory, pruneTaskDirectories, MAX_RETAINED_RUNS };
