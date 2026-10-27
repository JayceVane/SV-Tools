'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { traceContext, buildTraceContext } = require('../src/project/trace-context');
const { createRTLIndex } = require('../src/project/rtl-model');
const file = name => path.resolve('bin', name + '.sv');
const documents = [
    { path: file('adder'), text: 'module adder; genvar i; for(i=0;i<4;i=i+1) begin: g wire q; end endmodule' },
    { path: file('dut'), text: 'module dut(input [7:0] data,output [7:0] out);assign out=data;endmodule' },
    { path: file('tb'), text: 'module tb; reg [7:0] data; wire [7:0] out; dut u_dut(.data(data),.out(out));endmodule' }
];
const project = { top: 'adder', sets: [
        { type: 'DesignSrcs', top: 'adder', files: [file('adder'), file('dut')] },
        { type: 'SimulationSrcs', top: 'tb', files: [file('tb')] }
    ] };
const target = name => ({ moduleName: name, moduleLine: 1, path: file(name) });
test('仿真文件优先仿真顶层，设计文件保留设计集，配置不被修改', () => {
    const before = JSON.stringify(project);
    assert.deepEqual(traceContext(project, file('tb')).tops, ['tb']);
    assert.equal(traceContext(project, file('tb')).kind, 'simulation');
    assert.deepEqual(traceContext(project, file('dut')).tops, ['adder']);
    assert.equal(JSON.stringify(project), before);
});
test('无关综合顶层不能遮蔽选中的TB，回退仅返回所选层级提示', () => {
    const index = createRTLIndex(documents);
    const result = buildTraceContext(index, ['adder'], target('tb'));
    assert.equal(result.top, 'tb');
    assert.equal(result.fallback, true);
    assert.ok(!result.issues.some(issue => issue.startsWith('adder.')));
    assert.deepEqual(result.design.modules.map(module => module.name), ['tb', 'dut']);
});
test('目标在配置顶层内时保留上下文，包括未知类型位宽，不因无法追踪某位宽而改根', () => {
    const index = createRTLIndex([...documents, { path: file('outer'), text: 'module outer; tb u_tb();endmodule' }]);
    const result = buildTraceContext(index, ['outer'], target('dut'));
    assert.equal(result.top, 'outer');
    assert.equal(result.fallback, false);
    const unresolved = createRTLIndex([{ path: file('tb'), text: 'module tb; user_type data;endmodule' }]);
    assert.equal(buildTraceContext(unresolved, ['tb'], target('tb')).fallback, false);
});
test('过期配置顶层可回退，重复模块定义不能静默映射到其它文件', () => {
    assert.equal(buildTraceContext(createRTLIndex(documents), ['missing'], target('tb')).top, 'tb');
    const duplicate = createRTLIndex([...documents, { path: file('duplicate'), text: documents[2].text }]);
    assert.throws(() => buildTraceContext(duplicate, ['tb'], target('tb')), /重复/);
    assert.throws(() => buildTraceContext(createRTLIndex(documents), ['tb'], { ...target('tb'), path: file('wrong') }), /所选模块/);
});
