'use strict';

const { SV_SNIPPETS } = require('../completion-data');

// 模板只负责完整语法骨架；标准名称和接口签名由 catalog 维护。
const TEMPLATES = [
    { name: 'package', body: 'package ${1:name};\n\t$0\nendpackage : $1', scopes: ['root'] },
    { name: 'class', body: 'class ${1:name};\n\tfunction new();\n\tendfunction\n\t$0\nendclass : $1', scopes: ['root', 'package'] },
    { name: 'class_extends', body: 'class ${1:name} extends ${2:base};\n\tfunction new();\n\t\tsuper.new();\n\tendfunction\n\t$0\nendclass : $1', scopes: ['root', 'package'] },
    { name: 'class_param', body: 'class ${1:name} #(type ${2:T} = int);\n\t$2 ${3:value};\n\t$0\nendclass : $1', scopes: ['root', 'package'] },
    { name: 'constraint', body: 'constraint ${1:name} {\n\t${2:value} inside {[${3:min}:${4:max}]};\n\t$0\n}', scopes: ['class'] },
    { name: 'covergroup', body: 'covergroup ${1:name} @(posedge ${2:clk});\n\t${3:cp}: coverpoint ${4:signal} {\n\t\tbins ${5:values}[] = {[${6:0}:${7:15}]};\n\t}\n\t$0\nendgroup : $1', scopes: ['module', 'interface', 'class', 'package', 'root'] },
    { name: 'covergroup_sample', body: 'covergroup ${1:name} with function sample(${2:int value});\n\t${3:cp}: coverpoint ${4:value};\n\t$0\nendgroup : $1', scopes: ['module', 'interface', 'class', 'package', 'root'] },
    { name: 'property', body: 'property ${1:name};\n\t@(posedge ${2:clk}) disable iff (!${3:rst_n})\n\t\t${4:req} |-> ##${5:1} ${6:ack};\nendproperty : $1\n${7:assert} property ($1);', scopes: ['module', 'interface', 'checker'] },
    { name: 'sequence', body: 'sequence ${1:name};\n\t${2:a} ##${3:1} ${4:b};\nendsequence : $1', scopes: ['module', 'interface', 'checker', 'package'] },
    { name: 'assert_property', body: 'assert property (@(posedge ${1:clk}) disable iff (!${2:rst_n}) ${3:expression})\n\telse \\$error("${4:assertion failed}");', scopes: ['module', 'interface', 'checker'] },
    { name: 'clocking', body: 'clocking ${1:cb} @(posedge ${2:clk});\n\tdefault input #1step output #0;\n\tinput ${3:sample};\n\toutput ${4:drive};\nendclocking : $1', scopes: ['interface', 'module', 'program'] },
    { name: 'modport', body: 'modport ${1:name} (input ${2:clk}, output ${3:data});', scopes: ['interface'] },
    { name: 'checker', body: 'checker ${1:name} (${2:input logic clk});\n\t$0\nendchecker : $1', scopes: ['root', 'package'] },
    { name: 'program', body: 'program automatic ${1:name};\n\tinitial begin\n\t\t$0\n\tend\nendprogram : $1', scopes: ['root'] },
    { name: 'typedef_union', body: 'typedef union packed {\n\t${1:logic [31:0]} ${2:bits};\n\t${3:int} ${4:value};\n} ${5:name_t};' },
    { name: 'nettype', body: 'nettype ${1:real} ${2:name_t};', scopes: ['root', 'package', 'module'] },
    { name: 'foreach', body: 'foreach (${1:array}[${2:i}]) begin\n\t$0\nend', scopes: ['block', 'function', 'task'] },
    { name: 'foreach_2d', body: 'foreach (${1:mem}[${2:row}, ${3:col}]) begin\n\t$0\nend', scopes: ['block', 'function', 'task'] },
    { name: 'fork_join', body: 'fork\n\tbegin\n\t\t$0\n\tend\n\tbegin\n\t\t\n\tend\njoin', scopes: ['block', 'task'] },
    { name: 'fork_join_none', body: 'fork\n\tbegin\n\t\t$0\n\tend\njoin_none', scopes: ['block', 'task'] },
    { name: 'randomize_with', body: 'assert (${1:obj}.randomize() with { ${2:value} inside {[${3:min}:${4:max}]}; });', scopes: ['block', 'function', 'task'] },
    { name: 'import_package', body: 'import ${1:pkg}::*;' },
    { name: 'uvm_component', uvm: true, body: 'class ${1:name} extends ${2:uvm_component};\n\t`uvm_component_utils($1)\n\n\tfunction new(string name, uvm_component parent);\n\t\tsuper.new(name, parent);\n\tendfunction\n\n\tfunction void build_phase(uvm_phase phase);\n\t\tsuper.build_phase(phase);\n\t\t$0\n\tendfunction\nendclass : $1', scopes: ['root', 'package'] },
    { name: 'uvm_sequence_item', uvm: true, body: 'class ${1:name} extends uvm_sequence_item;\n\t`uvm_object_utils($1)\n\n\tfunction new(string name = "$1");\n\t\tsuper.new(name);\n\tendfunction\n\t$0\nendclass : $1', scopes: ['root', 'package'] },
    { name: 'uvm_sequence', uvm: true, body: 'class ${1:name} extends uvm_sequence #(${2:item_t});\n\t`uvm_object_utils($1)\n\n\tfunction new(string name = "$1");\n\t\tsuper.new(name);\n\tendfunction\n\n\tvirtual task body();\n\t\t$2 req;\n\t\treq = $2::type_id::create("req");\n\t\tstart_item(req);\n\t\t$0\n\t\tfinish_item(req);\n\tendtask\nendclass : $1', scopes: ['root', 'package'] },
    { name: 'uvm_run_phase', uvm: true, body: 'task run_phase(uvm_phase phase);\n\tphase.raise_objection(this);\n\t$0\n\tphase.drop_objection(this);\nendtask', scopes: ['class'] },
    { name: 'uvm_config_get', uvm: true, body: 'if (!uvm_config_db#(${1:virtual interface_t})::get(this, "", "${2:key}", ${3:value})) begin\n\t`uvm_fatal("CONFIG", "Missing $2")\nend', scopes: ['block', 'function', 'task'] },
    { name: 'uvm_config_set', uvm: true, body: 'uvm_config_db#(${1:virtual interface_t})::set(${2:null}, "${3:uvm_test_top.env.*}", "${4:key}", ${5:value});', scopes: ['block', 'function', 'task'] }
];

const VERILOG = new Set(['always', 'always_star', 'always_posedge', 'module', 'module_param', 'if', 'ifelse', 'case', 'casex', 'for', 'generate_for', 'beginend', 'initial', 'initial_forever', 'assign', 'wire', 'reg', 'parameter', 'localparam', 'testbench', 'timescale', 'include', 'define', 'task', 'function']);
const ROOT = new Set(['module', 'module_param', 'interface', 'testbench', 'timescale', 'include', 'define', 'typedef_enum', 'typedef_struct']);

function templatesFor(context, options) {
    const language = options.language || 'systemverilog', scope = context.scope.kind;
    const legacy = SV_SNIPPETS.filter(entry => (language !== 'verilog' || VERILOG.has(entry.label))
        && (entry.label !== 'localparam' || !options.keywords || options.keywords.has('localparam'))
        && (entry.label !== 'generate_for' || !options.keywords || options.keywords.has('generate'))
        && (entry.label !== 'always_star' || options.standard !== '1364-1995')
        && (scope !== 'root' || ROOT.has(entry.label))
        && (!['block', 'function', 'task'].includes(scope) || !/^(?:module|interface|always|generate|fsm|testbench)/.test(entry.label)))
        .map(entry => ({ name: entry.label, kind: 'snippet', body: language === 'verilog' ? entry.body.replace(/logic/g, 'reg') : entry.body, detail: entry.detail }));
    if (language === 'verilog') {
        if (options.standard === '1364-1995') {
            for (const entry of legacy) {
                entry.body = entry.body.replace(/\bautomatic\s+/g, '');
                if (entry.name === 'module') entry.body = 'module ${1:name} (${2:clk}, ${3:rst_n}, ${4:data});\n\tinput $2;\n\tinput $3;\n\toutput $4;\n\t$0\nendmodule';
                if (entry.name === 'module_param') entry.body = 'module ${1:name} (${4:clk}, ${5:rst_n}, ${6:data});\n\tparameter ${2:W} = ${3:8};\n\tinput $4;\n\tinput $5;\n\toutput $6;\n\t$0\nendmodule';
            }
        }
        const loop = legacy.find(entry => entry.name === 'for');
        if (loop) loop.body = 'integer ${1:i};\nfor ($1 = 0; $1 < ${2:N}; $1 = $1 + 1) begin\n\t$0\nend';
        return legacy;
    }
    return [...legacy, ...TEMPLATES.filter(entry => (!entry.uvm || options.uvm !== 'off') && (!entry.scopes || entry.scopes.includes(scope)))
        .map(entry => ({ ...entry, kind: 'snippet', detail: entry.uvm ? 'UVM 模板' : 'SystemVerilog 模板' }))];
}

module.exports = { templatesFor };
