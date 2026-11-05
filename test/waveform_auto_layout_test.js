'use strict';
// 同名布局自动套用：宿主握手时序、可选依赖与客户端命中判定。
const test = require('node:test');
const assert = require('node:assert/strict');
const { bindWaveformPanel } = require('../src/waveform/host');
const { clientHarness } = require('./helpers/waveform-client-harness');

const METADATA = { timescale: '1 ns', headers: [], scopes: [{ path: 'tb' }], endTime: 100, fileBytes: 100, eventCount: 2,
    vars: [{ path: 'tb.clk', name: 'clk', id: '!', width: 1, type: 'wire', scopePath: 'tb', changeCount: 2 }] };
const LAYOUT = { kind: 'svtools-wave-layout', version: 1,
    tracks: [{ signal: { path: 'tb.clk', range: '', width: 1 }, visible: true }],
    collapsedGroups: [], view: { start: 10, span: 20 }, cursorA: 12, cursorB: null,
    secondsPerTick: 1e-9, fullName: false, snap: true };

function hostFixture(layoutFiles) {
    const sent = [], receives = new Set(), closes = new Set();
    let resolveOpen;
    const opening = new Promise(resolve => { resolveOpen = resolve; });
    const panel = {
        webview: { html: '', postMessage(message) { sent.push(message); return Promise.resolve(true); },
            onDidReceiveMessage(listener) { receives.add(listener); return { dispose() { receives.delete(listener); } }; } },
        onDidDispose(listener) { closes.add(listener); return { dispose() { closes.delete(listener); } }; },
        dispose() { for (const listener of [...closes]) listener(); }
    };
    const binding = bindWaveformPanel({ filePath: 'trace.vcd', panel, layoutFiles,
        createSession: () => ({ open: () => opening, dispose: async () => {} }) });
    return { sent, binding, resolveOpen, receive(message) { for (const listener of [...receives]) listener(message); } };
}

test('未提供布局服务时波形仍可正常加载', async t => {
    const h = hostFixture(undefined); t.after(() => h.binding.dispose());
    h.receive({ type: 'ready' }); h.resolveOpen(METADATA); await h.binding.loaded;
    assert.deepEqual(h.sent.map(message => message.type), ['init']);
    assert.equal(h.binding.getMetadata().endTime, 100);
});

test('ready 晚于加载：同名布局在握手后补送且只送一次', async t => {
    let calls = 0;
    const h = hostFixture({ auto: async () => { calls++; return LAYOUT; } }); t.after(() => h.binding.dispose());
    h.resolveOpen(METADATA); await h.binding.loaded;
    assert.equal(h.sent.length, 0, 'ready 之前的页面消息会被宿主抑制');
    h.receive({ type: 'ready' });
    assert.deepEqual(h.sent.map(message => message.type), ['init', 'layout-auto']);
    assert.deepEqual(h.sent[1].layout, LAYOUT);
    h.receive({ type: 'ready' });
    assert.equal(h.sent.filter(message => message.type === 'layout-auto').length, 1, '重复 ready 不重复套用');
    assert.equal(calls, 1);
});

test('ready 先到可送达；布局缺失、损坏或被取消时不打扰默认视图', async t => {
    const ready = hostFixture({ auto: async () => LAYOUT }); t.after(() => ready.binding.dispose());
    ready.receive({ type: 'ready' }); ready.resolveOpen(METADATA); await ready.binding.loaded;
    assert.deepEqual(ready.sent.map(message => message.type), ['init', 'layout-auto']);

    for (const auto of [async () => null, async () => { throw new Error('damaged'); }]) {
        const h = hostFixture({ auto }); t.after(() => h.binding.dispose());
        h.receive({ type: 'ready' }); h.resolveOpen(METADATA); await h.binding.loaded;
        assert.deepEqual(h.sent.map(message => message.type), ['init']);
    }
    const cancelled = hostFixture({ auto: async () => LAYOUT }); t.after(() => cancelled.binding.dispose());
    cancelled.receive({ type: 'cancel' }); cancelled.receive({ type: 'ready' });
    cancelled.resolveOpen(METADATA); await cancelled.binding.loaded;
    assert.equal(cancelled.sent.some(message => message.type === 'layout-auto'), false, '取消后不发送');
});

const CLIENT_LAYOUT = { ...LAYOUT, tracks: [{ signal: { path: 'tb.a', range: '', width: 32 }, visible: true }] };
const send = (h, message) => h.windowListeners.message({ data: message });

test('同名布局有命中才自动套用，0 命中静默保留默认视图', async () => {
    const h = clientHarness(null); await h.flush();
    const before = [...h.state.selected];
    assert.ok(before.length > 1);
    send(h, { type: 'layout-auto', layout: { ...CLIENT_LAYOUT,
        tracks: [{ signal: { path: 'tb.missing', range: '', width: 32 }, visible: true }] } });
    assert.deepEqual([...h.state.selected], before, '0 命中不改动选择');
    assert.equal(h.node('layoutReport').hidden, undefined, '不显示未匹配报告');
    send(h, { type: 'layout-auto', layout: CLIENT_LAYOUT });
    assert.deepEqual([...h.state.selected], ['tb.a']);
    assert.equal(h.state.cursorA, 12);
    assert.equal(h.state.view.start, 10);
});

test('metadata 未就绪时挂起自动布局，initialize 末尾消费', async () => {
    const h = clientHarness(null, { bootMetadata: null });
    send(h, { type: 'layout-auto', layout: CLIENT_LAYOUT });
    send(h, { type: 'init', metadata: h.metadata });
    await h.flush();
    assert.deepEqual([...h.state.selected], ['tb.a']);
    assert.equal(h.state.cursorA, 12);
});
