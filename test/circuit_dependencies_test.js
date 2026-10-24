'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveSourceClosure, MAX_SCAN_FILES, MAX_FILE_BYTES } = require('../src/circuit/source-dependencies');
const { createCircuitSourceResolver } = require('../src/circuit/source-context');
const { prepareSourceRequest } = require('../src/circuit/source-request');
const { createToolTaskManager } = require('../src/toolchains/job');

async function fixture(t, contents) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-deps-')), files = [];
    for (const [name, text] of Object.entries(contents)) { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); files.push(file); }
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, files, current: path.join(root, 'top.sv'), top: 'top' };
}

test('自动收集参数化generate子模块与包的传递闭包，排除无关仿真代码和注释假实例', async t => {
    const input = await fixture(t, { 'top.sv': 'module top; import types::*; child #(.N(2)) inst[2](); // fake u();\nendmodule',
        'not-child-name.sv': 'module child #(parameter N=1); generate for(genvar i=0;i<N;i++) begin leaf u(); end endgenerate endmodule',
        'leaf.sv': 'module leaf; endmodule', 'types.sv': 'package types; typedef enum {A,B} kind_t; endpackage',
        'tb.sv': 'module unused_tb; totally_unknown u(); initial $finish; endmodule' });
    const result = (await resolveSourceClosure(input)).map(file => path.basename(file));
    assert.deepEqual(result, ['types.sv', 'leaf.sv', 'not-child-name.sv', 'top.sv']);
});

test('限定名包引用自动排在使用方之前，不凭类型名猜测import', async t => {
    const input = await fixture(t, { 'top.sv': 'module top #(parameter types::kind_t X=types::A)(); endmodule',
        'types.sv': 'package types; typedef enum {A,B} kind_t; endpackage' });
    assert.deepEqual((await resolveSourceClosure(input)).map(file => path.basename(file)), ['types.sv', 'top.sv']);
    await fs.writeFile(input.current, 'module top #(parameter kind_t X=0)(); endmodule');
    assert.deepEqual(await resolveSourceClosure(input), [input.current]);
});

test('只对实际引用的重复定义报错，不能由文件发现顺序决定所用模块', async t => {
    const input = await fixture(t, { 'top.sv': 'module top; child u(); endmodule', 'a.sv': 'module child; endmodule', 'b.sv': 'module child; endmodule' });
    await assert.rejects(resolveSourceClosure(input), /重复定义 child.*svtools\.circuit\.sources/);
    await fs.writeFile(input.current, 'module top; endmodule'); assert.deepEqual(await resolveSourceClosure(input), [input.current]);
});

test('字面include已经提供子模块时不再重复作为独立源读入，仍补齐其外部依赖', async t => {
    const input = await fixture(t, { 'top.sv': '`include "child.sv"\nmodule top; child u(); endmodule',
        'child.sv': 'module child; leaf u(); endmodule', 'leaf.sv': 'module leaf; endmodule' });
    assert.deepEqual((await resolveSourceClosure(input)).map(file => path.basename(file)), ['leaf.sv', 'top.sv']);
});

test('循环实例不会让依赖收集递归失控，未解析名称交给真实编译器诊断', async t => {
    const input = await fixture(t, { 'top.sv': 'module top; child u(); missing v(); endmodule', 'child.sv': 'module child; top u(); endmodule' });
    assert.deepEqual((await resolveSourceClosure(input)).map(file => path.basename(file)), ['child.sv', 'top.sv']);
});

test('自动扫描有文件、字节与工作区边界，拒绝不完整上下文', async t => {
    const input = await fixture(t, { 'top.sv': 'module top; endmodule' });
    await assert.rejects(resolveSourceClosure({ ...input, files: Array(MAX_SCAN_FILES + 1).fill(input.current) }), /4096/);
    await assert.rejects(resolveSourceClosure({ ...input, files: [path.join(input.root, '../outside.sv')] }), /工作区之外/);
    await assert.rejects(resolveSourceClosure({ ...input, documents: [{ file: input.current, text: ' '.repeat(MAX_FILE_BYTES + 1) }] }), /2 MiB/);
});

test('正式适配器在Worker解析依赖并为同名文件的脏正文建立独立快照', async t => {
    const input = await fixture(t, { 'top.sv': 'module top; child_a a(); child_b b(); endmodule',
        'a/child.sv': 'module child_a; endmodule', 'b/child.sv': 'module child_b; endmodule' });
    const dirty = input.files.slice(1).map(file => ({ uri: { scheme: 'file', fsPath: file }, isDirty: true, getText: () => 'module ' + (file.includes(path.sep+'a'+path.sep) ? 'child_a' : 'child_b') + '; wire changed; endmodule' }));
    const vscode = { workspace: { textDocuments: dirty, findFiles: async () => input.files.map(fsPath => ({ fsPath })) } };
    const manager = createToolTaskManager(), task = manager.start('auto');
    t.after(async () => { task.cancel(); await task.finish({ keepArtifacts: true }); await manager.dispose(); });
    const result = await prepareSourceRequest({ task, root: input.root, top: 'top', outputBase: path.join(input.root, 'tasks'), config: {},
        document: { uri: { fsPath: input.current }, isDirty: false, getText: () => 'module top; child_a a(); child_b b(); endmodule' }, resolveSources: createCircuitSourceResolver({ vscode }) });
    const snapshots = Object.keys(result.sourceMap); assert.equal(snapshots.length, 2); assert.notEqual(snapshots[0], snapshots[1]);
    for (const snapshot of snapshots) assert.match(await fs.readFile(snapshot, 'utf8'), /changed/);
    for (const file of input.files.slice(1)) assert.doesNotMatch(await fs.readFile(file, 'utf8'), /changed/);
    assert.equal(result.sources.at(-1), input.current);
});

test('显式sources保留用户顺序且不启动自动扫描，已取消任务不会继续解析', async t => {
    const input = await fixture(t, { 'top.sv': 'module top; endmodule' });
    const resolver = createCircuitSourceResolver({ vscode: { workspace: { findFiles() { throw new Error('不应发现文件'); } } } });
    const current = { file: input.current, text: 'module top; endmodule', isDirty: false }, sources = ['b.sv','a.sv',input.current];
    assert.deepEqual((await resolver({ ...input, current, sources, isExplicit: true, task: { throwIfCancelled() {} } })).sources, sources);
    await assert.rejects(resolver({ ...input, current, sources: [], isExplicit: false, task: { throwIfCancelled() { throw new Error('cancelled'); } } }), /cancelled/);
});


test('接口端口类型加入自动源闭包', async t => {
    const input = await fixture(t, { 'top.sv': 'module top(bus link); endmodule', 'bus.sv': 'interface bus; logic req; endinterface' });
    for (const port of ['bus link', 'bus.master link']) {
        await fs.writeFile(input.current, 'module top(' + port + '); endmodule');
        assert.deepEqual((await resolveSourceClosure(input)).map(file => path.basename(file)), ['bus.sv', 'top.sv']);
    }
});


test('含局部include的未保存依赖明确要求先保存，不能误读当前文件目录的同名头', async t => {
    const input = await fixture(t, { 'top.sv': 'module top; child u(); endmodule', 'local.svh': '`define VALUE 0',
        'lib/child.sv': '`include "local.svh"\nmodule child; endmodule', 'lib/local.svh': '`define VALUE 1' });
    const child = path.join(input.root, 'lib/child.sv'), body = await fs.readFile(child, 'utf8');
    const resolver = createCircuitSourceResolver({ vscode: { workspace: {
        findFiles: async () => input.files.filter(file => file.endsWith('.sv')).map(fsPath => ({ fsPath })),
        textDocuments: [{ uri: { scheme: 'file', fsPath: child }, isDirty: true, getText: () => body + '\n// dirty' }]
    } } });
    const manager = createToolTaskManager(), task = manager.start('include-context');
    t.after(async () => { task.cancel(); await task.finish({ keepArtifacts: true }); await manager.dispose(); });
    await assert.rejects(resolver({ ...input, current: { file: input.current, text: await fs.readFile(input.current, 'utf8'), isDirty: false },
        sources: [], isExplicit: false, task }), /依赖文件尚未保存且包含 include/);
    assert.equal(await fs.readFile(child, 'utf8'), body);
});
