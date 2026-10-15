'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createCompletionProvider } = require('../src/editor/completion/provider');

function harness(source, settings = {}) {
    const offset = source.indexOf('§'), text = source.replace('§', ''), calls = { find: 0, dispose: 0, text: 0 };
    const document = { uri: { fsPath: 'C:/hdl/x.sv', toString: () => 'file:///C:/hdl/x.sv' }, languageId: 'systemverilog', version: 1,
        getText: () => { calls.text++; return text; }, offsetAt: position => position.character, positionAt: value => ({ line: 0, character: value }) };
    class Range { constructor(start, end) { this.start = start; this.end = end; } }
    class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
    class SnippetString { constructor(value) { this.value = value; } }
    class CompletionList { constructor(items, isIncomplete) { this.items = items; this.isIncomplete = isIncomplete; } }
    const listener = () => ({ dispose() { calls.dispose++; } });
    const vscode = { Range, CompletionItem, SnippetString, CompletionList, CompletionItemKind: { Method: 1, Keyword: 2 }, workspace: {
        textDocuments: [document], getConfiguration: () => ({ get: (name, fallback) => settings[name] ?? fallback }),
        findFiles: async () => { calls.find++; return []; },
        createFileSystemWatcher: () => ({ onDidCreate: listener, onDidChange: listener, onDidDelete: listener, dispose() { calls.dispose++; } }),
        onDidChangeTextDocument: listener, onDidCloseTextDocument: listener, onDidChangeConfiguration: listener, onDidChangeWorkspaceFolders: listener } };
    return { provider: createCompletionProvider({ vscode }), document, position: document.positionAt(offset), calls, SnippetString };
}

test('VS Code 双 range 正确覆盖中间编辑词并保留后续括号', async () => {
    const h = harness('module x; string s; initial s.to§lower(); endmodule');
    const result = await h.provider.provideCompletionItems(h.document, h.position), item = result.items.find(item => item.label === 'tolower');
    assert.ok(item); assert.equal(result.isIncomplete, false); assert.equal(item.range.inserting.end.character, h.position.character);
    assert.equal(item.range.replacing.end.character - item.range.replacing.start.character, 7); assert.equal(item.insertText, 'tolower'); h.provider.dispose();
});

test('宏及系统调用替换区间排除 sigil 且参数保留 SnippetString 编辑点', async () => {
    for (const [source, expected, sigil] of [['module x; initial $dis§; endmodule', 'display', '$'], ['`uvm_in§', 'uvm_info', '`']]) {
        const h = harness(source), result = await h.provider.provideCompletionItems(h.document, h.position);
        const item = result.items.find(item => item.label === expected); assert.ok(item); assert.ok(item.insertText instanceof h.SnippetString);
        assert.equal(source[item.range.inserting.start.character - 1], sigil); assert.ok(item.insertText.value.startsWith(expected)); h.provider.dispose();
    }
});

test('提前取消不解析文本也不扫描工程，注释请求不启动工程索引', async () => {
    const h = harness('module x; // §');
    assert.equal(await h.provider.provideCompletionItems(h.document, h.position, { isCancellationRequested: true }), undefined);
    assert.deepEqual(h.calls, { find: 0, dispose: 0, text: 0 });
    assert.deepEqual((await h.provider.provideCompletionItems(h.document, h.position)).items, []); assert.equal(h.calls.find, 0); h.provider.dispose();
});

test('不依赖原生模块、资源配置生效且释放所有缓存监听', async () => {
    const h = harness('module x; § endmodule', { standard: '1364-1995', uvmVersion: 'off' });
    const result = await h.provider.provideCompletionItems(h.document, h.position);
    assert.ok(result.items.some(item => item.label === 'module')); assert.ok(!result.items.some(item => item.label === 'logic' || item.label === 'localparam'));
    h.provider.dispose(); assert.equal(h.calls.dispose, 8);
});

test('转义标识符插入必需的终止空白，不把后续标点合并进名称', async () => {
    const h = harness('module x; logic \\a.b ; initial \\a.§ endmodule');
    const result = await h.provider.provideCompletionItems(h.document, h.position), item = result.items.find(item => item.label === '\\a.b');
    assert.ok(item); assert.equal(item.insertText, '\\a.b '); h.provider.dispose();
});
