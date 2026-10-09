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
    // runtime 空串 → 'all'（run all 跑到 $finish）；未传时保持 1000ns 兼容
    const rt = (o.runtime === undefined || o.runtime === null) ? '1000ns'
        : (String(o.runtime) === '' ? 'all' : String(o.runtime));
    // 默认生成的 <top>.tcl 先做 wave 配置（add_wave）再 run——模块只有不可
    // trace 的对象（如动态数组，xsim 不支持 trace 动态类型）时脚本在 wave
    // 块中断，run all 永不执行、$display 无输出。用 custom_tcl 换成只含
    // run 的最小脚本；结束后 reset 属性，不影响用户手动 launch_simulation
    L.push('set xsimTcl [file join [file dirname [info script]] xsim_run.tcl]');
    L.push('set fh [open $xsimTcl w]');
    L.push('puts $fh "run ' + tclQuote(rt) + '"');
    L.push('puts $fh "quit"');
    L.push('close $fh');
    L.push('set_property -name {xsim.simulate.custom_tcl} -value $xsimTcl -objects [get_filesets sim_1]');
    L.push('launch_simulation');
    L.push('catch { reset_property xsim.simulate.custom_tcl [get_filesets sim_1] }');
    L.push('puts "SVTOOLS_SIM_DONE"');
    return L.filter(Boolean).join('\n') + '\n';
}

/**
 * 生成 OOC 综合报告 TCL：read_verilog → synth_design（out_of_context）→
 * 分层资源占用（report_utilization -hierarchical）+ 逻辑级数分布
 * （report_design_analysis -logic_level_distribution，无约束 OOC 设计可用）。
 * 不打开/修改任何 .xpr 工程。2022.1 实测两命令均支持；report_logic_levels
 * 命令不存在（更早版本移除/更晚引入），-hierarchical 与 -logic_level_distribution
 * 不能同用。
 * flatten：'none'（默认，保留模块边界——可看子模块分摊，代价是禁跨边界优化）
 * 或 'full'（Vivado 默认，跨模块边界优化——资源/时序最优，层次被展平）。
 * 两档都保持 -mode out_of_context，对比时只差 flatten 一个变量。
 * @param {{files: string[], includeDirs: string[], top: string, part: string, outDir: string, isSv?: boolean, flatten?: 'none'|'full'}} o
 */
function buildOocReportsScript(o) {
    const L = [
        '# 由 svtools 生成的 OOC 综合报告脚本（不修改任何工程）',
        'set outDir ' + tclQuote(o.outDir),
        'file mkdir $outDir',
        // include 目录必须挂在 synth_design 上（2022.1 实测 read_verilog 无
        // -include_dirs 选项、include 由综合器解析；`include 相对本文件目录仍自动生效）
        'read_verilog ' + (o.isSv === false ? '' : '-sv ') + tclList(o.files),
        'synth_design -top ' + tclQuote(o.top) + ' -part ' + tclQuote(o.part)
            + ' -mode out_of_context -flatten_hierarchy ' + (o.flatten === 'full' ? 'full' : 'none')
            + ' -include_dirs ' + tclList(o.includeDirs || []),
        'report_utilization -hierarchical -file $outDir/utilization_hier.rpt',
        'report_design_analysis -logic_level_distribution -file $outDir/logic_levels.rpt',
        'puts "SVTOOLS_OOC_DONE"'
    ];
    return L.join('\n') + '\n';
}

/**
 * 解析 report_utilization -hierarchical 的表格为摘要行。
 * 表列：Instance | Module | Total LUTs | Logic LUTs | LUTRAMs | SRLs | FFs | RAMB36 | RAMB18 | DSP Blocks
 * @param {string} rptText 报告全文
 * @returns {string[]} 每个实例一行摘要
 */
function parseUtilHierSummary(rptText) {
    const rows = [];
    for (const line of String(rptText).split(/\r?\n/)) {
        const m = line.match(/^\|(.+)\|\s*$/);
        if (!m) continue;
        const cells = m[1].split('|').map(c => c.trim());
        if (cells.length < 10 || cells[0] === 'Instance' || /^-+$/.test(cells[0])) continue;
        const [inst, mod, lut, , , , ff, b36, b18, dsp] = cells;
        if (!/^\d+$/.test(lut)) continue;   // 跳过非数据行
        // 形如 "(mytop)" 的行 = 顶层模块自身逻辑（不含子实例）；首行 = 全设计合计
        const self = inst.match(/^\((.+)\)$/);
        const label = self ? self[1] + ' 自身' : inst + (mod === '(top)' ? ' (top)' : '');
        rows.push(`${label}: LUT ${lut} | FF ${ff} | BRAM36/18 ${b36}/${b18} | DSP ${dsp}`);
    }
    return rows;
}

/**
 * 解析 report_design_analysis -logic_level_distribution 的分布表为摘要。
 * 表列：End Point Clock | Requirement | 0 | 1 | 2 | …（列名即级数）
 * @param {string} rptText 报告全文
 * @returns {string} 摘要行（无数据时返回提示）
 */
function parseLogicLevelSummary(rptText) {
    const lines = String(rptText).split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/^\|(.+)\|\s*$/);
        if (!m) continue;
        const cells = m[1].split('|').map(c => c.trim());
        if (cells.length < 3 || cells[0] === 'End Point Clock' || /^-+$/.test(cells[0])) continue;
        if (!/^\d+$/.test(cells[2])) continue;   // 数据行：第 3 列起是各级计数
        const dist = [];
        for (let i = 2; i < cells.length; i++) dist.push(`${i - 2} 级=${cells[i]}`);
        return `逻辑级数分布（时钟 ${cells[0]}，Top 路径）: ${dist.join(', ')}`;
    }
    return '逻辑级数分布: 无时序路径数据';
}

module.exports = {
    tclQuote, tclList,
    buildCreateProjectScript, buildAddFilesScript, buildRemoveFilesScript, buildSimulateScript,
    buildOocReportsScript, parseUtilHierSummary, parseLogicLevelSummary,
    extractVivadoIssues, firstModuleName
};
