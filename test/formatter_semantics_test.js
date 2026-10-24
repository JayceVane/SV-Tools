"use strict";
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createNativeLoader } = require('../src/native-loader');
const native = createNativeLoader({ rootDir: path.join(__dirname, '..') }).load();

function formatStable(source, options = {}) {
    const output = native.formatText(source, options);
    assert.equal(output.replace(/[ \t\r\n]/g, ''), source.replace(/[ \t\r\n]/g, ''), '非排版字符必须守恒');
    assert.equal(native.formatText(output, options), output, '重复格式化必须稳定');
    return output;
}

for (const declaration of [
    'logic [8 + +1:0] a;',
    'logic [8 - -1:0] a;',
    'logic [31:0] a [8 + +1:0];'
]) {
    test(`范围紧凑保留相邻二元/一元操作符边界：${declaration}`, () => {
        const output = formatStable(`module m;\n${declaration}\nendmodule\n`);
        assert.match(output, /8\s*[+-]\s+[+-]\s*1/, output);
        assert.doesNotMatch(output, /8(?:\+\+|--)1/, output);
        assert.match(output, /^ {4}logic/m, '应继续完成布局而非回退整个文件');
    });
}

for (const operator of ['===', '!==', '==?', '!=?', '>>>', '<<<', '>>=', '<<=', '>>>=', '<<<=']) {
    test(`for 行规范化保留完整操作符 ${operator}`, () => {
        const expression = operator.endsWith('=') && !['===', '!=='].includes(operator)
            ? `a ${operator} 1` : `a = a ${operator} 1`;
        const source = `module m;\ninteger i,a;\ninitial begin\nfor(i=0;i<1;i++) ${expression};\nend\nendmodule\n`;
        const output = formatStable(source);
        assert.ok(output.includes(operator), output);
        assert.match(output, /for\(i = 0; i < 1; i\+\+\)/, '应规范 for 而非回退整个文件');
    });
}

test('端口、task 参数与选区对齐均保持范围 token 边界', () => {
    const source = 'module m(input logic [8 + +1:0] d);\ntask t(input logic [8 - -1:0] x);\nendtask\nendmodule\n';
    const output = formatStable(source);
    assert.match(output, /8\s*\+\s+\+\s*1/, output);
    assert.match(output, /8\s*-\s+-\s*1/, output);
    const selection = 'logic [8 + +1:0] a;\nlogic [15:0] longer;\n';
    const aligned = native.alignCode(selection, 4);
    assert.equal(aligned.replace(/[ \t\r\n]/g, ''), selection.replace(/[ \t\r\n]/g, ''));
    assert.match(aligned, /8\s*\+\s+\+\s*1/, aligned);
});


test('宏定义、指令行界、字符串和注释的语义边界保留', () => {
    const macro = '`define VALUE(x) ((x) + +1)\n';
    const literal = '"a  b \\" q"';
    const source = macro + '`ifdef FEATURE\nmodule m;\ninitial $display(' + literal + '); // trailing\nendmodule\n`endif\n';
    const output = formatStable(source);
    assert.ok(output.startsWith(macro), output);
    assert.match(output, /`ifdef FEATURE\nmodule m;/);
    assert.ok(output.includes(literal), output);
    assert.match(output, /\/\/ trailing\nendmodule/);
    assert.match(output, /endmodule\n`endif/);
});

// 一次真实程序同时覆盖声明范围、比较、算术移位及四种移位赋值。
const semanticProgram = `module formatter_semantics;
logic [8 + +1:0] plus_range;
logic [8 - -1:0] minus_range;
logic [3:0] unknown_bits;
logic case_equal, case_different;
integer i, value, arithmetic_right, arithmetic_left;
integer logical_right_assign, logical_left_assign, arithmetic_right_assign, arithmetic_left_assign;
initial begin
if ($bits(plus_range) != 10 || $bits(minus_range) != 10) $fatal(1, "range width changed");
unknown_bits = 4'bx001;
for(i=0;i<1;i++) case_equal = unknown_bits === 4'bx001;
for(i=0;i<1;i++) case_different = unknown_bits !== 4'b0001;
if (case_equal !== 1'b1 || case_different !== 1'b1) $fatal(1, "case comparison changed");
value = -16;
for(i=0;i<1;i++) arithmetic_right = value >>> 2;
value = 3;
for(i=0;i<1;i++) arithmetic_left = value <<< 2;
logical_right_assign = 64;
for(i=0;i<1;i++) logical_right_assign >>= 2;
logical_left_assign = 3;
for(i=0;i<1;i++) logical_left_assign <<= 1;
arithmetic_right_assign = -32;
for(i=0;i<1;i++) arithmetic_right_assign >>>= 2;
arithmetic_left_assign = 3;
for(i=0;i<1;i++) arithmetic_left_assign <<<= 1;
if (arithmetic_right != -4 || arithmetic_left != 12) $fatal(1, "arithmetic shift changed");
if (logical_right_assign != 16 || logical_left_assign != 6 || arithmetic_right_assign != -8 || arithmetic_left_assign != 6) $fatal(1, "shift assignment changed");
$display("FORMAT_SEMANTICS_PASS width=%0d/%0d case=%0b/%0b shifts=%0d/%0d assign=%0d/%0d/%0d/%0d", $bits(plus_range), $bits(minus_range), case_equal, case_different, arithmetic_right, arithmetic_left, logical_right_assign, logical_left_assign, arithmetic_right_assign, arithmetic_left_assign);
end
endmodule
`;

const iverilog = process.env.SVTOOLS_CODEGEN_IVERILOG;
const vvp = process.env.SVTOOLS_CODEGEN_VVP;
test('真实Icarus：原文与格式化产物均编译运行且结果一致', { skip: !iverilog || !vvp, timeout: 60000 }, () => {
    const root = path.join(__dirname, '..');
    const directory = path.join(process.env.SVTOOLS_CODEGEN_OUTPUT || path.join(root, 'bin/release-formatter-validation'),
        String(process.pid), 'formatter_semantics');
    fs.mkdirSync(directory, { recursive: true });
    const env = { ...process.env };
    if (process.env.SVTOOLS_CODEGEN_CYGWIN) env.PATH = process.env.SVTOOLS_CODEGEN_CYGWIN + path.delimiter + env.PATH;
    const options = { cwd: directory, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
    const formatted = formatStable(semanticProgram);
    assert.notEqual(formatted, semanticProgram, '必须真正完成布局，不能依靠整体回退通过验收');
    const outputs = [];
    for (const [name, source] of [['original', semanticProgram], ['formatted', formatted]]) {
        fs.writeFileSync(path.join(directory, name + '.sv'), source);
        const compiled = spawnSync(iverilog, ['-g2012', '-s', 'formatter_semantics', '-o', name + '.vvp', name + '.sv'], options);
        const compileLog = String(compiled.stdout || '') + String(compiled.stderr || '') + String(compiled.error || '');
        fs.writeFileSync(path.join(directory, name + '.compile.log'), compileLog);
        assert.ifError(compiled.error);
        assert.equal(compiled.status, 0, name + ': ' + compileLog);
        const runtime = spawnSync(vvp, [name + '.vvp'], options);
        const runtimeLog = String(runtime.stdout || '') + String(runtime.stderr || '') + String(runtime.error || '');
        fs.writeFileSync(path.join(directory, name + '.runtime.log'), runtimeLog);
        assert.ifError(runtime.error);
        assert.equal(runtime.status, 0, name + ': ' + runtimeLog);
        assert.match(runtime.stdout, /FORMAT_SEMANTICS_PASS width=10\/10 case=1\/1 shifts=-4\/12 assign=16\/6\/-8\/6/);
        outputs.push(runtime.stdout.replace(/\r\n/g, '\n'));
    }
    assert.equal(outputs[1], outputs[0], '格式化前后实际仿真输出应完全一致');
});
