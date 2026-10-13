'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createNativeLoader } = require('../src/native-loader');
const native = createNativeLoader({ rootDir: path.join(__dirname, '..') }).load();

/** 完整原生管线：首轮格式化和幂等验证使用同一组选项。 */
function formatStable(source, options = {}) {
    const formatted = native.formatText(source, options);
    assert.equal(native.formatText(formatted, options), formatted, '二次格式化应保持不变');
    return formatted;
}

/** 只统计文件内部空行，首尾换行由输出合同约束。 */
function blankLineCount(source) {
    return source.trim().split('\n').filter(line => /^\s*$/.test(line)).length;
}

for (const inlineCompact of [true, false]) {
    test(`UTF-8 字符串与注释保真，inlineCompact=${inlineCompact}`, () => {
        const literal = '"中文 🚀, (if begin)  a=b"';
        const comment = '// 中文注释：end, begin';
        const source = `module demo;\ninitial $display(${literal}); ${comment}\nendmodule\n`;
        const formatted = formatStable(source, { inlineCompact });
        assert.ok(formatted.includes(literal), formatted);
        assert.ok(formatted.includes(comment), formatted);
    });
}

for (const indentStyle of ['1tbs', 'gnu']) {
    test(`注释中的控制关键字不能吞掉 begin，indentStyle=${indentStyle}`, () => {
        const source = 'module demo;\ninitial\n// if example\nbegin\n$display("ok");\nend\nendmodule\n';
        const formatted = formatStable(source, { indentStyle });
        assert.match(formatted, /\/\/ if example\n\s*begin\b/);
        assert.equal(formatted.match(/\bbegin\b/g)?.length, 1);
        assert.match(formatted, /\$display\("ok"\);/);
    });
}

test('转义引号、反斜杠、括号及逗号在字符串内原样保留', () => {
    const literal = String.raw`"中文, (a,b); \"end\" \\ // if"`;
    const source = `module demo;\ninitial $display(${literal}, mix(a, b));\nendmodule\n`;
    const formatted = formatStable(source);
    assert.ok(formatted.includes(literal), formatted);
    assert.equal(formatted.match(/mix\(a,\s*b\)/g)?.length, 1);
});

test('块注释的缩进、空行和伪语法原样保留', () => {
    const comment = '/* 中文 begin (x,y)\n  if fake\n\n    end */';
    const source = `module demo;\n${comment}\nlogic flag;\nendmodule\n`;
    const formatted = formatStable(source, { maxConsecutiveEmptyLines: 0 });
    assert.ok(formatted.includes(comment), formatted);
});

test('宏定义续行体和其行内空白原样保留', () => {
    const macro = '`define PAIR(a,b) { \\\n  a, b \\\n}\n';
    const source = `${macro}module demo;\nlogic [1:0] pair = \`PAIR(1,0);\nendmodule\n`;
    const formatted = formatStable(source);
    assert.ok(formatted.startsWith(macro), formatted);
    assert.match(formatted, /`PAIR\(1,\s*0\)/);
});

test('属性中的字符串保真，属性仍附着于声明', () => {
    const literal = '"中文, (x)  a=b"';
    const source = `module demo;\n(* keep = "true", note = ${literal} *) logic [1:0] data;\nendmodule\n`;
    const formatted = formatStable(source);
    assert.ok(formatted.includes(literal), formatted);
    assert.match(formatted, /\*\)\s+logic\s+\[1:0\]\s+data\s*;/);
});

test('pragma protect 加密区逐行原样透传，并统一输入行尾', () => {
    const protectedRegion = [
        '`pragma protect begin_protected',
        '`pragma protect key_keyowner = "中文 owner"',
        '`pragma protect data_block',
        '  AbCd+/0123456789==  ',
        '',
        '`pragma protect end_protected',
        ''
    ].join('\n');
    const source = `module before; endmodule\n${protectedRegion}module after; endmodule\n`;
    const formatted = formatStable(source.replace(/\n/g, '\r\n'));
    assert.ok(formatted.includes(protectedRegion), formatted);
    assert.equal(formatted.includes('\r'), false);
    assert.match(formatted, /module before;[\s\S]*endmodule/);
    assert.match(formatted, /module after;[\s\S]*endmodule/);
});

for (const escapedName of [String.raw`\data.if[0]`, String.raw`\data.if(0){end}`]) {
    test(`escaped identifier 标点和关键字保持单个标识符：${escapedName}`, () => {
        const source = `module demo;\nwire ${escapedName} ;\nassign ${escapedName} = 1'b0;\nendmodule\n`;
        const formatted = formatStable(source);
        assert.equal(formatted.split(escapedName).length - 1, 2);
        for (const followingText of formatted.split(escapedName).slice(1)) {
            assert.match(followingText, /^\s/, 'escaped identifier 的每次出现都必须有终止空白');
        }
        assert.equal(formatted.replace(/\s/g, ''), source.replace(/\s/g, ''), formatted);
        assert.ok(formatted.endsWith('endmodule\n'), formatted);
    });
}

for (const maxConsecutiveEmptyLines of [-1, 0, 1]) {
    test(`跨行赋值遵守空行上限，blankCompact=false，max=${maxConsecutiveEmptyLines}`, () => {
        const source = 'module demo;\nassign x = a +\n\n\n    b;\nendmodule\n';
        const formatted = formatStable(source, { blankCompact: false, maxConsecutiveEmptyLines });
        const expectedCount = maxConsecutiveEmptyLines < 0 ? 2 : maxConsecutiveEmptyLines;
        assert.equal(blankLineCount(formatted), expectedCount, formatted);
        assert.match(formatted, /a\s*\+[\s\S]*b\s*;/);
    });
}

test('max=-1 禁用全部空行处理，即使 blankCompact=true', () => {
    const source = 'module demo;\ninitial begin\n$display("a");\n\n\n$display("b");\nend\nendmodule\n';
    const formatted = formatStable(source, { blankCompact: true, maxConsecutiveEmptyLines: -1 });
    assert.equal(blankLineCount(formatted), 2, formatted);
});

test('blankCompact=false 不给无空行输入增加空行', () => {
    const source = 'module demo;\nlogic a;\ninitial begin\na = 0;\nend\nalways @(a) begin\na = !a;\nend\nendmodule\n';
    const formatted = formatStable(source, { blankCompact: false, maxConsecutiveEmptyLines: 1 });
    assert.equal(blankLineCount(formatted), 0, formatted);
});

test('inlineCompact=false 保留语句内部的水平空白', () => {
    const source = 'module demo;\ninitial $display(" a=b  c ",    value);\nendmodule\n';
    const formatted = formatStable(source, { inlineCompact: false });
    assert.ok(formatted.includes('$display(" a=b  c ",    value);'), formatted);
});

const structuralSource = [
    'module demo(input logic clk, input logic rst, output logic q);',
    'logic [3:0] count;',
    'always @(posedge clk) begin',
    'if (rst) begin',
    'count <= 0;',
    'q <= 0;',
    'end else begin',
    'count <= count + 1;',
    'q <= count[0];',
    'end',
    'end',
    'endmodule',
    ''
].join('\n');

for (const indentStyle of ['1tbs', 'gnu']) {
    for (const useTab of [false, true]) {
        test(`结构 token 保真和幂等，style=${indentStyle}，tabs=${useTab}`, () => {
            const formatted = formatStable(structuralSource, { indentStyle, useTab, blankCompact: false });
            assert.equal(formatted.replace(/\s/g, ''), structuralSource.replace(/\s/g, ''));
            if (useTab) assert.match(formatted, /^\t+logic\b/m);
            assert.ok(formatted.endsWith('\n'));
            assert.equal(formatted.endsWith('\n\n'), false);
        });
    }
}

for (const [name, source, literal] of [
    ['module 参数表', 'module demo #(parameter string LABEL = "中文, (x)", parameter int SIZE = calc(2, 3)) (input logic a, output logic z);\nendmodule\n', '"中文, (x)"'],
    ['task 参数表', 'module demo;\ntask automatic run(input string message = "中文, (x)", input int size = pick(1, 2));\n$display(message, size);\nendtask\nendmodule\n', '"中文, (x)"'],
    ['实例参数和端口绑定', 'module demo;\nchild #(.NAME("中文, (a,b)"), .WIDTH(calc(1, 2))) u_child(\n.data({a, fnc(b,c)}),\n.valid(gate(a,b))\n);\nendmodule\n', '"中文, (a,b)"']
]) {
    test(`${name}中的嵌套括号和字符串逗号不分裂字段`, () => {
        const formatted = formatStable(source);
        assert.ok(formatted.includes(literal), formatted);
        assert.equal(formatted.replace(/\s/g, ''), source.replace(/\s/g, ''), formatted);
    });
}


const realDeclarations = 'logic real_short;\nlogic [7:0] real_longer;\n';
const realAssignments = 'assign a=signal;\nassign longname=signal;\n';

/** 验证真实声明仍排齐名称列，保护词法区域不能使整个声明组跳过布局。 */
function assertRealDeclarationAlignment(formatted) {
    const lines = formatted.split('\n');
    const shorter = lines.find(line => /^\s*logic\b/.test(line) && line.includes('real_short'));
    const longer = lines.find(line => /^\s*logic\b/.test(line) && line.includes('real_longer'));
    assert.ok(shorter && longer, formatted);
    assert.equal(shorter.indexOf('real_short'), longer.indexOf('real_longer'), formatted);
}

/** 验证真实赋值仍排齐等号列，原文保护只作用于非代码区域。 */
function assertRealAssignmentAlignment(formatted) {
    const lines = formatted.split('\n');
    const shorter = lines.find(line => /^\s*assign\s+a\s*=/.test(line));
    const longer = lines.find(line => /^\s*assign\s+longname\s*=/.test(line));
    assert.ok(shorter && longer, formatted);
    assert.equal(shorter.indexOf('='), longer.indexOf('='), formatted);
}

for (const literal of ['"a;b"', '"a,b"', '"a  b"']) {
    test(`声明字符串${literal}保持原文，相邻声明正常对齐`, () => {
        const source = `module demo;\nstring s=${literal};\nstring longname="tail";\n${realDeclarations}endmodule\n`;
        const formatted = formatStable(source);
        assert.ok(formatted.includes(literal), formatted);
        assert.equal(formatted.replace(/\s/g, ''), source.replace(/\s/g, ''), formatted);
        const lines = formatted.split('\n');
        const shorter = lines.find(line => /^\s*string\s+s\s*=/.test(line));
        const longer = lines.find(line => /^\s*string\s+longname\s*=/.test(line));
        assert.ok(shorter && longer, formatted);
        assert.equal(shorter.indexOf('='), longer.indexOf('='), formatted);
        assertRealDeclarationAlignment(formatted);
    });
}

test('跨行赋值中的字符串双空格保真，相邻真实赋值正常对齐', () => {
    const source = `module demo;\nassign x = cond ?\n f("a  b") +\n c : d;\n${realAssignments}endmodule\n`;
    const formatted = formatStable(source);
    assert.ok(formatted.includes('"a  b"'), formatted);
    assert.equal(formatted.replace(/\s/g, ''), source.replace(/\s/g, ''), formatted);
    assertRealAssignmentAlignment(formatted);
});

test('块注释中的伪声明和赋值保持原文，邻接代码仍对齐', () => {
    const comment = '/* 中文原文\nwire a;\nwire [7:0] longname;\na=1;\nlongname=2;\n*/';
    const source = `module demo;\n${comment}\n${realDeclarations}${realAssignments}endmodule\n`;
    const formatted = formatStable(source);
    assert.ok(formatted.includes(comment), formatted);
    assertRealDeclarationAlignment(formatted);
    assertRealAssignmentAlignment(formatted);
});

test('宏定义续行中的赋值保持原文，宏后的代码仍对齐', () => {
    const macro = '`define APPLY(x) \\\n  a=x; \\\n  longname=x;\n';
    const source = `${macro}module demo;\n${realDeclarations}${realAssignments}endmodule\n`;
    const formatted = formatStable(source);
    assert.ok(formatted.startsWith(macro), formatted);
    assertRealDeclarationAlignment(formatted);
    assertRealAssignmentAlignment(formatted);
});



test('宏续行的 begin 不影响真实声明间空行，宏保真且声明仍对齐', () => {
    const macro = '`define OPEN \\\n begin \\\n a=1;\n';
    const source = `${macro}module demo;\nlogic [3:0] low;\nlogic a;\n\nlogic wider;\nlogic [7:0] high;\nendmodule\n`;
    const formatted = formatStable(source);
    assert.ok(formatted.startsWith(macro), formatted);
    assert.match(formatted, /logic\s+a[^\n]*;\n\n[ \t]*logic\s+wider/);
    const lines = formatted.split('\n');
    const a = lines.find(line => /^\s*logic\s+a\s*;$/.test(line));
    const low = lines.find(line => /^\s*logic\s+\[3:0\]\s+low\s*;$/.test(line));
    const wider = lines.find(line => /^\s*logic\s+wider\s*;$/.test(line));
    const high = lines.find(line => /^\s*logic\s+\[7:0\]\s+high\s*;$/.test(line));
    assert.ok(a && low && wider && high, formatted);
    assert.equal(a.indexOf('a'), low.indexOf('low'), formatted);
    assert.equal(a.indexOf(';'), low.indexOf(';'), formatted);
    assert.equal(wider.indexOf('wider'), high.indexOf('high'), formatted);
    assert.equal(wider.indexOf(';'), high.indexOf(';'), formatted);
});

const alwaysEventHeaders = [
    ['用户 always 时钟块', 'always @(posedge   i_clk)', 'always @(posedge i_clk)'],
    ['always_ff 双边沿 or 列表', 'always_ff @(posedge   i_clk or  negedge   rst_n)', 'always_ff @(posedge i_clk or negedge rst_n)'],
    ['always 逗号事件列表', 'always @(posedge   i_clk ,   negedge   rst_n)', 'always @(posedge i_clk, negedge rst_n)'],
    ['always_ff 多层函数括号与 iff', 'always_ff @(posedge   get_clk(  select(i_clk , mux(a, b)) ) iff   enabled )', 'always_ff @(posedge get_clk(select(i_clk, mux(a, b))) iff enabled)'],
];
for (const [label, original, expected] of alwaysEventHeaders) {
    for (const inlineCompact of [true, false]) {
        test(label + '：inlineCompact=' + inlineCompact, () => {
            const source = 'module demo;\n' + original + ' begin\nq <= d;\nend\nendmodule\n';
            const formatted = formatStable(source, { inlineCompact });
            assert.ok(formatted.includes(inlineCompact ? expected : original), formatted);
        });
    }
}

test('always 事件头只紧凑代码，保护字符串、注释和转义标识符', () => {
    const literal = '"中文  (a,b); \\"保留\\""';
    const comment = '/* posedge  保留  (,) */';
    const escaped = '\\clk.name[0] ';
    const original = 'always_ff @(posedge   get_clk( ' + literal + ' ,  ' + escaped + ') ' + comment + ' or   negedge  rst_n)';
    const source = 'module demo;\n' + original + ' begin\nq <= d;\nend\nendmodule\n';
    const formatted = formatStable(source);
    assert.ok(formatted.includes('always_ff @(posedge get_clk('), formatted);
    assert.ok(formatted.includes(literal), formatted);
    assert.ok(formatted.includes(comment), formatted);
    assert.ok(formatted.includes(escaped), formatted);
    assert.ok(formatted.includes('or negedge rst_n)'), formatted);
    assert.ok(formatStable(source, { inlineCompact: false }).includes(original));
});

test('always 多行事件列表保留行形态并在各代码行紧凑', () => {
    const source = 'module demo;\nalways_ff @(\nposedge   get_clk(i_clk , nested(a, b)) or\nnegedge   rst_n\n) begin\nq <= d;\nend\nendmodule\n';
    const formatted = formatStable(source);
    assert.match(formatted, /always_ff @\(\n\s*posedge get_clk\(i_clk, nested\(a, b\)\) or\n\s*negedge rst_n\n\s*\)/);
});

test('注释与宏中的伪 always 头原样保留', () => {
    const comment = '// always @(posedge   i_clk) begin';
    const macro = '`define CLOCKED \\\n  always @(posedge   i_clk) begin \\\n    q <= d; end\n';
    const source = macro + 'module demo;\n' + comment + '\nlogic flag;\nendmodule\n';
    const formatted = formatStable(source);
    assert.ok(formatted.startsWith(macro), formatted);
    assert.ok(formatted.includes(comment), formatted);
});
