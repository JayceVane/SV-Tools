'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { COPYFILE_EXCL } = require('node:fs').constants;
const { nativeApi, codeOf } = require('./rust-backend');

function cancelled(signal) {
    if (signal?.aborted) throw Object.assign(new Error('波形转换已取消'), { code: 'TOOL_CANCELLED' });
}
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

/** 读取内容标记；不能根据 .vcd/.fst 后缀推断仿真器真正写入的格式。 */
async function isFst(file) {
    const handle = await fs.open(file, 'r');
    try {
        const bytes = Buffer.alloc(9), { bytesRead } = await handle.read(bytes, 0, 9, 0);
        return bytesRead === 9 && (bytes[0] === 254 || (bytes[0] === 0 && bytes.readBigUInt64BE(1) === 329n));
    } finally { await handle.close(); }
}

/**
 * 共用的仿真后处理：只处理本轮实际改变的波形，转换完成才删除 VCD。
 * 不覆盖既有 FST；同名输出使用递增后缀，避免误删用户保存的历史波形。
 * @param {string[]} files 本轮新生成的波形路径。
 * @param {object} options 设置、取消信号、视图写入租约与日志边界。
 * @returns {Promise<string[]>} 可交给查看器打开的最终文件。
 */
async function postprocessWaveforms(files, options = {}) {
    if (!options.enabled) return files;
    const result = [];
    for (const file of files) {
        cancelled(options.signal);
        let temporary, published, lease, committed = false;
        try {
            if (await isFst(file)) { result.push(file); continue; }
            const before = await fs.lstat(file, { bigint: true });
            if (!before.isFile()) throw new Error('只转换普通 VCD 文件');
            temporary = await fs.mkdtemp(path.join(path.dirname(file), '.svtools-fst-'));
            const target = path.join(temporary, 'wave.fst');
            // 关闭 VCD 读取者并保持写入租约，转换在 libuv 线程池执行。
            lease = await options.prepare?.({ paths: [file], sourceFile: options.sourceFile });
            cancelled(options.signal);
            options.onProgress?.('正在转换 VCD → FST：' + file);
            let stats;
            try { stats = JSON.parse(await (options.native || nativeApi()).waveConvertVcdToFstAsync(file, target)); }
            catch (error) { const parsed = codeOf(error); throw Object.assign(new Error(parsed.message), { code: parsed.code }); }
            cancelled(options.signal);
            if (!await isFst(target) || !(stats.outputBytes > 0)) throw new Error('FST 输出验证失败');
            if (identity(before) !== identity(await fs.lstat(file, { bigint: true }))) throw new Error('转换期间 VCD 发生变化');
            const base = path.join(path.dirname(file), path.basename(file, path.extname(file)));
            for (let suffix = 1; suffix <= 10000; suffix++) {
                const candidate = base + (suffix === 1 ? '' : '-' + suffix) + '.fst';
                // 硬链接提供同目录的原子、排他发布；不会替换同名文件。
                try {
                    try { await fs.link(target, candidate); }
                    catch (error) {
                        if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw error;
                        // exFAT/部分网络盘没有硬链接，排他复制完成前始终保留源 VCD。
                        await fs.copyFile(target, candidate, COPYFILE_EXCL);
                    }
                    published = candidate; break;
                }
                catch (error) { if (error.code !== 'EEXIST') throw error; }
            }
            if (!published) throw new Error('FST 同名文件数量过多');
            cancelled(options.signal);
            if (identity(before) !== identity(await fs.lstat(file, { bigint: true }))) throw new Error('发布前 VCD 发生变化');
            await fs.unlink(file); committed = true;
            const saved = Math.round((1 - stats.outputBytes / Math.max(1, stats.sourceBytes)) * 100);
            options.onProgress?.('FST 已保存：' + published + '（' + stats.sourceBytes + ' → ' + stats.outputBytes + ' 字节，节省 ' + saved + '%）');
            result.push(published);
        } catch (error) {
            if (published && !committed) {
                try { await fs.unlink(published); }
                catch (cleanup) { options.onWarning?.('清理未提交 FST 失败：' + cleanup.message); }
            }
            if (options.signal?.aborted || error.code === 'TOOL_CANCELLED') throw error;
            options.onWarning?.('VCD → FST 转换失败，原波形已保留：' + file + '\n' + error.message);
            result.push(file);
        } finally {
            try {
                if (temporary) {
                    try { await fs.unlink(path.join(temporary, 'wave.fst')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                    await fs.rmdir(temporary);
                }
            } catch (error) { options.onWarning?.('清理转换临时文件失败：' + error.message); }
            finally { await lease?.dispose(); }
        }
    }
    return result;
}
module.exports = { postprocessWaveforms };
