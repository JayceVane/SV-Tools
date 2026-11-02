'use strict';
// M4 wave 查询合同：索引缓存命中与身份失效、时间点值/跳变/沿/时钟采样/A-B 差异、
// tick 字符串精确时标与受限 where 条件；角色过滤要求 RTL 匹配且不伪造方向。
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli/main');

const VCD_A = `$timescale 1 ns $end
$scope module tb $end $var wire 1 ! clk $end $var wire 8 # q [7:0] $end $var wire 8 $ d [7:0] $end $upscope $end $enddefinitions $end
$dumpvars 0! b0 # b0 $ $end
#10 1! b1 # b10 $
#20 0! b1x #
#30 1! b11 # b1010 $
#40 0! b100 # b1100 $
`;
const VCD_B = `$timescale 1 ns $end
$scope module tb $end $var wire 1 ! clk $end $var wire 8 # q [7:0] $end $upscope $end $enddefinitions $end
$dumpvars 0! b0 # $end
#10 1! b1 #
#20 0! b101 #
#30 1! b11 #
#40 0! b100 #
`;

/** @param {object} t @param {string} name @param {string} text 写入隔离工作区的 VCD。 @returns {Promise<string>} 工作区路径。 */
async function workspace(t, name, text) {
    const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-wave-')));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    await fsp.writeFile(path.join(directory, name), text);
    return directory;
}

test('wave signals/values/changes：tick 字符串、解码值、游标分页与缓存复用', async t => {
    const directory = await workspace(t, 'trace.vcd', VCD_A);
    const first = (await run(['wave', 'signals', '--workspace', directory, '--file', 'trace.vcd', '--query', 'q'])).output;
    assert.equal(first.status, 'success');
    assert.equal(first.data.timescale, '1 ns');
    assert.equal(first.data.endTime, '40');
    assert.deepEqual(first.data.signals.map(signal => signal.path), ['tb.q']);
    assert.equal(first.data.signals[0].changes, 5);
    assert.equal(first.data.stats.cached, false, '首次解析');
    const second = (await run(['wave', 'signals', '--workspace', directory, '--file', 'trace.vcd'])).output;
    assert.equal(second.data.stats.cached, true, '第二次命中索引缓存');
    assert.ok(second.data.stats.loadMs < 500, '缓存加载是轻量操作');
    // 修改文件后身份失效：缓存不能复活旧数据。
    await fsp.writeFile(path.join(directory, 'trace.vcd'), VCD_A.replace('b100 #', 'b111 #'));
    const renewed = (await run(['wave', 'values', '--workspace', directory, '--file', 'trace.vcd', '--signals', 'tb.q', '--at', '40ns'])).output;
    assert.equal(renewed.status, 'success');
    assert.equal(renewed.data.values['tb.q'].value, '0x07');
    assert.equal(renewed.data.timeText, '40 ns');
    const paged = (await run(['wave', 'changes', '--workspace', directory, '--file', 'trace.vcd', '--signals', 'tb.q', '--limit', '2'])).output;
    assert.equal(paged.data.series[0].total, 5);
    assert.equal(paged.data.series[0].next, '11', 'next 是下一页可直接使用的 --from');
    const rest = (await run(['wave', 'changes', '--workspace', directory, '--file', 'trace.vcd', '--signals', 'tb.q', '--limit', '10', '--from', paged.data.series[0].next])).output;
    assert.deepEqual(rest.data.series[0].events.map(event => event.t), ['20', '30', '40']);
    assert.equal(rest.data.series[0].next, null);
});

test('wave edges：rise/fall/X 搜索，向量沿需要位级投影', async t => {
    const directory = await workspace(t, 'trace.vcd', VCD_A);
    const rise = (await run(['wave', 'edges', '--workspace', directory, '--file', 'trace.vcd', '--signal', 'clk', '--kind', 'rise'])).output;
    assert.deepEqual(rise.data.events, [{ t: '10', from: '0', to: '1' }, { t: '30', from: '0', to: '1' }]);
    const unknown = (await run(['wave', 'edges', '--workspace', directory, '--file', 'trace.vcd', '--signal', 'q', '--kind', 'x'])).output;
    assert.deepEqual(unknown.data.events, [{ t: '20', from: '1', to: '1x' }]);
    const rejected = await run(['wave', 'edges', '--workspace', directory, '--file', 'trace.vcd', '--signal', 'q', '--kind', 'rise']);
    assert.equal(rejected.output.diagnostics[0].code, 'INVALID_ARGUMENT', '向量信号整体没有 rise 语义');
    // bit0 序列 0→1→x→1→0：X 之后回到 1 不构成 rise，与采样沿的未知态语义一致。
    const bit = (await run(['wave', 'edges', '--workspace', directory, '--file', 'trace.vcd', '--signal', 'q', '--bit', '0', '--kind', 'rise'])).output;
    assert.deepEqual(bit.data.events.map(event => event.t), ['10']);
});

test('wave sample：时钟沿采样与 where 条件定位首个异常', async t => {
    const directory = await workspace(t, 'trace.vcd', VCD_A);
    const plain = (await run(['wave', 'sample', '--workspace', directory, '--file', 'trace.vcd', '--clock', 'clk', '--clock-edge', 'rise', '--signals', 'q,d'])).output;
    assert.deepEqual(plain.data.samples.map(sample => sample.t), ['10', '30']);
    assert.equal(plain.data.scannedEdges, 2);
    // rise 沿 t10/t30：q 分别为 0x01 与 0x03（b11），都不等于 8'h11。
    const bad = (await run(['wave', 'sample', '--workspace', directory, '--file', 'trace.vcd', '--clock', 'clk', '--signals', 'q', "--where", "q != 8'h11"])).output;
    assert.equal(bad.data.matched, 2);
    assert.deepEqual(bad.data.samples.map(sample => sample.values['tb.q'].value), ['0x01', '0x03']);
    const withX = (await run(['wave', 'sample', '--workspace', directory, '--file', 'trace.vcd', '--clock', 'clk', '--signals', 'q', '--where', 'q contains-x', '--clock-edge', 'both'])).output;
    // both 沿 10/20/30/40；t=20 时刻 q 的新值 1x 含 x。
    assert.deepEqual(withX.data.samples.map(sample => sample.t), ['20']);
});

test('wave diff：首差异时刻与差异计数，短名剥 range 匹配', async t => {
    const directory = await workspace(t, 'trace.vcd', VCD_A);
    await fsp.writeFile(path.join(directory, 'other.vcd'), VCD_B);
    const output = (await run(['wave', 'diff', '--workspace', directory, '--file', 'trace.vcd', '--against', 'other.vcd', '--signals', 'q'])).output;
    assert.equal(output.status, 'success');
    assert.equal(output.data.pairs, 1);
    assert.equal(output.data.totalDiffs, 1);
    assert.deepEqual(output.data.firstDiff, { path: 'tb.q[7:0]', t: '20', a: '1x', b: '101' });
    const missing = await run(['wave', 'diff', '--workspace', directory, '--file', 'trace.vcd', '--against', 'missing.vcd']);
    assert.equal(missing.output.diagnostics[0].code, 'SOURCE_NOT_FOUND');
});

test('wave 信号解析与错误合同：未命中/时间非法的退出码为 2', async t => {
    const directory = await workspace(t, 'trace.vcd', VCD_A);
    const notFound = await run(['wave', 'values', '--workspace', directory, '--file', 'trace.vcd', '--signals', 'tb.nothing', '--at', '5']);
    assert.equal(notFound.exitCode, 2);
    assert.equal(notFound.output.diagnostics[0].code, 'SIGNAL_NOT_FOUND');
    assert.ok(Array.isArray(notFound.output.data.candidates), '候选列表随失败详情返回');
    const noAt = await run(['wave', 'values', '--workspace', directory, '--file', 'trace.vcd', '--signals', 'q']);
    assert.equal(noAt.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    const badTime = await run(['wave', 'values', '--workspace', directory, '--file', 'trace.vcd', '--signals', 'q', '--at', '5ls']);
    assert.equal(badTime.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    const past = await run(['wave', 'values', '--workspace', directory, '--file', 'trace.vcd', '--signals', 'q', '--at', '999']);
    assert.equal(past.output.diagnostics[0].code, 'INVALID_ARGUMENT', '--at 超出记录范围要拒绝');
    const broken = await run(['wave', 'changes', '--workspace', directory, '--file', 'trace.vcd', '--signals', 'q', '--from', '30', '--to', '10']);
    assert.equal(broken.output.diagnostics[0].code, 'INVALID_ARGUMENT', 'from 晚于 to 要拒绝');
});

test('wave signals --role：RTL 匹配到唯一端口才标方向，垃圾条件不伪造', async t => {
    const directory = await workspace(t, 'trace.vcd', VCD_A);
    await fsp.writeFile(path.join(directory, 'dut.sv'), 'module tb(input wire clk, output wire [7:0] q);\nendmodule\n');
    const inputs = (await run(['wave', 'signals', '--workspace', directory, '--file', 'trace.vcd', '--role', 'input'])).output;
    assert.deepEqual(inputs.data.signals.map(signal => signal.path), ['tb.clk'], 'clk 是唯一 input');
    assert.match(inputs.data.sourceRoleNote, /RTL方向匹配/);
    const outputs = (await run(['wave', 'signals', '--workspace', directory, '--file', 'trace.vcd', '--role', 'output'])).output;
    assert.deepEqual(outputs.data.signals.map(signal => signal.path), ['tb.q']);
    const none = (await run(['wave', 'signals', '--workspace', directory, '--file', 'trace.vcd', '--role', 'inout'])).output;
    assert.equal(none.status, 'success');
    assert.deepEqual(none.data.signals, []);
});
