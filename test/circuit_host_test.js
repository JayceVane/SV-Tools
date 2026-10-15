'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bindCircuitPanel } = require('../src/circuit/host');

const flush = () => new Promise(resolve => setImmediate(resolve));
const descriptor = { id: 'content-hash', title: 'Circuit', top: 'module/top', modules: [
    { id: 'module/top', name: 'top' }, { id: 'module/child', name: 'child' }
] };
function graph(moduleId) {
    return { id: 'graph:' + moduleId, moduleId, name: moduleId, nodes: moduleId === descriptor.top
        ? [{ id: 'node/inst', cellId: 'cell/inst', moduleId: 'module/child', label: 'u_child' }] : [], edges: [] };
}
function setup({ load = async () => ({ filePath: 'input.json' }), request } = {}) {
    const sent = [], calls = [], errors = [], sources = [];
    let message, disposePanel;
    const session = { async request(command, payload) {
        calls.push({ command, payload });
        if (request) return request(command, payload);
        if (command === 'load') return descriptor;
        if (command === 'layout') return graph(payload.moduleId);
        return { path: 'rtl/top.sv', line: 2, column: 1 };
    }, dispose() { this.closed = true; } };
    const panel = { webview: {
        postMessage(value) { sent.push(value); return Promise.resolve(true); },
        onDidReceiveMessage(handler) { message = handler; return { dispose() { message = null; } }; }
    }, onDidDispose(handler) { disposePanel = handler; return { dispose() {} }; } };
    const binding = bindCircuitPanel({ panel, session, load, onError: error => errors.push(error), onSource: source => sources.push(source) });
    return { binding, session, sent, calls, errors, sources,
        async send(value) { message?.(value); for (let i = 0; i < 4; i++) await flush(); },
        close() { disposePanel(); } };
}

test('ready 只加载一次，源码请求使用领域模块 ID', async () => {
    const host = setup();
    await host.send({ type: 'ready' });
    await host.send({ type: 'ready' });
    assert.equal(host.calls.filter(call => call.command === 'load').length, 1);
    assert.equal((await host.binding.loaded).ok, true);
    await host.send({ type: 'source', cellId: 'cell/inst' });
    assert.equal(host.calls.at(-1).payload.moduleId, descriptor.top);
    assert.equal(host.sources.length, 1);
    await host.send({ type: 'source', cellId: 'untrusted-cell' });
    assert.equal(host.sources.length, 1);
    host.close();
});

test('顶层布局失败仍保留模块目录，可直接切换较小模块恢复', async () => {
    const host = setup({ request: async (command, payload) => {
        if (command === 'load') return descriptor;
        if (command === 'layout' && payload.moduleId === descriptor.top) throw new Error('2000 node budget');
        return graph(payload.moduleId);
    } });
    await host.send({ type: 'ready' });
    assert.ok(host.sent.some(message => message.type === 'design' && message.design.modules.length === 2));
    assert.equal((await host.binding.loaded).ok, false);
    await host.send({ type: 'module', moduleId: 'module/child' });
    assert.equal(host.sent.at(-1).type, 'graph');
    assert.equal(host.sent.at(-1).graph.moduleId, 'module/child');
    host.close();
});

test('层级、模块选择和返回仅接受当前设计中的对象', async () => {
    const host = setup();
    await host.send({ type: 'ready' });
    await host.send({ type: 'navigate', cellId: 'not-visible' });
    assert.equal(host.sent.filter(message => message.type === 'graph').length, 1);
    await host.send({ type: 'navigate', cellId: 'cell/inst' });
    assert.deepEqual(host.sent.at(-1).breadcrumbs, [{ id: descriptor.top, name: 'top' }, { id: 'module/child', name: 'u_child' }]);
    await host.send({ type: 'back' });
    assert.equal(host.sent.at(-1).graph.moduleId, descriptor.top);
    await host.send({ type: 'module', moduleId: 'outside-design' });
    assert.equal(host.sent.at(-1).graph.moduleId, descriptor.top);
    await host.send({ type: '__proto__' });
    assert.equal(host.errors.length, 0);
    host.close();
});

test('当前 load 或首轮 layout 错误必须展示，不能因代次推进而被吞掉', async () => {
    for (const failed of ['load', 'layout']) {
        const host = setup({ request: async command => {
            if (command === failed) throw new Error('failed-' + failed);
            return descriptor;
        } });
        await host.send({ type: 'ready' });
        assert.equal(host.sent.at(-1).type, 'error');
        assert.match(host.sent.at(-1).message, new RegExp(failed));
        assert.equal(host.errors.length, 1);
        host.close();
    }
});

test('关闭面板取消正在生成的数据并终止会话', async () => {
    let signal, resolveLoad;
    const host = setup({ load: options => { signal = options.signal; return new Promise(resolve => { resolveLoad = resolve; }); } });
    await host.send({ type: 'ready' });
    assert.equal(signal.aborted, false);
    host.close();
    assert.equal(signal.aborted, true);
    assert.equal(host.session.closed, true);
    resolveLoad({ filePath: 'late.json' });
    await flush();
    assert.equal(host.calls.length, 0);
    assert.equal(host.sent.some(message => message.type === 'graph'), false);
});

test('刷新取代旧 loader，旧失败不会覆盖新图', async () => {
    const pending = [];
    const host = setup({ load: ({ signal }) => new Promise((resolve, reject) => pending.push({ signal, resolve, reject })) });
    await host.send({ type: 'ready' });
    await host.send({ type: 'reload' });
    assert.equal(pending[0].signal.aborted, true);
    pending[1].resolve({ filePath: 'new.json' });
    for (let i = 0; i < 4; i++) await flush();
    pending[0].reject(new Error('stale failure'));
    await flush();
    assert.equal(host.sent.at(-1).type, 'graph');
    assert.equal(host.errors.length, 0);
    host.close();
});

test('迟到的源码响应不触发离开当前导航的编辑器跳转', async () => {
    let resolveSource;
    const host = setup({ request: async (command, payload) => {
        if (command === 'load') return descriptor;
        if (command === 'layout') return graph(payload.moduleId);
        return new Promise(resolve => { resolveSource = resolve; });
    } });
    await host.send({ type: 'ready' });
    await host.send({ type: 'source', cellId: 'cell/inst' });
    await host.send({ type: 'navigate', cellId: 'cell/inst' });
    resolveSource({ path: 'old.sv', line: 1 });
    await flush();
    assert.equal(host.sources.length, 0);
    host.close();
});
