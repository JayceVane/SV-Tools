'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { clientHarness } = require('./helpers/waveform-client-harness');
const columns = require('../src/waveform/column-layout');

function pointer(handle, type, x, extra = {}) {
    const event = { button: 0, isPrimary: true, pointerId: 7, clientX: x, target: handle,
        preventDefault() { this.prevented = true; }, ...extra };
    handle.listeners[type](event); return event;
}
const count = (h, type) => h.messages.filter(message => message.type === type).length;
const geometry = h => columns.waveGeometry(h.tracks.clientWidth, h.state.columns.names, h.state.fullName);

test('同文件恢复两栏请求宽度，时间窗、游标、行高和格式保持', async () => {
    const h = clientHarness({ fileKey: 'test', selected: ['tb.a', 'tb.b'], columns: { catalog: 300, names: 360 },
        start: 10, span: 70, cursorA: 30, cursorB: 50, fullName: true, formats: { 'tb.a': 'fp32' } });
    await h.flush();
    assert.equal(h.node('catalogPane').style.width, '300px');
    assert.equal(geometry(h).names, 360);
    assert.equal(h.node('namesResize').style.left, '360px');
    assert.equal(h.node('namesResize').style.height, '435px');
    assert.equal(h.state.view.start, 10); assert.equal(h.state.view.span, 70);
    assert.equal(h.state.cursorA, 30); assert.equal(h.state.cursorB, 50);
    assert.equal(h.state.formats['tb.a'], 'fp32');
});

test('信号栏拖动只预览；完成后单次保存和窗口请求，不重复精确读值', async () => {
    const h = clientHarness(); await h.flush();
    const handle = h.node('namesResize'), windows = count(h, 'window'), values = count(h, 'values'), saves = h.saves.length;
    const before = { ...h.state.view }, cursor = h.state.cursorA, order = h.state.selected.slice();
    pointer(handle, 'pointerdown', 500);
    for (const x of [520, 570, 650]) { pointer(handle, 'pointermove', x); h.runFrame(); }
    assert.equal(geometry(h).names, 420);
    assert.equal(h.node('namesResize').style.left, '420px');
    assert.equal(count(h, 'window'), windows); assert.equal(count(h, 'values'), values); assert.equal(h.saves.length, saves);
    pointer(handle, 'pointerup', 650); await h.flush();
    assert.equal(count(h, 'window'), windows + 1); assert.equal(count(h, 'values'), values); assert.equal(h.saves.length, saves + 1);
    assert.equal(h.persisted().columns.names, 420);
    assert.deepEqual({ ...h.state.view }, before); assert.equal(h.state.cursorA, cursor); assert.deepEqual(h.state.selected, order);
});

test('目录边线拖动更新面板与绘图预算，完成后不重复游标查询', async () => {
    const h = clientHarness(); await h.flush();
    const handle = h.node('catalogResize'), windows = count(h, 'window'), values = count(h, 'values');
    pointer(handle, 'pointerdown', 252); pointer(handle, 'pointermove', 342); h.runFrame();
    assert.equal(h.node('catalogPane').style.width, '342px'); assert.equal(h.tracks.clientWidth, 810);
    assert.equal(h.node('catalogResize').style.left, '342px'); assert.equal(count(h, 'window'), windows);
    pointer(handle, 'pointerup', 342); await h.flush();
    assert.equal(count(h, 'window'), windows + 1); assert.equal(count(h, 'values'), values);
    assert.equal(h.persisted().columns.catalog, 342);
});

for (const cancel of ['pointercancel', 'lostpointercapture', 'Escape', 'blur']) test(`${cancel} 回滚请求宽度且不提交或查询`, async () => {
    const h = clientHarness({ fileKey: 'test', selected: ['tb.a'], columns: { names: 370 } }); await h.flush();
    const handle = h.node('namesResize'), windows = count(h, 'window'), saves = h.saves.length;
    pointer(handle, 'pointerdown', 500); pointer(handle, 'pointermove', 590); h.runFrame();
    if (cancel === 'Escape') h.documentListeners.keydown({ target: handle, key: 'Escape', preventDefault() {} });
    else if (cancel === 'blur') h.windowListeners.blur({});
    else pointer(handle, cancel, 590);
    h.runFrame();
    assert.equal(h.state.columns.names, 370); assert.equal(h.node('namesResize').style.left, '370px');
    assert.equal(h.saves.length, saves); assert.equal(count(h, 'window'), windows);
    assert.equal(handle.captures.size, 0);
});

test('缩窄窗口只限制有效宽度，恢复窗口仍保留用户选择', async () => {
    const h = clientHarness({ fileKey: 'test', selected: ['tb.a'], columns: { catalog: 330, names: 420 } }); await h.flush();
    const saves = h.saves.length;
    h.resize(500); await h.flush();
    assert.ok(geometry(h).names < 420); assert.ok(geometry(h).plot >= 1);
    assert.equal(h.state.columns.catalog, 330); assert.equal(h.state.columns.names, 420);
    h.resize(1152); await h.flush();
    assert.equal(h.node('catalogPane').style.width, '330px'); assert.equal(geometry(h).names, 420);
    assert.equal(h.saves.length, saves);
});

test('分隔线方向键和默认恢复不触发边沿快捷键', async () => {
    const h = clientHarness(); await h.flush();
    const handle = h.node('namesResize');
    const key = name => { const event = { target: handle, key: name, preventDefault() {} }; handle.listeners.keydown(event); h.documentListeners.keydown(event); };
    key('ArrowRight'); await h.flush();
    assert.equal(h.state.columns.names, 278); assert.equal(count(h, 'edge'), 0);
    key('Home'); await h.flush();
    assert.equal(h.state.columns.names, undefined); assert.equal(geometry(h).names, 270);
});

test('宽度手势期间阻止行拖动和滚轮时间缩放，其他文件不继承栏宽', async () => {
    const h = clientHarness({ fileKey: 'other', columns: { catalog: 400, names: 550 } }); await h.flush();
    assert.equal(h.state.columns.names, undefined); assert.equal(h.state.columns.catalog, undefined);
    const handle = h.node('namesResize'), view = { ...h.state.view }, windows = count(h, 'window');
    pointer(handle, 'pointerdown', 500); pointer(handle, 'pointermove', 540);
    h.pointer('tb.a');
    h.tracks.listeners.wheel({ ctrlKey: true, deltaY: 20, preventDefault() {} });
    assert.equal(h.state.multi.size, 0); assert.deepEqual({ ...h.state.view }, view); assert.equal(count(h, 'window'), windows);
    pointer(handle, 'pointercancel', 540);
});
