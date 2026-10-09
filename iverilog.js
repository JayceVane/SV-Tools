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

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lintWithXvlog, elaborateWithXvlog, resetXvlogCache } = require('./xvlog');

const OUTPUT_CHANNEL_TITLE = 'SystemVerilog Tools · Icarus Verilog';
const DIAGNOSTIC_SOURCE = 'iverilog';
const VERILOG_LANGUAGE_IDS = ['verilog', 'systemverilog', 'system-verilog'];
const WAVEFORM_EXTENSIONS = ['.vcd', '.fst'];
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
    return new Promise((resolve) => {
        const startedAt = Date.now();
        let child;
        try {
            child = spawn(command, args, {
                cwd: options.cwd,
                env: options.env,
                windowsHide: true
            });
        } catch (err) {
            resolve({ code: -1, stdout: '', stderr: '', errorMessage: String(err), timedOut: false, elapsedMs: 0 });
            return;
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;

        const timer = timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                child.kill();
            }, timeoutMs)
            : null;

        const finish = (code, errorMessage) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({ code, stdout, stderr, errorMessage: errorMessage || null, timedOut, elapsedMs: Date.now() - startedAt });
        };

        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', err => finish(-1, String(err)));
        child.on('close', code => finish(code, null));
    });
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
// 工作区源码扫描（目录清单 + 模块名 → 文件索引，带 TTL 缓存）
// ---------------------------------------------------------------------------

// module/interface/package/program 都算设计单元：TB 跨文件引用的 interface 实例、
// import 的 package 同样要能按定义文件补编译（"Module <apb_if> not found" 类报错）
const MODULE_DECL_RE = /^[ \t]*(?:module|macromodule|interface|package|program)[ \t]+([A-Za-z_][A-Za-z0-9_$]*)/gm;
// iverilog 缺模块汇总块：*** These modules were missing:\n        name referenced N times.\n***
const MISSING_MODULE_BLOCK_RE = /\*\*\* These modules were missing:\r?\n([\s\S]*?)\r?\n\s*\*\*\*/;
const MISSING_MODULE_ENTRY_RE = /^[ \t]+([A-Za-z_][A-Za-z0-9_$]*)[ \t]+referenced/gm;

const WORKSPACE_SCAN_TTL_MS = 10000;
const WORKSPACE_SCAN_MAX_DIRS = 200;
const WORKSPACE_SCAN_MAX_FILES = 3000;

/** @type {{dirs: string[], modules: Map<string, string>, expiresAt: number}} */
let workspaceScanCache = { dirs: [], modules: new Map(), expiresAt: 0 };

/**
 * 扫描工作区 Verilog 源码：收集含源文件的目录（供 -y/-I 使用）与
 * 「设计单元名（module/interface/package/program）→ 文件路径」索引
 * （供缺单元时按实际定义文件补编译，覆盖文件名≠单元名的情况）。
 * 结果带 TTL 缓存，避免每次防抖 lint 都全量扫描；缺模块重试与文件增删事件会强制刷新。
 * @param {boolean} [force=false] 跳过缓存强制重新扫描
 * @returns {Promise<{dirs: string[], modules: Map<string, string>}>}
 */
async function scanWorkspaceSources(force = false) {
    const vscode = require('vscode');
    const now = Date.now();
    if (!force && workspaceScanCache.expiresAt > now) {
        return { dirs: workspaceScanCache.dirs, modules: workspaceScanCache.modules };
    }

    const dirs = [];
    const modules = new Map();
    const roots = vscode.workspace.workspaceFolders;
    const enabled = vscode.workspace.getConfiguration('svtools.iverilog').get('scanWorkspace', true);
    if (enabled && roots && roots.length > 0) {
        const dirSet = new Set();
        let scanned = 0;
        for (const pattern of ['**/*.sv', '**/*.v', '**/*.svh', '**/*.vh']) {
            if (scanned >= WORKSPACE_SCAN_MAX_FILES) break;
            let uris = [];
            try {
                uris = await vscode.workspace.findFiles(pattern, undefined, WORKSPACE_SCAN_MAX_FILES);
            } catch (err) {
                continue; // 单个模式失败不影响其余
            }
            for (const uri of uris) {
                if (scanned++ >= WORKSPACE_SCAN_MAX_FILES) break;
                dirSet.add(path.dirname(uri.fsPath));
                try {
                    const text = fs.readFileSync(uri.fsPath, 'utf8');
                    MODULE_DECL_RE.lastIndex = 0;
                    let match;
                    while ((match = MODULE_DECL_RE.exec(text)) !== null) {
                        if (!modules.has(match[1])) modules.set(match[1], uri.fsPath);
                    }
                } catch (err) {
                    // 不可读文件跳过，不影响其余扫描
                }
            }
        }
        dirs.push(...dirSet);
    }

    workspaceScanCache = {
        dirs: dirs.slice(0, WORKSPACE_SCAN_MAX_DIRS),
        modules,
        expiresAt: now + WORKSPACE_SCAN_TTL_MS
    };
    return { dirs: workspaceScanCache.dirs, modules: workspaceScanCache.modules };
}

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
async function compileWithModuleResolution(toolchain, commonArgs, inputFiles, cwd) {
    let files = [...inputFiles];
    const compiledSet = new Set(files.map(f => path.resolve(f)));
    let result = await runTool(toolchain.iverilog, [...commonArgs, ...files], { cwd, env: toolchain.env });

    for (let round = 0; round < 3 && result.code !== 0; round++) {
        // 既然缺模块，缓存里的目录/索引可能已过期（如刚新建的源文件），强制重新扫描
        const { modules } = await scanWorkspaceSources(true);
        const additions = resolveMissingModuleFiles(`${result.stderr}\n${result.stdout}`, modules, compiledSet);
        if (additions.length === 0) break;
        for (const file of additions) compiledSet.add(path.resolve(file));
        files = files.concat(additions);
        result = await runTool(toolchain.iverilog, [...commonArgs, ...files], { cwd, env: toolchain.env });
    }
    return { result, files };
}

// ---------------------------------------------------------------------------
// 工具链探测（带缓存）
// ---------------------------------------------------------------------------

/** @type {{binDir: string, iverilog: string, vvp: string, env: NodeJS.ProcessEnv, version: string, cygwinDir: string|null}|null} */
let cachedToolchain = null;
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

/**
 * 探测并缓存 iverilog/vvp 工具链。Cygwin 构建缺 cygwin1.dll 时自动定位 DLL 目录并重试。
 * @param {boolean} [force=false] 忽略缓存强制重新探测
 * @returns {Promise<{binDir: string, iverilog: string, vvp: string, env: NodeJS.ProcessEnv, version: string}>}
 * @throws {Error} 找不到工具链或无法启动时抛出带修复指引的错误
 */
async function resolveToolchain(force = false) {
    if (cachedToolchain && !force) return cachedToolchain;
    if (toolchainFailure && !force) throw new Error(toolchainFailure);

    const vscode = require('vscode');
    const config = vscode.workspace.getConfiguration('svtools.iverilog');

    const binDir = findIverilogBinDir(config.get('path'));
    if (!binDir) {
        toolchainFailure = '未找到 Icarus Verilog（iverilog）。请安装后将其 bin 目录配置到 svtools.iverilog.path。';
        throw new Error(toolchainFailure);
    }

    const iverilog = path.join(binDir, IV_EXE);
    const vvp = path.join(binDir, VVP_EXE);

    // 先按原样探测；Cygwin 构建缺 cygwin1.dll 时，带上 DLL 目录重试
    let probe = await runTool(iverilog, ['-V'], { env: process.env }, TOOL_PROBE_TIMEOUT_MS);
    let cygwinDir = null;
    if (probe.errorMessage || probe.code !== 0) {
        if (looksLikeMissingDll(probe)) {
            cygwinDir = findCygwinBinDir(config.get('cygwinPath'), binDir);
            if (cygwinDir) {
                probe = await runTool(iverilog, ['-V'], { env: buildChildEnv(cygwinDir) }, TOOL_PROBE_TIMEOUT_MS);
            }
        }
    }

    if (probe.errorMessage || probe.code !== 0) {
        const hint = looksLikeMissingDll(probe)
            ? 'iverilog 是 Cygwin 构建但未找到 cygwin1.dll，请将含该 DLL 的目录（如 <Cygwin根>\\bin）配置到 svtools.iverilog.cygwinPath。'
            : `iverilog 无法启动：${probe.errorMessage || probe.stderr.trim() || `exit ${probe.code}`}`;
        toolchainFailure = hint;
        throw new Error(hint);
    }

    const versionMatch = `${probe.stdout}\n${probe.stderr}`.match(/Icarus Verilog version\s+([^\s(]+)/i);
    cachedToolchain = {
        binDir,
        iverilog,
        vvp,
        env: buildChildEnv(cygwinDir),
        version: versionMatch ? versionMatch[1] : 'unknown',
        // Cygwin 构建时定位到的 DLL 目录（bin 内含 stdbuf.exe 等工具）；原生构建为 null
        cygwinDir: cygwinDir
    };
    toolchainFailure = null;
    return cachedToolchain;
}

// ---------------------------------------------------------------------------
// VSCode 集成
// ---------------------------------------------------------------------------

/**
 * 激活 Icarus Verilog 功能：lint 诊断、仿真命令、状态栏与事件接线。
 * @param {vscode.ExtensionContext} context
 * @param {{waveViewer?: {openWaveform: (path: string) => Promise<void>}}} [deps] 依赖注入（内置 VCD 查看器）
 */
function activateIverilog(context, deps) {
    const vscode = require('vscode');
    /** @type {{openWaveform: (path: string) => Promise<void>}} */
    const waveViewer = (deps && deps.waveViewer) || { openWaveform: async () => { } };

    const diagnostics = vscode.languages.createDiagnosticCollection('svtools-iverilog');
    const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_TITLE);
    context.subscriptions.push(diagnostics, channel);

    /** 进行中的仿真：{ child, document, startedAt, timeoutTimer, killed } */
    let activeSim = null;
    /** 每个文档的 lint 世代计数，旧的异步结果不覆盖新结果 */
    const lintGenerations = new Map();
    /** 每个文档的 on-change 防抖定时器 */
    const lintDebounceTimers = new Map();

    function getConfig() {
        return vscode.workspace.getConfiguration('svtools.iverilog');
    }

    function isVerilogDocument(document) {
        return VERILOG_LANGUAGE_IDS.includes(document.languageId);
    }

    /**
     * 把相对路径配置项（includePaths/libraryPaths/simFiles）解析为基于工作区根的绝对路径。
     * @param {string[]} paths
     * @param {string} fallbackBase 无工作区时的基准目录
     */
    function resolveConfigPaths(paths, fallbackBase) {
        const root = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const base = root ? root.uri.fsPath : fallbackBase;
        return (paths || []).map(p => path.resolve(base, p));
    }

    /**
     * 将编译输出解析结果写入诊断集合（Problems 面板可点击跳转）。
     * @param {vscode.TextDocument|null} document 触发 lint 的文档（用于整行 squiggle 范围）
     * @param {ReturnType<typeof parseCompilerOutput>} findings
     * @param {string} [source] 诊断来源标识（iverilog / xvlog）
     */
    function applyDiagnostics(document, findings, source) {
        const grouped = new Map();
        for (const f of findings) {
            if (!grouped.has(f.file)) grouped.set(f.file, []);
            grouped.get(f.file).push(f);
        }

        // 主文档即使无诊断也要清掉旧条目
        if (document && !grouped.has(document.uri.fsPath)) {
            grouped.set(document.uri.fsPath, []);
        }

        for (const [file, items] of grouped) {
            const uri = vscode.Uri.file(file);
            const list = [];
            for (const item of items) {
                const lineIdx = item.line - 1;
                let range;
                if (document && document.uri.fsPath === file) {
                    try {
                        range = document.lineAt(Math.min(Math.max(lineIdx, 0), document.lineCount - 1)).range;
                    } catch (e) {
                        range = new vscode.Range(lineIdx, 0, lineIdx, 0);
                    }
                } else {
                    range = new vscode.Range(Math.max(lineIdx, 0), 0, Math.max(lineIdx, 0), 0);
                }
                const diag = new vscode.Diagnostic(range, item.message,
                    item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
                diag.source = source || DIAGNOSTIC_SOURCE;
                list.push(diag);
            }
            diagnostics.set(uri, list);
        }
    }

    /**
     * 对单个文档执行 iverilog 语法检查并更新诊断。
     * 文档有未保存修改时，把缓冲区内容写入临时文件进行 lint（保持 include/库目录
     * 指向原文件目录），并把输出的临时路径回映射为原文件，保证 squiggle 落在正确位置。
     * @param {vscode.TextDocument} document
     * @returns {Promise<{ok: boolean, errorCount: number, warningCount: number}>}
     *          ok = 编译退出码为 0 且无 error 级诊断（仅警告视为通过）
     */
    async function lintDocument(document) {
        const empty = { ok: true, errorCount: 0, warningCount: 0 };
        if (!isVerilogDocument(document)) return empty;
        if (document.uri.scheme !== 'file') return empty;

        // lint 引擎分流：xvlog（Vivado 语法/详细化检查）走独立模块
        if (vscode.workspace.getConfiguration('svtools.lint').get('engine', 'iverilog') === 'xvlog') {
            const gen = (lintGenerations.get(document.uri.toString()) || 0) + 1;
            lintGenerations.set(document.uri.toString(), gen);
            return lintWithXvlog(document, {
                vscode, channel, applyDiagnostics, isVerilogDocument, scanWorkspaceSources,
                lintGenerations, gen,
                showToolchainError: (msg, setting) => showToolchainError(msg, setting)
            });
        }

        let toolchain;
        try {
            toolchain = await resolveToolchain();
        } catch (err) {
            channel.appendLine(`[lint] 工具链不可用：${err.message}`);
            showToolchainError(err.message);
            return empty;
        }

        const filePath = document.uri.fsPath;
        const fileDir = path.dirname(filePath);
        const config = getConfig();

        let lintTarget = filePath;
        let tempFile = null;
        if (document.isDirty) {
            const hash = crypto.createHash('md5').update(document.uri.toString()).digest('hex').slice(0, 10);
            tempFile = path.join(os.tmpdir(), `svtools-lint-${hash}${path.extname(filePath)}`);
            try {
                fs.writeFileSync(tempFile, document.getText());
                lintTarget = tempFile;
            } catch (err) {
                channel.appendLine(`[lint] 写入临时文件失败，回退用磁盘内容：${err.message}`);
                tempFile = null;
            }
        }

        // currentFileOnly（默认开）：不附带工作区扫描目录（-y/-I 不广播），
        // 但实例化本工作区定义的模块时仍按设计单元索引精确补定义文件重试，
        // 避免把跨文件引用误报成 Unknown module type；关闭后附带 -y 目录
        const fileOnly = vscode.workspace.getConfiguration('svtools.lint').get('currentFileOnly', true);
        const scanDirs = fileOnly ? [] : (await scanWorkspaceSources()).dirs;

        const args = [
            '-tnull',
            ...buildCommonArgs({
                fileName: filePath,
                standard: config.get('standard'),
                includePaths: [fileDir, ...resolveConfigPaths(config.get('includePaths'), fileDir), ...scanDirs],
                libraryPaths: [fileDir, ...resolveConfigPaths(config.get('libraryPaths'), fileDir), ...scanDirs],
                extraArgs: ['-Y', '.sv', ...config.get('lintArgs', [])]
            })
        ];

        const gen = (lintGenerations.get(document.uri.toString()) || 0) + 1;
        lintGenerations.set(document.uri.toString(), gen);

        const { result } = await compileWithModuleResolution(toolchain, args, [lintTarget], fileDir);
        if (tempFile) {
            try { fs.unlinkSync(tempFile); } catch (err) { /* 清理失败可忽略 */ }
        }
        if (lintGenerations.get(document.uri.toString()) !== gen) return empty; // 已被更新的 lint 取代

        let raw = `${result.stderr}\n${result.stdout}`;
        if (tempFile) {
            // 把 iverilog 输出中的临时文件路径映射回原文件，诊断才能落在正确的编辑器上
            raw = raw.split(tempFile).join(filePath);
        }
        const findings = parseCompilerOutput(raw, fileDir);
        applyDiagnostics(document, findings);
        const errorCount = findings.filter(f => f.severity === 'error').length;
        const summary = {
            ok: result.code === 0 && errorCount === 0,
            errorCount,
            warningCount: findings.length - errorCount
        };
        // 触发轨迹写入输出通道，便于确认自动 lint 是否生效
        channel.appendLine(`[lint] ${path.basename(filePath)}${document.isDirty ? '（缓冲区）' : ''} → ${errorCount} 错误, ${summary.warningCount} 警告 (${result.elapsedMs}ms)`);
        return summary;
    }

    let toolchainErrorShown = false;
    function showToolchainError(message, setting) {
        if (toolchainErrorShown) return;
        toolchainErrorShown = true;
        vscode.window.showErrorMessage(message, '打开设置')
            .then(choice => {
                toolchainErrorShown = false;
                if (choice === '打开设置') {
                    vscode.commands.executeCommand('workbench.action.openSettings', setting || 'svtools.iverilog.path');
                }
            });
    }

    /**
     * 终止仿真进程。只 kill() 直接子进程在两种情况下会留孤儿：
     * 1) stdbuf 包装：cygwin exec 会更换 Windows PID，且参数不进 Windows 命令行
     *    （CommandLine 里只有 vvp.exe 自身路径），不能按命令行匹配；
     * 2) Windows 对部分进程树的信号投递不可靠。
     * 因此 Windows 上先用 taskkill /T 按进程树强杀，stdbuf 包装时再按
     * ParentProcessId == 原 spawn PID 定位 exec 后的 vvp 精确兜底
     * （cygwin exec 产生的新进程父指针指向原进程，关系可查）。
     * @param {{child: import('child_process').ChildProcess, wrapped: boolean}} sim
     */
    function killSimProcess(sim) {
        const { child, wrapped } = sim;
        try { child.kill(); } catch (err) { /* 下面继续兜底 */ }
        if (process.platform !== 'win32') return;
        if (child.pid) {
            try {
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            } catch (err) { /* 忽略 */ }
        }
        if (!wrapped) return;
        try {
            spawn('powershell.exe', ['-NoProfile', '-Command',
                `Get-CimInstance Win32_Process -Filter "Name='vvp.exe' AND ParentProcessId=${child.pid}" | `
                + `ForEach-Object { taskkill /F /PID $_.ProcessId }`], { windowsHide: true });
        } catch (err) {
            channel.appendLine(`停止仿真兜底清理失败：${err}`);
        }
    }

    /**
     * 停止正在运行的仿真。
     * @param {string} [reason] 停止原因，写入输出通道
     */
    function stopSimulation(reason) {
        if (!activeSim) return;
        if (activeSim.timeoutTimer) clearTimeout(activeSim.timeoutTimer);
        activeSim.killed = true;
        killSimProcess(activeSim);
        channel.appendLine(reason ? `** 仿真已停止（${reason}）**` : '** 仿真已停止 **');
        activeSim = null;
        updateStatusBar();
    }

    /**
     * 展开仿真附加源文件 glob（相对工作区根），返回绝对路径列表。
     * @param {string[]} patterns
     */
    async function expandSimFiles(patterns) {
        const files = [];
        for (const pattern of patterns || []) {
            try {
                const uris = await vscode.workspace.findFiles(pattern, undefined, 500);
                files.push(...uris.map(u => u.fsPath));
            } catch (err) {
                channel.appendLine(`忽略无效的 simFiles 模式 "${pattern}"：${err.message || err}`);
            }
        }
        return [...new Set(files)];
    }

    /**
     * 仿真结束后扫描运行目录，找出本次运行新生成的波形文件。
     * @param {string} dir
     * @param {number} startedAtMs
     */
    function findFreshWaveforms(dir, startedAtMs) {
        const found = [];
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            return found;
        }
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (!WAVEFORM_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
            try {
                const stat = fs.statSync(path.join(dir, entry.name));
                if (stat.mtimeMs >= startedAtMs - 2000) found.push(path.join(dir, entry.name));
            } catch (err) {
                // 单个文件 stat 失败不影响其余扫描
            }
        }
        return found;
    }

    /**
     * 运行 Icarus Verilog 仿真：编译当前文档（+simFiles 附加源文件），成功后执行 vvp 并流式输出。
     * 已有仿真在运行时先停止再启动新仿真。
     * @param {vscode.TextDocument} document 仿真入口（通常是 testbench）
     */
    async function runSimulation(document) {
        if (!document || !isVerilogDocument(document) || document.uri.scheme !== 'file') {
            vscode.window.showWarningMessage('请先保存并在编辑器中打开 Verilog/SystemVerilog 文件再运行仿真。');
            return;
        }

        let toolchain;
        try {
            toolchain = await resolveToolchain();
        } catch (err) {
            showToolchainError(err.message);
            return;
        }

        if (activeSim) stopSimulation('被新的仿真运行取代');

        const config = getConfig();
        const filePath = document.uri.fsPath;
        const fileDir = path.dirname(filePath);
        const fileName = path.basename(filePath);

        const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri);
        const outDir = path.join(
            workspaceRoot ? workspaceRoot.uri.fsPath : path.join(os.tmpdir(), 'svtools-sim'),
            '.svtools', 'sim'
        );
        fs.mkdirSync(outDir, { recursive: true });
        const vvpFile = path.join(outDir, path.basename(fileName, path.extname(fileName)) + '.vvp');

        channel.show(true);
        channel.appendLine('');
        channel.appendLine(`==== Icarus Verilog 仿真：${fileName}（${new Date().toLocaleString()}）====`);

        // ---- 编译 ----
        const extraFiles = (await expandSimFiles(config.get('simFiles', [])))
            .filter(f => path.resolve(f) !== path.resolve(filePath));
        if (document.isDirty) {
            channel.appendLine('提示：文件存在未保存修改，本次仿真使用磁盘上的内容。');
        }
        const compileArgs = [
            ...buildCommonArgs({
                fileName: filePath,
                standard: config.get('standard'),
                includePaths: [fileDir, ...resolveConfigPaths(config.get('includePaths'), fileDir), ...(await scanWorkspaceSources()).dirs],
                libraryPaths: [fileDir, ...resolveConfigPaths(config.get('libraryPaths'), fileDir), ...(await scanWorkspaceSources()).dirs],
                extraArgs: ['-Y', '.sv', ...config.get('lintArgs', [])]
            })
        ];
        const topModule = String(config.get('simTop') || '').trim();
        if (topModule) compileArgs.push('-s', topModule);
        compileArgs.push('-o', vvpFile);

        channel.appendLine(`$ ${formatCommandLine(toolchain.iverilog, [...compileArgs, filePath, ...extraFiles])}`);
        const { result: compile } = await compileWithModuleResolution(toolchain, compileArgs, [filePath, ...extraFiles], fileDir);
        if (compile.stderr.trim()) channel.append(compile.stderr.endsWith('\n') ? compile.stderr : compile.stderr + '\n');

        if (compile.code !== 0) {
            const findings = parseCompilerOutput(`${compile.stderr}\n${compile.stdout}`, fileDir);
            applyDiagnostics(document, findings);
            channel.appendLine(`** 编译失败（exit ${compile.code}），仿真未运行 **`);
            if (/Unknown module type|These modules were missing/.test(compile.stderr)
                && !(config.get('simFiles') || []).length) {
                channel.appendLine('提示：存在未解析模块。工作区目录已按「文件名=模块名」约定自动搜索；'
                    + '若模块所在文件名与模块名不同，请确认模块已在工作区内定义，或在 svtools.iverilog.simFiles 配置额外源文件（如 "src/**/*.sv"）。');
            }
            return;
        }
        applyDiagnostics(document, []);
        channel.appendLine(`编译完成，输出：${vvpFile}`);

        // ---- 运行 vvp ----
        const runArgs = ['-n', ...config.get('simArgs', []), vvpFile];

        // Cygwin 构建的 vvp 在 stdout 接管道时是块缓冲：短输出要等进程退出才可见，
        // 进程被强杀则整个丢失（表现为「仿真无输出」）。stdbuf -oL 强制行缓冲让
        // $display/$monitor 实时流到输出通道。注意 cygwin exec 会更换 Windows PID，
        // 停止时不能只 kill 直接子进程（见 killSimProcess）。
        let vvpCmd = toolchain.vvp;
        let vvpCmdArgs = runArgs;
        let vvpWrapped = false;
        if (process.platform === 'win32' && toolchain.cygwinDir) {
            const stdbuf = path.join(toolchain.cygwinDir, 'stdbuf.exe');
            if (fs.existsSync(stdbuf)) {
                vvpCmd = stdbuf;
                vvpCmdArgs = ['-oL', toolchain.vvp, ...runArgs];
                vvpWrapped = true;
            }
        }
        channel.appendLine(`$ ${formatCommandLine(vvpCmd, vvpCmdArgs)}`);

        const startedAt = Date.now();
        const child = spawn(vvpCmd, vvpCmdArgs, { cwd: fileDir, env: toolchain.env, windowsHide: true });
        const sim = { child, document, startedAt, timeoutTimer: null, killed: false, vvpFile, wrapped: vvpWrapped };
        activeSim = sim;
        updateStatusBar();

        const timeoutMs = Number(config.get('simTimeoutMs') || 0);
        if (timeoutMs > 0) {
            sim.timeoutTimer = setTimeout(() => stopSimulation(`超过 ${Math.round(timeoutMs / 1000)}s 超时`), timeoutMs);
        }

        await new Promise((resolve) => {
            child.stdout.on('data', d => channel.append(d.toString()));
            child.stderr.on('data', d => channel.append(d.toString()));
            child.on('error', err => {
                channel.appendLine(`vvp 启动失败：${err}`);
                resolve();
            });
            child.on('close', code => resolve(code));
        });

        // 自然结束时清掉本 run 的超时定时器，防止其触发时误杀后续新仿真
        if (sim.timeoutTimer) clearTimeout(sim.timeoutTimer);

        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const wasStopped = sim.killed;
        if (activeSim === sim) {
            activeSim = null;
            updateStatusBar();
        }
        channel.appendLine(`** 仿真结束：耗时 ${elapsed}s ${wasStopped ? '（手动停止/超时）' : ''}**`);

        // ---- 波形提示 ----
        const waves = findFreshWaveforms(fileDir, startedAt);
        if (waves.length > 0) {
            const vcdFile = waves.find(w => path.extname(w).toLowerCase() === '.vcd');
            const viewer = String(config.get('waveViewer') || '').trim();
            const autoOpen = config.get('autoOpenWaveform', true);

            // 内置查看器优先：未配置外部程序且是新 .vcd 时直接打开波形面板
            if (vcdFile && !viewer && autoOpen) {
                await waveViewer.openWaveform(vcdFile);
            }

            const rel = path.basename(waves[0]);
            const buttons = [];
            if (vcdFile && !viewer && vcdFile !== waves[0]) buttons.push('打开波形');
            if (viewer) buttons.push('外部查看器打开');
            buttons.push('在资源管理器中显示');
            vscode.window.showInformationMessage(`仿真波形已生成：${rel}`, ...buttons).then(choice => {
                if (choice === '打开波形' && vcdFile) {
                    waveViewer.openWaveform(vcdFile);
                } else if (choice === '外部查看器打开' && viewer) {
                    const target = vcdFile || waves[0];
                    const view = spawn(viewer, [target], { detached: true, stdio: 'ignore', windowsHide: true });
                    view.on('error', err => vscode.window.showErrorMessage(`启动波形查看器失败：${err.message}`));
                    view.unref();
                } else if (choice === '在资源管理器中显示') {
                    vscode.commands.executeCommand('revealFileInOs', vscode.Uri.file(waves[0]));
                }
            });
        }
    }

    // ---- 状态栏 ----
    const simStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    simStatusBar.command = 'svtools.iverilog.simulate';
    context.subscriptions.push(simStatusBar);

    // lint 引擎切换按钮（状态栏右侧）。xelab 详细化按钮在编辑器工具栏
    // （标签页右上角，package.json editor/title，仅 xvlog 引擎显示）
    const engineStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    engineStatusBar.command = 'svtools.lint.selectEngine';
    context.subscriptions.push(engineStatusBar);

    function currentLintEngine() {
        return vscode.workspace.getConfiguration('svtools.lint').get('engine', 'iverilog');
    }

    function updateStatusBar() {
        const editor = vscode.window.activeTextEditor;
        const verilogOpen = !!(editor && isVerilogDocument(editor.document));

        // context key 让 editor/title 停止按钮跟随仿真状态显隐
        vscode.commands.executeCommand('setContext', 'svtools.simRunning', !!activeSim);

        if (!verilogOpen) {
            simStatusBar.hide();
        } else if (activeSim) {
            // 运行中点击 = 停止（旧版点击会重新运行，卡死的仿真看起来「停不掉」）
            simStatusBar.command = 'svtools.iverilog.stopSimulation';
            simStatusBar.text = '$(debug-stop) 停止仿真';
            simStatusBar.tooltip = 'Icarus Verilog 仿真正在运行 — 点击停止';
            simStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            simStatusBar.show();
        } else {
            simStatusBar.command = 'svtools.iverilog.simulate';
            simStatusBar.text = '$(play) iverilog 仿真';
            simStatusBar.tooltip = '运行 Icarus Verilog 仿真（编译 + vvp）';
            simStatusBar.backgroundColor = undefined;
            simStatusBar.show();
        }

        if (verilogOpen) {
            const engine = currentLintEngine();
            engineStatusBar.text = `$(zap) ${engine}`;
            engineStatusBar.tooltip = `lint 引擎：${engine} — 点击切换 iverilog / xvlog`;
            engineStatusBar.show();
        } else {
            engineStatusBar.hide();
        }
    }

    // ---- 事件与命令接线 ----
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => {
            if (getConfig().get('lintOnOpen')) lintDocument(document);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (!getConfig().get('lintOnChange')) return;
            if (event.contentChanges.length === 0) return;
            const document = event.document;
            if (!isVerilogDocument(document) || document.uri.scheme !== 'file') return;
            // 防抖：停止输入一段时间后才触发，避免每个按键起一个 iverilog 进程
            const key = document.uri.toString();
            const pending = lintDebounceTimers.get(key);
            if (pending) clearTimeout(pending);
            const delay = Math.max(100, Number(getConfig().get('lintDebounceMs')) || 800);
            lintDebounceTimers.set(key, setTimeout(() => {
                lintDebounceTimers.delete(key);
                lintDocument(document);
            }, delay));
        }),
        vscode.workspace.onDidSaveTextDocument(document => {
            if (getConfig().get('lintOnSave')) lintDocument(document);
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            diagnostics.delete(document.uri);
            lintGenerations.delete(document.uri.toString());
            const pending = lintDebounceTimers.get(document.uri.toString());
            if (pending) {
                clearTimeout(pending);
                lintDebounceTimers.delete(document.uri.toString());
            }
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('svtools.iverilog')
                && !event.affectsConfiguration('svtools.lint')
                && !event.affectsConfiguration('svtools.vivado')) return;
            // 工具路径类配置变更后强制重新探测
            if (event.affectsConfiguration('svtools.iverilog.path')
                || event.affectsConfiguration('svtools.iverilog.cygwinPath')) {
                cachedToolchain = null;
                toolchainFailure = null;
            }
            if (event.affectsConfiguration('svtools.vivado.path')) {
                resetXvlogCache();
            }
            // 引擎切换等配置变化后刷新状态栏按钮
            updateStatusBar();
            // 重新检查所有打开的 Verilog 文档
            for (const doc of vscode.workspace.textDocuments) {
                lintDocument(doc);
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),

        // 文件增删/重命名后使工作区扫描缓存失效，新建的模块文件能立即被 lint/仿真解析
        vscode.workspace.onDidCreateFiles(() => { workspaceScanCache = { dirs: [], modules: new Map(), expiresAt: 0 }; }),
        vscode.workspace.onDidDeleteFiles(() => { workspaceScanCache = { dirs: [], modules: new Map(), expiresAt: 0 }; }),
        vscode.workspace.onDidRenameFiles(() => { workspaceScanCache = { dirs: [], modules: new Map(), expiresAt: 0 }; }),

        vscode.commands.registerCommand('svtools.lint.selectEngine', async () => {
            const cur = currentLintEngine();
            const pick = await vscode.window.showQuickPick([
                { label: 'iverilog', description: 'Icarus Verilog — 快速语法检查（-tnull）', value: 'iverilog' },
                { label: 'xvlog', description: 'Vivado — 与 xsim 编译阶段一致的诊断，可配合 xelab 按钮', value: 'xvlog' }
            ], { placeHolder: `当前 lint 引擎：${cur} — 选择要切换的引擎` });
            if (!pick || pick.value === cur) return;
            const target = vscode.workspace.workspaceFolders
                ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            await vscode.workspace.getConfiguration('svtools.lint').update('engine', pick.value, target);
            vscode.window.setStatusBarMessage(`lint 引擎已切换：${pick.value}`, 3000);
            updateStatusBar();
        }),
        vscode.commands.registerCommand('svtools.xvlog.elaborate', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isVerilogDocument(editor.document) || editor.document.uri.scheme !== 'file') {
                vscode.window.showWarningMessage('请先在编辑器中打开 Verilog/SystemVerilog 文件。');
                return;
            }
            if (currentLintEngine() !== 'xvlog') {
                vscode.window.showWarningMessage('xelab 详细化检查需要 lint 引擎为 xvlog — 点击状态栏引擎按钮切换。');
                return;
            }
            const gen = (lintGenerations.get(editor.document.uri.toString()) || 0) + 1;
            lintGenerations.set(editor.document.uri.toString(), gen);
            const summary = await elaborateWithXvlog(editor.document, {
                vscode, channel, applyDiagnostics, isVerilogDocument, scanWorkspaceSources,
                lintGenerations, gen,
                showToolchainError: (msg, setting) => showToolchainError(msg, setting)
            });
            vscode.window.setStatusBarMessage(
                summary.errorCount
                    ? `xelab：发现 ${summary.errorCount} 个错误，详见 Problems 面板`
                    : 'xelab：详细化检查未发现问题',
                5000);
            return summary;
        }),
        vscode.commands.registerCommand('svtools.iverilog.lint', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('没有打开的编辑器。');
                return { ok: false, errorCount: 0, warningCount: 0 };
            }
            // 手动触发时清除缓存的探测失败，允许用户修复环境后立即恢复
            if (toolchainFailure) {
                toolchainFailure = null;
                channel.appendLine('[lint] 手动触发：重新探测工具链');
            }
            const summary = await lintDocument(editor.document);
            let message;
            if (!summary.ok) {
                message = `iverilog: 发现 ${summary.errorCount} 个错误，详见 Problems 面板`;
            } else if (summary.warningCount > 0) {
                message = `iverilog: 通过，${summary.warningCount} 个警告`;
            } else {
                message = 'iverilog: 未发现问题';
            }
            vscode.window.setStatusBarMessage(message, 4000);
            return summary;
        }),
        vscode.commands.registerCommand('svtools.iverilog.simulate', () => {
            const editor = vscode.window.activeTextEditor;
            return runSimulation(editor ? editor.document : null);
        }),
        vscode.commands.registerCommand('svtools.iverilog.stopSimulation', () => {
            if (!activeSim) {
                vscode.window.setStatusBarMessage('当前没有正在运行的仿真', 3000);
                return;
            }
            stopSimulation();
        })
    );

    // 激活由打开 .v/.sv 文件触发，该文件不会再来 onDidOpenTextDocument 事件，这里补跑 lint
    if (getConfig().get('lintOnOpen')) {
        for (const doc of vscode.workspace.textDocuments) {
            lintDocument(doc);
        }
    }

    updateStatusBar();
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
