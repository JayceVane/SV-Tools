'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { tokenize, matchDelimiters, parseDocument, contextAt } = require('../src/editor/completion/syntax');

function cursor(source) {
    const offset = source.indexOf('¦');
    assert.notEqual(offset, -1);
    const text = source.replace('¦', '');
    const model = parseDocument(text);
    return { model, context: contextAt(model, offset), offset };
}

function named(model, name, scope = null) {
    const symbols = model.symbols.filter(symbol => symbol.name === name && (scope === null || model.scopes[symbol.scope].name === scope));
    assert.equal(symbols.length, 1, `需要唯一的 ${scope ? scope + '::' : ''}${name}，实际 ${symbols.length}`);
    return symbols[0];
}

test('lexer 忽略注释内关键字，保留字符串、转义名称、数字和原始位置', () => {
    const text = '// module ghost\nmodule real; wire \\escaped.name ; string s="endclass \\""; logic [7:0] v=8\'hff; endmodule';
    const tokens = tokenize(text);
    assert.equal(tokens[0].kind, 'comment');
    assert.equal(tokens.find(token => token.value === '\\escaped.name').kind, 'identifier');
    assert.equal(tokens.find(token => token.value === "8'hff").kind, 'number');
    assert.equal(tokens.filter(token => token.kind === 'string').length, 1);
    for (const token of tokens) assert.equal(text.slice(token.start, token.end), token.value);
    assert.deepEqual(parseDocument(text).scopes.map(scope => scope.name), ['', 'real']);
});

test('define 包含续行和 begin/end 时不污染作用域', () => {
    const model = parseDocument('`define DO_IT(a,b) begin \\\n a=b; \\\n end\nmodule good; `DO_IT(x,y)\n logic value; endmodule');
    assert.equal(model.macros.length, 1);
    assert.deepEqual(model.macros[0].parameters, ['a', 'b']);
    assert.equal(model.macros[0].name, 'DO_IT');
    assert.equal(model.macros[0].body, undefined);
    assert.match(model.macros[0].definitionBody, /begin/);
    assert.deepEqual(model.scopes.map(scope => scope.name), ['', 'good']);
    assert.equal(named(model, 'value').type, 'logic');
});

test('delimiter pairing 匹配混合嵌套，并容忍尚未完成的括号', () => {
    const tokens = tokenize('foo({a[2], b()}), unfinished(');
    const pairs = matchDelimiters(tokens);
    const begin = tokens.findIndex(token => token.value === '(');
    assert.equal(tokens[pairs.get(begin)].value, ')');
    assert.equal(pairs.get(pairs.get(begin)), begin);
    assert.equal(pairs.has(tokens.length - 1), false);
});

test('ANSI 端口和 parameter 列表继承类型，packed 不误判为数组对象', () => {
    const model = parseDocument('module fifo #(parameter int WIDTH=8, DEPTH=16)(input logic [WIDTH-1:0] data, next_data, output logic done); endmodule');
    assert.equal(named(model, 'WIDTH').kind, 'parameter');
    assert.equal(named(model, 'DEPTH').type, 'int');
    assert.equal(named(model, 'data').kind, 'port');
    assert.equal(named(model, 'data').type, 'logic');
    assert.equal(named(model, 'data').array, undefined);
    assert.equal(named(model, 'next_data').direction, 'input');
    assert.equal(named(model, 'done').direction, 'output');
});

test('header localparam 不能误列为可覆盖 parameter，常量数组大小区别于 typedef 键', () => {
    const model = parseDocument('module m #(parameter N=8, localparam A=1,B=2)(); typedef string key_t; int fixed[N]; int assoc[key_t]; endmodule');
    assert.equal(named(model, 'A').kind, 'localparam');
    assert.equal(named(model, 'B').kind, 'localparam');
    assert.equal(named(model, 'fixed').array.kind, 'fixed');
    assert.equal(named(model, 'assoc').array.kind, 'associative');
});

test('非 ANSI 端口、parameter、localparam、net 和多声明建立独立符号', () => {
    const model = parseDocument('module m(a,b); input [7:0] a; output b; parameter A=1,B=2; localparam int C=3; wire n,p; endmodule');
    assert.equal(named(model, 'a').kind, 'port');
    assert.equal(named(model, 'b').kind, 'port');
    assert.equal(named(model, 'A').kind, 'parameter');
    assert.equal(named(model, 'B').kind, 'parameter');
    assert.equal(named(model, 'C').kind, 'localparam');
    assert.equal(named(model, 'n').kind, 'net');
    assert.equal(named(model, 'p').kind, 'net');
});

test('class 泛型、继承和 extern/pure virtual 原型不会吞并后续字段', () => {
    const model = parseDocument(`package pkg;
class base #(type T=int, int N=4);
 protected T queue[$];
 extern virtual function string get_name();
 pure virtual task execute(input int n);
 static int count;
 function T get(input int i); T result; return result; endfunction
endclass
class child extends base #(pkg::item_t, 8); local int state; endclass
endpackage`);
    const base = named(model, 'base');
    assert.deepEqual(base.parameters.map(symbol => [symbol.name, symbol.default]), [['T', 'int'], ['N', '4']]);
    assert.equal(named(model, 'child').base, 'base # ( pkg::item_t , 8 )');
    assert.equal(named(model, 'queue').visibility, 'protected');
    assert.equal(named(model, 'count').static, true);
    assert.equal(named(model, 'state').visibility, 'local');
    assert.equal(named(model, 'get_name').returnType, 'string');
    assert.equal(named(model, 'get').returnType, 'T');
    assert.equal(model.scopes[named(model, 'count').scope].kind, 'class');
    assert.equal(model.scopes[named(model, 'result').scope].kind, 'function');
    assert.equal(named(model, 'i').kind, 'port');
});

test('DPI import 函数是原型，后续模块声明保留独立作用域', () => {
    const model = parseDocument('import "DPI-C" function int foreign(input int a); module m; int local_data; endmodule');
    assert.equal(named(model, 'foreign').returnType, 'int');
    assert.equal(named(model, 'local_data', 'm').type, 'int');
    assert.equal(named(model, 'm').scope, 0);
});

test('qualified 返回类型保留，与 out-of-class 方法 owner 分别解析', () => {
    const model = parseDocument('class C; function pkg::item_t get(input int index); endfunction endclass function pkg::item_t pkg::C::get(input int index); endfunction');
    assert.equal(named(model, 'get', 'C').returnType, 'pkg::item_t');
    assert.equal(named(model, 'get', '').returnType, 'pkg::item_t');
    assert.equal(named(model, 'get', '').owner, 'pkg::C');
    assert.deepEqual(named(model, 'get', 'C').arguments.map(symbol => symbol.name), ['index']);
});

test('typedef struct 和 enum 的成员、别名和枚举常量可分辨', () => {
    const model = parseDocument('package p; typedef struct packed {logic [7:0] data; int tag;} item_t; typedef enum logic[1:0] {IDLE=0,RUN,DONE} state_t; item_t item; endpackage');
    assert.deepEqual(named(model, 'item_t').members.map(symbol => [symbol.name, symbol.type]), [['data', 'logic'], ['tag', 'int']]);
    assert.equal(named(model, 'state_t').type, 'enum');
    assert.equal(named(model, 'RUN').kind, 'enumMember');
    assert.equal(named(model, 'RUN').type, 'state_t');
    assert.equal(named(model, 'item').type, 'item_t');
});

test('匿名和 typedef 的嵌套 struct/union 保存每层实际成员和数组', () => {
    const model = parseDocument(`package p;
typedef struct packed { union packed {logic [7:0] byte_data; struct packed {logic valid; logic [6:0] code;} meta;} payload; int tag;} packet_t;
struct {string name; struct {int count; byte data[];} inner;} anonymous;
union packed {int whole; logic [31:0] bits;} storage;
endpackage`);
    const packet = named(model, 'packet_t');
    assert.deepEqual(packet.members.map(member => member.name), ['payload', 'tag']);
    const payload = packet.members[0];
    assert.equal(payload.type, 'union');
    assert.deepEqual(payload.members.map(member => member.name), ['byte_data', 'meta']);
    assert.deepEqual(payload.members[1].members.map(member => member.name), ['valid', 'code']);
    assert.equal(named(model, 'anonymous').members[1].members[1].array.kind, 'dynamic');
    assert.equal(named(model, 'storage').type, 'union');
    assert.equal(model.scopes[1].symbols.some(symbol => symbol.name === 'byte_data'), false);
});

test('covergroup 命名 coverpoint/cross 保留成员类型，bins 不污染外层', () => {
    const model = parseDocument(`class monitor;
int value; int state;
covergroup cg @(posedge clk);
cp_value: coverpoint value { bins low[] = {[0:3]}; }
cp_state: coverpoint state;
cp_cross: cross cp_value, cp_state { ignore_bins none = binsof(cp_value) intersect {0}; }
endgroup
int after_group;
endclass`);
    const group = named(model, 'cg');
    assert.deepEqual(group.members.filter(symbol => ['coverpoint', 'cross'].includes(symbol.kind)).map(symbol => [symbol.name, symbol.kind, symbol.type]),
        [['cp_value', 'coverpoint', 'coverpoint'], ['cp_state', 'coverpoint', 'coverpoint'], ['cp_cross', 'cross', 'cross']]);
    assert.equal(named(model, 'after_group').type, 'int');
    assert.equal(model.scopes[named(model, 'cp_value').scope].kind, 'covergroup');
    assert.equal(group.members.some(symbol => symbol.name === 'low' || symbol.name === 'none'), false);
});

test('命名 constraint 和 rand/randc 字段保存随机化资格', () => {
    const model = parseDocument('class item; rand int addr, data; randc bit [1:0] kind; int normal; rand struct packed {logic valid;} packet; protected constraint legal {addr < 4; data >= 0;} int tail; endclass');
    for (const name of ['addr', 'data', 'kind', 'packet']) assert.equal(named(model, name).random, true);
    assert.equal(named(model, 'normal').random, undefined);
    assert.equal(named(model, 'legal').kind, 'constraint');
    assert.equal(named(model, 'legal').type, 'constraint');
    assert.equal(named(model, 'legal').visibility, 'protected');
    assert.equal(named(model, 'tail').type, 'int');
});

test('类外 function/task 实现合并到对应类，入参和字段查询回到类作用域', () => {
    const { model, context } = cursor(`package p;
class C;
 protected int secret;
 extern virtual function string get(input int id);
 extern task put(input int data);
endclass
function string C::get(input int id); string temp; secret¦; return temp; endfunction
task C::put(input int data); secret = data; endtask
endpackage`);
    const cls = named(model, 'C');
    assert.equal(cls.members.filter(symbol => symbol.name === 'get').length, 1);
    const get = named(model, 'get', 'C');
    assert.equal(get.owner, 'C');
    assert.deepEqual(get.arguments.map(argument => argument.name), ['id']);
    assert.equal(context.scope.id, get.bodyScope);
    assert.equal(model.scopes[context.scope.parent].id, cls.bodyScope);
    assert.equal(named(model, 'put', 'C').owner, 'C');
    assert.equal(model.scopes[1].symbols.some(symbol => ['get', 'put', 'id', 'data', 'temp'].includes(symbol.name)), false);
});

test('specify 有独立作用域，foreach 索引保留整数及迭代来源', () => {
    const { context } = cursor('module m(input a, output b); specify (a=>b)=1; $set¦up(a,b,2); endspecify endmodule');
    assert.equal(context.scope.kind, 'specify');
    const model = parseDocument('module m; int arr[4]; initial foreach(arr[idx]) begin idx; end endmodule');
    assert.equal(named(model, 'idx').type, 'int');
    assert.equal(named(model, 'idx').iteratorKind, 'foreachIndex');
});

test('数组区分 queue/dynamic/associative/fixed 和二维 unpacked 维度', () => {
    const model = parseDocument('module m; byte q[$:16]; int d[]; string a[string]; logic [7:0] mem[0:15][0:31]; endmodule');
    assert.equal(named(model, 'q').array.kind, 'queue');
    assert.equal(named(model, 'd').array.kind, 'dynamic');
    assert.equal(named(model, 'a').array.kind, 'associative');
    assert.equal(named(model, 'mem').array.kind, 'fixed');
    assert.equal(named(model, 'mem').array.dimensions.length, 2);
});

test('嵌套 named block 中声明不泄漏到 module 或外层函数', () => {
    const { model, context } = cursor('module m; int global_data; initial begin : drive int local_data; begin int nested_data; nested_data¦; end end endmodule');
    const local = named(model, 'local_data');
    const nested = named(model, 'nested_data');
    assert.equal(model.scopes[local.scope].name, 'drive');
    assert.equal(model.scopes[nested.scope].kind, 'block');
    assert.equal(context.scope.id, nested.scope);
    assert.equal(model.scopes[named(model, 'm').bodyScope].symbols.some(symbol => symbol.name === 'local_data'), false);
});

test('for/foreach 的局部索引只在循环内部可见，constraint 后字段不丢失', () => {
    const { model, context } = cursor('module m; initial begin for(int i=0;i<4;i++) begin int value; i¦; end int after_loop; end endmodule');
    const index = named(model, 'i');
    assert.equal(model.scopes[index.scope].loopKind, 'for');
    assert.equal(model.scopes[context.scope.parent].id, index.scope);
    assert.notEqual(named(model, 'after_loop').scope, index.scope);
    const loops = parseDocument('class c; rand int mem[2][3]; constraint limits { foreach(mem[i,j]) mem[i][j] < 4; } int state; function void f(); foreach(mem[row,col]) begin int value; end endfunction endclass');
    assert.equal(named(loops, 'state').type, 'int');
    assert.equal(named(loops, 'row').type, 'int');
    assert.equal(named(loops, 'col').type, 'int');
    assert.equal(loops.scopes[named(loops, 'state').scope].kind, 'class');
});

test('包 import wildcard 与指定符号按作用域保存', () => {
    const model = parseDocument('import root_pkg::*; package p; import types::item_t, cfg::*; class c; import nested::value; endclass endpackage');
    assert.deepEqual(model.imports.map(entry => [entry.package, entry.name, entry.wildcard, model.scopes[entry.scope].name]),
        [['root_pkg', '*', true, ''], ['types', 'item_t', false, 'p'], ['cfg', '*', true, 'p'], ['nested', 'value', false, 'c']]);
});

test('virtual interface 声明不打开 interface scope；modport 保存类型', () => {
    const model = parseDocument('interface bus(input logic clk); logic valid; modport drv(output valid), mon(input valid); endinterface class c; virtual bus.drv vif; int count; endclass');
    assert.deepEqual(model.scopes.map(scope => scope.kind), ['root', 'interface', 'class']);
    assert.equal(named(model, 'drv').kind, 'modport');
    assert.equal(named(model, 'mon').kind, 'modport');
    assert.equal(named(model, 'vif').type, 'bus.drv');
    assert.equal(named(model, 'count').type, 'int');
});

test('modport 仅公开命名端口/别名和导入方法，保留源类型和方向', () => {
    const model = parseDocument(`interface bus(input logic clk);
logic valid; int data; logic hidden;
function int read(input int index); return data; endfunction
modport drv(input clk, output valid, data, import read), mon(input .sampled(valid));
endinterface`);
    const driver = named(model, 'drv');
    assert.deepEqual(driver.members.map(symbol => [symbol.name, symbol.kind, symbol.type, symbol.direction]),
        [['clk', 'port', 'logic', 'input'], ['valid', 'port', 'logic', 'output'], ['data', 'port', 'int', 'output'], ['read', 'function', 'int', 'import']]);
    assert.equal(driver.members.some(symbol => symbol.name === 'hidden'), false);
    assert.deepEqual(named(model, 'mon').members.map(symbol => [symbol.name, symbol.sourceName, symbol.type]), [['sampled', 'valid', 'logic']]);
});

test('qualified 常量引用和普通表达式不凭空声明变量', () => {
    const model = parseDocument('module m; pkg::VALUE; object.field; a+b; assign a=b; endmodule');
    assert.deepEqual(model.scopes[1].symbols, []);
});

test('命名 parameter 和 port 跨越超过 30 行且保留已用名称', () => {
    const parameters = cursor('module tb; child #( .WIDTH(8),\n' + '\n'.repeat(40) + ' .DE¦ ) u_dut( .clk(clk), .data(data)); endmodule');
    assert.equal(parameters.context.kind, 'parameter');
    assert.equal(parameters.context.instance.type, 'child');
    assert.equal(parameters.context.instance.name, 'u_dut');
    assert.deepEqual(parameters.context.usedNames, ['WIDTH', 'DE']);
    assert.equal(parameters.context.prefix, 'DE');
    const ports = cursor('module tb; child #(.WIDTH(foo(1,2))) u_dut( .clk(clk), .d¦ ); endmodule');
    assert.equal(ports.context.kind, 'port');
    assert.deepEqual(ports.context.usedNames, ['clk', 'd']);
});

test('未完成实例参数和端口仍能建立上下文', () => {
    assert.equal(cursor('module tb; child #(.WI¦').context.kind, 'parameter');
    assert.equal(cursor('module tb; child u_dut(.cl¦').context.kind, 'port');
});

test('连接表达式内对象成员与函数调用不误判为命名端口', () => {
    const { context } = cursor('module tb; child u_dut(.data(packet.payload¦)); endmodule');
    assert.equal(context.kind, 'member');
    assert.equal(context.receiver, 'packet');
    assert.equal(context.prefix, 'payload');
    const call = cursor('module tb; initial begin check(packet.field¦); end endmodule');
    assert.equal(call.context.kind, 'member');
    assert.equal(call.model.instances.length, 0);
});

test('同一声明多个实例各自具备端口范围', () => {
    const { model, context } = cursor('module tb; child #(.WIDTH(8)) u0(.clk(clk)), u1(.cl¦); endmodule');
    assert.deepEqual(model.instances.map(instance => instance.name), ['u0', 'u1']);
    assert.equal(context.instance.name, 'u1');
    assert.deepEqual(context.usedNames, ['cl']);
});

test('链式成员、下标、调用返回值和参数化 static receiver 保留原表达式', () => {
    const cases = [
        ['module m; initial handle.array[2].field¦; endmodule', 'member', 'handle.array[2]'],
        ['module m; initial obj.get_item(3).na¦; endmodule', 'member', 'obj.get_item(3)'],
        ['class c; function void f(); pkg::klass#(int, 8)::ty¦; endfunction endclass', 'scope', 'pkg::klass#(int, 8)'],
        ['class c; function void f(); this.fi¦; endfunction endclass', 'member', 'this']
    ];
    for (const [source, kind, receiver] of cases) {
        const { context } = cursor(source);
        assert.equal(context.kind, kind);
        assert.equal(context.receiver, receiver);
    }
});

test('宏、系统任务和替换 range 不包含前导符号', () => {
    const macro = cursor('`uvm_in¦fo("id","msg",UVM_LOW)');
    assert.equal(macro.context.kind, 'macro');
    assert.equal(macro.context.prefix, 'uvm_in');
    assert.equal(macro.model.text.slice(macro.context.start, macro.context.end), 'uvm_info');
    const system = cursor('module m; initial $disp¦lay("x"); endmodule');
    assert.equal(system.context.kind, 'system');
    assert.equal(system.context.prefix, 'disp');
    assert.equal(system.model.text.slice(system.context.start, system.context.end), 'display');
});

test('二分定位覆盖名称首部、中部、尾部、空白与 escaped identifier', () => {
    for (const source of ['module m; initial obj.¦payload; endmodule', 'module m; initial obj.pay¦load; endmodule', 'module m; initial obj.payload¦; endmodule']) {
        const { model, context } = cursor(source);
        assert.equal(context.kind, 'member');
        assert.equal(context.receiver, 'obj');
        assert.equal(model.text.slice(context.start, context.end), 'payload');
    }
    const escaped = cursor('module m; logic \\strange.na¦me ; endmodule');
    assert.equal(escaped.context.prefix, '\\strange.na');
    assert.equal(escaped.model.text.slice(escaped.context.start, escaped.context.end), '\\strange.name');
    const blank = cursor('module m; initial obj. ¦ endmodule');
    assert.equal(blank.context.kind, 'member');
    assert.equal(blank.context.prefix, '');
    assert.equal(blank.context.start, blank.offset);
    const system = cursor('module m; initial $¦display(); endmodule');
    assert.equal(system.context.kind, 'system');
    assert.equal(system.context.prefix, '');
    assert.equal(system.model.text.slice(system.context.start, system.context.end), 'display');
});

test('注释字符串 suppress，include 路径返回独立前缀和替换范围', () => {
    assert.equal(cursor('// obj.fi¦').context.kind, 'comment');
    assert.equal(cursor('/* obj.fi¦ */').context.kind, 'comment');
    assert.equal(cursor('`define DO_IT(a) a.¦').context.kind, 'comment');
    assert.equal(cursor('initial $display("obj.fi¦");').context.kind, 'string');
    const include = cursor('`include "sub/fi¦le.svh"');
    assert.equal(include.context.kind, 'include');
    assert.equal(include.context.prefix, 'sub/fi');
    assert.equal(include.model.text.slice(include.context.start, include.context.end), 'sub/file.svh');
    assert.equal(cursor('`include "sub/fi¦').context.kind, 'include');
});

test('未闭合 class/function/block 保持最后声明的实际词法作用域', () => {
    const { model, context } = cursor('class c; function void f(); int v; begin int x; x¦');
    assert.equal(context.scope.kind, 'block');
    assert.equal(context.scope.id, named(model, 'x').scope);
    assert.equal(model.scopes[context.scope.parent].kind, 'function');
    assert.equal(model.scopes[named(model, 'v').scope].kind, 'function');
});

test('同一大型作用域保留全部声明，重复端口声明不会重复候选', () => {
    const count = 10000;
    const declarations = Array.from({ length: count }, (_, index) => `logic [31:0] word_${index};`).join('\n');
    const model = parseDocument(`module large(input logic clk); input clk;\n${declarations}\nendmodule`);
    const scope = model.scopes[1];
    assert.equal(scope.symbols.length, count + 1);
    assert.equal(scope.symbols.filter(symbol => symbol.name === 'clk').length, 1);
    assert.equal(scope.symbols[scope.symbols.length - 1].name, 'word_9999');
});
