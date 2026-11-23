'use strict';

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
// 复杂 IP 的界面结构由 helper proc、foreach 和字符串生成，静态正则读不全。
// 这里让 Vivado 用桩函数执行 IP 自带的 XGUI Tcl，再回收 ipgui::add_* 的调用序列，
// 并用当前参数值执行 update_PARAM_VALUE.*，得到与 Vivado 一致的可用/禁用状态。
// 执行在独立子解释器内完成，覆盖的 load/package/set_property 不会影响会话本身。

const { readFile, readdir } = require('node:fs/promises');
const path = require('node:path');

const DUMP = `# ---- 捕获 ipgui::add_* 调用 ----
namespace eval ::sv {}
set ::sv::seq 0
set ::sv::nodes [dict create]
set ::sv::order {}
set ::sv::props [dict create]
set ::sv::dir ""
set ::sv::iproot ""
set ::sv::missing [dict create]
set ::sv::values [dict create]
set ::sv::file {__FILE__}
__VALUES__

proc ::sv::token {type} {
    incr ::sv::seq
    return "\${type}#$::sv::seq"
}

proc ::sv::param_name {token} {
    if {[dict exists $::sv::nodes $token]} {
        lassign [dict get $::sv::nodes $token] type parent name widget text
        return $name
    }
    return ""
}

# XGUI 的参数名是混合大小写（Input_Data_Width），update 过程用全大写形式（INPUT_DATA_WIDTH），按大小写不敏感匹配。
proc ::sv::find_param {name} {
    set lower [string tolower $name]
    foreach token $::sv::order {
        if {![dict exists $::sv::nodes $token]} { continue }
        lassign [dict get $::sv::nodes $token] type parent pname widget text
        if {$type eq "param" && [string tolower $pname] eq $lower} { return $token }
    }
    return ""
}

# update_PARAM_VALUE.* 的形参是 PARAM_VALUE.X 形式的变量名，映射到参数节点。
proc ::sv::formal_token {formal} {
    if {[string match PARAM_VALUE.* $formal]} {
        set name [string range $formal 12 end]
        set token [::sv::find_param $name]
        if {$token ne ""} { return $token }
        set token [::sv::token param]
        dict set ::sv::nodes $token [list param "" $name "" ""]
        lappend ::sv::order $token
        return $token
    }
    return [::sv::token other]
}

# 属性重复赋值时取最后一次，字符串整体作为值保存，避免被拆成列表。
proc ::sv::getprop {name target} {
    if {[dict exists $::sv::props $target $name]} {
        return [dict get $::sv::props $target $name]
    }
    return ""
}

# 缺省值：板卡接口参数在未使用板卡流程时取 Custom，其余留空；键名同样按大小写不敏感匹配。
proc ::sv::value_of {name} {
    if {$name ne ""} {
        if {[dict exists $::sv::values $name]} { return [dict get $::sv::values $name] }
        set lower [string tolower $name]
        foreach key [dict keys $::sv::values] {
            if {[string tolower $key] eq $lower} { return [dict get $::sv::values $key] }
        }
    }
    if {[string match -nocase *_BOARD_INTERFACE $name]} { return "Custom" }
    return ""
}

# get_paramspec/get_guiparamspec 既用 -name 也用位置参数；返回对应参数节点，便于 tooltip 落到正确参数。
proc ::sv::spec {args} {
    set name ""
    set skip 0
    foreach item $args {
        if {$skip} { set skip 0; continue }
        if {$item eq "-name" || $item eq "-of"} { set skip 1; continue }
        if {[string index $item 0] ne "-" && $name eq ""} { set name $item }
    }
    if {$name ne ""} {
        set token [::sv::find_param $name]
        if {$token ne ""} { return $token }
    }
    return [::sv::token spec]
}

proc ::sv::add {type args} {
    if {[llength $args] == 0} { return [::sv::token $type] }
    set view [lindex $args 0]
    set rest [lrange $args 1 end]
    if {[catch {array set o $rest}]} { array set o {} }
    set name ""
    if {[info exists o(-name)]} { set name $o(-name) }
    set widget ""
    if {[info exists o(-widget)]} { set widget $o(-widget) }
    set text ""
    if {[info exists o(-text)]} { set text $o(-text) }
    set parent $view
    if {[info exists o(-parent)]} { set parent $o(-parent) }
    set token [::sv::token $type]
    dict set ::sv::nodes $token [list $type $parent $name $widget $text]
    lappend ::sv::order $token
    return $token
}

proc ::sv::prop {name value target} {
    dict set ::sv::props $target $name $value
}

proc ::sv::esc {value} {
    return [string map [list "%" "%25" "\t" "%09" "\n" "%0A" "\r" "%0D"] $value]
}

proc ::sv::dump {} {
    set lines {}
    foreach token $::sv::order {
        lassign [dict get $::sv::nodes $token] type parent name widget text
        lappend lines [list $token $type $parent $name $widget \
            [::sv::getprop tooltip $token] [::sv::getprop display_name $token] $text [::sv::getprop enabled $token]]
    }
    return $lines
}

proc ::sv::vlnv_dir {vlnv} {
    lassign [split $vlnv :] vendor library name version
    return [file join $::sv::iproot "\${name}_v[string map [list . _] $version]"]
}

rename ::load ::sv::load_real
proc ::load {args} { return "" }
# 子解释器里没有 Vivado 的 xilinx::board 等命名空间，require 时补一个空命名空间。
proc ::package {args} {
    if {[lindex $args 0] eq "require"} {
        set name [lindex $args 1]
        if {![namespace exists ::$name]} { namespace eval ::$name {} }
    }
    return ""
}
proc ::set_property {name value target} { ::sv::prop $name $value $target }
proc ::get_property {name target} {
    if {$name eq "value"} { return [::sv::value_of [::sv::param_name $target]] }
    if {$name eq "enabled"} { return [::sv::getprop enabled $target] }
    return ""
}
proc ::get_param_value {args} { return [::sv::value_of [lindex $args 0]] }
proc ::add_board_tab {args} { return "" }
proc ::get_project_property {args} { return "" }
proc ::unknown {args} { dict set ::sv::missing [lindex $args 0] 1; return "" }

proc ::source_ipfile {file} {
    set path [file join $::sv::dir $file]
    if {![file exists $path]} { return "" }
    set saved $::sv::dir
    set code ""
    catch { set code [read [open $path r]] }
    if {[catch {uplevel #0 $code} err]} { puts "SVGUI SOURCE_ERROR: $path: $err" }
    set ::sv::dir $saved
    return ""
}

# 复杂 IP 的公共界面在别的 IP 包里（source_subcore_ipfile），按 VLNV 找到安装目录递归执行。
proc ::source_subcore_ipfile {vlnv file} {
    set core [::sv::vlnv_dir $vlnv]
    set path [file join $core $file]
    if {![file exists $path]} { return "" }
    set saved $::sv::dir
    set ::sv::dir $core
    set code ""
    catch { set code [read [open $path r]] }
    if {[catch {uplevel #0 $code} err]} { puts "SVGUI SUBCORE_ERROR: $path: $err" }
    set ::sv::dir $saved
    return ""
}

namespace eval ::ipgui {
    proc add_param {args} { return [::sv::add param {*}$args] }
    proc add_page {args} { return [::sv::add page {*}$args] }
    proc add_group {args} { return [::sv::add group {*}$args] }
    proc add_panel {args} { return [::sv::add panel {*}$args] }
    proc add_row {args} { return [::sv::add row {*}$args] }
    proc add_table {args} { return [::sv::add table {*}$args] }
    proc add_static_text {args} { return [::sv::add static {*}$args] }
    proc add_dynamic_text {args} { return [::sv::add dynamic {*}$args] }
    proc add_image {args} { return [::sv::add image {*}$args] }
    proc add_indent {args} { return "" }
    proc add_custom_widget {args} { return [::sv::add custom {*}$args] }
    proc get_paramspec {args} { return [::sv::spec {*}$args] }
    proc get_guiparamspec {args} { return [::sv::spec {*}$args] }
    proc get_modelparamspec {args} { return [::sv::spec {*}$args] }
    proc get_groupspec {args} { return [::sv::token spec] }
    proc get_pagespec {args} { return [::sv::token spec] }
    proc get_textspec {args} { return [::sv::token spec] }
    proc get_canvasspec {args} { return [::sv::token spec] }
    proc get_imagespec {args} { return [::sv::token spec] }
    proc get_tablespec {args} { return [::sv::token spec] }
    proc get_coredir {} { return $::sv::dir }
    proc update_params {args} { return "" }
    proc find_file {args} { return "" }
}

set ::sv::dir [file dirname [file dirname $::sv::file]]
set ::sv::iproot [file dirname $::sv::dir]
if {[catch {source -encoding utf-8 $::sv::file} err]} { puts "SVGUI SOURCE_ERROR: $err" }
set ::sv::entry ""
foreach candidate {init_gui create_gui} {
    if {[llength [info commands $candidate]]} { set ::sv::entry $candidate; break }
}
if {$::sv::entry eq ""} {
    puts "SVGUI NO_INIT_GUI"
} else {
    set view [::sv::token view]
    set argc [llength [info args $::sv::entry]]
    set call [list $::sv::entry $view]
    for {set i 1} {$i < $argc} {incr i} { lappend call "" }
    if {[catch {uplevel #0 $call} err]} { puts "SVGUI INIT_ERROR: $err" }
    # 部分 IP 把提示与显示名拆到独立过程里，由 Vivado 在 init_gui 之后调用。
    foreach hook {setToolTips setDisplayNames} {
        if {[llength [info commands $hook]]} { catch {uplevel #0 [list $hook $view]} }
    }
    # 用当前参数值执行 update_PARAM_VALUE.* 与 update_gui_for_PARAM_VALUE.*，回收 enabled 状态。
    foreach pattern {update_PARAM_VALUE.* update_gui_for_PARAM_VALUE.*} {
        foreach procname [info procs $pattern] {
            set call [list $procname]
            foreach formal [info args $procname] { lappend call [::sv::formal_token $formal] }
            catch {uplevel #0 $call}
        }
    }
    foreach line [::sv::dump] {
        lassign $line token type parent name widget tooltip display text enabled
        puts "SVGUI_ROW\t$token\t$type\t$parent\t[::sv::esc $name]\t[::sv::esc $widget]\t[::sv::esc $tooltip]\t[::sv::esc $display]\t[::sv::esc $text]\t$enabled"
    }
    puts "SVGUI_MISSING: [lsort [dict keys $::sv::missing]]"
}
`;

const tclWord = text => '"' + String(text).replace(/[\\"$[\]]/gu, match => '\\' + match) + '"';

/** 生成 dump 脚本正文：由调用方写入临时文件后交给 Vivado 执行。 */
function dumpScript(file, values = {}) {
    const lines = Object.entries(values).map(([name, value]) =>
        'dict set ::sv::values [list ' + tclWord(name) + '] [list ' + tclWord(value) + ']').join('\n');
    return DUMP.replace('__VALUES__', lines).replace('__FILE__', file.replaceAll('\\', '/'));
}

/** 生成持久会话里的执行行：独立子解释器执行，避免覆盖命令泄漏到工程会话。 */
function sessionLines(scriptPath) {
    return [
        'set ::svtools_gui_script {' + scriptPath.replaceAll('\\', '/') + '}',
        'interp create ::svtools_gui',
        'catch {interp eval ::svtools_gui [list source $::svtools_gui_script]} ::svtools_gui_error',
        'if {[info exists ::svtools_gui_error]} { puts "SVGUI CHILD_ERROR: $::svtools_gui_error"; unset ::svtools_gui_error }',
        'interp delete ::svtools_gui',
        'unset ::svtools_gui_script'
    ];
}

const decode = value => {
    try { return decodeURIComponent(String(value ?? '')); }
    catch { return String(value ?? ''); }
};

/** 解析 Tcl 回传的 SVGUI_ROW 行，得到页面/分组、提示、静态说明与可用状态。 */
function parse(stdout) {
    const nodes = new Map(), order = [];
    for (const line of String(stdout || '').split(/\r?\n/u)) {
        if (!line.startsWith('SVGUI_ROW\t')) continue;
        const [, token, type, parent, name, widget, tooltip, display, text, enabled] = line.split('\t');
        if (!token) continue;
        nodes.set(token, { type, parent, name: decode(name), widget: decode(widget),
            tooltip: decode(tooltip), display: decode(display), text: decode(text),
            enabled: enabled === 'false' ? false : enabled === 'true' ? true : undefined });
        order.push(token);
    }
    const pathOf = token => {
        const parts = [];
        for (let item = nodes.get(token), depth = 0; item && depth < 16; depth += 1) {
            if (['page', 'group', 'panel', 'table'].includes(item.type) && (item.name || item.display)) {
                parts.unshift(item.display || item.name);
            }
            item = item.parent ? nodes.get(item.parent) : undefined;
        }
        return parts.join(' / ');
    };
    const params = new Map(), notes = new Map(), enabled = new Map();
    for (const token of order) {
        const node = nodes.get(token);
        if (node.type === 'param') {
            if (!node.name || params.has(node.name)) continue;
            params.set(node.name, { label: node.display, help: node.tooltip, group: pathOf(node.parent), widget: node.widget });
            if (node.enabled !== undefined) enabled.set(node.name, node.enabled);
        } else if (node.type === 'static' && node.text) {
            const group = pathOf(node.parent);
            if (!notes.has(group)) notes.set(group, []);
            if (!notes.get(group).includes(node.text)) notes.get(group).push(node.text);
        }
    }
    return { params, notes, enabled };
}

/** 读取安装目录下某个 VLNV 的 XGUI 文件，供会话执行。 */
async function guiFile(binDir, vlnv) {
    const [vendor, , name, version] = String(vlnv || '').split(':');
    if (vendor !== 'xilinx.com' || !/^[\w-]+$/u.test(name || '') || !/^\d+(?:\.\d+)+$/u.test(version || '')) return;
    const core = path.resolve(binDir, '..', 'data', 'ip', 'xilinx', name + '_v' + version.replaceAll('.', '_'));
    let list;
    try { list = await readdir(path.join(core, 'xgui')); }
    catch { return; }
    const candidates = list.filter(file => file.endsWith('.tcl'));
    // 主界面文件是定义 init_gui/create_gui 的那个；其余是工具文件。
    for (const file of candidates) {
        const text = await readFile(path.join(core, 'xgui', file), 'utf8').catch(() => '');
        if (/proc\s+(?:init_gui|create_gui)\b/u.test(text)) return path.join(core, 'xgui', file);
    }
    return;
}

module.exports = { dumpScript, sessionLines, parse, guiFile };
