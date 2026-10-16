'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSourcePathMapper } = require('../src/circuit/source-paths');
const { MAX_ERROR_CHARS, createYosysDiagnostics, yosysErrorHint } = require('../src/circuit/yosys-diagnostics');

for (const order of ['before', 'after']) test(`Slang源码错误优先于${order}通用错误，保留首个源码诊断与行列`, () => {
    const root = path.resolve('RTL space'), collect = createYosysDiagnostics({ sourceRoot: root });
    const generic = 'ERROR: Design elaboration failed; see full log for details';
    if (order === 'before') collect.onLine(generic);
    collect.onLine("top.sv:12:34: error: use of undeclared identifier 'impl_t'");
    collect.onLine('other.sv:99:1: fatal error: later failure');
    if (order === 'after') collect.onLine(generic);
    assert.equal(collect.getError(), path.join(root, 'top.sv') + ":12:34: error: use of undeclared identifier 'impl_t'");
});

test('工具警告不是错误，支持无列号与ANSI源码诊断，摘要有界', () => {
    const collect = createYosysDiagnostics();
    collect.onLine('(node:1) ExperimentalWarning: WASI'); collect.onLine('top.sv:2:3: warning: unused signal');
    assert.equal(collect.getError(), null);
    collect.onLine('\x1b[31mtop.sv:16: ERROR: syntax error\x1b[0m');
    assert.match(collect.getError(), /top.sv:16: ERROR: syntax error$/); assert.doesNotMatch(collect.getError(), /\x1b/);
    const huge = createYosysDiagnostics(); huge.onLine('ERROR: ' + 'x'.repeat(20000)); assert.equal(huge.getError().length, MAX_ERROR_CHARS);
});

test('Windows路径的盘符、空格和行列不混淆，伪文件位置不改写', () => {
    const collect = createYosysDiagnostics();
    collect.onLine('C:\\RTL space\\top.sv:12:34: fatal error: bad type');
    assert.match(collect.getError(), /top.sv:12:34: fatal error: bad type$/);
    const pseudo = createYosysDiagnostics(); pseudo.onLine('<command-line>:1:2: error: bad macro');
    assert.equal(pseudo.getError(), '<command-line>:1:2: error: bad macro');
});

test('工具目录优先匹配最具体路径，随后把未保存快照映射回原文件', () => {
    const original = path.resolve('project/rtl/top.sv'), snapshot = path.resolve('tasks/source/top.sv');
    const map = createSourcePathMapper({ sourceRoot: '/', sourceMap: { [snapshot]: original }, sourceDirectories: [
        { from: '/', to: path.resolve('fallback') }, { from: '/source0', to: path.dirname(snapshot) }
    ] });
    assert.equal(map('source0/top.sv'), original); assert.equal(map('/source0/top.sv'), original); assert.equal(map(snapshot), original);
    const collect = createYosysDiagnostics({ sourceRoot: '/', sourceMap: { [snapshot]: original }, sourceDirectories: [{ from: '/source0', to: path.dirname(snapshot) }] });
    collect.onLine('source0/top.sv:1:31: error: missing type'); assert.equal(collect.getError(), original + ':1:31: error: missing type');
});

test('映射拒绝相邻前缀和上级路径，不误用目录快照', () => {
    const target = path.resolve('mapped'), root = path.parse(process.cwd()).root;
    const map = createSourcePathMapper({ sourceRoot: root, sourceDirectories: [{ from: '/source0', to: target }] });
    assert.equal(map('/source0/top.sv'), path.join(target, 'top.sv'));
    assert.equal(map('/source0-other/top.sv'), path.resolve(root, 'source0-other/top.sv'));
    assert.equal(map('/source0/../top.sv'), path.resolve(root, 'top.sv'));
});

test('缺类型或包提示显式依赖与import；普通语法和进程错误不给错误建议', () => {
    assert.match(yosysErrorHint("use of undeclared identifier 'impl_t'", 'slang'), /svtools\.circuit\.sources.*package/);
    assert.match(yosysErrorHint("unknown module 'half_adder'", 'slang'), /includeDirs/);
    assert.match(yosysErrorHint('syntax error, unexpected TOK_ID', 'verilog'), /slang/);
    assert.equal(yosysErrorHint('syntax error', 'slang'), ''); assert.equal(yosysErrorHint('disk full', 'slang'), '');
});
