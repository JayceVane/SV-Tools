'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseDocument } = require('../src/editor/completion/syntax');
const { complete } = require('../src/editor/completion/engine');

function query(source, files = [], options = {}) {
    const offset = source.indexOf('§'); assert.ok(offset >= 0);
    const uri = name => ({ fsPath: 'C:/hdl/' + name, toString: () => 'file:///C:/hdl/' + name });
    const current = { uri: uri('active.sv'), model: parseDocument(source.replace('§', '')) };
    const records = [current, ...files.map((text, index) => ({ uri: uri('file' + index + '.svh'), model: parseDocument(text) }))];
    return complete({ current, records, fileUris: records.map(record => record.uri), incomplete: false }, offset, { language: 'systemverilog', ...options });
}
const names = result => result.items.map(item => item.name);
function contains(source, expected, files = [], options = {}) {
    const result = query(source, files, options);
    for (const name of expected) assert.ok(names(result).includes(name), `${name} missing: ${names(result).join(', ')}`);
    return result;
}

test('Verilog 与 SystemVerilog 规范关键词保持独立，包括低频 UDP/config/checker 语法', () => {
    contains('module x; § endmodule', ['checker', 'nettype', 'interconnect', 's_always', 'eventually', 'matches']);
    const result = contains('module x; § endmodule', ['tranif0', 'pulsestyle_ondetect', 'config', 'scalared'], [], { language: 'verilog' });
    for (const forbidden of ['logic', 'class', 'always_ff', 'uvm_component']) assert.ok(!names(result).includes(forbidden));
});

test('注释、字符串和宏定义正文不提供普通代码补全', () => {
    for (const text of ['module x; // always module §\nendmodule', 'module x; initial $display("§"); endmodule', '`define D begin §']) assert.deepEqual(query(text).items, []);
});

test('符号只在词法可见范围内出现，同名内层声明覆盖外层', () => {
    const result = contains('module x; int outer; initial begin : b string outer; int local_a; § end initial begin int hidden; end endmodule', ['outer', 'local_a']);
    assert.equal(result.items.find(item => item.name === 'outer').type, 'string'); assert.ok(!names(result).includes('hidden'));
    assert.ok(!names(query('module x; initial begin int hidden; end § endmodule')).includes('hidden'));
});

test('跨文件 package 指定 import 与 wildcard 不泄漏未导入名称', () => {
    const pkg = 'package p; typedef struct packed { int addr; bit valid; } item_t; int shared; int unimported; endpackage';
    const specific = contains('module x; import p::item_t; item_t item; initial begin item.§ end endmodule', ['addr', 'valid'], [pkg]);
    assert.equal(specific.context.kind, 'member');
    assert.ok(!names(query('module x; import p::item_t; § endmodule', [pkg])).includes('shared'));
    contains('module x; import p::*; § endmodule', ['shared', 'unimported', 'item_t'], [pkg]);
    contains('module x; p::§ endmodule', ['shared', 'item_t'], [pkg]);
});

test('类继承支持公开成员，外部句柄隐藏 protected/local', () => {
    const classes = 'package p; class base; int pub; protected int protected_field; local int private_field; function string title(); endfunction endclass class child extends base; int own; endclass endpackage';
    const result = contains('module x; import p::*; child obj; initial obj.§ endmodule', ['pub', 'own', 'title'], [classes]);
    assert.ok(!names(result).includes('protected_field')); assert.ok(!names(result).includes('private_field'));
});

test('this/super 的访问控制不会暴露基类 local 字段', () => {
    const text = 'class base; protected int p; local int secret; int pub; endclass class child extends base; local int mine; function void f(); this.§ endfunction endclass';
    const result = contains(text, ['mine', 'p', 'pub']); assert.ok(!names(result).includes('secret'));
    const parent = contains(text.replace('this.§', 'super.§'), ['p', 'pub']); assert.ok(!names(parent).includes('mine')); assert.ok(!names(parent).includes('secret'));
});

test('Class:: 仅补全静态方法、常量和嵌套类型', () => {
    const result = contains('class C; int instance_field; static int shared; static function int id(); endfunction function void f(); endfunction endclass module x; initial C::§ endmodule', ['shared', 'id']);
    assert.ok(!names(result).includes('instance_field')); assert.ok(!names(result).includes('f'));
});

test('参数化类的成员和继承替换实际类型，支持返回值链式访问', () => {
    contains('class item; int value; endclass class box #(type T = int); T content; function T get(); endfunction endclass module x; box#(item) b; initial b.content.§ endmodule', ['value']);
    contains('class item; int value; endclass class box #(type T = int); function T get(); endfunction endclass class derived #(type U = int) extends box#(U); endclass module x; derived#(item) b; initial b.get().§ endmodule', ['value']);
});

test('用户方法补全含参数编辑点，已有调用括号不重复插入', () => {
    const source = 'class C; function string title(int code, string text); endfunction endclass module x; C obj; initial obj.ti§ endmodule';
    const result = contains(source, ['title']); assert.equal(result.items.find(item => item.name === 'title').body, 'title(${1:code}, ${2:text})');
    assert.equal(query(source.replace('ti§', 'ti§(1, "x");')).items.find(item => item.name === 'title').body, undefined);
});

test('string 类型别名与返回字符串链补全内建方法', () => {
    contains('module x; typedef string text_t; text_t s; initial s.§ endmodule', ['len', 'substr', 'toupper', 'atoi']);
    contains('module x; string s; initial s.tolower().§ endmodule', ['len', 'getc']);
    const result = contains('class C; function string title(); int hidden; endfunction endclass module x; C obj; initial obj.title().§ endmodule', ['len']);
    assert.ok(!names(result).includes('hidden'));
});

test('queue/dynamic/associative/fixed 数组方法分离', () => {
    contains('module x; int q[$]; initial q.§ endmodule', ['push_back', 'pop_front', 'size', 'find', 'sum']);
    const dynamic = contains('module x; int a[]; initial a.§ endmodule', ['size', 'delete', 'find']); assert.ok(!names(dynamic).includes('push_back'));
    const associative = contains('module x; int a[string]; initial a.§ endmodule', ['exists', 'first', 'next', 'num']); assert.ok(!names(associative).includes('push_back')); assert.ok(!names(associative).includes('sort'));
    const fixed = contains('module x; int a[8]; initial a.§ endmodule', ['sum', 'sort']); assert.ok(!names(fixed).includes('delete'));
});

test('二维 mem 逐层索引，数组元素的 struct/class 字段在最后一维可见', () => {
    contains('module x; typedef struct { int data; bit valid; } word_t; word_t mem[4][8]; initial mem[0][1].§ endmodule', ['data', 'valid']);
    const partial = contains('module x; typedef struct { int data; } word_t; word_t mem[4][8]; initial mem[0].§ endmodule', ['sum']); assert.ok(!names(partial).includes('data'));
    const popped = contains('class item; int data; endclass module x; item q[$][8]; initial q.pop_front().§ endmodule', ['sum']); assert.ok(!names(popped).includes('data'));
    contains('module x; int table[p::key_t]; initial table.§ endmodule', ['exists'], ['package p; typedef string key_t; endpackage']);
});

test('enum/covergroup/mailbox/semaphore/process 标准内建接口', () => {
    contains('module x; typedef enum { A, B } state_t; state_t s; initial s.§ endmodule', ['first', 'last', 'next', 'prev', 'name', 'num']);
    contains('module x; mailbox#(int) m; initial m.§ endmodule', ['put', 'get', 'try_peek', 'num']);
    contains('module x; semaphore s; initial s.§ endmodule', ['put', 'get', 'try_get']);
    contains('module x; initial process::§ endmodule', ['self', 'state']);
    contains('module x; initial process::state::§ endmodule', ['FINISHED', 'KILLED']);
    contains('module x; initial std::§ endmodule', ['randomize', 'process', 'weak_reference']);
});

test('virtual interface modport 不被当成新 interface 声明', () => {
    contains('interface bus; logic ready; modport drv(output ready); endinterface class C; virtual bus.drv vif; function void f(); vif.§ endfunction endclass', ['ready']);
    const selected = contains('interface bus; logic ready, hidden; modport drv(output ready); endinterface class C; virtual bus.drv vif; function void f(); vif.§ endfunction endclass', ['ready']);
    assert.ok(!names(selected).includes('hidden'));
});

test('长命名端口/参数列表使用真实类型，参数列表不混入端口/localparam', () => {
    const leaf = 'module leaf #(parameter W=8, parameter D=4)(input clk, input rst_n, output [W-1:0] data); localparam H=2; endmodule';
    const ports = contains('module x; leaf #(.W(16)) dut(\n.clk(clk),\n' + '\n'.repeat(45) + '.§); endmodule', ['rst_n', 'data'], [leaf]);
    assert.ok(!names(ports).includes('clk')); assert.ok(!names(ports).includes('W'));
    const parameters = contains('module x; leaf #(.W(16), .§) dut(); endmodule', ['D'], [leaf]); assert.ok(!names(parameters).includes('W')); assert.ok(!names(parameters).includes('H'));
});

test('连接表达式内的对象成员与调用不会混入模块端口', () => {
    const defs = ['module leaf(input clk, input data); endmodule'];
    const result = contains('class C; int field; endclass module x; C obj; leaf dut(.data(obj.§)); endmodule', ['field'], defs);
    assert.equal(result.context.kind, 'member'); assert.ok(!names(result).includes('clk'));
});

test('系统任务补全消除前置 $ 重复，宏函数保留用户参数签名', () => {
    const system = contains('module x; initial $dis§ endmodule', ['display']); assert.ok(system.items.find(item => item.name === 'display').body.startsWith('display('));
    const macro = contains('`define CHECK(a,b) if(a) b\nmodule x; `CH§ endmodule', ['CHECK']); assert.equal(macro.items.find(item => item.name === 'CHECK').body, 'CHECK(${1:a}, ${2:b})');
    contains('`uvm_in§', ['uvm_info']);
});

test('UVM package、类继承与 config_db 参数化静态接口', () => {
    contains('module x; initial uvm_pkg::§ endmodule', ['uvm_component', 'uvm_reg', 'UVM_HIGH', 'run_test']);
    contains('import uvm_pkg::*; class env extends uvm_env; function void f(); this.§ endfunction endclass', ['build_phase', 'get_full_name', 'get_parent', 'connect_phase']);
    contains('module x; initial uvm_config_db#(int)::§ endmodule', ['get', 'set', 'exists', 'wait_modified']);
});

test('UVM utils 注册类可补 factory type_id 与 create 返回具体类', () => {
    const text = 'import uvm_pkg::*; class txn extends uvm_sequence_item; `uvm_object_utils(txn) int data; endclass module x; initial txn::type_id::§ endmodule';
    contains(text, ['create', 'get']);
    contains(text.replace('txn::type_id::§', 'txn::type_id::create("txn").§'), ['data', 'get_name']);
});

test('关闭 UVM 目录后不再补 UVM API，但真实工程声明仍可用', () => {
    assert.equal(query('module x; initial uvm_pkg::§ endmodule', [], { uvm: 'off' }).items.length, 0);
    const result = contains('class uvm_custom; int value; endclass module x; uvm_custom x; initial x.§ endmodule', ['value'], [], { uvm: 'off' });
    assert.ok(!names(result).includes('get_name'));
});

test('include 补全使用相对路径，并在标识符中间提供完整替换区间', () => {
    const include = query('`include "fi§"', ['package p; endpackage']); assert.equal(include.context.kind, 'include'); assert.deepEqual(names(include), ['file0.svh']);
    const middle = contains('module x; string txt; initial txt.to§lower(); endmodule', ['tolower']); assert.equal(middle.context.end - middle.context.start, 7);
});

test('候选容量限制显式返回 incomplete，继续输入仍能定位列表外的声明', () => {
    const declarations = Array.from({ length: 2000 }, (_, i) => 'int value_' + i + ';').join(' ');
    const broad = query('module x; ' + declarations + ' initial § endmodule', [], { maxItems: 100 });
    assert.equal(broad.items.length, 100); assert.equal(broad.incomplete, true);
    const narrow = contains('module x; ' + declarations + ' initial value_199§ endmodule', ['value_1999'], [], { maxItems: 100 });
    assert.equal(narrow.incomplete, false);
});

test('begin_keywords 版本区间与 end_keywords 恢复当前文档标准', () => {
    const old = query('`begin_keywords "1364-1995"\nmodule x; § endmodule'); assert.ok(!names(old).includes('logic')); assert.ok(!names(old).includes('localparam'));
    contains('`begin_keywords "1364-1995"\nmodule x; endmodule\n`end_keywords\n§', ['class', 'interface']);
});

test('数组弹出元素和 UVM driver 的 TLM 泛型成员可继续解析实际类型', () => {
    contains('class item; int data; endclass module x; item q[$]; initial q.pop_front().§ endmodule', ['data']);
    contains('import uvm_pkg::*; class txn extends uvm_sequence_item; int data; endclass class drv extends uvm_driver#(txn); function void f(); seq_item_port.§ endfunction endclass', ['get_next_item', 'item_done', 'put_response']);
    const member = query('import uvm_pkg::*; class txn extends uvm_sequence_item; int data; endclass class drv extends uvm_driver#(txn); function void f(); seq_item_port.get_ne§ endfunction endclass').items.find(item => item.name === 'get_next_item');
    assert.ok(member.signature.includes('txn'));
});

test('匿名及嵌套 struct/union 成员逐层解析', () => {
    contains('module x; struct packed { int data; struct packed { bit valid; } meta; } packet; initial packet.§ endmodule', ['data', 'meta']);
    contains('module x; struct packed { int data; struct packed { bit valid; } meta; } packet; initial packet.meta.§ endmodule', ['valid']);
});

test('覆盖率对象、options、constraint、rand 字段及 event/sequence 的内建接口', () => {
    contains('class C; rand int value; constraint limits { value < 10; } function void f(); value.§ endfunction endclass', ['rand_mode']);
    contains('class C; constraint limits { 1; } function void f(); limits.§ endfunction endclass', ['constraint_mode']);
    contains('module x; covergroup cg; cp: coverpoint value; cross_cp: cross cp; endgroup cg cov; initial cov.§ endmodule', ['sample', 'get_inst_coverage', 'option']);
    contains('module x; covergroup cg; cp: coverpoint value; endgroup cg cov; initial cov.option.§ endmodule', ['goal', 'per_instance', 'auto_bin_max']);
    contains('module x; covergroup cg; cp: coverpoint value; endgroup cg cov; initial cov.cp.§ endmodule', ['get_coverage', 'get_inst_coverage', 'option']);
    const cross = contains('module x; covergroup cg; cp: coverpoint value; cross_cp: cross cp; endgroup cg cov; initial cov.cross_cp.option.§ endmodule', ['weight']);
    assert.ok(!names(cross).includes('auto_bin_max'));
    contains('module x; event ev; initial ev.§ endmodule', ['triggered']);
    contains('module x; sequence s; 1; endsequence initial s.§ endmodule', ['triggered', 'matched']);
});

test('specify 专属时序检查只在 specify 内出现', () => {
    contains('module x; specify $setup§ endspecify endmodule', ['setup', 'setuphold']);
    assert.deepEqual(query('module x; initial $setup§ endmodule').items, []);
});

test('out-of-class 方法实现保留类作用域并生成调用参数', () => {
    const text = 'class C; int value; extern function int read(int index); endclass function int C::read(int index); this.§ endfunction';
    const result = contains(text, ['value', 'read']); assert.ok(!names(result).includes('index'));
    const external = contains(text.replace('this.§', 'value').concat(' module x; C obj; initial obj.re§ endmodule'), ['read']);
    assert.equal(external.items.find(item => item.name === 'read').body, 'read(${1:index})');
});
