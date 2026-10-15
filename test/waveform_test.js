'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseVcd, buildSignalTree, parseTimescaleSeconds } = require('../src/waveform/parser');

const waveform = [
    '$date 2026-10-12 $end',
    '$version',
    'svtools contract fixture',
    '$end',
    '$timescale',
    '10 ps',
    '$end',
    '$scope module tb $end',
    '$var wire 1 ! clk $end',
    '$var wire 8 # data [7:0] $end',
    '$var real 1 % temperature $end',
    '$var parameter 32 & WIDTH $end',
    '$scope module dut $end',
    '$var wire 1 ! clk_alias $end',
    '$var wire 1 " valid $end',
    '$upscope $end',
    '$upscope $end',
    '$enddefinitions $end',
    '$dumpvars',
    '0!',
    'X"',
    'b00000000 #',
    'r25.5 %',
    'b1000 &',
    '$end',
    '#10',
    '1!',
    'Z"',
    'B10100101 #',
    '#20',
    '$dumpall',
    '0!',
    'r-3.25 %',
    '$end',
    '#30',
    'b1x0z #',
    ''
].join('\n');

test('VCD 同时支持行内和多行头信息，并读取时间单位', () => {
    const parsed = parseVcd(waveform.replace(/\n/g, '\r\n'));
    assert.deepEqual(parsed.headers, [
        { key: '$date', value: '2026-10-12' },
        { key: '$version', value: 'svtools contract fixture' },
        { key: '$timescale', value: '10 ps' }
    ]);
    assert.equal(parsed.timescale, '10 ps');
    assert.equal(parsed.endTime, 30);
});

test('VCD 信号保留作用域、向量宽度及 alias 定义', () => {
    const parsed = parseVcd(waveform);
    assert.deepEqual(parsed.scopes.map(scope => scope.path), ['tb', 'tb.dut']);
    assert.deepEqual(parsed.vars.map(signal => [signal.path, signal.id, signal.width]), [
        ['tb.clk', '!', 1],
        ['tb.data', '#', 8],
        ['tb.temperature', '%', 1],
        ['tb.WIDTH', '&', 32],
        ['tb.dut.clk_alias', '!', 1],
        ['tb.dut.valid', '"', 1]
    ]);
});

test('VCD 初始值、标量 X/Z、向量及实数按时间保留', () => {
    const parsed = parseVcd(waveform);
    assert.deepEqual(parsed.changes.get('"'), [{ t: 0, value: 'x' }, { t: 10, value: 'z' }]);
    assert.deepEqual(parsed.changes.get('#'), [
        { t: 0, value: '00000000' },
        { t: 10, value: '10100101' },
        { t: 30, value: '1x0z' }
    ]);
    assert.deepEqual(parsed.changes.get('%'), [{ t: 0, value: '25.5' }, { t: 20, value: '-3.25' }]);
});

test('非零时刻的 dumpall 使用当前时间，不能回到零时刻', () => {
    const parsed = parseVcd(waveform);
    assert.deepEqual(parsed.changes.get('!'), [
        { t: 0, value: '0' },
        { t: 10, value: '1' },
        { t: 20, value: '0' }
    ]);
});

test('信号树保留 alias 并排除参数', () => {
    const tree = buildSignalTree(parseVcd(waveform));
    const top = tree.children.find(node => node.path === 'tb');
    const child = top.children.find(node => node.path === 'tb.dut');
    assert.equal(top.children.some(node => node.name === 'WIDTH'), false);
    assert.equal(top.children.find(node => node.name === 'clk').hasChanges, true);
    assert.equal(child.children.find(node => node.name === 'clk_alias').id, '!');
    assert.equal(child.children.find(node => node.name === 'clk_alias').hasChanges, true);
});

test('无变更信号仍出现在树中，时间信息缺失时安全返回', () => {
    const parsed = parseVcd('$scope module empty $end\n$var wire 1 ! idle $end\n$upscope $end\n$enddefinitions $end\n');
    const signal = buildSignalTree(parsed).children[0].children[0];
    assert.equal(signal.hasChanges, false);
    assert.equal(parsed.endTime, 0);
    assert.equal(parsed.timescale, '');
});

for (const [source, expected] of [['1ns', 1e-9], ['10 ps', 1e-11], ['100FS', 1e-13], ['1sec', 1], ['2 usec', 2e-6]]) {
    test(`时间尺度转换：${source}`, () => {
        assert.ok(Math.abs(parseTimescaleSeconds(source) - expected) <= expected * 1e-12);
    });
}

for (const source of ['', 'abc', '10 elephants']) {
    test(`非法时间尺度返回 null：${JSON.stringify(source)}`, () => {
        assert.equal(parseTimescaleSeconds(source), null);
    });
}
