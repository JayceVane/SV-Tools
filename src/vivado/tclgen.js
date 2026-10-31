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
const { maskSourceText } = require('../workspace/sources');

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
    const m = maskSourceText(text || '').match(/\bmodule\s+(?:(?:automatic|static)\s+)?([A-Za-z_][A-Za-z0-9_$]*)/);
    return m ? m[1] : '';
}

/**
 * 工程写操作脚本公共骨架：open_project → body（catch 包裹）→ close_project。
 * - 任何 Tcl 错误 → 打 SVTOOLS_TCL_ERROR 并 exit 1（Vivado batch 对脚本内错误
 *   不可靠，不能只靠退出码判断成败）
 * - 显式 close_project：确保工程态修改写回 .xpr（不等退出时机）
 */
function wrapProjectScript(xprPath, bodyLines) {
    return [
        'if {[catch {',
        '    open_project ' + tclQuote(xprPath),
        ...bodyLines.map(l => '    ' + l),
        '} errMsg]} {',
        '    puts "SVTOOLS_TCL_ERROR $errMsg"',
        '    catch { close_project }',
        '    exit 1',
        '}',
        'close_project',
        'puts "SVTOOLS_DONE"'
    ].join('\n') + '\n';
}

function buildAddFilesScript(xprPath, file, fileset, isSv) {
    return wrapProjectScript(xprPath, [
        'set fs [get_filesets ' + tclQuote(fileset) + ']',
        'set f ' + tclQuote(file),
        'if {[llength [get_files -quiet -of $fs $f]] == 0} {',
        '    add_files -fileset $fs $f',
        '    puts "SVTOOLS_ADDED $f"',
        '} else {',
        '    puts "SVTOOLS_ALREADY_IN $f"',
        '}',
        isSv ? 'catch { set_property file_type SystemVerilog [get_files -of $fs $f] }' : '',
        'update_compile_order -fileset $fs'
    ].filter(Boolean));
}

/**
 * 生成"把文件移出工程"的增量 TCL。按规范化全路径精确匹配（-nocase），
 * 不用 basename 后缀——后缀会误删同名文件，也会在路径形态不一致时静默空转
 * （removed=0 退出码 0，插件侧曾据此误报成功）。
 */
function buildRemoveFilesScript(xprPath, file, fileset) {
    return wrapProjectScript(xprPath, [
        'set fs [get_filesets ' + tclQuote(fileset) + ']',
        'set target [file normalize ' + tclQuote(file) + ']',
        'set removed 0',
        'foreach f [get_files -quiet -of $fs] {',
        '    if {[string equal -nocase [file normalize $f] $target]} {',
        '        remove_files $f',
        '        set removed 1',
        '    }',
        '}',
        'puts [expr {$removed ? "SVTOOLS_REMOVED" : "SVTOOLS_NOT_IN_PRJ"}]'
    ]);
}

/** 批量加入文件：逐文件报告 SVTOOLS_ADDED 或 SVTOOLS_ALREADY_IN，供幂等调用与审计。 */
function buildAddFilesBatchScript({ xprPath, files, fileset }) {
    const body = ['set fs [get_filesets ' + tclQuote(fileset) + ']'];
    for (const file of files) {
        body.push('set f ' + tclQuote(file));
        body.push('if {[llength [get_files -quiet -of $fs $f]] == 0} {');
        body.push('    add_files -fileset $fs $f');
        body.push('    puts "SVTOOLS_ADDED $f"');
        body.push('} else { puts "SVTOOLS_ALREADY_IN $f" }');
        body.push('if {[string match -nocase *.sv $f]} { catch { set_property file_type SystemVerilog [get_files -of $fs $f] } }');
    }
    body.push('update_compile_order -fileset $fs');
    return wrapProjectScript(xprPath, body);
}

/**
 * 生成"设置文件集顶层"TCL（sources_1 → 综合顶层；sim_1 → 仿真顶层）。
 * @param {{xprPath:string, fileset:string, top:string}} o
 */
function buildSetTopScript(o) {
    return wrapProjectScript(o.xprPath, [
        'set_property top ' + tclQuote(o.top) + ' [get_filesets ' + tclQuote(o.fileset) + ']',
        'update_compile_order -fileset ' + tclQuote(o.fileset),
        'puts "SVTOOLS_TOP_SET ' + o.top + '"'
    ]);
}

/**
 * 生成文件集移动事务：先加入并验证目标引用，再移除源；后续失败恢复源引用与常用属性。
 * @param {{xprPath:string, file:string, from:string, to:string, isSv:boolean}} o
 */
function buildMoveFileScript(o) {
    return wrapProjectScript(o.xprPath, [
        'proc svtools_move_member {fileset target} {',
        '    foreach member [get_files -quiet -of_objects $fileset] {',
        '        if {[string equal -nocase [file normalize $member] $target]} { return $member }',
        '    }',
        '    return {}',
        '}',
        'set target [file normalize ' + tclQuote(o.file) + ']',
        'if {![file isfile $target]} { error "Move source is missing or not a regular file; original membership preserved: $target" }',
        'set sourceSet [get_filesets -quiet ' + tclQuote(o.from) + ']',
        'set destinationSet [get_filesets -quiet ' + tclQuote(o.to) + ']',
        'if {[llength $sourceSet] != 1 || [llength $destinationSet] != 1 || $sourceSet eq $destinationSet} { error {Invalid move filesets; original membership preserved} }',
        'set original [svtools_move_member $sourceSet $target]',
        'if {$original eq {}} { error {Move source is no longer a member of the original fileset} }',
        'set properties {}',
        'set available [list_property $original]',
        'foreach property {FILE_TYPE LIBRARY USED_IN IS_GLOBAL_INCLUDE} {',
        '    if {[lsearch -exact $available $property] >= 0} { dict set properties $property [get_property $property $original] }',
        '}',
        'set destinationExisted [expr {[svtools_move_member $destinationSet $target] ne {}}]',
        'if {[catch {',
        '    if {!$destinationExisted} { add_files -fileset $destinationSet $target }',
        '    set destination [svtools_move_member $destinationSet $target]',
        '    if {$destination eq {}} { error {Destination fileset did not retain the file} }',
        '    if {!$destinationExisted} { dict for {property value} $properties { set_property $property $value $destination } }',
        '    update_compile_order -fileset $destinationSet',
        '    remove_files $original',
        '    if {[svtools_move_member $sourceSet $target] ne {}} { error {Source membership was not removed; move is incomplete} }',
        '    update_compile_order -fileset $sourceSet',
        '} moveError]} {',
        '    if {[catch {',
        '        if {[svtools_move_member $sourceSet $target] eq {}} { add_files -fileset $sourceSet $target }',
        '        set restored [svtools_move_member $sourceSet $target]',
        '        if {$restored eq {}} { error {Could not restore original membership} }',
        '        dict for {property value} $properties { set_property $property $value $restored }',
        '        if {!$destinationExisted} {',
        '            set added [svtools_move_member $destinationSet $target]',
        '            if {$added ne {}} { remove_files $added }',
        '        }',
        '    } rollbackError]} { error "Move failed: $moveError; rollback failed: $rollbackError. Check both filesets; existing references were retained where possible." }',
        '    error "Move failed; original membership restored: $moveError"',
        '}',
        'puts "SVTOOLS_MOVED $target"'
    ]);
}

/**
 * 生成"综合 / 布局布线"TCL：launch_runs（impl 自动级联 synth）+ wait_on_run，
 * 结束打印 run 的 STATUS/PROGRESS 供插件判定成败。
 * @param {{xprPath:string, run:'synth_1'|'impl_1', toStep?:string, jobs?:number}} o
 */
function buildLaunchRunScript(o) {
    const step = o.toStep ? ' -to_step ' + o.toStep : '';
    // reset：显式"重新运行"语义（源已变化的已完成run需重置，否则launch_runs拒绝）。
    return [
        'if {[catch {',
        '    open_project ' + tclQuote(o.xprPath),
        '    update_compile_order -fileset sources_1',
        ...(o.reset ? ['    reset_run ' + o.run] : []),
        '    launch_runs ' + o.run + step + ' -jobs ' + (o.jobs || 4),
        '    wait_on_run ' + o.run,
        '    set r [get_runs ' + o.run + ']',
        '    puts "SVTOOLS_RUN_STATUS [get_property STATUS $r] [get_property PROGRESS $r]"',
        '} errMsg]} {',
        '    puts "SVTOOLS_TCL_ERROR $errMsg"',
        '    catch { close_project }',
        '    exit 1',
        '}',
        'close_project',
        'puts "SVTOOLS_DONE"'
    ].join('\n') + '\n';
}

/**
 * 生成"打开已完成的 run 并输出报告"TCL。synth 报告含分层资源 + 逻辑级数；
 * impl 报告含时序汇总 + 资源。run 未完成时 open_run 报错（插件提示先跑）。
 * @param {{xprPath:string, run:'synth_1'|'impl_1', outDir:string, reports?:Array<'utilization'|'logic_levels'|'timing_summary'>}} o
 * reports 缺省 = 该 run 全套；传子集则只生成所选报告（快捷区拆分入口用）。
 */
function buildRunReportsScript(o) {
    const isSynth = o.run === 'synth_1';
    const kinds = o.reports || (isSynth ? ['utilization', 'logic_levels'] : ['utilization', 'timing_summary']);
    const L = [
        'open_project ' + tclQuote(o.xprPath),
        'set outDir ' + tclQuote(o.outDir),
        'file mkdir $outDir',
        'open_run ' + o.run + (isSynth ? ' -name netlist_1' : ' -name impl_1')
    ];
    for (const k of kinds) {
        if (k === 'utilization') {
            // 与 Vivado GUI 对齐：synth/impl 打开设计后的 Utilization 视图都是
            // 分层表（synthesized/implemented design 默认 hierarchical 展示）
            L.push('report_utilization -hierarchical -file $outDir/' + (isSynth ? 'synth_utilization.rpt' : 'impl_utilization.rpt'));
        } else if (k === 'logic_levels') {
            L.push('report_design_analysis -logic_level_distribution -file $outDir/synth_logic_levels.rpt');
        } else if (k === 'timing_summary') {
            L.push('report_timing_summary -file $outDir/timing_summary.rpt');
        }
    }
    L.push('puts "SVTOOLS_REPORTS_DONE"', 'puts "SVTOOLS_DONE"');
    return L.join('\n') + '\n';
}

/**
 * 生成 xsim 行为仿真 TCL：打开工程（缺文件先补入）→ 当前文件模块置为 sim_1 顶层 → launch_simulation。
 * @param {{xprPath:string, top:string, file:string, isSv:boolean, runtime:string,fileset?:string}} o
 */
function buildSimulateScript(o) {
    const L = [
        'open_project ' + tclQuote(o.xprPath),
        'set fs [get_filesets ' + tclQuote(o.fileset || 'sim_1') + ']',
        'set f ' + tclQuote(o.file)
    ];
    if (o.file) {
        L.push('if {[llength [get_files -quiet -of $fs $f]] == 0} {');
        L.push('    add_files -fileset $fs $f');
        L.push(o.isSv ? '    catch { set_property file_type SystemVerilog [get_files -of $fs $f] }' : '');
        L.push('}');
    }
    if (o.top) {
        L.push('set_property top ' + tclQuote(o.top) + ' $fs');
        L.push('update_compile_order -fileset $fs');
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
    L.push('set_property -name {xsim.simulate.custom_tcl} -value $xsimTcl -objects $fs');
    L.push('launch_simulation -simset $fs');
    L.push('catch { reset_property xsim.simulate.custom_tcl $fs }');
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

// 无 tcllib 依赖的单行 JSON 输出：显式构造已序列化片段，避免 Tcl 列表/字典二义性。
// svtText 归一化多元素属性（如时序路径 NAME），svtNumProp 让数值属性保持 JSON number。
const JSON_HELPERS = String.raw`
proc svtStr {s} {
    set map [list "\\" "\\\\" "\"" "\\\"" "\n" "\\n" "\r" "\\r" "\t" "\\t"]
    return "\"[string map $map $s]\""
}
proc svtObj {args} {
    set parts [list]
    foreach {k v} $args { lappend parts "[svtStr $k]:$v" }
    return "{[join $parts ,]}"
}
proc svtArr {items} { return "\[[join $items ,]\]" }
proc svtText {obj prop} {
    if {[catch {get_property $prop $obj} v] || ![string length $v]} { return null }
    return [svtStr [join $v " "]]
}
proc svtNumProp {obj prop} {
    if {[catch {get_property $prop $obj} v] || ![string length $v]} { return null }
    if {[string is double -strict $v]} { return $v }
    return [svtStr [join $v " "]]
}
`;

/** 打开工程输出版本/器件/两种top/全部run状态，供无界面状态查询。 */
function buildVivadoStatusScript({ xprPath }) {
    return JSON_HELPERS + [
        'open_project ' + tclQuote(xprPath),
        'set runs [list]',
        'foreach r [get_runs -quiet] {',
        '    lappend runs [svtObj name [svtText $r NAME] status [svtText $r STATUS] progress [svtText $r PROGRESS]]',
        '}',
        'set tops [svtObj sources [svtText [get_filesets sources_1] TOP] sim [svtText [get_filesets sim_1] TOP]]',
        'puts "SVTOOLS_JSON [svtObj version [svtStr [version -short]] part [svtText [current_project] PART] tops $tops runs [svtArr $runs]]"',
        'close_project',
        'puts "SVTOOLS_DONE"'
    ].join('\n') + '\n';
}

/** 打开指定run并输出结构化时序路径；无路径时保持空数组而不是零错误通过。 */
function buildVivadoTimingScript({ xprPath, run, maxPaths }) {
    return JSON_HELPERS + [
        'open_project ' + tclQuote(xprPath),
        'if {[catch {open_run ' + run + ' -quiet} error]} { puts "SVTOOLS_ERROR [svtStr $error]"; exit 1 }',
        'set items [list]',
        'foreach p [get_timing_paths -max_paths ' + String(Math.max(1, Number(maxPaths) || 10)) + ' -quiet] {',
        '    lappend items [svtObj name [svtText $p NAME] slack [svtNumProp $p SLACK] startpoint [svtText $p STARTPOINT_PIN] endpoint [svtText $p ENDPOINT_PIN] pathgroup [svtText $p PATH_GROUP] logic [svtNumProp $p LOGIC_LEVELS]]',
        '}',
        'puts "SVTOOLS_JSON [svtObj run [svtStr ' + run + '] paths [svtArr $items]]"',
        'close_project',
        'puts "SVTOOLS_DONE"'
    ].join('\n') + '\n';
}

/** 输出分层资源报告的原始文本行，由 parseUtilHierSummary 解析为摘要。 */
function buildVivadoUtilizationScript({ xprPath, run }) {
    return JSON_HELPERS + [
        'open_project ' + tclQuote(xprPath),
        'if {[catch {open_run ' + run + ' -quiet} error]} { puts "SVTOOLS_ERROR [svtStr $error]"; exit 1 }',
        'foreach line [split [report_utilization -hierarchical -return_string -quiet] "\n"] { puts "SVTOOLS_UTIL $line" }',
        'close_project',
        'puts "SVTOOLS_DONE"'
    ].join('\n') + '\n';
}

/** 输出DRC违规对象（名称/规则/严重级别）。2022.1 的 report_drc 无 -format JSON，故统一走 Tcl 对象属性，缺失属性为 null。 */
function buildVivadoDrcScript({ xprPath, run }) {
    return JSON_HELPERS + [
        'open_project ' + tclQuote(xprPath),
        'if {[catch {open_run ' + run + ' -quiet} error]} { puts "SVTOOLS_ERROR [svtStr $error]"; exit 1 }',
        // get_drc_violations 只返回“上一次DRC”的对象；必须先完成本次DRC，否则会静默得到空列表。
        'if {[catch {report_drc -quiet} error]} { puts "SVTOOLS_ERROR [svtStr $error]"; exit 1 }',
        'set items [list]',
        'foreach v [get_drc_violations -quiet] {',
        '    set drcName ""; catch { set drcName [get_property NAME $v] }',
        '    set drcRule ""; catch { set drcRule [get_property RULE $v] }',
        '    if {![string length $drcRule]} { set drcRule [lindex [split $drcName #] 0] }',
        '    lappend items [svtObj name [svtStr $drcName] rule [svtStr $drcRule] severity [svtText $v SEVERITY]]',
        '}',
        'puts "SVTOOLS_JSON [svtObj run [svtStr ' + run + '] checked 1 violations [svtArr $items]]"',
        'close_project',
        'puts "SVTOOLS_DONE"'
    ].join('\n') + '\n';
}

module.exports = {
    tclQuote, tclList, wrapProjectScript,
    buildCreateProjectScript, buildAddFilesScript, buildRemoveFilesScript, buildSimulateScript,
    buildSetTopScript, buildMoveFileScript, buildLaunchRunScript, buildRunReportsScript,
    buildOocReportsScript, parseUtilHierSummary, parseLogicLevelSummary,
    buildVivadoStatusScript, buildVivadoTimingScript, buildVivadoUtilizationScript, buildVivadoDrcScript,
    buildAddFilesBatchScript,
    extractVivadoIssues, firstModuleName
};
