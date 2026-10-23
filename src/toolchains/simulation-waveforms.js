'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { tokenize } = require('../editor/completion/syntax');
const MAX_FILES = 128, MAX_FILE_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 8 * 1024 * 1024;
function literal(token) {
    if (token?.kind !== 'string' || !token.closed) return null;
    try { return JSON.parse(token.value); } catch { return null; }
}

/**
 * 仿真磁盘源码的有界输出路径发现；不执行宏或表达式，动态路径明确标记为不确定。
 * @param {{files:string[],directory:string,includePaths?:string[],defaultDumpfiles?:string[],signal?:AbortSignal}} options
 * @returns {Promise<{paths:string[],uncertain:boolean}>} 绝对路径及是否需要目录回退。
 */
async function simulationWaveforms({ files, directory, includePaths = [], defaultDumpfiles = ['dump.vcd'], signal }) {
    const pending = [...files], visited = new Set(), paths = new Set();
    let total = 0, uncertain = false, dumpvars = false;
    while (pending.length) {
        signal?.throwIfAborted();
        const file = path.resolve(pending.shift());
        if (visited.has(file)) continue;
        if (visited.size >= MAX_FILES) { uncertain = true; break; }
        visited.add(file);
        let source;
        try {
            const handle = await fs.open(file, 'r');
            try {
                const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
                let bytesRead = 0;
                while (bytesRead < buffer.length) {
                    const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
                    if (!chunk.bytesRead) break;
                    bytesRead += chunk.bytesRead;
                }
                total += bytesRead;
                if (total > MAX_TOTAL_BYTES) { uncertain = true; break; }
                if (bytesRead > MAX_FILE_BYTES) { uncertain = true; continue; }
                source = buffer.subarray(0, bytesRead).toString('utf8');
            } finally { await handle.close(); }
        } catch (error) {
            if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
            uncertain = true; continue;
        }
        const tokens = tokenize(source).filter(token => token.kind !== 'comment' && token.kind !== 'define');
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.value === '`include') {
                const name = literal(tokens[i + 1]);
                if (name === null) { uncertain = true; continue; }
                let found = false;
                for (const base of [path.dirname(file), ...includePaths]) {
                    const candidate = path.resolve(base, name);
                    try { if ((await fs.stat(candidate)).isFile()) { pending.push(candidate); found = true; break; } }
                    catch (error) { if (error.code !== 'ENOENT') throw error; }
                }
                if (!found) uncertain = true;
            }
            if (token.kind === 'macro' && !['`include', '`timescale', '`ifdef', '`ifndef', '`elsif', '`else', '`endif', '`default_nettype', '`resetall', '`undef'].includes(token.value)) uncertain = true;
            if (token.kind !== 'system') continue;
            if (token.value === '$dumpvars') dumpvars = true;
            if (token.value !== '$dumpfile') continue;
            const name = tokens[i + 1]?.value === '(' && tokens[i + 3]?.value === ')' ? literal(tokens[i + 2]) : null;
            if (name === null || !name || name.includes(String.fromCharCode(0))) uncertain = true;
            else paths.add(path.resolve(directory, name));
        }
    }
    // 源码中的dumpfile可能位于未执行分支，不能据此排除vvp的默认输出。
    if (dumpvars) for (const name of defaultDumpfiles) paths.add(path.resolve(directory, name));
    signal?.throwIfAborted();
    return { paths: [...paths], uncertain };
}
module.exports = { simulationWaveforms };
