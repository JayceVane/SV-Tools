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
// Vivado xvlog/xelab lint 引擎（svtools.lint.engine = "xvlog"）。
// xvlog 只做语法/静态分析；svtools.lint.elaborate 开启时在 xvlog 通过后
// 追加 xelab 详细化（类型/端口/位宽等深度检查）。

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
 * xvlog（可选 xelab）lint 主流程。
 * @param {object} document vscode.TextDocument
 * @param {object} ctx { vscode, channel, applyDiagnostics, isVerilogDocument,
 *                       scanWorkspaceSources, lintGenerations }
 */
async function lintWithXvlog(document, ctx) {
    const empty = { ok: true, errorCount: 0, warningCount: 0 };
    const { vscode, channel, applyDiagnostics, isVerilogDocument, scanWorkspaceSources } = ctx;
    if (!isVerilogDocument(document) || document.uri.scheme !== 'file') return empty;

    let binDir;
    try {
        binDir = resolveXvlogBinDir(vscode.workspace.getConfiguration('svtools.vivado').get('path'));
    } catch (err) {
        channel.appendLine(`[lint] xvlog 工具链不可用：${err.message}`);
        if (ctx.showToolchainError) ctx.showToolchainError(err.message, 'svtools.vivado.path');
        return empty;
    }

    const filePath = document.uri.fsPath;
    const startedAt = Date.now();

    // 工作目录固定在 <ws>/.svtools/xvlog：xsim.dir 增量缓存落这里，重复 lint 只重编改动文件
    const wf = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const workDir = path.join(wf ? wf.uri.fsPath : os.tmpdir(), '.svtools', 'xvlog');
    try { fs.mkdirSync(workDir, { recursive: true }); } catch (err) {
        channel.appendLine(`[lint] 创建工作目录失败：${err.message}`);
        return empty;
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

    // 文件集：当前文件 + 工作区模块索引（跨文件定义），当前文件排最前
    let files = [lintTarget];
    try {
        const scan = await scanWorkspaceSources();
        const extra = [...scan.modules.values()].filter(f => path.normalize(f) !== path.normalize(lintTarget));
        files = [lintTarget, ...extra];
    } catch (err) { /* 扫描失败只 lint 当前文件 */ }

    const prjFile = path.join(workDir, 'svtools.prj');
    try { fs.writeFileSync(prjFile, buildPrjBody(files)); } catch (err) {
        channel.appendLine(`[lint] 写入 prj 失败：${err.message}`);
        if (tempFile) try { fs.unlinkSync(tempFile); } catch (e) { /* 忽略 */ }
        return empty;
    }

    const mapTemp = (raw) => (tempFile ? raw.split(tempFile).join(filePath) : raw);
    const collect = (raw) => parseVivadoDiagnostics(mapTemp(raw), workDir, filePath);
    const summarize = (findings, okByExit) => {
        const errorCount = findings.filter(f => f.severity === 'error').length;
        return {
            ok: okByExit && errorCount === 0,
            errorCount,
            warningCount: findings.length - errorCount
        };
    };

    // 1) xvlog 语法检查
    const xv = await runVivadoTool(binDir, 'xvlog', ['--nolog', '--incr', '-prj', 'svtools.prj'], workDir, 120000);
    if (tempFile) try { fs.unlinkSync(tempFile); } catch (e) { /* 忽略 */ }
    if (ctx.lintGenerations && ctx.lintGenerations.get(document.uri.toString()) !== ctx.gen) return empty;

    let findings = collect(`${xv.stderr}\n${xv.stdout}`);
    let stage = 'xvlog';

    // 2) xelab 详细化检查（xvlog 无 error 时才值得跑；顶层 = 当前文件首个 module）
    if (xv.code === 0 && !findings.some(f => f.severity === 'error')
        && vscode.workspace.getConfiguration('svtools.lint').get('elaborate', false)) {
        const top = require('./vivado/tclgen').firstModuleName(document.getText());
        if (top) {
            const xe = await runVivadoTool(binDir, 'xelab',
                ['--nolog', '--incr', '--snapshot', 'svtools_lint', 'work.' + top], workDir, 120000);
            if (ctx.lintGenerations && ctx.lintGenerations.get(document.uri.toString()) !== ctx.gen) return empty;
            findings = findings.concat(collect(`${xe.stderr}\n${xe.stdout}`));
            stage = 'xvlog+xelab';
        }
    }

    applyDiagnostics(document, findings, 'xvlog');
    const summary = summarize(findings, xv.code === 0);
    channel.appendLine(`[lint:${stage}] ${path.basename(filePath)}${document.isDirty ? '（缓冲区）' : ''} → ${summary.errorCount} 错误, ${summary.warningCount} 警告 (${Date.now() - startedAt}ms)`);
    return summary;
}

module.exports = {
    lintWithXvlog,
    resetXvlogCache,
    resolveXvlogBinDir,
    parseVivadoDiagnostics,
    buildPrjBody
};
