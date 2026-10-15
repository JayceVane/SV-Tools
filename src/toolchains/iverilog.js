/**
 * Copyright (c) 2025 JayceVane (JayceVane@163.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Icarus Verilog 集成：语法检查（lint 诊断）与仿真运行（iverilog 编译 + vvp 执行）。
 *
 * 模块分层：
 *  - 工具链定位 / 参数构建 / 输出解析为纯函数，不依赖 vscode，可独立单元测试；
 *  - activateIverilog() 负责 VSCode 集成（诊断、命令、状态栏、事件接线）。
 */

const { runProcess } = require('./process');
const { createDiagnosticCapture } = require('./diagnostics');
const { processSucceeded } = require('./result');
const { COMPILE_TIMEOUT_MS } = require('./compile-policy');
const { scanWorkspaceSources } = require('../workspace/sources');
const fs = require('fs');
const path = require('path');

const TOOL_PROBE_TIMEOUT_MS = 10000;
// 0xC0000135 STATUS_DLL_NOT_FOUND：Windows 加载器找不到 DLL 时进程以此码退出且无任何输出
const DLL_NOT_FOUND_EXIT_CODE = 3221225781;

const IV_EXE = process.platform === 'win32' ? 'iverilog.exe' : 'iverilog';
const VVP_EXE = process.platform === 'win32' ? 'vvp.exe' : 'vvp';

// ---------------------------------------------------------------------------
// 工具链定位
// ---------------------------------------------------------------------------

/**
 * 规范化用户配置的工具路径：接受 bin 目录或 iverilog 可执行文件全路径，统一返回 bin 目录。
 * @param {string} configuredPath 配置值（svtools.iverilog.path）
 * @returns {string|null} bin 目录，配置为空返回 null
 */
function normalizeToolDirPath(configuredPath) {
    const trimmed = String(configuredPath || '').trim();
    if (!trimmed) return null;
    const base = path.basename(trimmed).toLowerCase();
    if (base === 'iverilog' || base === 'iverilog.exe') {
        return path.dirname(trimmed);
    }
    return trimmed;
}

/**
 * 定位 iverilog 安装 bin 目录。查找顺序：显式配置 → IVERILOG_HOME → PATH → 常见安装位置。
 * @param {string} configuredPath 配置值（svtools.iverilog.path），空串表示自动探测
 * @returns {string|null} 含 iverilog 可执行文件的目录，找不到返回 null
 */
function findIverilogBinDir(configuredPath) {
    const candidates = [];
    const configuredDir = normalizeToolDirPath(configuredPath);
    if (configuredDir) candidates.push(configuredDir);

    if (process.env.IVERILOG_HOME) {
        candidates.push(path.join(process.env.IVERILOG_HOME, 'bin'), process.env.IVERILOG_HOME);
    }

    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path');
    for (const dir of String((pathKey && process.env[pathKey]) || '').split(path.delimiter)) {
        if (dir) candidates.push(dir);
    }

    if (process.platform === 'win32') {
        candidates.push(
            'C:\\iverilog\\bin',
            'C:\\Program Files\\Icarus Verilog\\bin',
            'D:\\iverilog\\bin',
            'D:\\DevKit\\iverilog\\bin'
        );
    } else {
        candidates.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin');
    }

    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, IV_EXE))) return dir;
    }
    return null;
}

/**
 * 定位 Cygwin 构建的 iverilog 所需的 cygwin1.dll 目录。
 * iverilog 若安装在 Cygwin 根目录之外（如 D:\DevKit\iverilog 与 D:\DevKit\cygwin64 并列），
 * 需要把含 DLL 的目录加入子进程 PATH 才能启动。
 * @param {string} configuredCygwinPath 配置值（svtools.iverilog.cygwinPath）
 * @param {string} iverilogBinDir iverilog bin 目录
 * @returns {string|null} 含 cygwin1.dll 的目录，找不到返回 null
 */
function findCygwinBinDir(configuredCygwinPath, iverilogBinDir) {
    const candidates = [];
    const configuredDir = String(configuredCygwinPath || '').trim();
    if (configuredDir) candidates.push(configuredDir);
    if (iverilogBinDir) {
        candidates.push(iverilogBinDir);
        // 安装根目录的兄弟目录：D:\DevKit\iverilog\bin → D:\DevKit\cygwin64\bin
        const grandParent = path.dirname(path.dirname(iverilogBinDir));
        candidates.push(
            path.join(grandParent, 'cygwin64', 'bin'),
            path.join(grandParent, 'cygwin', 'bin')
        );
    }
    candidates.push('C:\\cygwin64\\bin', 'C:\\cygwin\\bin');

    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'cygwin1.dll'))) return dir;
    }
    return null;
}

/**
 * 构建子进程环境变量；cygwinBinDir 非空时前置到 PATH（Windows 环境变量名大小写不敏感）。
 * @param {string|null} cygwinBinDir
 * @returns {NodeJS.ProcessEnv}
 */
function buildChildEnv(cygwinBinDir) {
    const env = { ...process.env };
    if (!cygwinBinDir) return env;
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = cygwinBinDir + path.delimiter + (env[pathKey] || '');
    return env;
}

/**
 * 执行外部工具并收集全部输出。
 * @param {string} command 可执行文件绝对路径
 * @param {string[]} args 参数
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} options spawn 选项
 * @param {number} [timeoutMs=0] 超时毫秒数，0 表示不限制
 * @returns {Promise<{code: number, stdout: string, stderr: string, errorMessage: string|null, timedOut: boolean, elapsedMs: number}>}
 */
function runTool(command, args, options, timeoutMs = 0) {
    return runProcess(command, args, { ...options, timeoutMs });
}

// ---------------------------------------------------------------------------
// 参数构建与输出解析（纯函数，可独立测试）
// ---------------------------------------------------------------------------

/**
 * 根据文件扩展名与配置生成语言标准参数。
 * @param {string} fileName 源文件名
 * @param {string} standardSetting 配置值（auto / default / 1995 / 2001 / 2005 / 2005-sv / 2009 / 2012）
 * @returns {string|null} 如 '-g2012'；无需指定时返回 null
 */
function languageStandardFlag(fileName, standardSetting) {
    if (standardSetting === 'default') return null;
    if (standardSetting && standardSetting !== 'auto') return `-g${standardSetting}`;
    const ext = path.extname(fileName).toLowerCase();
    return (ext === '.sv' || ext === '.svh') ? '-g2012' : '-g2005';
}

/**
 * 构建 lint / 仿真编译共用的参数：语言标准、include 目录、库目录。
 * 同目录模块解析依赖 -y <文件目录> -Y .sv（-Y 追加 .sv 后缀，默认 .v 仍生效）。
 * @param {{fileName: string, standard: string, includePaths: string[], libraryPaths: string[], extraArgs: string[]}} input
 * @returns {string[]}
 */
function buildCommonArgs(input) {
    const args = [];
    const stdFlag = languageStandardFlag(input.fileName, input.standard);
    if (stdFlag) args.push(stdFlag);
    for (const dir of input.includePaths || []) args.push('-I', dir);
    for (const dir of input.libraryPaths || []) args.push('-y', dir);
    args.push(...(input.extraArgs || []));
    return args;
}

/**
 * 解析 iverilog 编译输出（stdout/stderr）为诊断条目。
 * iverilog 消息格式：`file:line: message` 或 `file:line:col: message`；
 * 警告以 `warning:` 开头，错误可能是 `error: xxx` 也可能无前缀（如 `syntax error`）；
 * 汇总行（`2 error(s) during elaboration.` 等）不含路径，自然跳过。
 * @param {string} rawText 原始输出
 * @param {string} baseDir 相对路径基准目录（消息中的相对文件名按此解析）
 * @returns {{file: string, line: number, column: number|null, message: string, severity: 'error'|'warning'}[]}
 */
function parseCompilerOutput(rawText, baseDir) {
    const findings = [];
    for (const rawLine of String(rawText || '').split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        const match = line.match(/^(.+?):(\d+):(?:(\d+):)?\s*(.*)$/);
        if (!match) continue;

        const [, fileRef, lineText, colText, rest] = match;
        // 过滤误匹配：Windows 盘符后必须像路径，且行号必须为正整数
        const lineNo = parseInt(lineText, 10);
        if (!Number.isInteger(lineNo) || lineNo < 1) continue;

        const isWarning = /^warning\b/i.test(rest);
        const severity = isWarning ? 'warning' : 'error';
        const message = rest.replace(/^(warning|error)\s*:\s*/i, '') || line;
        const column = colText ? parseInt(colText, 10) : null;

        findings.push({
            file: path.resolve(baseDir, fileRef),
            line: lineNo,
            column: Number.isInteger(column) && column > 0 ? column : null,
            message,
            severity
        });
    }
    return findings;
}

/** 供展示用的命令行回显：含空白字符的参数加引号。 */
function formatCommandLine(command, args) {
    const quoted = args.map(a => (/\s/.test(a) ? `"${a}"` : a));
    return [path.basename(command), ...quoted].join(' ');
}

// ---------------------------------------------------------------------------
// 依赖补编译（工作区索引由 workspace/sources 独立管理）
// ---------------------------------------------------------------------------

// iverilog 缺模块汇总块：*** These modules were missing:\n        name referenced N times.\n***
const MISSING_MODULE_BLOCK_RE = /\*\*\* These modules were missing:\r?\n([\s\S]*?)\r?\n\s*\*\*\*/;
const MISSING_MODULE_ENTRY_RE = /^[ \t]+([A-Za-z_][A-Za-z0-9_$]*)[ \t]+referenced/gm;

/**
 * 从编译输出解析缺模块清单，用模块索引找出尚未参与编译的定义文件。
 * @param {string} rawText 编译输出
 * @param {Map<string, string>} moduleIndex 模块名 → 文件路径
 * @param {Set<string>} compiledSet 已参与编译的文件（绝对路径）
 * @returns {string[]} 需要追加编译的文件路径
 */
function resolveMissingModuleFiles(rawText, moduleIndex, compiledSet) {
    const block = MISSING_MODULE_BLOCK_RE.exec(String(rawText || ''));
    if (!block) return [];
    const additions = [];
    MISSING_MODULE_ENTRY_RE.lastIndex = 0;
    let match;
    while ((match = MISSING_MODULE_ENTRY_RE.exec(block[1])) !== null) {
        const file = moduleIndex.get(match[1]);
        if (file && !compiledSet.has(path.resolve(file))) additions.push(file);
    }
    return additions;
}

/**
 * 运行一次 iverilog 编译；若因缺模块失败且模块索引能补齐，追加文件重试（最多 3 轮）。
 * @param {{iverilog: string, env: NodeJS.ProcessEnv}} toolchain
 * @param {string[]} commonArgs -g/-I/-y/-Y 等公共参数
 * @param {string[]} inputFiles 首轮参与编译的文件
 * @param {string} cwd
 * @returns {Promise<{result: object, inputFiles: string[]}>}
 */
async function compileWithModuleResolution(toolchain, commonArgs, inputFiles, cwd, options = {}) {
    let files = [...inputFiles];
    const compiledSet = new Set(files.map(f => path.resolve(f)));
    const scan = options.scanSources || scanWorkspaceSources;
    async function compileRound() {
        options.task?.throwIfCancelled();
        const capture = createDiagnosticCapture({ parseLine: line => parseCompilerOutput(options.mapLine ? options.mapLine(line) : line, cwd),
            extractMissing: line => Array.from(line.matchAll(/Unknown module type:\s*([A-Za-z_][A-Za-z0-9_$]*)|^\s*([A-Za-z_][A-Za-z0-9_$]*)\s+referenced/g), match => match[1] || match[2]) });
        const args = [...(toolchain.compilePrefix || []), ...commonArgs, ...files];
        const settings = { cwd, env: toolchain.env, stage: 'compiling', timeoutMs: options.timeoutMs ?? COMPILE_TIMEOUT_MS,
            onLine: capture.onLine, onStdout: options.onStdout, onStderr: options.onStderr };
        const result = options.task ? await options.task.run(toolchain.iverilog, args, settings)
            : await runProcess(toolchain.iverilog, args, settings);
        return capture.snapshot(result);
    }
    let result = await compileRound();

    for (let round = 0; round < 3 && result.code !== 0; round++) {
        // 既然缺模块，缓存里的目录/索引可能已过期（如刚新建的源文件），强制重新扫描
        if (result.stopped || result.aborted || result.diagnosticsIncomplete || !result.missingUnits.size) break;
        const { modules } = await scan(true); options.task?.throwIfCancelled();
        const additions = [...new Set([...result.missingUnits].map(name => modules.get(name)).filter(file => file && !compiledSet.has(path.resolve(file))))];
        if (additions.length === 0) break;
        for (const file of additions) compiledSet.add(path.resolve(file));
        // 缺失定义前置而非追加：iverilog 单遍编译要求 package 在 import 它的
        // 文件之前（模块先后无关，前置对两者都安全）
        files = additions.concat(files);
        result = await compileRound();
    }
    return { result, files };
}

// ---------------------------------------------------------------------------
// 工具链探测（带缓存）
// ---------------------------------------------------------------------------

/** @type {{binDir: string, iverilog: string, vvp: string, env: NodeJS.ProcessEnv, version: string, cygwinDir: string|null}|null} */
let cachedToolchain = null;
let cachedToolchainKey = null;
/** @type {string|null} 最近一次探测失败的原因，避免每次保存都重复探测报错 */
let toolchainFailure = null;

/**
 * 判断一次运行失败是否由缺失 DLL（典型为 Cygwin 构建缺 cygwin1.dll）导致。
 * @param {{code: number, stderr: string, errorMessage: string|null}} result
 * @returns {boolean}
 */
function looksLikeMissingDll(result) {
    return result.code === DLL_NOT_FOUND_EXIT_CODE || /cygwin1\.dll/i.test(`${result.stderr} ${result.errorMessage || ''}`);
}

/** 原始探测失败且确认缺 DLL 时，定位 Cygwin 并重试；每次 await 后检查取消。 */
async function probeIcarus(iverilog, binDir, cygwinPath, task) {
    const probeTool = env => task ? task.run(iverilog, ['-V'], { env, stage: 'probe', timeoutMs: TOOL_PROBE_TIMEOUT_MS })
        : runTool(iverilog, ['-V'], { env }, TOOL_PROBE_TIMEOUT_MS);
    let probe = await probeTool(process.env); task?.throwIfCancelled();
    let cygwinDir = null;
    if (!processSucceeded(probe) && looksLikeMissingDll(probe)) {
        cygwinDir = findCygwinBinDir(cygwinPath, binDir);
        if (cygwinDir) { probe = await probeTool(buildChildEnv(cygwinDir)); task?.throwIfCancelled(); }
    }
    return { probe, cygwinDir };
}

/**
 * 探测并缓存 iverilog/vvp 工具链。Cygwin 构建缺 cygwin1.dll 时自动定位 DLL 目录并重试。
 * @param {boolean} [force=false] 忽略缓存强制重新探测
 * @returns {Promise<{binDir: string, iverilog: string, vvp: string, env: NodeJS.ProcessEnv, version: string}>}
 * @throws {Error} 找不到工具链或无法启动时抛出带修复指引的错误
 */
async function resolveToolchain(force = false, task = null, editor = null) {
    task?.throwIfCancelled();
    const vscode = editor || require('vscode');
    const config = vscode.workspace.getConfiguration('svtools.iverilog', task?.documentUri);
    const key = JSON.stringify([config.get('path'), config.get('cygwinPath'), process.env.IVERILOG_HOME]);
    if (key !== cachedToolchainKey || force) { cachedToolchain = null; toolchainFailure = null; cachedToolchainKey = key; }
    if (cachedToolchain) return cachedToolchain;
    if (toolchainFailure) throw new Error(toolchainFailure);

    const binDir = findIverilogBinDir(config.get('path'));
    if (!binDir) {
        toolchainFailure = '未找到 Icarus Verilog（iverilog）。请安装后将其 bin 目录配置到 svtools.iverilog.path。';
        throw new Error(toolchainFailure);
    }

    const iverilog = path.join(binDir, IV_EXE);
    const vvp = path.join(binDir, VVP_EXE);

    const { probe, cygwinDir } = await probeIcarus(iverilog, binDir, config.get('cygwinPath'), task);

    if (!processSucceeded(probe)) {
        const hint = looksLikeMissingDll(probe)
            ? 'iverilog 是 Cygwin 构建但未找到 cygwin1.dll，请将含该 DLL 的目录（如 <Cygwin根>\\bin）配置到 svtools.iverilog.cygwinPath。'
            : `iverilog 无法启动：${probe.errorMessage || probe.stderr.trim() || `exit ${probe.code}`}`;
        if (cachedToolchainKey === key) toolchainFailure = hint;
        throw new Error(hint);
    }

    const versionMatch = `${probe.stdout}\n${probe.stderr}`.match(/Icarus Verilog version\s+([^\s(]+)/i);
    const resolved = {
        binDir,
        iverilog,
        vvp,
        env: buildChildEnv(cygwinDir),
        version: versionMatch ? versionMatch[1] : 'unknown',
        // Cygwin 构建时定位到的 DLL 目录（bin 内含 stdbuf.exe 等工具）；原生构建为 null
        cygwinDir: cygwinDir
    };
    // 不同工作区配置可同时探测，迟到的结果不能污染另一个配置的缓存。
    if (cachedToolchainKey === key) { cachedToolchain = resolved; toolchainFailure = null; }
    return resolved;
}

// ---------------------------------------------------------------------------
// VSCode 集成
// ---------------------------------------------------------------------------

/**
 * 激活 Icarus Verilog 功能：lint 诊断、仿真命令、状态栏与事件接线。
 * @param {vscode.ExtensionContext} context
 * @param {{waveViewer?: {openWaveform: (path: string) => Promise<void>}}} [deps] 依赖注入（内置 VCD 查看器）
 */
function activateIverilog(context, deps = {}) {
    return require('./iverilog-controller').activateIverilog(context, { ...deps,
        buildCommonArgs, compileWithModuleResolution,
        resolveToolchain: deps.resolveToolchain || (task => resolveToolchain(false, task, deps.vscode)),
        resetToolchain() { cachedToolchain = null; toolchainFailure = null; },
        resetToolchainFailure() { toolchainFailure = null; }
    });
}

module.exports = {
    activateIverilog,
    // 纯函数导出，便于不依赖 vscode 的单元测试
    parseCompilerOutput,
    buildCommonArgs,
    languageStandardFlag,
    normalizeToolDirPath,
    findIverilogBinDir,
    findCygwinBinDir,
    buildChildEnv,
    looksLikeMissingDll,
    resolveMissingModuleFiles,
    scanWorkspaceSources,
    compileWithModuleResolution,
    formatCommandLine
};
