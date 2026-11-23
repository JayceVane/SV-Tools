'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const RESULT_FILE = 'assets.tsv';
const MAX_RESULT = 8 * 1024 * 1024;

// Tcl 字面量不使用路径转义，保留参数值里的反斜线、换行和 Unicode。
const literal = value => '[encoding convertfrom utf-8 [binary format H* {' + Buffer.from(String(value), 'utf8').toString('hex') + '}]]';
const filePath = value => literal(value.replace(/\\/gu, '/'));
const list = values => '[list ' + values.map(literal).join(' ') + ']';

const helpers = [
    'proc sv_prop {object property} { return [get_property -quiet $property $object] }',
    'proc sv_row {kind args} {',
    '    global sv_output',
    '    set fields [list $kind]',
    '    foreach value $args {',
    '        binary scan [encoding convertto utf-8 $value] H* encoded',
    '        lappend fields $encoded',
    '    }',
    '    puts $sv_output [join $fields "\t"]',
    '}',
    'proc sv_exact {items name label} {',
    '    set matches [lsearch -all -inline -exact $items $name]',
    '    if {[llength $matches] != 1} { error "$label unavailable or ambiguous: $name" }',
    '    return [lindex $matches 0]',
    '}',
    'proc sv_same_path {a b} {',
    '    set a [file normalize $a]',
    '    set b [file normalize $b]',
    '    if {$::tcl_platform(platform) eq "windows"} { return [string equal -nocase $a $b] }',
    '    return [string equal $a $b]',
    '}',
    'proc sv_file {wanted files} {',
    '    set matches {}',
    '    foreach file $files { if {[sv_same_path $file $wanted]} { lappend matches $file } }',
    '    if {[llength $matches] != 1} { error "Project file unavailable or ambiguous: $wanted" }',
    '    return [lindex $matches 0]',
    '}',
    'proc sv_parameters {obj} {',
    '    foreach key [lsort -dictionary [list_property $obj]] {',
    '        if {![string match CONFIG.* $key] || $key in {CONFIG.Component_Name CONFIG.LOGO_FILE}} { continue }',
    '        set choices {}',
    '        catch { set choices [list_property_value $key $obj] }',
    '        sv_row parameter $key [sv_prop $obj $key] {*}$choices',
    '    }',
    '}',
    // Vivado 2022.1 的 get_ips 帮助列出了 -exclude_bd_ips，但实际调用会报未知选项；
    // 先试选项，不支持时退回全量并按工程的 <name>.srcs/sources_1/bd 目录过滤。
    'proc sv_standalone_ips {args} {',
    '    if {![catch {get_ips -quiet -exclude_bd_ips {*}$args} ips]} { return $ips }',
    '    set project [current_project]',
    '    set root [file normalize [file join [get_property -quiet DIRECTORY $project] "[get_property -quiet NAME $project].srcs" sources_1 bd]]',
    '    set ips {}',
    '    foreach ip [get_ips -quiet {*}$args] {',
    '        set file [sv_prop $ip IP_FILE]',
    '        if {$file eq ""} { continue }',
    '        set normalized [file normalize $file]',
    '        set inside 0',
    '        if {[string length $normalized] >= [string length $root]} {',
    '            set head [string range $normalized 0 [expr {[string length $root] - 1}]]',
    '            if {$::tcl_platform(platform) eq "windows"} { set inside [string equal -nocase $head $root] } else { set inside [string equal $head $root] }',
    '        }',
    '        if {!$inside} { lappend ips $ip }',
    '    }',
    '    return $ips',
    '}'
];

function script(xpr, body, { readOnly = false } = {}) {
    return [
        ...helpers,
        'if {[catch {',
        '    set sv_output [open ' + RESULT_FILE + ' w]',
        '    puts $sv_output SVTOOLS_ASSETS_V1',
        '    open_project ' + (readOnly ? '-read_only ' : '') + filePath(xpr),
        ...body.map(line => '    ' + line),
        '    close_project',
        '    puts $sv_output END',
        '    close $sv_output',
        '} message]} {',
        '    catch { close $sv_output }',
        '    catch { close_project }',
        '    puts "SVTOOLS_TCL_ERROR $message"',
        '    exit 1',
        '}',
        'puts SVTOOLS_DONE'
    ].join('\n') + '\n';
}

/**
 * 常驻会话脚本：工程已由会话打开，只负责写出结果文件并执行动作。
 * body 与批处理共用，保证两条路径的执行语义一致。
 */
function sessionScript(body) {
    return [
        ...helpers,
        'set sv_output [open ' + RESULT_FILE + ' w]',
        'puts $sv_output SVTOOLS_ASSETS_V1',
        'set ::svtools_body_rc [catch {',
        ...body.map(line => '    ' + line),
        '    puts $sv_output END',
        '} ::svtools_body_msg]',
        'catch { close $sv_output }',
        'if {$::svtools_body_rc} { error $::svtools_body_msg }'
    ].join('\n') + '\n';
}

async function readRows(directory) {
    const file = path.join(directory, RESULT_FILE);
    const { size } = await fs.stat(file);
    if (size > MAX_RESULT) throw new Error('Vivado 返回的资产数据超过 8 MiB');
    const lines = (await fs.readFile(file, 'utf8')).trimEnd().split(/\r?\n/u);
    if (lines.shift() !== 'SVTOOLS_ASSETS_V1' || lines.pop() !== 'END') {
        throw new Error('Vivado 资产结果不完整');
    }
    return lines.map(line => {
        const [kind, ...fields] = line.split('\t');
        if (!/^[a-z][a-z0-9_]*$/u.test(kind) || fields.some(field => !/^(?:[0-9a-f]{2})*$/u.test(field))) {
            throw new Error('Vivado 资产结果格式无效');
        }
        return [kind, ...fields.map(field => Buffer.from(field, 'hex').toString('utf8'))];
    });
}

const rowsOf = (rows, kind) => rows.filter(row => row[0] === kind).map(row => row.slice(1));
const parametersOf = rows => rowsOf(rows, 'parameter').map(([key, value, ...choices]) => ({ key, value, choices }));

function removeFromProject(file, fileset) {
    return [
        'set set [sv_exact [get_filesets -quiet] ' + literal(fileset) + ' "Project fileset"]',
        'set file [sv_file ' + filePath(file) + ' [get_files -quiet -of_objects $set]]',
        'remove_files -fileset $set $file'
    ];
}

function properties(changes, object) {
    if (!changes.length) return [];
    const verify = changes.map(({ key, before }) => {
        if (!/^CONFIG\.[\w.:-]+$/u.test(key) || ['CONFIG.Component_Name', 'CONFIG.LOGO_FILE'].includes(key)) {
            throw new Error('参数名无效或为 Vivado 管理属性');
        }
        return 'if {[sv_prop ' + object + ' ' + literal(key) + '] ne ' + literal(before) + '} { error ' + literal('Parameter changed; refresh before applying: ' + key) + ' }';
    });
    return [...verify, 'set_property -dict ' + list(changes.flatMap(({ key, value }) => [key, value])) + ' ' + object];
}

function requireName(value) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error('名称须以字母或下划线开头，可包含数字');
    return literal(value);
}

function requireVlnv(value) {
    if (!/^[\w.-]+:[\w.-]+:[\w.-]+:[\w.-]+$/u.test(value)) throw new Error('无效的 Vivado IP VLNV');
    return literal(value);
}

module.exports = { literal, filePath, list, script, sessionScript, readRows, rowsOf, parametersOf, properties, removeFromProject, requireName, requireVlnv };
