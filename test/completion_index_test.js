'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createCompletionIndex } = require('../src/editor/completion/index');

function harness(files, overrides = {}) {
    const events = {}, calls = { find: 0, read: 0, errors: [] }, data = new Map(Object.entries(files));
    const uri = name => ({ fsPath: 'C:/hdl/' + name, toString: () => 'file:///C:/hdl/' + name });
    const event = name => callback => { events[name] = callback; return { dispose() { delete events[name]; } }; };
    const workspace = { textDocuments: [], workspaceFolders: [{ uri: uri('') }],
        getConfiguration: () => ({ get: (name, fallback) => overrides[name] ?? fallback }),
        findFiles: async () => { calls.find++; return [...data.keys()].map(uri); },
        fs: { stat: async target => ({ size: Buffer.byteLength(data.get(target.fsPath.slice(7))) }),
            readFile: async target => { calls.read++; return Buffer.from(data.get(target.fsPath.slice(7))); } },
        createFileSystemWatcher: () => ({ onDidCreate: event('create'), onDidChange: event('change'), onDidDelete: event('delete'), dispose() {} }),
        onDidChangeTextDocument: event('edit'), onDidCloseTextDocument: event('close'), onDidChangeConfiguration: event('config'), onDidChangeWorkspaceFolders: event('folders') };
    const index = createCompletionIndex({ vscode: { workspace }, onError: message => calls.errors.push(message) });
    function document(name, text) { return { uri: uri(name), languageId: 'systemverilog', version: 1, getText: () => text }; }
    return { index, workspace, document, events, calls, data, uri };
}

test('工程补全首次索引后复用关闭文件与当前文档版本，不受 lint 配置影响', async () => {
    const h = harness({ 'leaf.sv': 'module leaf(input logic clk); endmodule' }, { scanWorkspace: false });
    const doc = h.document('top.sv', 'module top; leaf dut(); endmodule');
    const first = await h.index.snapshot(doc), second = await h.index.snapshot(doc);
    assert.equal(h.calls.find, 1); assert.equal(h.calls.read, 1);
    assert.equal(first.current.model, second.current.model);
    assert.ok(second.records.some(record => record.model.symbols.some(symbol => symbol.name === 'leaf')));
    h.index.dispose();
});

test('脏文档覆盖磁盘声明，编辑事件只重建对应文档', async () => {
    const h = harness({ 'types.sv': 'package types; int disk_only; endpackage', 'leaf.sv': 'module leaf; endmodule' });
    const doc = h.document('types.sv', 'package types; int unsaved; endpackage'); h.workspace.textDocuments.push(doc);
    const before = await h.index.snapshot(doc); assert.ok(before.current.model.symbols.some(symbol => symbol.name === 'unsaved'));
    assert.equal(h.calls.read, 1);
    doc.version++; doc.getText = () => 'package types; int changed; endpackage'; h.events.edit({ document: doc });
    const after = await h.index.snapshot(doc);
    assert.ok(after.current.model.symbols.some(symbol => symbol.name === 'changed'));
    assert.equal(h.calls.read, 1); assert.notEqual(before.current.model, after.current.model); h.index.dispose();
});

test('文件变更及删除事件淘汰陈旧定义，未变更文件保留解析缓存', async () => {
    const h = harness({ 'leaf.sv': 'module old_leaf; endmodule', 'keep.sv': 'package keep; endpackage' });
    const doc = h.document('top.sv', 'module top; endmodule');
    const before = await h.index.snapshot(doc); const keep = before.records.find(record => record.uri.fsPath.endsWith('keep.sv')).model;
    h.data.set('leaf.sv', 'module new_leaf; endmodule'); h.events.change(h.uri('leaf.sv'));
    const after = await h.index.snapshot(doc);
    assert.ok(after.records.some(record => record.model.symbols.some(symbol => symbol.name === 'new_leaf')));
    assert.equal(after.records.find(record => record.uri.fsPath.endsWith('keep.sv')).model, keep);
    h.data.delete('leaf.sv'); h.events.delete(h.uri('leaf.sv'));
    assert.ok(!(await h.index.snapshot(doc)).records.some(record => record.uri.fsPath.endsWith('leaf.sv'))); h.index.dispose();
});

test('超出文件或单文件容量预算明确标记不完整，当前未保存文本仍可解析', async () => {
    const h = harness({ 'large.sv': ' '.repeat(2048), 'small.sv': 'module small; endmodule' }, { maxFileSizeKB: 1 });
    const doc = h.document('active.sv', 'module active; endmodule');
    const result = await h.index.snapshot(doc);
    assert.equal(result.incomplete, true); assert.equal(h.calls.read, 1); assert.equal(result.current.model.symbols[0].name, 'active');
    h.index.dispose();
    const capped = harness({ 'a.sv': 'module a; endmodule', 'b.sv': 'module b; endmodule' }, { maxFiles: 1 });
    assert.equal((await capped.index.snapshot(capped.document('x.sv', ''))).incomplete, true); capped.index.dispose();
});

test('取消的工程扫描可在下一次请求恢复，不把部分缓存当完整结果', async () => {
    const h = harness({ 'leaf.sv': 'module leaf; endmodule' }); const doc = h.document('top.sv', 'module top; endmodule');
    assert.equal((await h.index.snapshot(doc, { isCancellationRequested: true })).incomplete, true);
    const next = await h.index.snapshot(doc, { isCancellationRequested: false });
    assert.equal(next.incomplete, false); assert.equal(h.calls.read, 1); h.index.dispose();
});

test('并发补全共享同一工程扫描，所有请求仍使用各自的活动文档', async () => {
    const h = harness({ 'leaf.sv': 'module leaf; endmodule' });
    const [one, two] = await Promise.all([h.index.snapshot(h.document('a.sv', 'module a; endmodule')), h.index.snapshot(h.document('b.sv', 'module b; endmodule'))]);
    assert.equal(h.calls.find, 1); assert.equal(h.calls.read, 1);
    assert.equal(one.current.model.symbols[0].name, 'a'); assert.equal(two.current.model.symbols[0].name, 'b'); h.index.dispose();
});


test('生成文件即使被扫描器返回或已打开，也不污染工程补全记录', async () => {
    const h = harness({ '.svtools/circuit/sources.sv': 'module stale_copy; endmodule', 'leaf.sv': 'module leaf; endmodule' });
    const generated = h.document('.svtools/circuit/sources.sv', 'module opened_copy; endmodule');
    h.workspace.textDocuments.push(generated);
    try {
        const result = await h.index.snapshot(h.document('top.sv', 'module top; endmodule'));
        assert.ok(result.records.every(record => !record.uri.fsPath.includes('/.svtools/')));
        assert.equal(h.calls.read, 1);
        const internal = await h.index.snapshot(generated);
        assert.ok(internal.current.model.symbols.some(symbol => symbol.name === 'opened_copy'));
        assert.ok(internal.records.every(record => !record.uri.fsPath.includes('/.svtools/')));
    } finally { h.index.dispose(); }
});
