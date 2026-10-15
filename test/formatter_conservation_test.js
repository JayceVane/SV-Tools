'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createNativeLoader } = require('../src/native-loader');

const rootDir = path.join(__dirname, '..');
const native = createNativeLoader({ rootDir }).load();
const cliPath = path.join(rootDir, 'bin', process.platform === 'win32' ? 'svtools.exe' : 'svtools');
const cliAvailable = process.platform === 'win32' || fs.existsSync(cliPath);
const cliTimeoutMs = 5000;

// 只允许这四种 ASCII 排版字符变化；Unicode 空白、BOM 和控制字符均属于正文。
function significantCharacters(source) {
    return source.replace(/[\x20\t\r\n]/g, '');
}

function assertConserved(source, formatted, label) {
    assert.equal(typeof formatted, 'string', label);
    assert.equal(significantCharacters(formatted), significantCharacters(source),
        `${label}：非排版字符必须逐个保持原值、数量与顺序`);
}

function assertStable(source, options, label) {
    const formatted = native.formatText(source, options);
    assertConserved(source, formatted, label);
    const repeated = native.formatText(formatted, options);
    assertConserved(source, repeated, `${label}：第二轮`);
    assert.equal(repeated, formatted, `${label}：重复格式化必须稳定`);
    return formatted;
}

const optionProfiles = [
    ['默认', {}],
    ['拆分声明', { oneDeclPerLine: true }],
    ['合并 import', { importSameLine: true }],
    ['声明、import 与宏组合', {
        oneDeclPerLine: true, importSameLine: true, ignoreTick: false,
        oneBindPerLine: false, paramOneLine: false
    }],
    ['仅缩进', { reindentOnly: true, oneDeclPerLine: true, importSameLine: true }],
    ['GNU、TAB 与保留空白', {
        indentStyle: 'gnu', useTab: true, nbSpace: 2,
        inlineCompact: false, blankCompact: false, stripEmptyLine: false,
        alignComma: false, instAlignPort: false, maxConsecutiveEmptyLines: -1,
        portNameGap: 8
    }]
];

const controlCharacters = Array.from({ length: 32 }, (_, code) => code)
    .filter(code => ![9, 10, 13].includes(code))
    .map(code => String.fromCharCode(code)).join('') + '\x7f';

const corpus = [
    ['全部乱码', '锟斤拷烫烫烫 � ��� 銆愶紝🚀\r\n\t𠮷\u0000\u0001\u001b'],
    ['全部 ASCII 控制字符', `${controlCharacters}\r\n${controlCharacters.split('').reverse().join('')}`],
    ['Unicode 空白不是排版空白', '\v\f\u0085\u00a0\u1680\u2000\u2007\u2028\u2029\u202f\u205f\u3000\n'],
    ['BOM、零宽与组合字符', '\ufeffé e\u0301\u200b\u200c\u200d\u2060\ufeff👩‍💻\ufe0f\n'],
    ['重复字符与相对顺序', 'αββα🚀中中�α\n\tβ🚀中�α'],
    ['不完整字符串', 'module m;\ninitial $display("乱码🚀\\\"未结束\u0000\nendmodule'],
    ['不完整注释', 'module m;\nlogic a; /* 乱码🚀 if(x) begin // \v\f\u00a0\n'],
    ['不完整宏', '`define BROKEN(a,b) { \\\n  乱码🚀, a \\\n`ifdef MISSING\nlogic q;\n'],
    ['加密段夹杂乱码', '`pragma protect begin_protected\r\n  Ab+/==乱码🚀\u0000\v\u00a0  \r\n`pragma protect end_protected\r\n'],
    ['未闭合加密段', 'module m; endmodule\n`pragma protect begin_protected\n乱码\v\f\u3000🚀'],
    ['多变量声明', 'module m;\nlogic [7:0] a, b;\nwire c, d;\nendmodule\n'],
    ['多个 import', 'module m;\nimport alpha::*, beta::*;\nimport gamma::item;\nlogic q;\nendmodule\n'],
    ['合法 SV 与乱码混合', 'module m(input logic clk);\n// 乱码🚀\u00a0\u3000\nlogic q;\nalways @(posedge   clk) begin\nq <= 1\'b0;\nend\nendmodule\n乱码\v\f\u0000'],
    ['转义标识符与属性', 'module m;\n(* note = "é e\u0301 🚀" *) wire \\乱码[0].q ;\nassign \\乱码[0].q = 1\'b0;\nendmodule\n']
];

for (const [profile, options] of optionProfiles) {
    test(`字符守恒与幂等：${profile}`, () => {
        for (const [name, source] of corpus) assertStable(source, options, `${profile}/${name}`);
    });
}

// 按 Unicode scalar 变异，避免 JS 切片产生 NAPI UTF-8 字符串无法表达的孤立代理项。
function mutatedSources() {
    let seed = 0x51d00d;
    const next = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return seed >>> 0;
    };
    const fragments = ['乱码🚀', '\u0000', '\v\f', '\u00a0\u3000', '\ufeff', 'e\u0301',
        '\u200b', '(', ');', '"', '/*', '//', '`', '\\', 'begin', 'end', ',', '\r\n', ' \t'];
    return Array.from({ length: 64 }, (_, index) => {
        const characters = Array.from(corpus[index % corpus.length][1]);
        const changes = 1 + next() % 5;
        for (let mutation = 0; mutation < changes; mutation++) {
            const offset = next() % (characters.length + 1);
            const remove = next() % 3 === 0 ? 1 : 0;
            const addition = fragments[next() % fragments.length];
            characters.splice(offset, remove, ...Array.from(addition));
        }
        return characters.join('');
    });
}

const randomCorpus = mutatedSources();
for (const [profile, options] of optionProfiles) {
    test(`有界确定性乱码变异：${profile}`, () => {
        randomCorpus.forEach((source, index) => assertStable(source, options, `${profile}/seed-${index}`));
    });
}

test('字符守恒不能让正常代码失去格式化功能', () => {
    const source = 'module m(input logic clk);\nlogic q;\nalways @(posedge   clk) begin\nq<=1\'b0;\nend\nendmodule\n';
    const formatted = assertStable(source, {}, '正常代码');
    assert.notEqual(formatted, source);
    assert.match(formatted, /always @\(posedge clk\) begin/);
    assert.match(formatted, /^ {4}logic\b/m);
    assert.match(formatted, /q\s+<=\s+1'b0;/);
});

test('NAPI 不得把 UTF-16 孤立代理项替换为乱码', () => {
    for (const source of ['\ud800', '\udfff', '🚀\ud800\u0000', '\udfff🚀',
        'module m;\n// \ud800尾部\u0000\nendmodule\n']) {
        for (const [, options] of optionProfiles) {
            assert.equal(native.formatText(source, options), source,
                '无法无损转换为 UTF-8 时必须返回原始 JS 字符串');
        }
    }
});

test('选区对齐对未知内容、Unicode 和孤立代理项同样守恒', () => {
    const sources = [corpus[0][1], corpus[1][1], corpus[2][1], corpus[3][1],
        'logic \v\f\u00a0乱码🚀;\nlogic [7:0] \u3000数据;',
        'unknown += value;\n乱码\u0000', '\ud800', '🚀\udfff\u0000'];
    for (const source of sources) {
        for (const tabSize of [2, 4, 8]) {
            assertConserved(source, native.alignCode(source, tabSize), `alignCode/tab=${tabSize}`);
        }
    }
});

test('选区对齐的字符保护仍允许正常 logic 声明对齐', () => {
    const source = 'logic short_q;\nlogic [31:0] long_q;\n';
    const formatted = native.alignCode(source, 4);
    assertConserved(source, formatted, '合法声明对齐');
    assert.notEqual(formatted, source);
    const names = ['short_q', 'long_q'];
    const columns = formatted.split('\n').slice(0, 2).map((line, index) => {
        const offset = line.indexOf(names[index]);
        assert.ok(offset >= 0, line);
        let column = 0;
        for (const character of line.slice(0, offset)) {
            column += character === '\t' ? 4 - column % 4 : 1;
        }
        return column;
    });
    assert.equal(columns[0], columns[1], '声明名称的可见列应对齐');
});

function runCli(args, input) {
    const result = spawnSync(cliPath, args, {
        input, encoding: 'utf8', timeout: cliTimeoutMs, windowsHide: true
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
}

function withTemporaryDirectory(callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'svtools-conservation-'));
    try {
        callback(directory);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

const cliSource = '\ufeffmodule m;\r\nlogic [7:0] a, b;\r\n// 乱码🚀 e\u0301\r\n\v\f\u00a0\u3000\u0000\u200b�\r\nendmodule\r\n';
const cliOptions = ['--one-decl-per-line'];
const cliTestOptions = { skip: cliAvailable ? false : '当前平台未构建独立 CLI' };

test('CLI stdin 对乱码和 Unicode 空白保持字符守恒、输出幂等', cliTestOptions, () => {
    const result = runCli([...cliOptions, '-'], cliSource);
    assert.equal(result.status, 0, result.stderr);
    assertConserved(cliSource, result.stdout, 'CLI stdin');
    const repeated = runCli([...cliOptions, '-'], result.stdout);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(repeated.stdout, result.stdout);
});

test('CLI --inplace 和 --check 不损坏乱码正文', cliTestOptions, () => {
    withTemporaryDirectory(directory => {
        const inputPath = path.join(directory, '乱码.sv');
        fs.writeFileSync(inputPath, cliSource, 'utf8');
        const beforeCheck = fs.readFileSync(inputPath);
        const check = runCli([...cliOptions, '--check', inputPath]);
        assert.ok([0, 1].includes(check.status), check.stderr);
        assert.equal(check.stdout, '');
        assert.deepEqual(fs.readFileSync(inputPath), beforeCheck, '--check 不得写入源文件');

        const result = runCli([...cliOptions, '--inplace', inputPath]);
        assert.equal(result.status, 0, result.stderr);
        const formatted = fs.readFileSync(inputPath, 'utf8');
        assertConserved(cliSource, formatted, 'CLI --inplace');
        const formattedBytes = fs.readFileSync(inputPath);
        const stableCheck = runCli([...cliOptions, '--check', inputPath]);
        assert.equal(stableCheck.status, 0, stableCheck.stderr);
        assert.deepEqual(fs.readFileSync(inputPath), formattedBytes);
    });
});

test('CLI --output 保全乱码正文且不改源文件', cliTestOptions, () => {
    withTemporaryDirectory(directory => {
        const inputPath = path.join(directory, 'input.sv');
        const outputPath = path.join(directory, 'output.sv');
        fs.writeFileSync(inputPath, cliSource, 'utf8');
        const sourceBytes = fs.readFileSync(inputPath);
        const result = runCli([...cliOptions, '--output', outputPath, inputPath]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, '');
        assert.deepEqual(fs.readFileSync(inputPath), sourceBytes);
        assertConserved(cliSource, fs.readFileSync(outputPath, 'utf8'), 'CLI --output');
        const check = runCli([...cliOptions, '--check', outputPath]);
        assert.equal(check.status, 0, check.stderr);
    });
});

test('CLI 拒绝无效 UTF-8 且不修改任何输入或既有输出字节', cliTestOptions, () => {
    withTemporaryDirectory(directory => {
        const inputPath = path.join(directory, 'invalid-utf8.sv');
        const outputPath = path.join(directory, 'existing-output.sv');
        const invalidBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x6d, 0xc3, 0x28, 0xff, 0x00, 0x0a]);
        const outputBytes = Buffer.from('既有输出 🚀\r\n', 'utf8');
        fs.writeFileSync(inputPath, invalidBytes);
        fs.writeFileSync(outputPath, outputBytes);
        for (const args of [['--inplace'], ['--check'], ['--output', outputPath]]) {
            const result = runCli([...args, inputPath]);
            assert.notEqual(result.status, 0, `${args[0]} 应拒绝无效 UTF-8`);
            assert.equal(result.stdout, '');
            assert.deepEqual(fs.readFileSync(inputPath), invalidBytes);
            assert.deepEqual(fs.readFileSync(outputPath), outputBytes);
        }
        const stdin = runCli(['-'], invalidBytes);
        assert.notEqual(stdin.status, 0, 'stdin 应拒绝无效 UTF-8');
        assert.equal(stdin.stdout, '');
    });
});
