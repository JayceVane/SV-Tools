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
        // 超时必须按进程树杀：Windows 上只 kill() 会只杀掉 cmd.exe 壳，
        // xvlog/xelab 本体孤儿化继续占用 xsim.dir 库
        const timer = setTimeout(() => {
            if (process.platform === 'win32' && child.pid) {
                try {
                    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
                } catch (e) { try { child.kill(); } catch (e2) { /* 忽略 */ } }
            } else {
                try { child.kill(); } catch (e) { /* 忽略 */ }
            }
        }, timeoutMs || 120000);
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
 * 位置后缀 [file:line(:col)]；XSIM 系列把位置写在消息体内
 * （`File "path" Line 41 :` / `File : path, Line : 25994,`）也一并解析；
 * 两种都没有的 ERROR/WARNING 归到主文件第 1 行。
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
        // XSIM 消息体内嵌位置：File "D:/a.sv" Line 41 : / File : /d/a.sv, Line : 41,
        const embedded = loc ? null : rest.match(/File\s+(?:"([^"]+)"|:\s*([^,]+?))\s*,?\s*Line\s+:?\s*(\d+)/);
        let file = mainFile;
        let lineNo = 1;
        let message;
        if (loc) {
            const p = loc[1].replace(/\\/g, '/').replace(/\/$/, '');
            file = path.isAbsolute(p) ? p : path.resolve(cwd, p);
            lineNo = parseInt(loc[2], 10) || 1;
            message = rest.slice(0, loc.index).trim();
        } else if (embedded) {
            const p = (embedded[1] || embedded[2] || '').trim().replace(/\\/g, '/');
            if (path.isAbsolute(p)) file = p;
            lineNo = parseInt(embedded[3], 10) || 1;
            message = rest.trim();
        } else {
            message = rest.trim();
        }
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

/** 当前文件是否用到了 UVM（uvm_pkg/uvm_config_db/`uvm_* 宏/uvm_macros.svh 均命中）。 */
function detectUvmUsage(text) {
    return /\buvm_[a-z0-9_]+/i.test(String(text));
}

/**
 * 查找 Vivado 自带 UVM 源码目录（uvm_macros.svh 所在），供 xvlog -i 使用。
 * 不同版本安装布局不同（2022.1 是 data/system_verilog/uvm_1.2），逐个探测。
 * @param {string} binDir Vivado bin 目录
 * @returns {string|null} 找不到返回 null（此时不加 -i，`include "uvm_macros.svh" 会失败）
 */
function findUvmIncludeDir(binDir) {
    const root = path.resolve(binDir, '..');
    const candidates = [
        path.join(root, 'data', 'system_verilog', 'uvm_1.2'),
        path.join(root, 'data', 'system_verilog', 'uvm'),
        path.join(root, 'data', 'systemverilog', 'uvm')
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'uvm_macros.svh'))) return c;
    }
    return null;
}

/**
 * 从 xvlog/xelab 输出提取未解析的设计单元名：
 * - 实例化/例化目标缺失：`Module <apb_if> not found while processing ...`（VRFC 10-2063）
 * - import/类型引用未声明：`'apb_uvm_pkg' is not declared`（VRFC 10-2989）
 * 返回名字集合，由调用方按索引过滤（真实拼写错误的标识符查不到定义，自然落空）。
 */
function extractMissingUnits(raw) {
    const names = new Set();
    const text = String(raw);
    for (const m of text.matchAll(/Module <([A-Za-z_][A-Za-z0-9_$]*)> not found/g)) names.add(m[1]);
    for (const m of text.matchAll(/'([A-Za-z_][A-Za-z0-9_$]*)' is not declared/g)) names.add(m[1]);
    return names;
}

/**
 * 把缺失单元名映射为索引中的定义文件，排除已参与编译的。
 * @param {Set<string>} names extractMissingUnits 的结果
 * @param {Map<string, string>} unitIndex 设计单元名 → 文件路径
 * @param {string[]} files 当前文件集（绝对路径）
 * @returns {string[]} 需要补入的文件
 */
function resolveUnitFiles(names, unitIndex, files) {
    const additions = [];
    for (const name of names) {
        const f = unitIndex && unitIndex.get(name);
        if (f && !files.some(x => path.normalize(x) === path.normalize(f))) additions.push(f);
    }
    return additions;
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

    // UVM 工程：xvlog/xelab 需显式挂预编译 UVM 库（-L UVM，否则
    // 'uvm_pkg'/'uvm_config_db' is not declared，VRFC 10-2989）；编译还需
    // -i 指向自带 UVM 源码目录，`include "uvm_macros.svh" 才能解析；
    // xelab 需 --timescale 兜底——UVM 库全库无 `timescale，与带 timescale
    // 的用户代码混合细化会报 XSIM 43-4100（工程流由 Vivado 默认注入）。
    // 检测基于当前文件——elaborate 补入的工作区依赖文件不参与检测。
    let uvmLibArgs = [];
    let uvmIncArgs = [];
    let uvmTimescale = null;
    if (detectUvmUsage(document.getText())) {
        uvmLibArgs = ['-L', 'UVM'];
        const uvmInc = findUvmIncludeDir(binDir);
        if (uvmInc) uvmIncArgs = ['-i', uvmInc];
        const ts = String(document.getText()).match(/`timescale\s+([0-9.]+[munpf]?s\s*\/\s*[0-9.]+[munpf]?s)/i);
        uvmTimescale = ts ? ts[1].replace(/\s+/g, '') : '1ns/1ps';
        channel.appendLine('[lint] 检测到 UVM：附加 -L UVM'
            + (uvmIncArgs.length ? ' -i <uvm 源码目录>' : '')
            + `（xelab --timescale ${uvmTimescale}）`);
    }

    return {
        binDir, workDir, filePath, lintTarget, tempFile, uvmLibArgs, uvmIncArgs, uvmTimescale,
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
 * 两种模式下，当前文件引用了本工作区定义的 module/interface/package 而
 * 编译报「not found / not declared」时，自动补入定义文件重试（≤3 轮），
 * 避免把跨文件引用误报成语法错；--incr 下补入文件只在首次真正编译。
 */
async function lintWithXvlog(document, ctx) {
    const empty = { ok: true, errorCount: 0, warningCount: 0 };
    const { vscode, channel, applyDiagnostics, scanWorkspaceSources } = ctx;
    const prep = await prepareXvlogRun(document, ctx);
    if (!prep) return empty;
    const { binDir, workDir, filePath, lintTarget, collect, cleanup, stale, uvmLibArgs, uvmIncArgs } = prep;
    const startedAt = Date.now();

    const fileOnly = vscode.workspace.getConfiguration('svtools.lint').get('currentFileOnly', true);
    // xvlog 按 prj 顺序分析：import 的 package 必须排在 importer 之前，
    // 因此当前文件始终放最后、补入的依赖 prepend 到最前
    let files = [lintTarget];
    if (!fileOnly) {
        try {
            const scan = await scanWorkspaceSources();
            const extra = [...scan.modules.values()].filter(f => path.normalize(f) !== path.normalize(lintTarget));
            files = [...extra, lintTarget];
        } catch (err) { /* 扫描失败只检查当前文件 */ }
    }

    const prjFile = path.join(workDir, 'svtools.prj');
    let unitIndex = null;   // 惰性获取：只有报缺单元时才查索引
    let xv = null;
    for (let round = 0; round <= 3; round++) {
        try { fs.writeFileSync(prjFile, buildPrjBody(files)); } catch (err) {
            channel.appendLine(`[lint] 写入 prj 失败：${err.message}`);
            cleanup();
            return empty;
        }
        xv = await runVivadoTool(binDir, 'xvlog', ['--nolog', ...uvmLibArgs, ...uvmIncArgs, '--incr', '-prj', 'svtools.prj'], workDir, 120000);
        if (stale()) { cleanup(); return empty; }
        if (xv.code === 0) break;
        const raw = `${xv.stderr}\n${xv.stdout}`;
        if (!unitIndex) {
            try { unitIndex = (await scanWorkspaceSources()).modules; } catch (err) { unitIndex = new Map(); }
        }
        const additions = resolveUnitFiles(extractMissingUnits(raw), unitIndex, files);
        if (!additions.length) break;   // 真实语法错——如实报告
        channel.appendLine(`[lint] 补入缺失依赖：${additions.map(f => path.basename(f)).join(', ')}`);
        files.unshift(...additions);
    }
    cleanup();

    const findings = collect(`${xv.stderr}\n${xv.stdout}`);
    applyDiagnostics(document, findings, 'xvlog');
    const summary = summarize(findings, filePath);
    channel.appendLine(`[lint:xvlog] ${path.basename(filePath)}${document.isDirty ? '（缓冲区）' : ''} → ${summary.errorCount} 错误, ${summary.warningCount} 警告，编译 ${files.length} 个文件 (${Date.now() - startedAt}ms)`);
    return summary;
}

/**
 * xelab 详细化检查（手动触发：状态栏按钮）。
 * 从当前文件出发做依赖迭代解析：xvlog 编译 → xelab → 报缺单元（module/
 * interface/package）则按工作区设计单元索引补文件重试（≤6 轮，xvlog 与
 * xelab 阶段的缺失都驱动迭代）。不预先编入整个工作区——任一无关文件有
 * 语法错都会使 xvlog 中止且 xsim.dir 库不完整，导致 xelab 对当前文件误报。
 */
async function elaborateWithXvlog(document, ctx) {
    const empty = { ok: true, errorCount: 0, warningCount: 0 };
    const { channel, applyDiagnostics, scanWorkspaceSources } = ctx;
    const prep = await prepareXvlogRun(document, ctx);
    if (!prep) return empty;
    const { binDir, workDir, filePath, lintTarget, collect, cleanup, stale, uvmLibArgs, uvmIncArgs, uvmTimescale } = prep;
    const startedAt = Date.now();

    const top = require('./vivado/tclgen').firstModuleName(document.getText());
    const prjFile = path.join(workDir, 'svtools.prj');

    let modules = new Map();
    try { modules = (await scanWorkspaceSources()).modules; } catch (err) { /* 索引不可用则无法补依赖 */ }

    let files = [lintTarget];
    let findings = [];
    let rounds = 0;
    for (; rounds < 6; rounds++) {
        try { fs.writeFileSync(prjFile, buildPrjBody(files)); } catch (err) {
            channel.appendLine(`[lint] 写入 prj 失败：${err.message}`);
            cleanup();
            return empty;
        }
        // 全量编译（无 --incr）：本轮文件集必须全部通过，库才完整
        const xv = await runVivadoTool(binDir, 'xvlog', ['--nolog', ...uvmLibArgs, ...uvmIncArgs, '-prj', 'svtools.prj'], workDir, 120000);
        if (stale()) { cleanup(); return empty; }
        const xvRaw = `${xv.stderr}\n${xv.stdout}`;
        findings = collect(xvRaw);
        if (xv.code !== 0) {
            // xvlog 阶段也会缺依赖：import 本工作区 package（'X' is not declared）、
            // 实例化本工作区 interface/module（Module <X> not found）——先补齐再试
            const additions = resolveUnitFiles(extractMissingUnits(xvRaw), modules, files);
            if (!additions.length) break;   // 真实语法错（当前文件或依赖）——如实报告
            channel.appendLine(`[lint] 补入缺失依赖：${additions.map(f => path.basename(f)).join(', ')}`);
            files.unshift(...additions);    // 依赖必须在 importer 之前分析
            findings = [];
            continue;
        }
        if (!top) break;            // 当前文件无 module 声明，无法详细化

        const xe = await runVivadoTool(binDir, 'xelab',
            ['--nolog', '--snapshot', 'svtools_lint', ...uvmLibArgs,
             ...(uvmTimescale ? ['--timescale', uvmTimescale] : []), 'work.' + top], workDir, 120000);
        if (stale()) { cleanup(); return empty; }
        const xeRaw = `${xe.stderr}\n${xe.stdout}`;
        findings = findings.concat(collect(xeRaw));

        const additions = resolveUnitFiles(extractMissingUnits(xeRaw), modules, files);
        if (!additions.length) break;   // 无缺失或索引也找不到——保留当前诊断
        files.unshift(...additions);    // 依赖必须在 importer 之前分析
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
    buildPrjBody,
    extractMissingUnits,
    resolveUnitFiles,
    detectUvmUsage,
    findUvmIncludeDir
};
