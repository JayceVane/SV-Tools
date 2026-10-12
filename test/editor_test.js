'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createFormatter } = require('../src/editor/formatting');
const { createEditorCommands } = require('../src/editor/commands');
const defaults = require('../package.json').contributes.configuration.properties;

/** 模拟配置读取，保留清单默认的空字符串和显式 false。 */
function configuration(overrides = {}) {
    return {
        get(name, fallback) {
            if (Object.hasOwn(overrides, name)) return overrides[name];
            return defaults['svtools.' + name]?.default ?? fallback;
        }
    };
}

function formatterHarness(native, overrides = {}) {
    const errors = [];
    let missingCount = 0;
    const formatter = createFormatter({
        vscode: {
            workspace: { getConfiguration: namespace => {
                assert.equal(namespace, 'svtools');
                return configuration(overrides);
            } },
            window: { showErrorMessage: message => errors.push(message) }
        },
        loadNativeModule: () => native,
        reportNativeMissing: () => { missingCount++; }
    });
    return { formatter, errors, missingCount: () => missingCount };
}

test('编辑器格式化准确读取选择范围并传递原文和配置', async () => {
    const range = { start: { line: 2, character: 0 }, end: { line: 4, character: 9 } };
    const source = 'initial $display("中文");\n';
    let received;
    const harness = formatterHarness({ formatText: (text, options) => {
        received = { text, options };
        return 'formatted source\n';
    } }, { tabSize: 2, useTab: true, inlineCompact: false, blankCompact: false, maxConsecutiveEmptyLines: -1 });
    const document = { getText: actualRange => {
        assert.equal(actualRange, range);
        return source;
    } };
    assert.equal(await harness.formatter.formatDocument(document, range), 'formatted source\n');
    assert.equal(received.text, source);
    assert.equal(received.options.nbSpace, 2);
    assert.equal(received.options.useTab, true);
    assert.equal(received.options.inlineCompact, false);
    assert.equal(received.options.blankCompact, false);
    assert.equal(received.options.maxConsecutiveEmptyLines, -1);
});

test('全文格式化读取整个文档并返回原生结果', async () => {
    const source = 'module demo; endmodule\n';
    const harness = formatterHarness({ formatText: text => text });
    const document = { getText: range => { assert.equal(range, null); return source; } };
    assert.equal(await harness.formatter.formatDocument(document), source);
    assert.deepEqual(harness.errors, []);
});

test('原生模块缺失时编辑器格式化返回 null，并报告一次', async () => {
    const harness = formatterHarness(null);
    const document = { getText: () => { throw new Error('缺失模块时不应读取文档'); } };
    assert.equal(await harness.formatter.formatDocument(document), null);
    assert.equal(harness.missingCount(), 1);
});

test('原生格式化异常转为编辑器错误提示和 null', async context => {
    context.mock.method(console, 'error', () => {});
    const harness = formatterHarness({ formatText: () => { throw new Error('native contract failure'); } });
    assert.equal(await harness.formatter.formatDocument({ getText: () => 'source' }), null);
    assert.equal(harness.errors.length, 1);
    assert.match(harness.errors[0], /native contract failure/);
    assert.equal(harness.missingCount(), 0);
});

/** 只模拟 header 命令需要的编辑器 API，所有修改均记录为插入操作。 */
function headerHarness(headerTemplate) {
    const calls = [];
    const insertions = [];
    const fileName = 'C:\\hdl project\\demo.sv';
    const native = { generateHeader: (...args) => { calls.push(args); return 'generated header\n'; } };
    const commands = createEditorCommands({
        loadNativeModule: () => native,
        reportNativeMissing: () => { throw new Error('native unexpectedly missing'); },
        vscode: {
            Position: class Position { constructor(line, character) { this.line = line; this.character = character; } },
            workspace: { getConfiguration: namespace => namespace === 'svtools'
                ? configuration({ headerTemplate })
                : { get: name => { assert.equal(name, 'tabSize'); return 2; } } },
            window: {
                activeTextEditor: {
                    document: { fileName },
                    edit: async callback => callback({ insert: (position, text) => insertions.push({ position, text }) })
                },
                showErrorMessage: message => { throw new Error(message); }
            }
        }
    });
    return { commands, calls, insertions, fileName };
}

test('清单默认空 headerTemplate 使用非空且未缩进的内置模板', async () => {
    const harness = headerHarness('');
    await harness.commands.insertHeaderTemplate();
    assert.equal(harness.calls.length, 1);
    const [template, fileName, tabSize] = harness.calls[0];
    assert.ok(template.includes('{FILE}'));
    assert.ok(template.includes('{DATE}'));
    assert.ok(template.split(/\r?\n/).filter(Boolean).every(line => line.startsWith('//')));
    assert.equal(fileName, harness.fileName);
    assert.equal(tabSize, 2);
    assert.equal(harness.insertions[0].position.line, 0);
    assert.equal(harness.insertions[0].position.character, 0);
    assert.equal(harness.insertions[0].text, 'generated header\n');
});

test('自定义 headerTemplate 原样传给原生模块', async () => {
    const custom = '// 中文 {FILE}\n// {DATE}\n';
    const harness = headerHarness(custom);
    await harness.commands.insertHeaderTemplate();
    assert.equal(harness.calls[0][0], custom);
    assert.equal(harness.insertions.length, 1);
});
