'use strict';

const SV_KEYWORDS = [
    'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg',
    'logic', 'always', 'always_comb', 'always_ff', 'always_latch',
    'assign', 'begin', 'end', 'if', 'else', 'case', 'endcase',
    'casex', 'casez', 'for', 'while', 'do', 'repeat', 'forever',
    'function', 'endfunction', 'task', 'endtask', 'parameter',
    'localparam', 'generate', 'endgenerate', 'genvar', 'interface',
    'endinterface', 'modport', 'package', 'endpackage', 'class',
    'endclass', 'typedef', 'enum', 'struct', 'union', 'packed',
    'return', 'posedge', 'negedge', 'edge', 'or', 'and', 'not',
    'integer', 'real', 'time', 'bit', 'byte', 'shortint', 'int',
    'longint', 'shortreal', 'string', 'void', 'initial', 'final',
    'default', 'signed', 'unsigned', 'automatic', 'static',
    'virtual', 'extends', 'implements', 'import', 'export',
    'pure', 'extern', 'fork', 'join', 'join_any', 'join_none',
    'disable', 'wait', 'event', 'assert', 'assume', 'cover',
    'property', 'endproperty', 'sequence', 'endsequence',
    'covergroup', 'endgroup', 'rand', 'randc', 'constraint',
    'new', 'super', 'this', 'null', 'unique', 'priority',
];

const SV_SNIPPETS = [
    // Always blocks
    { label: 'always', detail: 'always @(...)', body: 'always @(${1:*}) begin\n\t$0\nend' },
    { label: 'always_ff', detail: 'always_ff @(posedge clk)', body: 'always_ff @(posedge ${1:clk}) begin\n\t$0\nend' },
    { label: 'always_ff_rst', detail: 'always_ff with async reset', body: 'always_ff @(posedge ${1:clk} or negedge ${2:rst_n}) begin\n\tif (!$2) begin\n\t\t$0\n\tend else begin\n\t\t\n\tend\nend' },
    { label: 'always_comb', detail: 'always_comb', body: 'always_comb begin\n\t$0\nend' },
    { label: 'always_latch', detail: 'always_latch', body: 'always_latch begin\n\t$0\nend' },
    { label: 'always_star', detail: 'always @(*)', body: 'always @(*) begin\n\t$0\nend' },
    { label: 'always_posedge', detail: 'always @(posedge clk)', body: 'always @(posedge ${1:clk}) begin\n\t$0\nend' },
    // Module / interface
    { label: 'module', detail: 'module template', body: 'module ${1:name} (\n\tinput  ${2:clk},\n\tinput  ${3:rst_n},\n\toutput ${4:data}\n);\n\n\t$0\n\nendmodule' },
    { label: 'module_param', detail: 'module with parameters', body: 'module ${1:name} #(\n\tparameter ${2:W} = ${3:8}\n) (\n\tinput  ${4:clk},\n\tinput  ${5:rst_n},\n\toutput ${6:data}\n);\n\n\t$0\n\nendmodule' },
    { label: 'interface', detail: 'interface template', body: 'interface ${1:name};\n\tlogic ${2:valid};\n\tlogic ${3:ready};\n\n\tmodport master (output $2, input $3);\n\tmodport slave  (input  $2, output $3);\nendinterface' },
    // Control flow
    { label: 'if', detail: 'if statement', body: 'if (${1:cond}) begin\n\t$0\nend' },
    { label: 'ifelse', detail: 'if-else statement', body: 'if (${1:cond}) begin\n\t$0\nend else begin\n\t\nend' },
    { label: 'case', detail: 'case statement', body: 'case (${1:sel})\n\t${2:val}: $0\n\tdefault: ;\nendcase' },
    { label: 'casex', detail: 'casex statement', body: 'casex (${1:sel})\n\t${2:val}: $0\n\tdefault: ;\nendcase' },
    { label: 'for', detail: 'for loop', body: 'for (int ${1:i} = 0; $1 < ${2:N}; $1++) begin\n\t$0\nend' },
    { label: 'generate_for', detail: 'generate for loop', body: 'genvar ${1:i};\ngenerate\n\tfor ($1 = 0; $1 < ${2:N}; $1 = $1 + 1) begin : ${3:gen_label}\n\t\t$0\n\tend\nendgenerate' },
    { label: 'beginend', detail: 'begin ... end block', body: 'begin\n\t$0\nend' },
    { label: 'initial', detail: 'initial block', body: 'initial begin\n\t$0\nend' },
    { label: 'initial_forever', detail: 'initial forever (clock gen)', body: 'initial begin\n\t${1:clk} = 1\'b0;\n\tforever #${2:5} $1 = ~$1;\nend' },
    // Declarations
    { label: 'assign', detail: 'assign statement', body: 'assign ${1:out} = ${2:in};' },
    { label: 'wire', detail: 'wire declaration', body: 'wire ${1:[${2:W}-1:0] }${3:name};' },
    { label: 'reg', detail: 'reg declaration', body: 'reg ${1:[${2:W}-1:0] }${3:name};' },
    { label: 'logic', detail: 'logic declaration', body: 'logic ${1:[${2:W}-1:0] }${3:name};' },
    { label: 'parameter', detail: 'parameter declaration', body: 'parameter ${1:NAME} = ${2:value};' },
    { label: 'localparam', detail: 'localparam declaration', body: 'localparam ${1:NAME} = ${2:value};' },
    { label: 'typedef_enum', detail: 'typedef enum', body: 'typedef enum logic [${1:1}:0] {\n\t${2:IDLE},\n\t${3:RUN},\n\t${4:DONE}\n} ${5:state_t};' },
    { label: 'typedef_struct', detail: 'typedef struct packed', body: 'typedef struct packed {\n\tlogic [${1:7}:0] ${2:data};\n\tlogic           ${3:valid};\n} ${4:packet_t};' },
    // Task / function
    { label: 'function', detail: 'function template', body: 'function automatic ${1:logic} ${2:name}(${3:input logic a});\n\t$0\nendfunction' },
    { label: 'task', detail: 'task template', body: 'task automatic ${1:name}(${2:input logic a});\n\t$0\nendtask' },
    // Testbench
    { label: 'testbench', detail: 'testbench template', body: '`timescale 1ns / 1ps\n\nmodule ${1:tb}_${2:top};\n\n\treg clk;\n\treg rst_n;\n\n\t// Clock generation\n\tinitial begin\n\t\tclk = 1\'b0;\n\t\tforever #5 clk = ~clk;\n\tend\n\n\t// Reset & stimulus\n\tinitial begin\n\t\trst_n = 1\'b0;\n\t\t#100;\n\t\trst_n = 1\'b1;\n\t\t$0\n\t\t#1000;\n\t\t$$finish;\n\tend\n\n\t// DUT\n\t$2 u_dut (\n\t\t.clk   (clk),\n\t\t.rst_n (rst_n)\n\t);\n\nendmodule' },
    { label: 'timescale', detail: '`timescale directive', body: '`timescale ${1:1ns} / ${2:1ps}' },
    { label: 'include', detail: '`include directive', body: '`include "${1:file.svh}"' },
    { label: 'define', detail: '`define directive', body: '`define ${1:NAME} ${2:value}' },
    // Misc
    { label: 'fsm', detail: 'FSM 3-process template', body: '// State definition\ntypedef enum logic [1:0] {\n\tIDLE,\n\tRUN,\n\tDONE\n} state_t;\n\nstate_t state, next_state;\n\n// State register\nalways_ff @(posedge ${1:clk} or negedge ${2:rst_n}) begin\n\tif (!$2)\n\t\tstate <= IDLE;\n\telse\n\t\tstate <= next_state;\nend\n\n// Next state logic\nalways_comb begin\n\tnext_state = state;\n\tcase (state)\n\t\tIDLE: $0\n\t\tRUN:  \n\t\tDONE: \n\t\tdefault: next_state = IDLE;\n\tendcase\nend\n\n// Output logic\nalways_comb begin\n\tcase (state)\n\t\tIDLE: ;\n\t\tRUN:  ;\n\t\tDONE: ;\n\t\tdefault: ;\n\tendcase\nend' },
];

module.exports = { SV_KEYWORDS, SV_SNIPPETS };
