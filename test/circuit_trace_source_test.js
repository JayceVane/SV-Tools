'use strict';
const { createSourceWatch } = require('../src/circuit/source-watch');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { traceSelection, traceCandidates, instanceContexts, keyPath } = require('../src/circuit/trace-source');
const { sourceHash, snapshotSources, createSourceLocator } = require('../src/circuit/source-snapshots');
const { fromYosys } = require('../src/circuit/adapters/yosys');

test('源码选择按声明作用域解析，引用不被误当作块内声明，静态位范围保留', () => {
    const text = 'module top(input logic clk, output logic [3:0] q); logic [3:0] r; always @(posedge clk) begin q <= r[2]; end endmodule';
    const target = traceSelection(text, { offset: text.indexOf('r[2]') });
    assert.equal(target.qualifiedName, 'r'); assert.deepEqual(target.indices, [2]);
    assert.equal(target.declColumn, text.indexOf(' r;') + 2);
    const range = traceSelection(text.replace('r[2]', 'r[3:1]'), { offset: text.indexOf('r[2]') });
    assert.deepEqual(range.indices, [1, 2, 3]);
    const dynamic = traceSelection(text.replace('r[2]', 'r[index]'), { offset: text.indexOf('r[2]') });
    assert.equal(dynamic.dynamicSelect, true);
    assert.throws(() => traceSelection(text, { offset: text.indexOf('top(') }), /信号声明/);
});

test('注释、类型、任务局部及匿名块声明不产生不可靠网络起点', () => {
    for (const text of ['module top; // value\nendmodule', 'module top; task t; int value; endtask endmodule', 'module top; initial begin int value; end endmodule']) {
        assert.throws(() => traceSelection(text, { offset: text.indexOf('value') }), /信号|标识符/);
    }
    const text = 'module top; if(1) begin: gen logic value; end endmodule';
    assert.equal(traceSelection(text, { offset: text.indexOf('value') }).qualifiedName, 'gen.value');
});

test('条件编译声明会标记不确定上下文，刷新按原声明身份重定位', () => {
    const text = 'module top;\n`ifdef TEST\nlogic value;\n`endif\nendmodule';
    const target = traceSelection(text, { offset: text.indexOf('value') });
    assert.equal(target.conditional, true);
    const fresh = traceSelection('// heading\n' + text, { previous: target });
    assert.equal(fresh.declLine, target.declLine + 1);
});

test('源码候选联合源码快照、模块位置和真实网络，重复实例必须显式区分', () => {
    const file = path.resolve('test', 'trace-source.sv'), text = 'module lane(input a, output y); assign y=a; endmodule';
    const model = fromYosys({ modules: {
        top: { attributes: { top: 1 }, ports: {}, cells: { u0: { type: 'lane', connections: { a: [1], y: [2] } }, u1: { type: 'lane', connections: { a: [3], y: [4] } } }, netnames: {} },
        lane: { attributes: { src: file.replace(/\\/g, '/') + ':1.1' }, ports: { a: { direction: 'input', bits: [1] }, y: { direction: 'output', bits: [1] } }, cells: {}, netnames: { y: { bits: [1] } } }
    } });
    const target = { ...traceSelection(text, { offset: text.indexOf('y)') }), path: file, sourceHash: sourceHash(text) };
    const snapshots = new Map([[keyPath(file), { hash: target.sourceHash }]]);
    const candidates = traceCandidates(model, target, snapshots).candidates;
    assert.equal(candidates.length, 2); assert.notDeepEqual(candidates[0].instancePath, candidates[1].instancePath);
    assert.throws(() => traceCandidates(model, { ...target, sourceHash: 'different' }, snapshots), /快照不一致/);
    assert.equal(traceCandidates(model, { ...target, moduleLine: 2 }, snapshots).candidates.length, 0);
    assert.equal(traceCandidates(model, { ...target, conditional: true }, snapshots).candidates.length, 0);
});

test('生成前快照支持脏正文映射，内容变化后验证失效；声明定位使用原始内容身份', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-source-snapshot-'));
    t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
    const original = path.join(root, 'original.sv'), snapshot = path.join(root, 'snapshot.sv');
    const text = 'module top(input logic a, output logic y); assign y=a; endmodule\n';
    await fs.writeFile(original, '// disk differs\n'); await fs.writeFile(snapshot, text);
    const entries = await snapshotSources({ sources: [snapshot], sourceMap: { [snapshot]: original } });
    assert.equal(entries[0].path, original); assert.equal(entries[0].hash, sourceHash(text));
    const model = fromYosys({ modules: { top: { attributes: { src: original.replace(/\\/g, '/') + ':1.1' },
        ports: { a: { direction: 'input', bits: [1] }, y: { direction: 'output', bits: [1] } }, cells: {}, netnames: { y: { bits: [1] } } } } });
    const locator = createSourceLocator(model, entries); await locator.verify();
    const source = await locator.locate(model.top, { objectId: model.modules[0].ports.find(port => port.name === 'y').id });
    assert.equal(source.column, text.indexOf('y)') + 1); assert.equal(source.expectedHash, sourceHash(text));
    await fs.writeFile(snapshot, text.replace('a;', '~a;'));
    const fresh = createSourceLocator(model, entries); await fresh.verify(); assert.equal(fresh.snapshots.size, 0);
    assert.equal(sourceHash('\uFEFFa\r\n'), sourceHash('a\n'));
});

test('源码观察仅检查已编译文件，合并输入事件，一次提示且换快照和关闭清理资源', () => {
    const timers = new Map(); let next = 0, handler, disposed = false, warnings = 0, content = 'module a; endmodule';
    const document = { uri: { fsPath: path.resolve('tracked.sv') }, getText: () => content };
    const clock = { setTimeout(callback) { timers.set(++next, callback); return next; }, clearTimeout(id) { timers.delete(id); } };
    const flush = () => { for (const callback of [...timers.values()]) callback(); timers.clear(); };
    const watch = createSourceWatch({ clock, onStale() { warnings++; }, vscode: { workspace: { textDocuments: [document],
        onDidChangeTextDocument(callback) { handler = callback; return { dispose() { disposed = true; } }; } } } });
    watch.replace([{ path: document.uri.fsPath, hash: sourceHash(content) }]); flush(); assert.equal(warnings, 0);
    handler({ document: { uri: { fsPath: path.resolve('unrelated.sv') } } }); assert.equal(timers.size, 0);
    content += '\n// edited'; handler({ document }); handler({ document }); assert.equal(timers.size, 1); flush(); assert.equal(warnings, 1);
    handler({ document }); assert.equal(timers.size, 0);
    watch.replace([{ path: document.uri.fsPath, hash: sourceHash(content) }]); flush(); assert.equal(warnings, 1);
    content += '\n'; handler({ document }); watch.dispose(); assert.equal(timers.size, 0); assert.equal(disposed, true);
});

test('层级成员和局部遮蔽不得误命中同名模块信号', () => {
    for (const expression of ['u.a', 'u./* reference */a', 'packet.a', 'pkg::a']) {
        const source = `module top; logic a,q; assign q=${expression}; endmodule`;
        assert.throws(() => traceSelection(source, { offset: source.lastIndexOf('a') }), /层级引用|成员/);
    }
    for (const body of ['task send(input logic a); $display(a); endtask',
        'initial begin logic a; $display(a); end']) {
        const source = `module top; logic a; ${body} endmodule`;
        assert.throws(() => traceSelection(source, { offset: source.indexOf('$display(a)') + 9 }), /局部声明|唯一/);
    }
});

test('实例上下文宽队列和深层级受限，缺失部分必须报告截断', () => {
    const broad = { top: 'top', modules: [{ id: 'top', cells: Array.from({ length: 5000 }, (_, i) => ({ id: 'u' + i, name: 'u' + i, moduleId: 'leaf' })) }, { id: 'leaf', cells: [] }] };
    const contexts = instanceContexts(broad, 'leaf'); assert.equal(contexts.contexts.length, 256); assert.equal(contexts.truncated, true);
    const deep = { top: 'm0', modules: Array.from({ length: 67 }, (_, i) => ({ id: 'm' + i,
        cells: i < 66 ? [{ id: 'c' + i, name: 'u', moduleId: 'm' + (i + 1) }] : [] })) };
    assert.deepEqual(instanceContexts(deep, 'm66'), { contexts: [], truncated: true });
});
