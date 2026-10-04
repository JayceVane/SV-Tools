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
 */
/**
 * xvlog（语法检查）/ xelab（详细化）lint 引擎（svtools.lint.engine = "xvlog"）。
 * 自动 lint 只编译当前文件（快速、诊断不外溢到工作区其他文件）；
 * 详细化检查（类型/端口/位宽/未定义模块引用）较慢，由状态栏按钮主动触发，
 * 此时才附带工作区模块索引满足跨文件依赖。
 */

'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findVivadoBinDir, cmdQuote } = require('./vivado/toolchain');

let cachedBinDir = null;
let probeFailure = null;

function resetXvlogCache() {
    cachedBinDir = null;
    probeFailure = null;
}

/** 定位含 xvlog/xelab 的 Vivado bin 目录（vivado.path → XILINX_VIVADO → PATH → 常见位置）。 */
function resolveXvlogBinDir(configuredPath) {
    if (cachedBinDir) return cachedBinDir;
    if (probeFailure) throw probeFailure;
    const dir = findVivadoBinDir(configuredPath);
    const bat = path.join(dir || '', process.platform === 'win32' ? 'xvlog.bat' : 'xvlog');
    if (!dir || !fs.existsSync(bat)) {
        probeFailure = new Error(
            '未找到 Vivado（xvlog/xelab）。请在 svtools.vivado.path 指定安装目录，' +
            '如 D:\\DevKit\\Xilinx\\Vivado\\2022.1');
        throw probeFailure;
    }
    cachedBinDir = dir;
    return dir;
}

/** 运行 Vivado bin 下的工具（bat 经 cmd /c，路径含空格安全）。 */
function runVivadoTool(binDir, tool, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const bat = path.join(binDir, process.platform === 'win32' ? tool + '.bat' : tool);
        let child;
        try {
            if (process.platform === 'win32') {
                const line = [bat].concat(args).map(cmdQuote).join(' ');
                child = spawn('cmd.exe', ['/d', '/s', '/c', line], { cwd, windowsVerbatimArguments: true, windowsHide: true });
            } else {
                child = spawn(bat, args, { cwd });
            }
        } catch (err) {
            resolve({ code: -1, stdout: '', stderr: '', errorMessage: String(err), elapsedMs: 0 });
            return;
        }
        let stdout = '', stderr = '', settled = false;
        const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* 忽略 */ } }, timeoutMs || 120000);
        const finish = (code, errorMessage) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stdout, stderr, errorMessage: errorMessage || null, elapsedMs: Date.now() - startedAt });
        };
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.stdout.on('error', err => finish(-1, String(err)));
        child.on('error', err => finish(-1, String(err)));
        child.on('close', code => finish(code, null));
    });
}

/**
 * 解析 Vivado 工具输出（xvlog/xelab 的 VRFC/XSIM 格式）为诊断条目。
 * `ERROR: [VRFC 10-4982] syntax error near '=' [d:/path/file.sv:6]`
 * 位置后缀 [file:line(:col)]；无位置的 ERROR/WARNING 归到主文件第 1 行。
 * @param {string} raw 工具输出
 * @param {string} cwd 工具运行目录（相对路径解析基准）
 * @param {string} mainFile 主文件绝对路径（无位置条目的落点）
 */
function parseVivadoDiagnostics(raw, cwd, mainFile) {
    const findings = [];
    for (const line of String(raw).split(/\r?\n/)) {
        const m = line.match(/^(ERROR|CRITICAL WARNING|WARNING):\s*\[([^\]]+)\]\s*(.+)$/);
        if (!m) continue;
        const severity = m[1] === 'ERROR' ? 'error' : 'warning';
        const rest = m[3];
        const loc = rest.match(/\[(.+?):(\d+)(?::(\d+))?\]\s*$/);
        let file = mainFile;
        let lineNo = 1;
        if (loc) {
            const p = loc[1].replace(/\\/g, '/').replace(/\/$/, '');
            file = path.isAbsolute(p) ? p : path.resolve(cwd, p);
            lineNo = parseInt(loc[2], 10) || 1;
        }
        const message = (loc ? rest.slice(0, loc.index) : rest).trim();
        if (!message) continue;
        findings.push({
            file: path.normalize(file),
            line: lineNo,
            severity,
            message: `[${m[2]}] ${message}`
        });
    }
    return findings;
}

/** 生成 xvlog -prj 工程文件内容（work 库；绕开 Windows 命令行长度限制）。 */
function buildPrjBody(files) {
    const lines = [];
    for (const f of files) {
        const lang = /\.svh?$/i.test(f) ? 'sv' : 'verilog';
        lines.push(lang + ' work "' + f.replace(/\\/g, '/') + '"');
    }
    return lines.join('\n') + '\n';
}

/**
 * 公共前置：文档校验、工具链、工作目录、未保存缓冲区临时文件。
 * @returns {null|object} 失败返回 null
 */
async function prepareXvlogRun(document, ctx) {
    const { vscode, channel, isVerilogDocument } = ctx;
    if (!isVerilogDocument(document) || document.uri.scheme !== 'file') return null;

    let binDir;
    try {
        binDir = resolveXvlogBinDir(vscode.workspace.getConfiguration('svtools.vivado').get('path'));
    } catch (err) {
        channel.appendLine(`[lint] xvlog 工具链不可用：${err.message}`);
        if (ctx.showToolchainError) ctx.showToolchainError(err.message, 'svtools.vivado.path');
        return null;
    }

    const filePath = document.uri.fsPath;

    // 工作目录固定在 <ws>/.svtools/xvlog：xsim.dir 增量缓存落这里，重复 lint 只重编改动文件
    const wf = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const workDir = path.join(wf ? wf.uri.fsPath : os.tmpdir(), '.svtools', 'xvlog');
    try { fs.mkdirSync(workDir, { recursive: true }); } catch (err) {
        channel.appendLine(`[lint] 创建工作目录失败：${err.message}`);
        return null;
    }

    // 未保存缓冲区 → 临时文件（保持扩展名，xvlog 按扩展名选语言）
    let lintTarget = filePath;
    let tempFile = null;
    if (document.isDirty) {
        const hash = crypto.createHash('md5').update(document.uri.toString()).digest('hex').slice(0, 10);
        tempFile = path.join(os.tmpdir(), `svtools-xvlog-${hash}${path.extname(filePath)}`);
        try {
            fs.writeFileSync(tempFile, document.getText());
            lintTarget = tempFile;
        } catch (err) {
            channel.appendLine(`[lint] 写入临时文件失败，回退用磁盘内容：${err.message}`);
            tempFile = null;
        }
    }

    return {
        binDir, workDir, filePath, lintTarget, tempFile,
        collect: (raw) => parseVivadoDiagnostics(tempFile ? raw.split(tempFile).join(filePath) : raw, workDir, filePath),
        cleanup: () => { if (tempFile) { try { fs.unlinkSync(tempFile); } catch (e) { /* 忽略 */ } } },
        stale: () => !!(ctx.lintGenerations && ctx.lintGenerations.get(document.uri.toString()) !== ctx.gen)
    };
}

/** 摘要取当前文件视角（其他文件的诊断照常进面板，不计入 ok）。 */
function summarize(findings, filePath) {
    const main = findings.filter(f => path.normalize(f.file) === path.normalize(filePath));
    const errorCount = main.filter(f => f.severity === 'error').length;
    return { ok: errorCount === 0, errorCount, warningCount: main.length - errorCount };
}

/**
 * xvlog lint 主流程（自动触发：防抖/打开/保存）。
 * svtools.lint.currentFileOnly（默认开）时只编译当前文件——快速、
 * 诊断不外溢到工作区其他文件；关闭后附带工作区模块索引跨文件解析。
 */
async function lintWithXvlog(document, ctx) {
    const empty = { ok: true, errorCount: 0, warningCount: 0 };
    const { vscode, channel, applyDiagnostics, scanWorkspaceSources } = ctx;
    const prep = await prepareXvlogRun(document, ctx);
    if (!prep) return empty;
    const { binDir, workDir, filePath, lintTarget, collect, cleanup, stale } = prep;
    const startedAt = Date.now();

    const fileOnly = vscode.workspace.getConfiguration('svtools.lint').get('currentFileOnly', true);
    let files = [lintTarget];
    if (!fileOnly) {
        try {
            const scan = await scanWorkspaceSources();
            const extra = [...scan.modules.values()].filter(f => path.normalize(f) !== path.normalize(lintTarget));
            files = [lintTarget, ...extra];
        } catch (err) { /* 扫描失败只检查当前文件 */ }
    }

    const prjFile = path.join(workDir, 'svtools.prj');
    try { fs.writeFileSync(prjFile, buildPrjBody(files)); } catch (err) {
        channel.appendLine(`[lint] 写入 prj 失败：${err.message}`);
        cleanup();
        return empty;
    }

    const xv = await runVivadoTool(binDir, 'xvlog', ['--nolog', '--incr', '-prj', 'svtools.prj'], workDir, 120000);
    cleanup();
    if (stale()) return empty;

    const findings = collect(`${xv.stderr}\n${xv.stdout}`);
    applyDiagnostics(document, findings, 'xvlog');
    const summary = summarize(findings, filePath);
    channel.appendLine(`[lint:xvlog] ${path.basename(filePath)}${document.isDirty ? '（缓冲区）' : ''} → ${summary.errorCount} 错误, ${summary.warningCount} 警告 (${Date.now() - startedAt}ms)`);
    return summary;
}

/**
 * xelab 详细化检查（手动触发：状态栏按钮）。
 * 从当前文件出发做依赖迭代解析：xvlog 编译 → xelab → 报缺模块则按工作区
 * 模块索引补文件重试（≤4 轮）。不预先编入整个工作区——任一无关文件有语法
 * 错都会使 xvlog 中止且 xsim.dir 库不完整，导致 xelab 对当前文件误报。
 */
async function elaborateWithXvlog(document, ctx) {
    const empty = { ok: true, errorCount: 0, warningCount: 0 };
    const { channel, applyDiagnostics, scanWorkspaceSources } = ctx;
    const prep = await prepareXvlogRun(document, ctx);
    if (!prep) return empty;
    const { binDir, workDir, filePath, lintTarget, collect, cleanup, stale } = prep;
    const startedAt = Date.now();

    const top = require('./vivado/tclgen').firstModuleName(document.getText());
    const prjFile = path.join(workDir, 'svtools.prj');

    let modules = new Map();
    try { modules = (await scanWorkspaceSources()).modules; } catch (err) { /* 索引不可用则无法补依赖 */ }

    let files = [lintTarget];
    let findings = [];
    let rounds = 0;
    for (; rounds < 4; rounds++) {
        try { fs.writeFileSync(prjFile, buildPrjBody(files)); } catch (err) {
            channel.appendLine(`[lint] 写入 prj 失败：${err.message}`);
            cleanup();
            return empty;
        }
        // 全量编译（无 --incr）：本轮文件集必须全部通过，库才完整
        const xv = await runVivadoTool(binDir, 'xvlog', ['--nolog', '-prj', 'svtools.prj'], workDir, 120000);
        if (stale()) { cleanup(); return empty; }
        findings = collect(`${xv.stderr}\n${xv.stdout}`);
        if (xv.code !== 0) break;   // 文件集有语法错（当前文件或补入的依赖）——如实报告
        if (!top) break;            // 当前文件无 module 声明，无法详细化

        const xe = await runVivadoTool(binDir, 'xelab',
            ['--nolog', '--snapshot', 'svtools_lint', 'work.' + top], workDir, 120000);
        if (stale()) { cleanup(); return empty; }
        const xeRaw = `${xe.stderr}\n${xe.stdout}`;
        findings = findings.concat(collect(xeRaw));

        const missing = [...xeRaw.matchAll(/Module <([A-Za-z_][A-Za-z0-9_$]*)> not found/g)].map(m => m[1]);
        if (!missing.length) break;
        const additions = [];
        for (const name of missing) {
            const f = modules.get(name);
            if (f && !files.some(x => path.normalize(x) === path.normalize(f))) additions.push(f);
        }
        if (!additions.length) break;   // 工作区索引也找不到——保留 missing 诊断
        files.push(...additions);
        findings = [];                  // 中间轮诊断丢弃，取收敛后的最终结果
    }
    cleanup();

    applyDiagnostics(document, findings, 'xvlog');
    const summary = summarize(findings, filePath);
    channel.appendLine(`[lint:xvlog+xelab] ${path.basename(filePath)}${document.isDirty ? '（缓冲区）' : ''} → ${summary.errorCount} 错误, ${summary.warningCount} 警告，依赖文件 ${files.length} 个 (${Date.now() - startedAt}ms)`);
    return summary;
}

module.exports = {
    lintWithXvlog,
    elaborateWithXvlog,
    resetXvlogCache,
    resolveXvlogBinDir,
    parseVivadoDiagnostics,
    buildPrjBody
};
