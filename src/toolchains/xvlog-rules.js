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
const fs = require('fs');
const path = require('path');
const { findVivadoBinDir } = require('../vivado/toolchain');

let cachedBinDir = null;
let probeFailure = null;
let cachedConfig = null;

function resetXvlogCache() {
    cachedBinDir = null;
    probeFailure = null;
    cachedConfig = null;
}

/** 定位含 xvlog/xelab 的 Vivado bin 目录（vivado.path → XILINX_VIVADO → PATH → 常见位置）。 */
function resolveXvlogBinDir(configuredPath) {
    const key = String(configuredPath || "");
    if (key !== cachedConfig) { resetXvlogCache(); cachedConfig = key; }
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

module.exports = { resetXvlogCache, resolveXvlogBinDir, parseVivadoDiagnostics, buildPrjBody, detectUvmUsage, findUvmIncludeDir, extractMissingUnits, resolveUnitFiles };
