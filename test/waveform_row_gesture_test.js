'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const L = require('../src/waveform/row-layout');
const { clientHarness } = require('./helpers/waveform-client-harness');

const names = ['a', 'b', 'c', 'd', 'e', 'f'];
function signals(keys = names, analog = false) {
    return keys.map((name, index) => ({ name, path: 'tb.' + name, scopePath: 'tb', width: index === 0 && analog ? 1 : 32,
        type: index === 0 && analog ? 'real' : 'reg', id: name, changeCount: 2 }));
}
function saved(vars, extra = {}) { return { fileKey: 'test', selected: vars.map(signal => signal.path), ...extra }; }
function escape(h, target = h.canvas) {
    const event = { target, key: 'Escape', preventDefault() { this.prevented = true; } };
    h.documentListeners.keydown(event); return event;
}

test('模拟量底边实时拖动，放下仅保存一次；同一可见集合不重读窗口或 A/B', async () => {
    const vars = signals(names, true), h = clientHarness(saved(vars), { vars }); await h.flush();
    const messages = h.messages.length, saves = h.saves.length, view = { ...h.state.view };
    h.event('pointermove', 500, 100);
    assert.equal(h.canvas.style.cursor, 'ns-resize'); assert.match(h.canvas.attributes.title, /60–480/);
    h.event('pointerdown', 500, 100); assert.equal(h.canvas.hasPointerCapture(1), true);
    h.event('pointermove', 500, 160); h.runFrame();
    assert.equal(h.state.rows[0].height, 160); assert.equal(h.state.rows[1].y, 160);
    assert.equal(h.saves.length, saves); assert.equal(h.messages.length, messages);
    h.event('pointerup', 1500, 190); await h.flush();
    assert.equal(h.state.heights['tb.a'], 190); assert.equal(h.persisted().heights['tb.a'], 190);
    assert.equal(h.saves.length, saves + 1); assert.equal(h.messages.length, messages);
    assert.equal(h.canvas.hasPointerCapture(1), false); assert.equal(h.state.cursorA, 0); assert.equal(h.state.cursorB, null);
    assert.deepEqual({ ...h.state.view }, view); assert.equal(h.state.multi.size, 0);
});

test('模拟量拖动在 60–480 px 内，数字行底边拖动不产生行高', async () => {
    const vars = signals(names, true), h = clientHarness(saved(vars), { vars }); await h.flush();
    h.event('pointerdown', 500, 100); h.event('pointermove', 500, -200);
    assert.equal(h.state.rows[0].height, 60);
    h.event('pointermove', 500, 1000); assert.equal(h.state.rows[0].height, 480);
    escape(h); h.settleFrames(); assert.equal(h.state.rows[0].height, 100);
    h.event('pointerdown', 500, 138); h.event('pointermove', 500, 180); h.event('pointerup', 500, 180);
    assert.equal(h.state.heights['tb.b'], undefined); assert.equal(h.state.rows[1].height, 38);
    assert.equal(h.state.rows[0].height, 100); assert.equal(h.state.cursorA, 0);
});

for (const method of ['Escape', 'pointercancel', 'lostpointercapture', 'blur']) {
    test(`${method} 取消模拟量缩放，恢复旧高度与滚动，不保存临时布局`, async () => {
        const vars = signals(names, true), h = clientHarness(saved(vars, { heights: { 'tb.a': 180 } }), { vars, height: 220 }); await h.flush();
        h.tracks.scrollTop = 30; const saves = h.saves.length;
        h.event('pointerdown', 500, 150); h.event('pointermove', 500, 200); h.runFrame();
        assert.equal(h.state.heights['tb.a'], 230);
        if (method === 'Escape') assert.equal(escape(h).prevented, true);
        else if (method === 'blur') h.windowListeners.blur();
        else h.event(method, 500, 200);
        h.settleFrames();
        assert.equal(h.state.heights['tb.a'], 180); assert.equal(h.state.rows[0].height, 180); assert.equal(h.tracks.scrollTop, 30);
        assert.equal(h.saves.length, saves); assert.equal(h.canvas.hasPointerCapture(1), false);
        assert.equal(h.state.rowPresentation.resizeKey, null); assert.equal(h.state.rowPresentation.positions, null);
        h.event('pointerup', 500, 200); assert.equal(h.saves.length, saves);
    });
}

test('多选排序即时让位并显示数量卡片与精确插入线；pointerup 不改变同一点的落点', async () => {
    const vars = signals(), h = clientHarness(saved(vars), { vars }); await h.flush();
    h.pointer('tb.b'); h.pointer('tb.d', { ctrlKey: true });
    const initial = [...h.state.selected], saves = h.saves.length, messages = h.messages.length;
    h.event('pointerdown', 20, 43); h.event('pointermove', 20, 210);
    assert.deepEqual([...h.state.selected], initial, '预览排序不提前修改保存顺序');
    assert.deepEqual(h.state.rowPresentation.targetRows.map(row => row.key), ['tb.a', 'tb.c', 'tb.e', 'tb.f', 'tb.b', 'tb.d']);
    assert.equal(h.state.rowPresentation.insertionY, 152);
    const preview = h.document.body.children.find(child => child.className === 'waveDragPreview');
    assert.ok(preview); assert.match(preview.children[1].textContent, /2 条信号/);
    h.runFrame(90);
    const y = h.state.rowPresentation.positions.get('tb.b'); assert.ok(y > 38 && y < 152);
    assert.equal(h.saves.length, saves); assert.equal(h.messages.length, messages);
    h.event('pointerup', 20, 210);
    assert.deepEqual([...h.state.selected], ['tb.a', 'tb.c', 'tb.e', 'tb.f', 'tb.b', 'tb.d']);
    assert.deepEqual([...h.state.multi], ['tb.b', 'tb.d']);
    assert.equal(h.saves.length, saves + 1); assert.equal(h.messages.length, messages);
    assert.equal(h.document.body.children.length, 0); assert.equal(h.canvas.hasPointerCapture(1), false);
    h.settleFrames(); assert.equal(h.state.rowPresentation.positions, null); assert.equal(h.state.rowPresentation.insertionY, null);
    assert.equal(h.state.cursorA, 0); assert.equal(h.state.cursorB, null);
});

test('多选上移到第一行之前与下移到末尾之后，内部顺序不受拖动方向影响', async () => {
    const vars = signals(), h = clientHarness(saved(vars), { vars }); await h.flush();
    h.pointer('tb.d'); h.pointer('tb.f', { ctrlKey: true });
    h.event('pointerdown', 20, 195); h.event('pointermove', 20, -100); h.event('pointerup', -500, -100);
    assert.deepEqual([...h.state.selected], ['tb.d', 'tb.f', 'tb.a', 'tb.b', 'tb.c', 'tb.e']);
    h.settleFrames();
    h.event('pointerdown', 20, 5); h.event('pointermove', 20, 450); h.event('pointerup', 20, 450);
    assert.deepEqual([...h.state.selected], ['tb.a', 'tb.b', 'tb.c', 'tb.e', 'tb.d', 'tb.f']);
});

test('取消自动滚动中的排序预览，恢复原选集、锚点和滚动，未提交顺序保持原样', async () => {
    const vars = signals(), h = clientHarness(saved(vars), { vars, height: 100 }); await h.flush();
    h.state.multi = new Set(['tb.a', 'tb.d']); h.state.selectionAnchor = 'tb.a'; h.state.activeKey = 'tb.d';
    h.tracks.scrollTop = 50; const saves = h.saves.length;
    h.event('pointerdown', 20, 31); h.event('pointermove', 20, 120);
    for (let index = 0; index < 10; index++) h.runFrame();
    assert.ok(h.tracks.scrollTop > 50); assert.deepEqual([...h.state.multi], ['tb.c']);
    escape(h); h.settleFrames();
    assert.deepEqual([...h.state.selected], vars.map(signal => signal.path)); assert.deepEqual([...h.state.multi], ['tb.a', 'tb.d']);
    assert.equal(h.state.selectionAnchor, 'tb.a'); assert.equal(h.state.activeKey, 'tb.d'); assert.equal(h.tracks.scrollTop, 50);
    assert.equal(h.saves.length, saves); assert.equal(h.document.body.children.length, 0); assert.equal(h.state.cursorA, 0);
});

test('输入框 Escape 不被手势拦截，非主指针及其他 pointerId 不改当前拖动', async () => {
    const vars = signals(names, true), h = clientHarness(saved(vars), { vars }); await h.flush();
    h.event('pointerdown', 500, 100); h.event('pointermove', 500, 180);
    assert.equal(escape(h, h.node('search')).prevented, undefined); assert.equal(h.state.heights['tb.a'], 180);
    h.event('pointermove', 500, 300, { pointerId: 2 }); h.event('pointerup', 500, 300, { pointerId: 2 });
    assert.equal(h.state.heights['tb.a'], 180); assert.equal(h.canvas.hasPointerCapture(1), true);
    escape(h); h.settleFrames();
    h.event('pointerdown', 500, 100, { pointerId: 2, isPrimary: false });
    assert.equal(h.canvas.hasPointerCapture(2), false);
});

test('2000 行排序及边缘滚动的帧不请求或保存 VCD，提交后查询仅覆盖视口并遵守点预算', async () => {
    const vars = signals(Array.from({ length: 2000 }, (_, index) => 's' + index));
    const h = clientHarness(saved(vars), { vars, height: 380 }); await h.flush();
    const messages = h.messages.length, saves = h.saves.length;
    assert.equal(h.messages[0].params.ids.length, 10);
    h.event('pointerdown', 20, 5); h.event('pointermove', 20, 450);
    for (let index = 0; index < 30; index++) { h.runFrame(); h.tracks.onscroll(); }
    assert.ok(h.tracks.scrollTop > 0); assert.equal(h.messages.length, messages); assert.equal(h.saves.length, saves);
    assert.ok(h.paints.every(paint => paint.height === 380 && paint.rows <= 24));
    h.event('pointerup', 20, 450); await h.flush(); h.settleFrames();
    assert.equal(h.saves.length, saves + 1); assert.ok(h.messages.length <= messages + 2);
    for (const message of h.messages) {
        assert.ok(message.params.ids.length <= 256);
        if (message.type === 'window') assert.ok(message.params.ids.length * message.params.pixels <= 240000);
    }
});

test('行总高小于视口时边缘拖动不会负滚动；减少动态效果切换仍能完成当前排序', async () => {
    const vars = signals(names.slice(0, 3)), h = clientHarness(saved(vars), { vars, height: 400 }); await h.flush();
    h.event('pointerdown', 20, 43); h.event('pointermove', 20, 450); h.settleFrames();
    assert.equal(h.tracks.scrollTop, 0); assert.equal(h.frames.size, 0);
    h.changeMotion(true);
    assert.equal(h.state.rowPresentation.positions.get('tb.b'), 76);
    h.event('pointerup', 20, 450); h.settleFrames();
    assert.deepEqual([...h.state.selected], ['tb.a', 'tb.c', 'tb.b']); assert.equal(h.state.rowPresentation.positions, null);
    assert.equal(h.tracks.scrollTop, 0); assert.equal(h.canvas.hasPointerCapture(1), false);
});

test('恢复行高过滤失效键、字符串和非有限值，安全约束数字值并保留未来切换模式的偏好', async () => {
    const vars = signals(names, true);
    const h = clientHarness(saved(vars, { heights: { 'tb.a': Infinity, 'tb.b': '200', 'tb.c': -20, 'tb.d': 99999, gone: 200 } }), { vars }); await h.flush();
    assert.equal(h.state.rows[0].height, 100); assert.equal(h.state.rows[3].height, 38);
    assert.deepEqual({ ...h.state.heights }, { 'tb.d': L.MAX_ANALOG_HEIGHT });
    assert.ok(Number.isFinite(Number.parseFloat(h.node('trackSpace').style.height)));
});

test('波形区域拖动仍平移时间轴，取消恢复窗口；预览期间不保存未提交窗口', async () => {
    const vars = signals(), h = clientHarness(saved(vars, { start: 20, span: 40 }), { vars }); await h.flush();
    const saves = h.saves.length;
    h.event('pointerdown', 500, 15); h.event('pointermove', 400, 15);
    assert.ok(h.state.view.start > 20); assert.equal(h.saves.length, saves);
    escape(h); assert.equal(h.state.view.start, 20); assert.equal(h.state.view.span, 40); assert.equal(h.saves.length, saves);
    h.event('pointerdown', 500, 15); h.event('pointermove', 400, 15); h.event('pointerup', 400, 15);
    assert.ok(h.persisted().start > 20); assert.equal(h.saves.length, saves + 1);
});
