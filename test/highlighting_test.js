'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const grammar = require('../syntaxes/systemverilog.tmLanguage.json');
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
