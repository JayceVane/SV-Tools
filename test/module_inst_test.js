'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createNativeLoader } = require('../src/native-loader');
const native = createNativeLoader({ rootDir: path.join(__dirname, '..') }).load();
const source = fs.readFileSync(path.join(__dirname, 'fixtures/codegen/cdc_hs_bits.sv'), 'utf8');
const names = ['i_clk_a', 'i_rst_n_a', 'i_clk_b', 'i_rst_n_b', 'i_data_a', 'i_valid_a', 'o_valid_b', 'o_data_b'];

/** 核对生成结果的实际连接，而不依赖列宽或注释文字。 */
function assertPortBindings(result, expected) {
    assert.equal(result.success, true, result.error);
    const bindings = [...result.result.matchAll(/^\s*\.(\w+)\s*\(\s*(\w+)\s*\)/gm)]
        .filter(([, name]) => expected.includes(name)).map(([, name, signal]) => [name, signal]);
    assert.deepEqual(bindings, expected.map(name => [name, name]), result.result);
}

for (const includeDeclarations of [true, false]) {
    test(`CDC实例逐端口同名连接，声明开关=${includeDeclarations}`, () => {
        const result = native.generateModuleInst(source, { includeDeclarations });
        assertPortBindings(result, names);
        assert.equal(result.module, 'cdc_hs_bits');
        for (const name of names) {
            const declarations = [...result.result.matchAll(new RegExp('^(?:reg|wire)\\s+[^;]*\\b' + name + '\\s*;', 'gm'))];
            assert.equal(declarations.length, includeDeclarations ? 1 : 0, result.result);
        }
        assert.match(result.result, /\.DATA_WIDTH\s*\(DATA_WIDTH\)/);
        assert.match(result.result, /\.CDC_LEVEL\s*\(CDC_LEVEL\)/);
    });
}

test('时钟和复位配置列表不是别名表，反向顺序及无关名字不改变连接', () => {
    const result = native.generateModuleInst(source, { instPrefix: 'dut_',
        clock: ['unrelated_clk', 'i_clk_b', 'i_clk_a'], reset: ['unrelated_reset', 'i_rst_n_b', 'i_rst_n_a'] });
    assertPortBindings(result, names);
    assert.match(result.result, /\) dut_cdc_hs_bits\s*\(/);
    assert.doesNotMatch(result.result, /\bunrelated_(?:clk|reset)\b/);
});

test('非ANSI端口与普通输入输出双向端口也逐端口连接', () => {
    const text = 'module legacy(clk_a, rst_a, clk_b, rst_b, d, q, pad);\n'
        + 'input clk_a, rst_a, clk_b, rst_b; input [7:0] d; output [7:0] q; inout pad;\n'
        + 'always @(posedge clk_a or negedge rst_a) q<=d;\n'
        + 'always @(posedge clk_b or negedge rst_b) q<=d;\nendmodule\n';
    assertPortBindings(native.generateModuleInst(text, {}), ['clk_a', 'rst_a', 'clk_b', 'rst_b', 'd', 'q', 'pad']);
});

test('单时钟域实例与时钟/复位输出端口保持同名', () => {
    const text = 'module single(input clk, input rst_n, input data, output clk_o, output rst_n_o);\n'
        + 'always @(posedge clk or negedge rst_n) q<=data;\nendmodule\n';
    assertPortBindings(native.generateModuleInst(text, {}), ['clk', 'rst_n', 'data', 'clk_o', 'rst_n_o']);
});

test('共享实例生成器用于Testbench时，额外时钟域保持独立且有信号声明', () => {
    const result = native.generateTestbench(source, { clock: [], reset: [], sreset: [], taskDrive: false, taskInit: false, waveType: 'vcd' });
    assertPortBindings(result, names);
    for (const name of ['i_clk_a', 'i_rst_n_a', 'i_clk_b', 'i_rst_n_b']) {
        assert.equal([...result.result.matchAll(new RegExp('^\\s*logic\\s+' + name + '\\s*;', 'gm'))].length, 1, result.result);
    }
});
