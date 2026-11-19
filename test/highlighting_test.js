'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const grammar = require('../syntaxes/systemverilog.tmLanguage.json');
const { inactiveRanges, activateConditionalHighlighting } = require('../src/editor/conditional-highlighting');
const literals = ["'0", "'1", "'x", "'X", "'z", "'Z"];
const numericMatches = source => grammar.repository.numbers.patterns.flatMap(rule =>
    [...source.matchAll(new RegExp(rule.match, 'g'))].map(match => ({ start: match.index, text: match[0], scope: rule.name })));

test('无基数常量的单引号与值由同一个数字规则完整识别', () => {
    for (const literal of literals) {
        const source = `assign q=${literal};`, start = source.indexOf("'");
        assert.ok(numericMatches(source).some(token => token.start === start && token.text === literal), literal);
    }
});

test('无基数常量不吞并相邻标识符、额外数字或弯引号', () => {
    for (const source of ["'10", "'01", "'1foo", "'x0", "'z_", "'0$foo", "id'1", "$flag'1", "'s1", "'?", '’0']) {
        assert.ok(!numericMatches(source).some(token => token.text.startsWith("'") && token.scope.includes('.unbased.')), source);
    }
});

test('现有有位宽及无位宽进制常量仍完整识别', () => {
    for (const literal of ["8'b1010_0011", "1'b0", "16'shff", "'hCAFE", "'sd12", '42', '1.5e-3']) {
        assert.ok(numericMatches(literal).some(token => token.start === 0 && token.text === literal), literal);
    }
});

const ports = ['`include"width_defs.v"', 'module demo(', '  `ifdef DDR16', '  inout [15:0] dq,',
    '  `elsif DDR32', '  inout [31:0] dq,', '  `elsif DDR64', '  inout [63:0] dq,', '  `endif', '  output ready', ');', 'endmodule'].join('\n');
const dimmed = (text, ranges) => ranges.map(([start, end]) => text.slice(start, end).trim());

test('条件端口按头文件的宏定义选分支，指令和 endif 后的端口保持可读', async () => {
    const ranges = await inactiveRanges({ file: 'top.sv', text: ports, async readInclude(file, name) {
        assert.equal(file, 'top.sv');
        assert.equal(name, 'width_defs.v');
        return { file: name, text: '//`define DDR16\n/*`define DDR32*/\n`define DDR64 0\n' };
    } });
    assert.deepEqual(dimmed(ports, ranges), ['inout [15:0] dq,', 'inout [31:0] dq,']);
});

test('嵌套条件和宏的定义顺序生效，已选分支不会读入后续分支的 include', async () => {
    const text = ['`ifndef GUARDED', '`define GUARDED', '`ifdef MODE', '`define INNER', '`elsif ALTERNATE', '`include "missing.v"',
        '`else', '`undef MODE', '`endif', '`ifdef INNER', 'wire valid;', '`endif', '`endif', '`undef MODE', '`ifdef MODE', 'wire disabled;',
        '`else', 'wire enabled;', '`endif'].join('\n');
    const ranges = await inactiveRanges({ file: 'top.sv', text, defines: ['MODE=0', 'ALTERNATE'], readInclude() { assert.fail('inactive include'); } });
    assert.deepEqual(dimmed(text, ranges), ['`include "missing.v"', '`undef MODE', 'wire disabled;']);
});

test('活动 include 缺失或条件指令尚未闭合时保留原有高亮', async () => {
    assert.deepEqual(await inactiveRanges({ file: 'top.sv', text: ports, readInclude: async () => null }), []);
    assert.deepEqual(await inactiveRanges({ file: 'top.sv', text: '`ifdef MISSING\nwire partial;\n' }), []);
});

test('编辑器自动按当前工程中的头文件更新可见模块的分支淡化', async t => {
    const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'svtools-conditional-highlight-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const headerPath = path.join(root, 'header', 'width_defs.v');
    await fs.mkdir(path.dirname(headerPath));
    await fs.writeFile(headerPath, '`define DDR64\n');
    const uri = file => ({ scheme: 'file', fsPath: file, toString: () => file });
    const document = { uri: uri(path.join(root, 'top.sv')), getText: () => ports, languageId: 'systemverilog', positionAt: offset => offset };
    let content = '`define DDR32\n', changed, closed;
    const header = { uri: uri(headerPath), getText: () => content };
    const updates = [], editor = { document, setDecorations: (_, ranges) => updates.push(ranges.map(({start,end}) => [start,end])) };
    const disposable = () => ({ dispose() {} });
    const vscode = { Range: class { constructor(start, end) { Object.assign(this, { start, end }); } }, DecorationRangeBehavior: { ClosedClosed: 1 },
        window: { visibleTextEditors: [editor], createTextEditorDecorationType: disposable, onDidChangeVisibleTextEditors: disposable },
        workspace: { textDocuments: [document], getWorkspaceFolder: () => ({ uri: uri(root) }), getConfiguration: () => ({ get: () => [] }),
            onDidChangeTextDocument: callback => { changed = callback; return disposable(); },
            onDidCloseTextDocument: callback => { closed = callback; return disposable(); } } };
    const highlighting = activateConditionalHighlighting({ vscode, sourceCatalog: { onDidChange: disposable },
        getProjectSources: async () => ({ files: [document.uri.fsPath, headerPath] }) });
    t.after(() => highlighting.dispose());
    async function waitForUpdate(count) {
        for (let attempt = 0; updates.length < count && attempt < 60; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(updates.length, count);
        return dimmed(ports, updates.at(-1));
    }
    assert.deepEqual(await waitForUpdate(1), ['inout [15:0] dq,', 'inout [31:0] dq,']);
    vscode.workspace.textDocuments.push(header);
    changed({ document: header, contentChanges: [{}] });
    assert.deepEqual(await waitForUpdate(2), ['inout [15:0] dq,', 'inout [63:0] dq,']);
    vscode.workspace.textDocuments.pop();
    closed(header);
    assert.deepEqual(await waitForUpdate(3), ['inout [15:0] dq,', 'inout [31:0] dq,']);
});

// 复用本机编辑器的真实TextMate/Oniguruma；CI无编辑器时仍运行上面的词法合同。
test('真实TextMate保证常量全宽着色，并保留注释、字符串、强转及赋值模式上下文', {
    skip: !process.env.SVTOOLS_EDITOR_APP_ROOT
}, async () => {
    const modules = path.join(process.env.SVTOOLS_EDITOR_APP_ROOT, 'node_modules');
    const textmate = require(path.join(modules, 'vscode-textmate'));
    const oniguruma = require(path.join(modules, 'vscode-oniguruma'));
    const wasm = await fs.readFile(path.join(modules, 'vscode-oniguruma/release/onig.wasm'));
    await oniguruma.loadWASM(wasm);
    const registry = new textmate.Registry({
        onigLib: Promise.resolve({ createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
            createOnigString: value => new oniguruma.OnigString(value) }),
        loadGrammar: async scope => scope === grammar.scopeName ? grammar : null
    });
    try {
        const loaded = await registry.loadGrammar(grammar.scopeName);
        const tokens = source => loaded.tokenizeLine(source).tokens;
        for (const literal of literals) {
            for (const source of [`assign q=${literal};`, `'{default:${literal}}`, `int'(${literal})`, `(* value=${literal} *) logic q;`, '`define VALUE ' + literal]) {
                const start = source.indexOf(literal);
                assert.ok(tokens(source).some(token => token.startIndex === start && token.endIndex === start + literal.length &&
                    token.scopes.includes('constant.numeric.unbased.systemverilog')), source);
            }
        }
        for (const source of ['// q=\'0;', '/* q=\'1; */', 'string s="\'x";', "int'(value)", "'{default:0}"]) {
            assert.ok(!tokens(source).some(token => token.scopes.includes('constant.numeric.unbased.systemverilog')), source);
        }
    } finally { registry.dispose(); }
});
