'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bindWaveformPanel } = require('../src/waveform/host');
const { VcdSession } = require('../src/waveform/session');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

/** 模拟面板事件边界，消息数组只记录真正送给页面的数据。 */
function panelFixture() {
    const receives = new Set(), closes = new Set(), sent = [];
    let closed = false;
    const panel = {
        webview: { html: '', postMessage(message) { sent.push(message); return Promise.resolve(true); },
            onDidReceiveMessage(listener) { receives.add(listener); return { dispose() { receives.delete(listener); } }; } },
        onDidDispose(listener) { closes.add(listener); return { dispose() { closes.delete(listener); } }; },
        dispose() { if (closed) return; closed = true; for (const listener of [...closes]) listener(); }
    };
    return { panel, sent, receives, closes, receive(message) { for (const listener of [...receives]) listener(message); } };
}

function metadata(timescale = '10 ps') {
    return { timescale, headers: [], scopes: [{ path: 'tb' }], endTime: 250, fileBytes: 1048576, eventCount: 4,
        vars: [{ path: 'tb.clk', name: 'clk', id: '!', width: 1, type: 'wire', scopePath: 'tb', changeCount: 4 }] };
}

/** 可控的服务端异步边界，特意允许 dispose 后迟到响应以验证宿主抑制逻辑。 */
function hostFixture() {
    const page = panelFixture(), opening = deferred(), calls = [], logs = [];
    let progress;
    const session = { disposed: false, disposeCalls: 0, releases: 0,
        open(filePath) { calls.push(['open', filePath]); return opening.promise; },
        dispose() { this.disposeCalls++; if (!this.disposed) { this.disposed = true; this.releases++; } return Promise.resolve(); },
        async window(params) { calls.push(['window', params]); return { series: [] }; },
        async values(params) { calls.push(['values', params]); return { values: { '!': '1' } }; },
        async edge(params) { calls.push(['edge', params]); return { time: 30, value: '0' }; } };
    const binding = bindWaveformPanel({ filePath: path.join(os.tmpdir(), 'capture.vcd'), panel: page.panel,
        channel: { appendLine(text) { logs.push(text); } }, createSession(options) { progress = options.onProgress; return session; } });
    return { ...page, binding, opening, calls, logs, session, progress(value) { progress(value); } };
}

test('加载先完成、ready 后到：元数据缓存至握手，HTML 不替换已加载页面', async t => {
    const h = hostFixture(); t.after(() => h.binding.dispose());
    const html = h.panel.webview.html;
    h.progress({ bytesRead: 100, fileBytes: 200, eventCount: 1 });
    h.opening.resolve(metadata()); await h.binding.loaded;
    assert.equal(h.sent.length, 0);
    h.receive({ type: 'ready' });
    assert.equal(h.sent.length, 1); assert.equal(h.sent[0].type, 'init');
    assert.equal(h.sent[0].metadata.endTime, 250);
    assert.equal(h.sent[0].metadata.secondsPerTick, 1e-11);
    assert.equal(h.panel.webview.html, html);
    assert.equal(h.calls.filter(([method]) => method === 'open').length, 1);
});

test('ready 先到：发送最新加载进度，随后发送完整元数据', async t => {
    const h = hostFixture(); t.after(() => h.binding.dispose());
    h.progress({ bytesRead: 5, fileBytes: 20, eventCount: 0 });
    h.progress({ bytesRead: 10, fileBytes: 20, eventCount: 1 });
    h.receive({ type: 'ready' });
    assert.deepEqual(h.sent, [{ type: 'progress', progress: { bytesRead: 10, fileBytes: 20, eventCount: 1 } }]);
    h.progress({ bytesRead: 20, fileBytes: 20, eventCount: 4 });
    h.opening.resolve(metadata()); await h.binding.loaded;
    assert.deepEqual(h.sent.map(message => message.type), ['progress', 'progress', 'init']);
});

test('metadata 缺少 timescale 时保留 tick 范围，不猜测物理单位', async t => {
    const h = hostFixture(); t.after(() => h.binding.dispose());
    h.receive({ type: 'ready' }); h.opening.resolve(metadata('')); await h.binding.loaded;
    assert.equal(h.sent[0].metadata.secondsPerTick, null);
    assert.equal(h.sent[0].metadata.endTime, 250);
    assert.equal(h.sent[0].metadata.timescale, '');
});

test('关闭先于加载完成：释放订阅和服务，迟到元数据/进度不再发送', async () => {
    const h = hostFixture(); h.receive({ type: 'ready' }); h.panel.dispose();
    assert.equal(h.receives.size, 0); assert.equal(h.closes.size, 0);
    assert.equal(h.session.releases, 1);
    h.progress({ bytesRead: 100, fileBytes: 100, eventCount: 4 });
    h.opening.resolve(metadata()); await h.binding.loaded;
    h.binding.dispose(); assert.equal(h.session.releases, 1); assert.equal(h.sent.length, 0);
});

test('取消加载后 ready 仍收到可诊断错误，迟到加载与查询不会重新激活会话', async t => {
    const h = hostFixture(); t.after(() => h.binding.dispose());
    h.receive({ type: 'cancel' }); await nextTurn();
    assert.equal(h.session.releases, 1); assert.equal(h.sent.length, 0);
    h.receive({ type: 'ready' });
    assert.equal(h.sent[0].type, 'error'); assert.match(h.sent[0].error, /取消/);
    h.progress({ bytesRead: 100, fileBytes: 100, eventCount: 4 });
    h.opening.resolve(metadata()); await h.binding.loaded;
    h.receive({ type: 'values', requestId: 5, params: { ids: ['!'], time: 0 } }); await nextTurn();
    assert.deepEqual(h.sent.map(message => message.type), ['error', 'response']);
    assert.match(h.sent[1].error, /取消/);
    assert.equal(h.calls.some(([method]) => method === 'values'), false);
    h.receive({ type: 'close' }); assert.equal(h.session.releases, 1);
});

test('window/values/edge 查询保留 requestId 与结果，加载前返回错误而不访问服务', async t => {
    const h = hostFixture(); t.after(() => h.binding.dispose()); h.receive({ type: 'ready' });
    h.receive({ type: 'window', requestId: 1, params: {} }); await nextTurn();
    assert.match(h.sent[0].error, /尚未完成加载/);
    assert.equal(h.calls.some(([method]) => method === 'window'), false);
    h.opening.resolve(metadata()); await h.binding.loaded;
    for (const [type, requestId, params] of [['window', 2, { ids: ['!'], start: 0, end: 20, pixels: 100 }],
        ['values', 3, { ids: ['!'], time: 10 }], ['edge', 4, { id: '!', time: 20, direction: 'next' }]]) {
        h.receive({ type, requestId, params });
    }
    await nextTurn();
    assert.deepEqual(h.sent.filter(message => message.type === 'response').map(message => message.requestId), [1, 2, 3, 4]);
    assert.deepEqual(h.sent.at(-1).result, { time: 30, value: '0' });
    assert.deepEqual(h.calls.filter(([method]) => method !== 'open').map(([method]) => method), ['window', 'values', 'edge']);
});

test('查询异常只影响对应请求，非法 method/requestId 不调用 worker 方法', async t => {
    const h = hostFixture(); t.after(() => h.binding.dispose()); h.receive({ type: 'ready' });
    h.opening.resolve(metadata()); await h.binding.loaded;
    h.session.window = () => { throw new Error('视窗像素预算无效'); };
    h.receive({ type: 'window', requestId: 7, params: { pixels: 0 } });
    h.receive({ type: 'open', requestId: 8, params: {} });
    h.receive({ type: 'values', requestId: 'bad', params: {} });
    h.receive({ type: 'values', requestId: Infinity, params: {} });
    h.receive({ type: 'values', requestId: 9, params: { ids: ['!'], time: 0 } }); await nextTurn();
    const responses = h.sent.filter(message => message.type === 'response');
    assert.deepEqual(responses.map(message => message.requestId), [7, 9]);
    assert.match(responses[0].error, /像素预算/);
    assert.deepEqual(responses[1].result, { values: { '!': '1' } });
    assert.equal(h.session.disposed, false);
});

test('关闭抑制已经发出的查询迟到响应，并且重复 dispose 不重复释放', async () => {
    const h = hostFixture(), query = deferred(); h.receive({ type: 'ready' });
    h.opening.resolve(metadata()); await h.binding.loaded;
    h.session.window = () => query.promise;
    h.receive({ type: 'window', requestId: 10, params: {} });
    h.panel.dispose(); h.binding.dispose(); h.panel.dispose();
    query.resolve({ series: [] }); await nextTurn();
    assert.deepEqual(h.sent.map(message => message.type), ['init']);
    assert.equal(h.session.releases, 1); assert.equal(h.receives.size, 0); assert.equal(h.closes.size, 0);
});

test('无信号与加载失败均显示错误并释放服务，错误可跨 ready 握手缓存', async () => {
    for (const failure of ['empty', 'parse']) {
        const h = hostFixture();
        if (failure === 'empty') h.opening.resolve({ ...metadata(), vars: [] });
        else h.opening.reject(new Error('line 7: 非法 VCD'));
        await h.binding.loaded;
        assert.equal(h.sent.length, 0); assert.equal(h.session.releases, 1);
        h.receive({ type: 'ready' });
        assert.equal(h.sent[0].type, 'error'); assert.match(h.sent[0].error, /没有信号|非法 VCD/);
        h.panel.dispose(); assert.equal(h.session.releases, 1);
    }
});

async function temporaryVcd() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-host-contract-'));
    const filePath = path.join(dir, 'capture.vcd');
    await fs.writeFile(filePath, '$timescale 1 ns $end\n$scope module tb $end\n$var wire 1 ! clk $end\n$var wire 1 ! clk_alias $end\n$upscope $end\n$enddefinitions $end\n$dumpvars\n0!\n$end\n#10\n1!\n');
    return { filePath, async remove() { await fs.unlink(filePath); await fs.rmdir(dir); } };
}

test('真实 worker 加载后关闭：准确元数据送往 ready 页面，线程退出且 pending 清空', { timeout: 10000 }, async t => {
    const file = await temporaryVcd(), page = panelFixture(); let session, binding;
    t.after(async () => { if (session) await session.dispose(); if (binding) binding.dispose(); await file.remove(); });
    binding = bindWaveformPanel({ filePath: file.filePath, panel: page.panel,
        createSession(options) { session = new VcdSession(options); return session; } });
    const worker = session.worker;
    page.receive({ type: 'ready' }); await binding.loaded;
    const init = page.sent.find(message => message.type === 'init');
    assert.ok(init); assert.equal(init.metadata.secondsPerTick, 1e-9); assert.equal(init.metadata.endTime, 10);
    assert.deepEqual(init.metadata.vars.map(signal => [signal.path, signal.id, signal.changeCount]), [['tb.clk', '!', 2], ['tb.clk_alias', '!', 2]]);
    assert.equal(Object.hasOwn(init.metadata, 'changes'), false);
    assert.ok(worker.threadId > 0);
    const exited = once(worker, 'exit'); page.panel.dispose(); await exited;
    assert.equal(worker.threadId, -1); assert.equal(session.pending.size, 0); assert.equal(session.disposed, true);
    assert.equal(page.receives.size, 0); assert.equal(page.closes.size, 0);
});

test('真实 worker 打开过程中取消后再关闭：加载完成 promise 结束且不遗留线程', { timeout: 10000 }, async t => {
    const file = await temporaryVcd(), page = panelFixture(); let session, binding;
    t.after(async () => { if (session) await session.dispose(); if (binding) binding.dispose(); await file.remove(); });
    binding = bindWaveformPanel({ filePath: file.filePath, panel: page.panel,
        createSession(options) { session = new VcdSession(options); return session; } });
    const worker = session.worker, exited = once(worker, 'exit');
    page.receive({ type: 'ready' }); page.receive({ type: 'cancel' }); await exited; await binding.loaded; await nextTurn();
    assert.equal(worker.threadId, -1); assert.equal(session.pending.size, 0);
    assert.equal(page.sent.some(message => message.type === 'init'), false);
    assert.ok(page.sent.some(message => message.type === 'error' && /取消/.test(message.error)));
    page.receive({ type: 'close' });
    assert.equal(page.receives.size, 0); assert.equal(page.closes.size, 0);
});

test('源上下文等待期间取消，不启动迟到worker或覆盖取消错误', async () => {
    const page=panelFixture(), context=deferred(); let opened=0;
    const binding=bindWaveformPanel({filePath:path.join(os.tmpdir(),'capture.vcd'),panel:page.panel,
        getSourceContext:()=>context.promise,createSession:()=>({async open(){opened++;return metadata();},dispose(){}})});
    page.receive({type:'ready'});page.receive({type:'cancel'});await nextTurn();context.resolve({files:[]});
    await binding.loaded;assert.equal(opened,0);assert.equal(page.sent.at(-1).type,'error');assert.match(page.sent.at(-1).error,/取消/);binding.dispose();
});
