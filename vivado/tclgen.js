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
// TCL 语法转义与各类 Vivado 脚本生成（纯函数，不依赖 vscode）。

const path = require('path');

/** TCL 列表元素转义：路径统一转 / 后按需加花括号（braced word 内 \ 为字面量，不安全故先消除）。 */
function tclQuote(value) {
    const s = String(value).replace(/\\/g, '/');
    if (s === '') return '{}';
    if (!/[\s{}[\]$"'\\/;#]/.test(s)) return s;
    if (!/[{}]/.test(s)) return '{' + s + '}';
    return '"' + s.replace(/([\\$"[\]])/g, '\\$1') + '"'; // 含花括号的罕见情况退化为双引号+转义
}

/** 多元素 TCL 列表：{a b c}。 */
function tclList(items) {
    return '[list ' + (items || []).map(i => tclQuote(i)).join(' ') + ']';
}

/**
 * 生成 create_project TCL 脚本文本。
 * @param {{name:string, dir:string, part:string, sources:string[], sims:string[], constraints:string[], top:string, simTop:string}} o
 */
function buildCreateProjectScript(o) {
    const L = [];
    L.push('# 由 svtools (VSCode 扩展) 生成的 Vivado 工程创建脚本');
    L.push('# 工程名: ' + o.name + (o.part ? '，器件: ' + o.part : '（未指定 -part，在 Vivado 中手动选择）'));
    L.push('');
    L.push('set prj_dir ' + tclQuote(o.dir));
    L.push('');
    L.push('if {[file exists $prj_dir/' + o.name + '.xpr]} {');
    L.push('    # 已存在同名工程则直接打开，避免重复创建');
    L.push('    open_project $prj_dir/' + o.name + '.xpr');
    L.push('} else {');
    L.push('    create_project ' + tclQuote(o.name) + ' $prj_dir' + (o.part ? ' -part ' + tclQuote(o.part) : ''));
    (o.sources || []).forEach(f => L.push('    add_files -fileset sources_1 ' + tclQuote(f)));
    (o.constraints || []).forEach(f => L.push('    add_files -fileset constrs_1 ' + tclQuote(f)));
    (o.sims || []).forEach(f => L.push('    add_files -fileset sim_1 ' + tclQuote(f)));
    L.push('    # .sv 文件显式标记 file_type（Vivado 有时按扩展名识别不全）');
    L.push('    foreach f [get_files -of [get_filesets sources_1]] {');
    L.push('        if {[string match -nocase *.sv $f]} { set_property file_type SystemVerilog $f }');
    L.push('    }');
    L.push('    foreach f [get_files -of [get_filesets sim_1]] {');
    L.push('        if {[string match -nocase *.sv $f]} { set_property file_type SystemVerilog $f }');
    L.push('    }');
    if (o.top) L.push('    set_property top ' + tclQuote(o.top) + ' [get_filesets sources_1]');
    if (o.simTop) L.push('    set_property top ' + tclQuote(o.simTop) + ' [get_filesets sim_1]');
    L.push('    update_compile_order -fileset sources_1');
    L.push('    update_compile_order -fileset sim_1');
    L.push('}');
    L.push('');
    L.push('puts "SVTOOLS_PROJECT_READY"');
    return L.join('\n') + '\n';
}

/** 从 batch 输出提取错误/严重警告行（供通道摘要）。 */
function extractVivadoIssues(lines) {
    const issues = [];
    String(lines).split(/\r?\n/).forEach(line => {
        const m = line.match(/^(ERROR|CRITICAL WARNING):\s*(.*)$/);
        if (m) issues.push({ level: m[1], text: m[2].slice(0, 300) });
    });
    return issues.slice(0, 50);
}

/** 取文件中第一个 module 声明的模块名（无则空串）。 */
function firstModuleName(text) {
    const m = String(text || '').match(/\bmodule\s+([A-Za-z_][A-Za-z0-9_]*)/);
    return m ? m[1] : '';
}

function buildAddFilesScript(xprPath, file, fileset, isSv) {
    return [
        'open_project ' + tclQuote(xprPath),
        'set fs [get_filesets ' + tclQuote(fileset) + ']',
        'set f ' + tclQuote(file),
        'if {[llength [get_files -quiet -of $fs $f]] == 0} {',
        '    add_files -fileset $fs $f',
        '    puts "SVTOOLS_ADDED $f"',
        '} else {',
        '    puts "SVTOOLS_ALREADY_IN $f"',
        '}',
        isSv ? 'catch { set_property file_type SystemVerilog [get_files -of $fs $f] }' : '',
        'update_compile_order -fileset $fs',
        'puts "SVTOOLS_DONE"'
    ].filter(Boolean).join('\n') + '\n';
}

/** 生成"把文件移出工程（按文件名在指定文件集内匹配）"的增量 TCL。 */
function buildRemoveFilesScript(xprPath, file, fileset) {
    const base = path.basename(String(file));
    return [
        'open_project ' + tclQuote(xprPath),
        'set fs [get_filesets ' + tclQuote(fileset) + ']',
        'set removed 0',
        'foreach f [get_files -quiet -of $fs] {',
        '    if {[string match -nocase *' + base.replace(/[\\{}$"]/g, '') + ' $f]} {',
        '        remove_files $f',
        '        set removed 1',
        '    }',
        '}',
        'puts [expr {$removed ? "SVTOOLS_REMOVED" : "SVTOOLS_NOT_IN_PRJ"}]',
        'puts "SVTOOLS_DONE"'
    ].join('\n') + '\n';
}

/**
 * 生成 xsim 行为仿真 TCL：打开工程（缺文件先补入）→ 当前文件模块置为 sim_1 顶层 → launch_simulation。
 * @param {{xprPath:string, top:string, file:string, isSv:boolean, runtime:string}} o
 */
function buildSimulateScript(o) {
    const L = [
        'open_project ' + tclQuote(o.xprPath),
        'set fs [get_filesets sim_1]',
        'set f ' + tclQuote(o.file)
    ];
    if (o.file) {
        L.push('if {[llength [get_files -quiet -of $fs $f]] == 0} {');
        L.push('    add_files -fileset $fs $f');
        L.push(o.isSv ? '    catch { set_property file_type SystemVerilog [get_files -of $fs $f] }' : '');
        L.push('}');
    }
    if (o.top) {
        L.push('set_property top ' + tclQuote(o.top) + ' [get_filesets sim_1]');
        L.push('update_compile_order -fileset sim_1');
    }
    L.push('set_property -name {xsim.simulate.runtime} -value ' + tclQuote(o.runtime || '1000ns') + ' -objects [get_filesets sim_1]');
    L.push('launch_simulation');
    L.push('puts "SVTOOLS_SIM_DONE"');
    return L.filter(Boolean).join('\n') + '\n';
}

module.exports = {
    tclQuote, tclList,
    buildCreateProjectScript, buildAddFilesScript, buildRemoveFilesScript, buildSimulateScript,
    extractVivadoIssues, firstModuleName
};
