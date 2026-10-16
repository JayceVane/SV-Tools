'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { processSucceeded } = require('../toolchains/result');
const { MAX_ERROR_CHARS, createYosysDiagnostics, yosysErrorHint } = require('./yosys-diagnostics');
const MAX_SOURCES = 4096;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_INCLUDE_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_INCLUDE_SNAPSHOT_FILES = 4096;
const MAX_INCLUDE_SNAPSHOT_ENTRIES = 16384;
const MAX_WRAPPER_BYTES = 4 * 1024 * 1024;

/** @param {string} value Yosys 命令中的单个词。@returns {string} 带引用的词；拒绝换行与 NUL。 */
function yosysQuote(value) {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 32768) {
        throw new Error('Yosys 参数包含无效字符或超过长度限制');
    }
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * @param {{sources:string[],top:string,outputPath:string,includeDirs?:string[],frontend?:string}} options
 * @returns {string} 保留层级的 RTL 预处理脚本，不做器件 LUT 映射。
 */
function buildYosysScript({ sources, top, outputPath, includeDirs = [], frontend = 'verilog' }) {
    if (!Array.isArray(sources) || !sources.length || sources.length > MAX_SOURCES) throw new Error('电路源文件数量无效');
    if (typeof top !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(top)) throw new Error('生成电路的 top 需要普通 HDL 标识符；转义模块可导入工具生成的 JSON 查看');
    if (!Array.isArray(includeDirs) || includeDirs.length > MAX_SOURCES
        || includeDirs.some(dir => typeof dir !== 'string' || !/^[A-Za-z0-9_./:\-]+$/.test(dir))) throw new Error('Yosys include 参数需要安全的目录别名');
    if (!['verilog', 'slang'].includes(frontend)) throw new Error('不支持的 Yosys 前端：' + frontend);
    const fileWord = file => yosysQuote(file.replace(/\\/g, '/'));
    const inputs = sources.map(file => {
        if (frontend !== 'slang') return fileWord(file);
        if (typeof file !== 'string' || !/^[A-Za-z0-9_./:\-]+$/.test(file)) throw new Error('slang 输入需要安全的任务相对路径');
        return file;
    });
    const args = [...includeDirs.map(dir => '-I' + dir), ...inputs];
    const reader = frontend === 'slang'
        ? 'read_slang --threads 1 --keep-hierarchy --top ' + top : 'read_verilog -sv';
    return [reader + ' ' + args.join(' '), 'prep -top ' + top, 'check', 'write_json ' + fileWord(outputPath), ''].join('\n');
}

/** @param {{sources:string[],defines?:string[]}} input @returns {string} 宏经 HDL 预处理器传递，避免脚本引号改变宏正文。 */
function buildSourceWrapper({ sources, defines = [] }) {
    if (!Array.isArray(sources) || !sources.length || sources.length > MAX_SOURCES || !Array.isArray(defines) || defines.length > MAX_SOURCES) {
        throw new Error('电路源文件或宏配置数量无效');
    }
    let inputBytes = 0;
    for (const value of [...sources, ...defines]) {
        if (typeof value !== 'string') throw new Error('电路源文件和宏必须是字符串');
        inputBytes += Buffer.byteLength(value, 'utf8');
        if (inputBytes > MAX_WRAPPER_BYTES) throw new Error('电路输入配置超过 4 MiB');
    }
    const macros = defines.map(define => {
        if (typeof define !== 'string' || /[\r\n\0]/.test(define) || define.endsWith('\\')) throw new Error('电路宏必须为单行定义');
        const match = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:=([\s\S]*))?$/.exec(define);
        if (!match) throw new Error('电路宏名称无效：' + define.slice(0, 80));
        return '`define ' + match[1] + (match[2] === undefined ? '' : ' ' + match[2]);
    });
    return [...macros, ...sources.map(file => '`include ' + yosysQuote(file.replace(/\\/g, '/'))), ''].join('\n');
}

/** Yosys 的 -I 参数保留引号；对不能直接表达的路径使用任务私有目录别名。 */
async function includeAliases({ task, executable, sourceRoot, includeDirs = [] }) {
    if (!Array.isArray(includeDirs) || includeDirs.length > MAX_SOURCES) throw new Error('电路 include 配置无效');
    const result = [], sourceDirectories = [];
    let bytes = 0, files = 0, entries = 0;
    for (const [index, directory] of includeDirs.entries()) {
        task.throwIfCancelled();
        if (typeof directory !== 'string' || /[\r\n\0]/.test(directory)) throw new Error('电路 include 路径无效');
        const absolute = await fs.realpath(path.resolve(sourceRoot, directory));
        let relative = path.relative(sourceRoot, absolute).replace(/\\/g, '/') || '.';
        if (!/^[A-Za-z0-9_./:\-]+$/.test(relative)) {
            const aliases = await task.directory(path.join(sourceRoot, '.svtools', 'circuit'), 'includes');
            const alias = path.join(aliases, 'include' + index);
            if (/(?:^|[\\/])yowasp-yosys(?:\.(?:exe|cmd|bat))?$/i.test(executable)) {
                // WASI 不跟随指向挂载点外的目录链接；用有界副本保留 include 内的相对结构。
                await fs.cp(absolute, alias, { recursive: true, filter: async source => {
                    task.throwIfCancelled();
                    const stat = await fs.lstat(source);
                    if (stat.isSymbolicLink()) throw new Error('YoWASP include 快照不支持符号链接，请使用原生 Yosys');
                    if (stat.isFile()) { bytes += stat.size; files++; }
                    entries++;
                    if (bytes > MAX_INCLUDE_SNAPSHOT_BYTES || files > MAX_INCLUDE_SNAPSHOT_FILES || entries > MAX_INCLUDE_SNAPSHOT_ENTRIES) {
                        throw new Error('YoWASP include 快照超过 64 MiB / 4096 文件，请使用原生 Yosys');
                    }
                    return true;
                } });
            } else await fs.symlink(absolute, alias, process.platform === 'win32' ? 'junction' : 'dir');
            sourceDirectories.push({ from: alias, to: absolute });
            relative = path.relative(sourceRoot, alias).replace(/\\/g, '/');
        }
        result.push(relative);
    }
    return { directories: result, sourceDirectories };
}

/**
 * @param {{task:object,executable:string,sources:string[],top:string,outputBase:string,sourceRoot:string,includeDirs?:string[],defines?:string[],frontend?:string,timeoutMs?:number,onOutput?:Function,env?:object}} options
 * @returns {Promise<{filePath:string,sourceRoot:string}>} 独立任务目录内的真实 JSON；失败不返回旧产物。
 */
async function runYosysCircuit(options) {
    const { task, executable = 'bundled', sources, outputBase, sourceRoot, onOutput, env } = options;
    if (typeof executable !== 'string' || !executable || typeof sourceRoot !== 'string' || !sourceRoot) {
        throw new Error('请配置本地 Yosys 路径和电路工作目录');
    }
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('Yosys 超时必须为正数');
    const isBundled = executable === 'bundled';
    const requestedFrontend = options.frontend || 'auto';
    const frontend = requestedFrontend === 'auto' ? (isBundled ? 'slang' : 'verilog') : requestedFrontend;
    let command = /[\\/]/.test(executable) ? path.resolve(sourceRoot, executable) : executable;
    const directory = await task.directory(outputBase, 'yosys');
    const filePath = path.join(directory, 'circuit.json');
    const scriptPath = path.join(directory, 'circuit.ys');
    let wrapperPath = path.join(directory, 'sources.sv');
    if (!isBundled && frontend === 'slang' && !/^[A-Za-z0-9_./:\-]+$/.test(path.relative(sourceRoot, wrapperPath).replace(/\\/g, '/'))) {
        wrapperPath = path.join(await task.directory(path.join(sourceRoot, '.svtools', 'circuit'), 'input'), 'sources.sv');
    }
    const bundled = isBundled ? await require('./yosys-bundled').prepareBundledYosys({ ...options, directory }) : null;
    const wrapperSources = bundled ? bundled.sources : frontend === 'slang'
        ? sources.map(file => path.relative(path.dirname(wrapperPath), path.resolve(sourceRoot, file))) : sources;
    await fs.writeFile(wrapperPath, buildSourceWrapper({ ...options, sources: wrapperSources }), 'utf8');
    const aliases = bundled ? { directories: bundled.includeDirs, sourceDirectories: bundled.sourceDirectories } : await includeAliases(options);
    const inputPath = bundled ? bundled.inputPath : frontend === 'slang' ? path.relative(sourceRoot, wrapperPath).replace(/\\/g, '/') : wrapperPath;
    await fs.writeFile(scriptPath, buildYosysScript({ ...options, frontend, sources: [inputPath], includeDirs: aliases.directories,
        outputPath: bundled ? bundled.outputPath : filePath }), 'utf8');
    task.throwIfCancelled();
    const diagnostics = createYosysDiagnostics({ sourceRoot: bundled ? '/' : sourceRoot,
        sourceMap: options.sourceMap, sourceDirectories: aliases.sourceDirectories });
    if (bundled) command = bundled.command;
    const result = await task.run(command, bundled ? bundled.args : ['-Q', '-T', '-s', scriptPath.replace(/\\/g, '/')], {
        cwd: sourceRoot, env: bundled ? { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' } : env,
        stage: 'yosys', timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        onStdout: onOutput, onStderr: onOutput, onLine: diagnostics.onLine
    });
    task.throwIfCancelled();
    if (/\bENOENT\b/.test(result.errorMessage || '')) {
        throw Object.assign(new Error('未找到 Yosys：' + command
            + '。请将 svtools.circuit.yosysPath 设置为已安装的 yosys 或 yowasp-yosys 的可执行文件路径。'
            + '\n完整日志：' + result.logPath), { code: 'YOSYS_NOT_FOUND' });
    }
    const diagnostic = diagnostics.getError();
    if (!processSucceeded(result) || diagnostic) {
        const detail = result.errorMessage || result.logError || diagnostic || result.output?.slice(-MAX_ERROR_CHARS) || `exit ${result.code}`;
        const hint = yosysErrorHint(detail, frontend);
        throw new Error('Yosys 电路生成失败：' + detail + hint + '\n完整日志：' + result.logPath);
    }
    const stat = await fs.stat(filePath).catch(error => { throw new Error('Yosys 未生成电路 JSON：' + error.message); });
    if (!stat.isFile() || !stat.size) throw new Error('Yosys 生成了空电路 JSON');
    // Slang 的 src 可能是相对 guest 路径，先按 WASI 根解析，再由 Worker 映射回宿主。
    return { filePath, sourceRoot: bundled ? '/' : sourceRoot, sourceDirectories: aliases.sourceDirectories };
}
module.exports = { buildYosysScript, buildSourceWrapper, runYosysCircuit, yosysQuote };
