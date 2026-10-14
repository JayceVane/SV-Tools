'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createCompletionProvider } = require('../src/editor/completion/provider');
const { complete } = require('../src/editor/completion/engine');

const DEFAULT_FILES = 512;
const DEFAULT_LINES = 100000;
const SAMPLE_COUNT = 20;
const round = value => Math.round(value * 100) / 100;
const percentile = (values, quantile) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1];

/** 真实生成和读取数百 HDL 文件与十万行文档，记录每次发现/读取并验证缓存复用。 */
async function run() {
    const arg = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
    const fileCount = Number(arg('--files') || DEFAULT_FILES), lineCount = Number(arg('--lines') || DEFAULT_LINES);
    assert.ok(Number.isInteger(fileCount) && fileCount >= 1 && fileCount <= 20000, '--files 必须在 1–20000 之间');
    assert.ok(Number.isInteger(lineCount) && lineCount >= 1000 && lineCount <= 500000, '--lines 必须在 1000–500000 之间');
    const reportRoot = path.resolve(__dirname, '..', 'bin', 'completion-performance');
    await fs.mkdir(reportRoot, { recursive: true });
    const root = await fs.mkdtemp(path.join(reportRoot, 'run-'));
    const fixture = path.join(root, 'workspace'); await fs.mkdir(fixture);
    for (let index = 0; index < fileCount; index++) {
        const body = Array.from({ length: 32 }, (_, field) => `    int field_${field};`).join('\n');
        await fs.writeFile(path.join(fixture, `types_${index}.sv`), `package types_${index};\nclass leaf_${index};\n${body}\nendclass\nendpackage\n`);
    }
    const tailName = `word_${String(lineCount - 4).padStart(6, '0')}`, prefix = tailName.slice(0, -1);
    const largeText = ['module large;', ...Array.from({ length: lineCount - 3 }, (_, line) => `logic [31:0] word_${String(line).padStart(6, '0')};`), 'initial ' + prefix, 'endmodule'].join('\n');
    const largePath = path.join(fixture, 'large.sv'); await fs.writeFile(largePath, largeText);
    const metrics = { find: 0, stat: 0, read: 0, bytesRead: 0 };
    const callbacks = {};
    const configValues = { maxFileSizeKB: 65536, maxTotalSourceMB: 128, maxFiles: fileCount + 10, uvmVersion: '1.2' };
    const uri = fsPath => ({ fsPath, toString: () => 'file:///' + fsPath.replace(/\\/g, '/') });
    const on = name => callback => { callbacks[name] = callback; return { dispose() { delete callbacks[name]; } }; };
    const lines = text => { const offsets = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1); return offsets; };
    function document(filename, text) {
        let offsets = lines(text);
        return { uri: uri(filename), languageId: 'systemverilog', version: 1,
            getText: () => text,
            positionAt(offset) { let low = 0, high = offsets.length; while (low + 1 < high) { const mid = (low + high) >> 1; if (offsets[mid] <= offset) low = mid; else high = mid; } return { line: low, character: offset - offsets[low] }; },
            offsetAt(position) { return offsets[position.line] + position.character; },
            replace(next) { text = next; offsets = lines(text); this.version++; } };
    }
    const current = document(largePath, largeText);
    const workspace = {
        textDocuments: [current], workspaceFolders: [{ uri: uri(fixture) }],
        getConfiguration: () => ({ get: (name, fallback) => configValues[name] ?? fallback }),
        async findFiles() { metrics.find++; return (await fs.readdir(fixture)).filter(name => /\.(sv|v|svh|vh)$/.test(name)).map(name => uri(path.join(fixture, name))); },
        fs: {
            async stat(target) { metrics.stat++; return fs.stat(target.fsPath); },
            async readFile(target) { metrics.read++; const data = await fs.readFile(target.fsPath); metrics.bytesRead += data.length; return data; }
        },
        createFileSystemWatcher: () => ({ onDidCreate: on('create'), onDidChange: on('change'), onDidDelete: on('delete'), dispose() {} }),
        onDidChangeTextDocument: on('edit'), onDidCloseTextDocument: on('close'), onDidChangeConfiguration: on('config'), onDidChangeWorkspaceFolders: on('folders')
    };
    class Range { constructor(start, end) { this.start = start; this.end = end; } }
    class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
    class SnippetString { constructor(value) { this.value = value; } }
    class CompletionList { constructor(items, isIncomplete) { this.items = items; this.isIncomplete = isIncomplete; } }
    const errors = [];
    const provider = createCompletionProvider({ vscode: { workspace, Range, CompletionItem, SnippetString, CompletionList, CompletionItemKind: {} }, onError: message => errors.push(message) });
    const timings = {};
    const memory = {};
    const measure = async (name, action) => { const start = performance.now(); const value = await action(); timings[name] = round(performance.now() - start);
        const usage = process.memoryUsage(); memory[name] = { heapMB: round(usage.heapUsed / 1024 / 1024), rssMB: round(usage.rss / 1024 / 1024) };
        console.log('COMPLETION_STAGE ' + JSON.stringify({ name, milliseconds: timings[name], ...memory[name] })); return value; };
    const offset = largeText.indexOf('initial ' + prefix) + ('initial ' + prefix).length;
    const position = current.positionAt(offset);
    try {
        const cold = await measure('coldIndexMilliseconds', () => provider.index.snapshot(current));
        assert.equal(cold.incomplete, false); assert.equal(cold.records.length, fileCount + 1);
        const first = await measure('coldEngineMilliseconds', () => complete(cold, offset, { language: 'systemverilog' }));
        assert.ok(first.items.some(item => item.name === tailName), '文档尾部声明必须可补全');
        const callsAfterCold = { ...metrics };
        const warmTimes = [];
        for (let index = 0; index < SAMPLE_COUNT; index++) {
            const start = performance.now(); await provider.provideCompletionItems(current, position); warmTimes.push(performance.now() - start);
        }
        assert.deepEqual(metrics, callsAfterCold, '未变化文档的热补全不能再次扫描或读取工程');
        const warm = await provider.index.snapshot(current); assert.equal(warm.current.model, cold.current.model, '热补全必须复用文档模型');
        timings.warmProviderMedianMilliseconds = round(percentile(warmTimes, 0.5));
        timings.warmProviderP95Milliseconds = round(percentile(warmTimes, 0.95));
        console.log('COMPLETION_STAGE ' + JSON.stringify({ name: 'warmProvider', medianMilliseconds: timings.warmProviderMedianMilliseconds, p95Milliseconds: timings.warmProviderP95Milliseconds }));
        const scale = Math.max(1, fileCount / DEFAULT_FILES, lineCount / DEFAULT_LINES);
        assert.ok(timings.coldIndexMilliseconds < 5000 * scale, '冷索引超过容量对应的 5 秒基线，请检查复杂度');
        assert.ok(timings.warmProviderP95Milliseconds < 250 * scale, '热补全 p95 超过容量对应的 250 毫秒基线，请检查全量遍历');

        const keptModel = warm.records.find(record => record.uri.fsPath.endsWith('types_0.sv')).model;
        const changedPath = path.join(fixture, `types_${fileCount - 1}.sv`);
        await fs.writeFile(changedPath, 'package changed_package; int changed_field; endpackage'); callbacks.change(uri(changedPath));
        const beforeChange = { ...metrics };
        const changed = await measure('oneFileChangeIndexMilliseconds', () => provider.index.snapshot(current));
        assert.equal(metrics.read - beforeChange.read, 1, '单文件事件必须只重新读取该文件');
        if (fileCount > 1) assert.equal(changed.records.find(record => record.uri.fsPath.endsWith('types_0.sv')).model, keptModel);
        assert.ok(changed.records.some(record => record.model.symbols.some(symbol => symbol.name === 'changed_package')));

        current.replace(largeText.replace('initial ' + prefix, 'initial word_00000')); callbacks.edit({ document: current });
        const beforeEdit = { ...metrics };
        const edited = await measure('activeEditIndexMilliseconds', () => provider.index.snapshot(current));
        assert.ok(timings.activeEditIndexMilliseconds < 5000 * scale, '活动文档重新索引超过容量对应的 5 秒基线');
        assert.equal(metrics.read, beforeEdit.read, '活动文档编辑不能重新读取未变化磁盘文件');
        assert.notEqual(edited.current.model, changed.current.model);
        assert.equal(await provider.provideCompletionItems(current, position, { isCancellationRequested: true }), undefined, '取消请求不能返回过期列表');

        configValues.maxFiles = 1; callbacks.config({ affectsConfiguration: name => name === 'svtools.completion' });
        const capped = await provider.provideCompletionItems(current, position);
        assert.equal(capped.isIncomplete, true, '超预算必须明确标记不完整'); assert.equal(errors.length, 0, errors.join('\n'));
        const report = { node: process.version, version: require('../package.json').version, fixture: { root, files: fileCount, lines: lineCount, largeBytes: Buffer.byteLength(largeText) }, timings, memory,
            warmSamples: SAMPLE_COUNT, coldIo: callsAfterCold, totalIo: metrics, resultCount: first.items.length,
            checks: ['冷索引加载全部夹具', `${lineCount} 行尾部声明可补全`, '热补全零发现/读取且模型复用', '单文件变化只读该文件', '活动编辑不读其余文件', '取消请求', '超预算 isIncomplete'], errors };
        await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
        console.log('补全性能报告：' + path.join(root, 'report.json'));
    } finally { provider.dispose(); }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
