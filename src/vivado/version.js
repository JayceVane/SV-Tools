'use strict';
/**
 * Vivado 工程与工具版本核验。
 * XPR 文件头部的注释记录了创建它的工具版本（Vivado v2022.1.2）；
 * 当前配置的 svtools.vivado.path 用 `vivado -version` 取工具版本。
 * 两者不一致时打开工程可能触发升级并改写工程，必须先让用户配置匹配的安装路径。
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { batchInvocation } = require('../toolchains/process');

const TOOL_CACHE = new Map();

/** 从 XPR 文本读取创建工具版本；缺失时返回 undefined。 */
function parseProjectVersion(text) {
    const match = /Product Version:\s*Vivado\s+v?([0-9]+(?:\.[0-9]+)+)/i.exec(String(text || ''));
    return match ? match[1] : undefined;
}

/** 只读取 XPR 的头部。快速保存可能沿用时间戳，版本核验须使用当前内容。 */
async function projectVersion(xpr) {
    if (!xpr) return undefined;
    const handle = await fs.open(xpr, 'r');
    try {
        const buffer = Buffer.alloc(16384);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return parseProjectVersion(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally { await handle.close(); }
}

function readToolVersion(binDir) {
    return new Promise(resolve => {
        const executable = path.join(binDir, process.platform === 'win32' ? 'vivado.bat' : 'vivado');
        const options = { windowsHide: true, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] };
        const args = ['-version'];
        const batch = process.platform === 'win32' ? batchInvocation(executable, args, process.env, options.cwd) : null;
        const command = batch
            ? spawn(process.env.ComSpec || 'cmd.exe', batch.args, { ...options, env: batch.env, windowsVerbatimArguments: true })
            : spawn(executable, args, options);
        let output = '', settled = false;
        const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
        const timer = setTimeout(() => { try { command.kill(); } catch { /* 进程已退出 */ } finish(undefined); }, 30000);
        command.on('error', () => finish(undefined));
        command.stdout.on('data', chunk => { output += chunk; });
        command.stderr.on('data', chunk => { output += chunk; });
        command.on('close', () => finish(/Vivado\s+v?([0-9]+(?:\.[0-9]+)+)/i.exec(output)?.[1]));
    });
}

/** 读取配置路径的 Vivado 版本，按安装目录缓存；失败返回 undefined。 */
async function vivadoVersion(binDir) {
    if (!binDir) return undefined;
    if (TOOL_CACHE.has(binDir)) return TOOL_CACHE.get(binDir);
    const version = await readToolVersion(binDir).catch(() => undefined);
    if (version) TOOL_CACHE.set(binDir, version);
    return version;
}

/** 只有完全一致才视为匹配，避免任何一侧被自动升级。 */
const same = (project, tool) => Boolean(project && tool) && project === tool;

module.exports = { parseProjectVersion, projectVersion, vivadoVersion, same };
