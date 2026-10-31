'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createLintDiagnostics } = require('../src/toolchains/lint-diagnostics');

function harness(fileOnly = false) {
    const values = new Map(), writes = [];
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, DiagnosticSeverity: { Error: 0, Warning: 1 },
        Range: class { constructor(...coordinates) { this.coordinates = coordinates; } },
        Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } } };
    const store = createLintDiagnostics({ vscode, currentFileOnly: () => fileOnly,
        collection: { set(uri, findings) { values.set(uri.fsPath, findings); writes.push(uri.fsPath); } } });
    const document = name => ({ uri: { fsPath: path.resolve('test', name), toString() { return 'file:' + this.fsPath; } },
        version: 1, lineCount: 10, lineAt: line => ({ range: { line } }) });
    const finding = (file, message = 'broken dependency', column = 3) => ({ file, line: 4, column, severity: 'error', message });
    return { store, values, writes, document, finding };
}

test('源文件变化撤销相关 owner 的旧诊断，但保留无关文件结果', () => {
    const h = harness(), a = h.document('a.sv'), b = h.document('b.sv'), other = h.document('other.sv');
    h.store.publish(a, [h.finding(b.uri.fsPath)], 'iverilog');
    h.store.publish(other, [h.finding(other.uri.fsPath)], 'iverilog');
    assert.deepEqual(h.store.invalidate(b.uri.fsPath), [a]);
    assert.deepEqual(h.values.get(b.uri.fsPath), []);
    assert.equal(h.values.get(other.uri.fsPath).length, 1);
    // 失效后仍保留依赖登记，保存依赖文件时可找到需要重新检查的根。
    assert.deepEqual(h.store.documentsFor(b.uri.fsPath), [a]);
});

test('同一文件在不同编译上下文的有效诊断不会被一次成功检查抹掉', () => {
    const h = harness(), a = h.document('a.sv'), b = h.document('b.sv');
    h.store.publish(a, [h.finding(b.uri.fsPath)], 'iverilog');
    h.store.publish(b, [], 'iverilog');
    assert.equal(h.values.get(b.uri.fsPath).length, 1);
    h.store.remove(a); assert.deepEqual(h.values.get(b.uri.fsPath), []);
});

test('编译过程中首次出现的依赖也拒绝失效后迟到的结果', () => {
    const h = harness(), a = h.document('a.sv'), b = h.document('b.sv'), since = h.store.revision();
    h.store.invalidate(b.uri.fsPath);
    assert.equal(h.store.publish(a, [h.finding(b.uri.fsPath)], 'xvlog', { since }), false);
    assert.equal(h.store.publish(a, [], 'xvlog', { since, sourceFiles: [b.uri.fsPath] }), false);
    assert.equal(h.store.publish(a, [], 'xvlog', { since: h.store.revision(), sourceFiles: [b.uri.fsPath] }), true);
});

test('同版本保存允许当前文档快照提交，但不豁免其他依赖变更', () => {
    const h = harness(), a = h.document('a.sv'), b = h.document('b.sv'), since = h.store.revision();
    h.store.invalidate(a.uri.fsPath);
    assert.equal(h.store.publish(a, [], 'iverilog', { since, documentVersion: 1 }), true);
    h.store.invalidate(b.uri.fsPath);
    assert.equal(h.store.publish(a, [], 'iverilog', { since, documentVersion: 1, sourceFiles: [b.uri.fsPath] }), false);
    a.version++;
    assert.equal(h.store.publish(a, [], 'iverilog', { since, documentVersion: 1 }), false);
});

test('当前文件模式保留依赖失败摘要，外部文件不进入 Problems', () => {
    const h = harness(true), a = h.document('a.sv'), b = h.document('b.sv');
    h.store.publish(a, [h.finding(b.uri.fsPath)], 'iverilog', { logPath: 'compile.log' });
    assert.equal(h.values.get(b.uri.fsPath), undefined);
    assert.equal(h.values.get(a.uri.fsPath).length, 1);
    assert.match(h.values.get(a.uri.fsPath)[0].message, /依赖文件存在 1 个错误.*compile.log/);
    assert.deepEqual(h.store.invalidate(b.uri.fsPath), [a]);
    assert.deepEqual(h.values.get(a.uri.fsPath), []);
});

test('诊断去重保留不同列的位置，重发和关闭仅重绘受影响文件', () => {
    const h = harness(), a = h.document('a.sv'), b = h.document('b.sv');
    h.store.publish(a, [h.finding(a.uri.fsPath, 'error', 3), h.finding(a.uri.fsPath, 'error', 8)], 'xvlog');
    assert.equal(h.values.get(a.uri.fsPath).length, 2);
    h.store.publish(b, [h.finding(b.uri.fsPath)], 'iverilog'); h.writes.length = 0;
    h.store.publish(a, [], 'xvlog');
    assert.deepEqual(h.writes, [a.uri.fsPath]);
    assert.equal(h.values.get(b.uri.fsPath).length, 1);
    h.store.remove(b); assert.deepEqual(h.values.get(b.uri.fsPath), []);
});

test('Windows 下依赖路径大小写和分隔符归一化', { skip: process.platform !== 'win32' }, () => {
    const h = harness(), a = h.document('a.sv'), b = h.document('b.sv');
    h.store.publish(a, [h.finding(b.uri.fsPath)], 'iverilog');
    assert.deepEqual(h.store.invalidate(b.uri.fsPath.toUpperCase().replaceAll('\\', '/')), [a]);
    assert.deepEqual(h.values.get(b.uri.fsPath), []);
});
