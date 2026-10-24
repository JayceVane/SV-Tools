'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
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
    const expected = '    initial $display("中文");\n';
    let received;
    const harness = formatterHarness({ formatText: (text, options) => {
        received = { text, options };
        return expected;
    } }, { tabSize: 2, useTab: true, inlineCompact: false, blankCompact: false, maxConsecutiveEmptyLines: -1 });
    const document = { getText: actualRange => {
        assert.equal(actualRange, range);
        return source;
    } };
    assert.equal(await harness.formatter.formatDocument(document, range), expected);
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

for (const [label, output] of [
    ['删除字符', 'module demo; endmodul\n'],
    ['添加字符', 'module demo;; endmodule\n'],
    ['重排字符', 'endmodule module demo;\n'],
    ['替换字符', 'module Demo; endmodule\n'],
    ['错误返回类型', null]
]) test(`编辑器拒绝原生结果${label}，全文与选区均保留原文`, async context => {
    context.mock.method(console, 'warn', () => {});
    const source = 'module demo; endmodule\n', range = { start: 0, end: 1 };
    const h = formatterHarness({ formatText: () => output });
    for (const selection of [null, range]) {
        assert.equal(await h.formatter.formatDocument({ getText: actual => { assert.equal(actual, selection); return source; } }, selection), source);
    }
    assert.deepEqual(h.errors, []);
});

test('编辑器按UTF-16保全孤立代理项、非布局空白与NUL，不接受有损替换', async context => {
    context.mock.method(console, 'warn', () => {});
    for (const character of ['\ud800', '\udfff', '\u0000', '\u000b', '\u000c', '\u00a0', '\u3000', '\ufeff', '\u2028', '\u2029', '\u200b']) {
        const source = 'a' + character + 'b\r\n';
        const h = formatterHarness({ formatText: () => 'a�b\n' });
        assert.equal(await h.formatter.formatDocument({ getText: () => source }), source);
    }
});

test('对齐选区也校验原生结果，只有排版变化才能创建替换', async context => {
    context.mock.method(console, 'warn', () => {});
    const source = 'logic a;\n\u00a0', selection = { start: 0, end: 1 }, replacements = [];
    let result;
    const commands = createEditorCommands({
        loadNativeModule: () => ({ alignCode: (text, tabSize) => { assert.equal(text, source); assert.equal(tabSize, 4); return result; } }),
        reportNativeMissing() { assert.fail('native missing'); },
        vscode: { workspace: { getConfiguration: () => configuration() }, window: {
            activeTextEditor: { selection, document: { getText: range => { assert.equal(range, selection); return source; } },
                edit: async callback => callback({ replace: (...args) => replacements.push(args) }) },
            showErrorMessage: message => assert.fail(message)
        } }
    });
    for (result of ['logic a;\n', 'logic b;\n\u00a0', undefined]) await commands.alignSelectedCode();
    assert.equal(replacements.length, 0);
    result = '\tlogic a;\r\n\u00a0'; await commands.alignSelectedCode();
    assert.deepEqual(replacements, [[selection, result]]);
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
function headerHarness(headerTemplate, options = {}) {
    const calls = [];
    const insertions = [];
    const errors = [], scopes = [], reads = [];
    const fileName = path.resolve('test', 'header project', 'rtl', 'demo.sv');
    const fileUri = fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath });
    const uri = fileUri(fileName);
    const folder = { uri: fileUri(path.dirname(path.dirname(fileName))) };
    const native = { generateHeader: (...args) => { calls.push(args); return 'generated header\n'; } };
    const commands = createEditorCommands({
        loadNativeModule: () => native,
        reportNativeMissing: () => { throw new Error('native unexpectedly missing'); },
        vscode: {
            Position: class Position { constructor(line, character) { this.line = line; this.character = character; } },
            Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(path.resolve(base.fsPath, ...parts)) },
            workspace: {
                getWorkspaceFolder: () => options.outsideWorkspace ? undefined : folder,
                fs: { readFile: async target => {
                    reads.push(target.fsPath);
                    if (options.readError) throw options.readError;
                    return Buffer.from(options.fileContent ?? '// file {FILE}\n');
                } },
                getConfiguration: (namespace, scope) => {
                    scopes.push({ namespace, scope });
                    return namespace === 'svtools'
                        ? configuration({ headerTemplate, headerTemplateFile: options.file || '' })
                        : { get: name => { assert.equal(name, 'tabSize'); return 2; } };
                }
            },
            window: {
                activeTextEditor: {
                    document: { fileName, uri },
                    edit: async callback => callback({ insert: (position, text) => insertions.push({ position, text }) })
                },
                showErrorMessage: message => errors.push(message)
            }
        }
    });
    return { commands, calls, insertions, fileName, uri, folder, scopes, reads, errors };
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


test('文件头设置使用多行控件并允许按资源配置外部UTF-8文件', () => {
    assert.equal(defaults['svtools.headerTemplate'].editPresentation, 'multilineText');
    assert.equal(defaults['svtools.headerTemplate'].scope, 'resource');
    assert.equal(defaults['svtools.headerTemplateFile'].scope, 'resource');
    assert.equal(defaults['svtools.headerTemplateFile'].default, '');
});

test('文件头与缩进设置读取当前文档的资源作用域', async () => {
    const harness = headerHarness('// one\n// two\n');
    await harness.commands.insertHeaderTemplate();
    assert.deepEqual(harness.scopes, [
        { namespace: 'editor', scope: harness.uri }, { namespace: 'svtools', scope: harness.uri }
    ]);
});

test('外部模板优先于内联，按当前文件所属工作区解析且保留中文与字面转义', async () => {
    const custom = '\uFEFF// 中文 {FILE}\r\n// C:\\new\\tools\\template\r\n// literal \\n';
    const harness = headerHarness('// inline\n', { file: 'templates/公司.txt', fileContent: custom });
    await harness.commands.insertHeaderTemplate();
    assert.deepEqual(harness.reads, [path.join(harness.folder.uri.fsPath, 'templates', '公司.txt')]);
    assert.equal(harness.calls[0][0], '// 中文 {FILE}\n// C:\\new\\tools\\template\n// literal \\n\n');
    assert.deepEqual(harness.errors, []);
});

test('模板支持workspaceFolder前缀和绝对路径，工作区外相对路径以源码目录为准', async () => {
    for (const options of [
        { file: '${workspaceFolder}/templates/head.txt', suffix: ['templates', 'head.txt'] },
        { file: path.resolve('bin', 'header 公司.txt'), absolute: true },
        { file: 'head.txt', outsideWorkspace: true }
    ]) {
        const harness = headerHarness('', options);
        await harness.commands.insertHeaderTemplate();
        const base = options.outsideWorkspace ? path.dirname(harness.fileName) : harness.folder.uri.fsPath;
        assert.deepEqual(harness.reads, [options.absolute ? options.file : path.join(base, ...(options.suffix || [options.file]))]);
        assert.equal(harness.insertions.length, 1);
    }
});

test('内联多行保留空行，缺少末尾换行时补齐，防止行注释吞掉源码', async () => {
    const harness = headerHarness('// one\r\n\r\n// two');
    await harness.commands.insertHeaderTemplate();
    assert.equal(harness.calls[0][0], '// one\n\n// two\n');
});

test('外部文件每次读取，修改模板后无需重载插件', async () => {
    const options = { file: 'head.txt', fileContent: '// first' };
    const harness = headerHarness('', options);
    await harness.commands.insertHeaderTemplate();
    options.fileContent = '// second';
    await harness.commands.insertHeaderTemplate();
    assert.deepEqual(harness.calls.map(args => args[0]), ['// first\n', '// second\n']);
});

test('文件不存在、空白、非UTF-8均明确报错且不回退或修改编辑器', async () => {
    for (const options of [
        { readError: new Error('ENOENT: fixture not found') },
        { fileContent: ' \r\n\t' },
        { fileContent: Buffer.from([0xff, 0xfe, 0x61, 0]) }
    ]) {
        const harness = headerHarness('// fallback\n', { ...options, file: 'templates/broken.txt' });
        await harness.commands.insertHeaderTemplate();
        assert.equal(harness.calls.length, 0);
        assert.equal(harness.insertions.length, 0);
        assert.equal(harness.errors.length, 1);
        assert.ok(harness.errors[0].includes('broken.txt'));
    }
});


test('跨文件定义检索排除电路临时文件，避免打开快照触发自动lint', async () => {
    const { createLanguageProviders } = require('../src/editor/language');
    const uri = fsPath => ({ fsPath, toString: () => fsPath });
    const generated = uri('C:/hdl/.svtools/circuit/yosys-test/sources.sv'), source = uri('C:/hdl/rtl/target.sv');
    const opened = [], searches = [];
    const vscode = { Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
        Location: class { constructor(uri, position) { Object.assign(this, { uri, position }); } },
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }),
            findFiles: async (pattern, exclude) => { searches.push({ pattern, exclude }); return [generated, source]; },
            openTextDocument: async uri => { opened.push(uri); return { getText: () => 'module target; endmodule', positionAt: () => ({ line: 0 }) }; } } };
    const providers = createLanguageProviders({ vscode, loadNativeModule: () => null });
    try {
        const query = { getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 6 } }),
            getText: () => 'target', lineAt: () => ({ text: 'target u_target();' }) };
        const result = await providers.provideDefinition(query, { line: 0, character: 2 });
        assert.equal(result.uri, source); assert.deepEqual(opened, [source]);
        assert.equal(searches[0].exclude, require('../src/workspace/source-policy').SOURCE_EXCLUDE_GLOB);
    } finally { providers.dispose(); }
});
