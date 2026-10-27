'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildRTLDesign } = require('../src/project/rtl-model');
const { constantValue, connectionBits, lexical } = require('../src/project/rtl-expression');
const { traceProjectSignal } = require('../src/project/signal-flow');
const { CircuitSession } = require('../src/circuit/session');
const { sourceHash } = require('../src/circuit/source-snapshots');
const build = (text, top = 'top') => buildRTLDesign([{ path: path.resolve('example.sv'), text }], { top });
const moduleOf = (built, name) => built.design.modules.find(module => module.name === name);
const portOf = (module, name) => module.ports.find(port => port.name === name);
test('常量表达式有界求值，支持参数/算术/clog2而不执行代码', () => {
    const values = new Map([['W', 8], ['DEPTH', 16]]);
    assert.equal(constantValue('W*2-1', values), 15);
    assert.equal(constantValue('$clog2(DEPTH)', values), 4);
    assert.equal(constantValue("8'shff", values), -1);
    assert.equal(constantValue('1 << 4', values), 16);
    assert.equal(constantValue('W > 4 ? 16 : 2', values), 16);
    assert.equal(constantValue('process.exit()'), undefined);
    assert.equal(constantValue('1/0'), undefined);
    assert.equal(constantValue('MISSING+1'), undefined);
    assert.equal(constantValue('999999999999999999999 & 1'), undefined);
    assert.equal(constantValue('9'.repeat(5000)), undefined);
});
test('直接位表达式保留升降序、切片、复制及常量，拒绝运算与越界', () => {
    const signals = new Map([['a', { bits: ['n:0', 'n:1', 'n:2', 'n:3'], offset: 0, upto: false }], ['b', { bits: ['n:4', 'n:5', 'n:6', 'n:7'], offset: 4, upto: true }]]);
    const read = (text, width) => connectionBits(lexical(text), signals, new Map(), width);
    assert.deepEqual(read('{a[1:0],b[4:5]}'), ['n:6', 'n:7', 'n:0', 'n:1']);
    assert.deepEqual(read('{2{a[0]}}'), ['n:0', 'n:0']);
    assert.deepEqual(read('b[4 +: 2]'), ['n:6', 'n:7']);
    assert.deepEqual(read("'1", 4), ['c:1', 'c:1', 'c:1', 'c:1']);
    assert.equal(read('a & 4\'hf'), null);
    assert.equal(read('a[4]'), null);
    assert.equal(read('a[dynamic]'), null);
});
test('三个文件独立时间声明和无关不可综合语句不会阻断静态连接', () => {
    const built = buildRTLDesign([
        { path: '/top.sv', text: 'timeunit 1ns; timeprecision 1ps; module top(input a,output y); leaf u_leaf(.i(a),.o(y)); endmodule' },
        { path: '/leaf.sv', text: 'timeunit 1ns; timeprecision 1ps; module leaf(input i,output o);assign o=i;endmodule' },
        { path: '/unused.sv', text: 'timeunit 1ns; timeprecision 1ps; module unused; initial $display("not synthesizable");endmodule' }
    ], { top: 'top' });
    const top = moduleOf(built, 'top'), flow = traceProjectSignal(built.design, { moduleId: top.id, instancePath: [], origin: { objectId: portOf(top, 'a').id } });
    assert.ok(flow.nodes.find(node => node.names[0] === 'u_leaf').roles.includes('input'));
    assert.equal(built.design.provenance.engine, 'rtl-static');
});
test('多层改名/位重排与重复实例在静态模型中正确隔离', () => {
    const built = build('module leaf(input [7:0] data,output [7:0] result);assign result={data[3:0],data[7:4]};endmodule\nmodule mid(input [7:0] rx,output [7:0] tx);leaf u_leaf(.data(rx),.result(tx));endmodule\nmodule top(input [7:0] a,b,output [7:0] y,z);mid u_a(.rx(a),.tx(y));mid u_b(.rx(b),.tx(z));endmodule');
    const top = moduleOf(built, 'top'), mid = moduleOf(built, 'mid'), leaf = moduleOf(built, 'leaf');
    const flow = traceProjectSignal(built.design, { moduleId: leaf.id, instancePath: [top.cells[0].id, mid.cells[0].id], origin: { objectId: portOf(leaf, 'data').id, indices: [6, 7] } });
    assert.deepEqual(flow.nodes.find(node => node.names.join('.') === 'u_a.u_leaf').details.find(detail => detail.port === 'result').indices, [2, 3]);
    assert.ok(flow.nodes.filter(node => node.names[0] === 'u_b').every(node => !node.roles.length));
});
test('参数覆盖与本地常量决定位宽，不复用另一组参数实例', () => {
    const built = build('module lane #(parameter W=8)(input [W-1:0] i,output [W-1:0] o);localparam P=$clog2(W);wire [P:0] count;assign o=i;endmodule\nmodule top(input [3:0] a, input [7:0] b,output [3:0] x,output [7:0] y);lane #(.W(4)) u_four(.i(a),.o(x));lane #(.W(8)) u_eight(.i(b),.o(y));endmodule');
    const lanes = built.design.modules.filter(module => module.name === 'lane');
    assert.equal(lanes.length, 2);
    assert.deepEqual(lanes.map(module => portOf(module, 'i').bits.length), [4, 8]);
    assert.deepEqual(lanes.map(module => module.signals.find(signal => signal.name === 'count').bits.length), [3, 4]);
});
test('带初值的网线组保持打包范围，变量初值与过程赋值不当作透传', () => {
    const built = build('module top(input [7:0] a,output [7:0] y);wire [7:0] first=a,second;logic [7:0] q=a;always @* q=a;assign y=first;endmodule');
    const top = moduleOf(built, 'top'), signal = name => top.signals.find(signal => signal.name === name);
    assert.equal(signal('second').bits.length, 8);
    assert.deepEqual(signal('first').bits, portOf(top, 'a').bits);
    assert.notDeepEqual(signal('q').bits, portOf(top, 'a').bits);
});
test('非ANSI端口按头部顺序连接，不按声明顺序错接时钟或数据', () => {
    const built = build('module leaf(data,clock,result);output result;input clock;input data;assign result=data;endmodule\nmodule top(input a,clk,output y);leaf u_leaf(a,clk,y);endmodule');
    const top = moduleOf(built, 'top'), cell = top.cells[0];
    assert.deepEqual(cell.ports.find(port => port.name === 'data').bits, portOf(top, 'a').bits);
    assert.deepEqual(cell.ports.find(port => port.name === 'clock').bits, portOf(top, 'clk').bits);
});
test('隐式命名与通配端口连接按已声明端口解析', () => {
    const built = build('module leaf(input a,output y);assign y=a;endmodule\nmodule top(input a,output y);leaf u_leaf(.a,.*);endmodule');
    const top = moduleOf(built, 'top');
    assert.equal(top.cells[0].ports.length, 2);
    assert.deepEqual(top.cells[0].ports[0].bits, portOf(top, 'a').bits);
});
test('宏/未知位宽不能降级成单比特，也不能让顺序端口移位', () => {
    const built = build('module leaf(input [UNKNOWN-1:0] data,other, input clk,output q);assign q=clk;endmodule\nmodule top(input a,b,c,output y);leaf u_leaf(a,b,c,y);endmodule');
    const top = moduleOf(built, 'top'), leaf = moduleOf(built, 'leaf');
    assert.ok(!portOf(leaf, 'data'));
    assert.ok(!portOf(leaf, 'other'));
    assert.deepEqual(top.cells[0].ports.find(port => port.name === 'clk').bits, portOf(top, 'c').bits);
    assert.ok(built.issues.some(issue => issue.includes('声明位宽')));
});
test('条件宏、生成分支和逻辑运算有明确边界，不合并可能互斥的网络', () => {
    for (const body of ['if (C) assign y=a; else assign y=~a;', 'generate if (C) begin assign y=a;end endgenerate', '`ifdef OPTION\nassign y=a;\n`endif', 'assign y=~a;']) {
        const built = build('module top #(parameter C=1)(input a,output y);\n' + body + '\nendmodule');
        const top = moduleOf(built, 'top');
        assert.notDeepEqual(portOf(top, 'a').bits, portOf(top, 'y').bits);
        assert.ok(built.issues.length);
    }
});
test('include guard保留模块，内层条件宏仍保持不确定', () => {
    const built = build('`ifndef TOP_GUARD\n`define TOP_GUARD\nmodule top(input a,output y);\n`ifdef OPTION\nassign y=a;\n`endif\nendmodule\n`endif');
    const top = moduleOf(built, 'top');
    assert.notDeepEqual(portOf(top, 'a').bits, portOf(top, 'y').bits);
});
test('多驱动和潜在条件驱动不把不同输入合并为同一网络', () => {
    for (const second of ['assign y=b;', 'assign y=~b;', 'if(C) assign y=b;', 'generate if(C) begin assign y=b;end endgenerate']) {
        const built = build('module top #(parameter C=1)(input a,b,output y);assign y=a;' + second + 'endmodule'), top = moduleOf(built, 'top');
        assert.notDeepEqual(portOf(top, 'a').bits, portOf(top, 'b').bits);
        assert.notDeepEqual(portOf(top, 'a').bits, portOf(top, 'y').bits);
        assert.ok(built.issues.some(issue => issue.includes('驱动')));
    }
    const built = build('module leaf(input b,output q);assign q=b;endmodule\nmodule top(input a,b,output y);assign y=a;leaf u(.b(b),.q(y));endmodule');
    const top = moduleOf(built, 'top');
    assert.notDeepEqual(portOf(top, 'a').bits, portOf(top, 'y').bits);
    const unknown = build('module top(input a,output y);assign y=a;unknown u(.o(y));endmodule');
    const unresolved = moduleOf(unknown, 'top');
    assert.notDeepEqual(portOf(unresolved, 'a').bits, portOf(unresolved, 'y').bits);
});
test('静态Worker读取字面头文件、复用源码候选并拒绝旧世代，全程不生成网表', { timeout: 20000 }, async (t) => {
    const base = path.resolve(__dirname, '../bin/project-rtl-test');
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'run-'));
    const file = path.join(root, 'top.sv'), header = path.join(root, 'leaf.svh'), text = 'timeunit 1ns;timeprecision 1ps;\n`include "leaf.svh"\nmodule top(input a,output y);leaf u_leaf(.i(a),.o(y));endmodule\n';
    await fs.writeFile(file, text);
    await fs.writeFile(header, '`ifndef LEAF_GUARD\n`define LEAF_GUARD\nmodule leaf(input i,output o);assign o=i;endmodule\n`endif\n');
    const session = new CircuitSession({ workerFile: path.resolve(__dirname, '../src/project/rtl-worker.js') });
    t.after(() => session.dispose());
    const loaded = await session.request('loadRTL', { files: [file], top: 'top' });
    assert.equal(loaded.sourceSnapshots.length, 2);
    const target = await session.request('traceSelection', { text, offset: text.indexOf('input a') + 6 });
    const identity = { designId: loaded.id, revision: loaded.revision };
    const candidates = await session.request('traceCandidates', { ...identity, target: { ...target, path: file, sourceHash: sourceHash(text) } });
    assert.equal(candidates.candidates.length, 1);
    const candidate = candidates.candidates[0], flow = await session.request('projectFlow', { ...identity, moduleId: candidate.moduleId, instancePath: candidate.instancePath, origin: { objectId: candidate.objectId } });
    assert.equal(flow.analysis, 'rtl-static');
    assert.ok(flow.nodes.some(node => node.names[0] === 'u_leaf' && node.roles.length));
    await assert.rejects(session.request('projectFlow', { ...identity, revision: 0 }), /过期/);
    assert.deepEqual((await fs.readdir(root)).sort(), ['leaf.svh', 'top.sv']);
    await fs.writeFile(file, '`ifdef UNKNOWN\n`include "leaf.svh"\n`endif\nmodule top(input a,output y);leaf u(.i(a),.o(y));endmodule\n');
    const conditional = await session.request('loadRTL', { files: [file], top: 'top' });
    assert.equal(conditional.sourceSnapshots.length, 1);
    assert.ok(conditional.issues.some(issue => issue.includes('条件include')));
    await assert.rejects(session.request('projectFlow', identity), /过期/);
});
