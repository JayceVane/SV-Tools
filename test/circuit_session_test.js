'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { CircuitSession } = require('../src/circuit/session');

class SilentWorker extends EventEmitter {
    postMessage(message) { this.last = message; }
    terminate() { this.terminated = true; return Promise.resolve(0); }
}

test('关闭会话拒绝全部挂起请求并终止 Worker', async () => {
    const session = new CircuitSession({ WorkerClass: SilentWorker });
    const pending = session.request('layout');
    const rejected = assert.rejects(pending, /已关闭/);
    session.dispose();
    await rejected;
    assert.equal(session.worker.terminated, true);
    await assert.rejects(session.request('load'), /已关闭/);
});

test('Worker 超时或异常不会保留挂起请求', async () => {
    const timed = new CircuitSession({ WorkerClass: SilentWorker, timeoutMs: 10 });
    await assert.rejects(timed.request('layout'), /超时/);
    assert.equal(timed.worker.terminated, true);
    assert.equal(timed.pending.size, 0);
    const broken = new CircuitSession({ WorkerClass: SilentWorker });
    const pending = broken.request('load');
    const rejected = assert.rejects(pending, /memory budget/);
    broken.worker.emit('error', new Error('memory budget'));
    await rejected;
});

test('真实 Worker 完成顶层索引、Yosys 模型、ELK 路由与源码请求', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-circuit-session-'));
    const session = new CircuitSession();
    t.after(async () => { session.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const filePath = path.join(root, 'circuit.json');
    await fs.writeFile(filePath, JSON.stringify({ modules: { top: { attributes: { src: 'top.sv:3.2-4.1' },
        ports: { a: { direction: 'input', bits: [2] }, y: { direction: 'output', bits: [2] } }, cells: {}, netnames: {} } } }));
    const tops = await session.request('topCandidates', { text: 'module real_top; endmodule' });
    assert.equal(tops[0].name, 'real_top');
    const descriptor = await session.request('load', { filePath, sourceRoot: root });
    assert.equal(descriptor.provenance.stage, 'netlist');
    const graph = await session.request('layout', { moduleId: descriptor.top });
    assert.equal(graph.moduleId, descriptor.top);
    assert.equal(graph.edges.length, 1);
    assert.ok(graph.width > 0);
    const source = await session.request('source', { moduleId: descriptor.top });
    assert.equal(source.path, path.join(root, 'top.sv'));
    assert.equal(source.line, 3);
    const original = path.join(root, 'original.sv');
    await session.request('load', { filePath, sourceRoot: root, sourceMap: { [path.join(root, 'top.sv')]: original } });
    assert.equal((await session.request('source', { moduleId: descriptor.top })).path, original);
    const headers = path.join(root, 'real-headers');
    await session.request('load', { filePath, sourceRoot: root, sourceDirectories: [{ from: root, to: headers }] });
    assert.equal((await session.request('source', { moduleId: descriptor.top })).path, path.join(headers, 'top.sv'));
    await assert.rejects(session.request('layout', { moduleId: 'not-a-module' }), /not found/);
});

test('JSON 导入自动识别 Vivado，拒绝错误 schema 及损坏 UTF-8', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-circuit-import-'));
    const session = new CircuitSession();
    t.after(async () => { session.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const filePath = path.join(root, 'vivado.json');
    const raw = { schemaVersion: 1, engine: 'vivado', version: '2022.1', stage: 'elaborated-rtl', view: 'flat',
        top: 'top', ports: [], cells: [], signals: [] };
    await fs.writeFile(filePath, JSON.stringify(raw));
    const descriptor = await session.request('load', { filePath });
    assert.equal(descriptor.provenance.engine, 'vivado');
    assert.equal(descriptor.provenance.hierarchy, 'flat');
    await fs.writeFile(filePath, JSON.stringify({ ...raw, schemaVersion: 99 }));
    await assert.rejects(session.request('load', { filePath }), /不是支持的 Vivado/);
    await fs.writeFile(filePath, Buffer.from([0xff, 0xfe]));
    await assert.rejects(session.request('load', { filePath }), /encoded data|encoding/i);
});

test('并发旧文件加载不能覆盖新会话的实际模型', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-circuit-race-'));
    const session = new CircuitSession();
    t.after(async () => { session.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const fileA = path.join(root, 'old.json'), fileB = path.join(root, 'new.json');
    const raw = name => ({ modules: { [name]: { ports: {}, cells: {}, netnames: {} } } });
    await fs.writeFile(fileA, JSON.stringify(raw('old')));
    await fs.writeFile(fileB, JSON.stringify(raw('new')));
    const old = session.request('load', { filePath: fileA });
    const latest = session.request('load', { filePath: fileB });
    await Promise.allSettled([old]);
    const descriptor = await latest;
    const graph = await session.request('layout', { moduleId: descriptor.top });
    assert.equal(graph.name, 'new');
});

test('误选带文件头注释的 RTL 时提示正确入口，不直接暴露 JSON 解析异常', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-circuit-wrong-file-'));
    const session = new CircuitSession();
    t.after(async () => { session.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const filePath = path.join(root, 'top.sv');
    await fs.writeFile(filePath, '// ------- header -------\nmodule top; endmodule');
    await assert.rejects(session.request('load', { filePath }), /RTL.*查看 RTL 电路/);
    await fs.writeFile(filePath, '{"modules":');
    await assert.rejects(session.request('load', { filePath }), /有效.*JSON/);
});
