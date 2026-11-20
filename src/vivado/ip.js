'use strict';

const path = require('node:path');
const { literal, filePath, list, properties, requireName, requireVlnv } = require('./asset-task');

function catalog(forBlockDesign) {
    return [
        'sv_row tool [version -short] [sv_prop [current_project] PART]',
        'foreach definition [get_ipdefs -quiet -all] {',
        forBlockDesign ? '    if {"IPI" ni [sv_prop $definition DESIGN_TOOL_CONTEXTS]} { continue }' : '',
        '    sv_row definition $definition [sv_prop $definition DISPLAY_NAME] [sv_prop $definition DESCRIPTION]',
        '}'
    ].filter(Boolean);
}

function create({ vlnv, name, directory }) {
    return [
        'set name ' + requireName(name),
        'if {[llength [get_ips -quiet $name]]} { error "IP name already exists: $name" }',
        'set def [sv_exact [get_ipdefs -quiet -all] ' + requireVlnv(vlnv) + ' "IP definition"]',
        'create_ip -vlnv $def -module_name $name' + (directory ? ' -dir ' + filePath(directory) : ''),
        'set ip [sv_exact [get_ips -quiet] $name IP]',
        'sv_row created [sv_prop $ip IP_FILE]'
    ];
}

function importSource(file, copy) {
    if (!path.isAbsolute(file) || !/\.(xci|xcix)$/iu.test(file)) throw new Error('请选择 .xci 或 .xcix 文件');
    return [
        'set file ' + filePath(file),
        'if {![file isfile $file]} { error "IP file unavailable: $file" }',
        'foreach existing [get_files -quiet] {',
        '    if {[sv_same_path $existing $file]} { error "IP already belongs to the project: $file" }',
        '}',
        'set imported [' + (copy ? (/\.xcix$/iu.test(file) ? 'import_files -norecurse' : 'import_ip') : 'add_files -norecurse') + ' [list $file]]',
        'if {[llength $imported] != 1} { error "Unable to resolve imported IP: $file" }',
        'sv_row imported [lindex $imported 0]'
    ];
}

const select = file => [
    'set ipFile [sv_file ' + filePath(file) + ' [get_files -quiet -all [list *.xci *.xcix]]]',
    'set matching {}',
    'foreach candidate [get_ips -quiet -exclude_bd_ips] {',
    '    set source [sv_prop $candidate IP_FILE]',
    '    if {$source ne "" && [sv_same_path $source $ipFile]} { lappend matching $candidate }',
    '}',
    // 容器的 IP_FILE 可能指向内部 XCI；按文件对象和模块名取顶层 IP。
    'if {![llength $matching]} {',
    '    set name [file rootname [file tail $ipFile]]',
    '    set matching [lsearch -all -inline -exact [get_ips -quiet -exclude_bd_ips -of_objects $ipFile] $name]',
    '}',
    'if {[llength $matching] != 1} { error "Standalone IP unavailable or ambiguous: $ipFile" }',
    'set ip [lindex $matching 0]'
];

const inspect = [
    'sv_row ip $ip [sv_prop $ip IPDEF] [sv_prop $ip IS_LOCKED] [sv_prop $ip UPGRADE_VERSIONS] [sv_prop $ipFile GENERATE_SYNTH_CHECKPOINT] {*}[sv_prop $ip SUPPORTED_TARGETS]',
    'sv_parameters $ip'
];
const info = file => [...select(file), ...inspect];

const configure = (file, changes, { readBack = false } = {}) => [
    ...select(file), ...properties(changes, '$ip'), ...(readBack ? inspect : [])
];
const TARGETS = ['all', 'synthesis', 'simulation', 'instantiation_template', 'example_design', 'changelog'];

function generate(file, target) {
    if (!TARGETS.includes(target)) throw new Error('不支持的 IP 生成目标');
    return [...select(file), 'generate_target -force ' + literal(target) + ' $ip'];
}

function template(file, extension) {
    if (!['.veo', '.vho'].includes(extension)) throw new Error('不支持的 IP 模板类型');
    return [
        ...select(file),
        'generate_target instantiation_template $ip',
        'set suffix ' + literal(extension),
        'set candidates {}',
        'foreach entry [get_files -quiet -all -of_objects $ip] {',
        '    if {[file extension $entry] eq $suffix && [file isfile $entry]} { lappend candidates [file normalize $entry] }',
        '}',
        // Vivado 2022.1 的模板可能是 IP 目录的上一级产物，且不列入 get_files。
        'set xci [sv_prop $ip IP_FILE]',
        'set output [sv_prop $ip IP_OUTPUT_DIR]',
        'set dirs [list [file dirname $xci] [file dirname [file dirname $xci]]]',
        'if {$output ne ""} { lappend dirs $output [file dirname $output] }',
        'foreach dir $dirs {',
        '    set file [file join $dir $ip$suffix]',
        '    if {[file isfile $file]} { lappend candidates [file normalize $file] }',
        '}',
        'set candidates [lsort -unique $candidates]',
        'if {[llength $candidates] != 1} { error "Vivado template missing or ambiguous: $ip$suffix" }',
        'file copy [lindex $candidates 0] [file join [pwd] template$suffix]',
        'sv_row artifact template$suffix'
    ];
}

const synthesize = file => [
    ...select(file),
    'set runName ${ip}_synth_1',
    'if {![llength [get_runs -quiet $runName]]} { create_ip_run $ip }',
    'set run [sv_exact [get_runs -quiet] $runName "IP synthesis run"]',
    'if {[sv_prop $run STATUS] ne "Not started"} { reset_run $run }',
    'launch_runs $run',
    'wait_on_run $run',
    'if {![string match "*Complete*" [sv_prop $run STATUS]] || [sv_prop $run PROGRESS] ne "100%"} { error "IP synthesis did not complete: [sv_prop $run STATUS]" }'
];

const upgrade = file => [
    ...select(file),
    'if {![llength [sv_prop $ip UPGRADE_VERSIONS]]} { error "No available upgrade for $ip" }',
    'upgrade_ip $ip'
];

const repositoryProperty = '[sv_prop [current_project] IP_REPO_PATHS]';
const repositories = () => ['foreach repo ' + repositoryProperty + ' { sv_row repo $repo }'];

function setRepositories(before, after) {
    return [
        'set current ' + repositoryProperty,
        'if {[list {*}$current] ne ' + list(before) + '} { error "IP repository list has changed; refresh it first" }',
        'set dirs ' + list(after.map(dir => dir.replace(/\\/gu, '/'))),
        'foreach dir $dirs { if {![file isdirectory $dir]} { error "IP repository directory unavailable: $dir" } }',
        'set_property IP_REPO_PATHS $dirs [current_project]',
        'update_ip_catalog -rebuild'
    ];
}

module.exports = { catalog, create, importSource, info, configure, generate, template, synthesize, upgrade,
    repositories, setRepositories, TARGETS };
