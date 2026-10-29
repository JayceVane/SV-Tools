'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const N = require('../src/waveform/time-scrollbar');
const { clientHarness } = require('./helpers/waveform-client-harness');

function fixture(view = { start: 200, span: 100 }, end = 1000, width = 1000) {
    const logs = [], nodes = [];
    class Element {
        constructor() { this.listeners = {}; this.attributes = {}; this.style = {}; this.captures = new Set(); this.clientWidth = width; this.classList = { toggle() {} }; nodes.push(this); }
        addEventListener(type, fn) { this.listeners[type] = fn; } removeEventListener(type) { delete this.listeners[type]; }
        setAttribute(key, value) { this.attributes[key] = value; } getBoundingClientRect() { return { left: 0, width: this.clientWidth }; }
        focus() {} setPointerCapture(id) { this.captures.add(id); } hasPointerCapture(id) { return this.captures.has(id); }
        releasePointerCapture(id) { this.captures.delete(id); this.emit('lostpointercapture', { pointerId: id }); }
        emit(type, props = {}) { const event = { pointerId: 1, button: 0, clientX: 220, target: this, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...props }; this.listeners[type]?.(event); return event; }
    }
    const [rail, thumb, previous, next, extent] = Array.from({ length: 5 }, () => new Element()); let current = { ...view }, blocked = false;
    const controller = N.createTimeScrollbar({ rail, thumb, previous, next, extent, getView: () => current, getEnd: () => end,
        formatTime: value => value + ' ns', onPreview(value) { current = value; logs.push('preview'); }, onCommit: () => logs.push('commit'), blocked: () => blocked });
    return { rail, thumb, previous, next, extent, controller, logs, nodes, get view() { return current; }, block(value) { blocked = value; controller.sync(); } };
}

test('滑块比例、位置和最小抓取区映射完整时间范围，长时间轴精确到达首尾', () => {
    const g = N.scrollGeometry({ start: 200, span: 100 }, 1000, 1000);
    assert.equal(g.thumb, 100); assert.equal(g.left, 200);
    assert.equal(N.viewFromThumb(900, g).start, 900);
    const tiny = N.scrollGeometry({ start: 0, span: 1 }, Number.MAX_SAFE_INTEGER, 1000);
    assert.equal(tiny.thumb, 24); assert.equal(N.viewFromThumb(tiny.travel, tiny).start, Number.MAX_SAFE_INTEGER - 1);
    assert.equal(N.viewFromThumb(-100, tiny).start, 0);
    for (const [view, end, width] of [[{ start: 0, span: 100 },100,1000],[{ start: 0, span: 1 },0,0],[{},100,10]]) {
        const result = N.scrollGeometry(view, end, width); assert.equal(result.disabled, true); assert.ok(Number.isFinite(result.left));
    }
});

test('拖动出界仍能到达首尾，只在释放时保存，点击轨道直接跳到目标区域', () => {
    const h = fixture(); h.rail.emit('pointerdown'); h.rail.emit('pointermove', { clientX: 1200 });
    assert.equal(h.view.start, 900); assert.equal(h.view.span, 100); assert.ok(!h.logs.includes('commit'));
    h.rail.emit('pointerup', { clientX: 1200 }); assert.equal(h.logs.filter(item => item === 'commit').length, 1);
    assert.equal(h.next.disabled, true); assert.equal(h.controller.active, false); assert.equal(h.rail.captures.size, 0);
    h.rail.emit('pointerdown', { clientX: 600 }); h.rail.emit('pointerup', { clientX: 600 });
    assert.equal(h.view.start, 550); assert.equal(h.logs.filter(item => item === 'commit').length, 2);
});

test('取消、丢失捕获和销毁恢复起始视窗，迟到指针不会提交', () => {
    for (const cancel of ['keydown','pointercancel','lostpointercapture','dispose']) {
        const h = fixture(); h.rail.emit('pointerdown'); h.rail.emit('pointermove', { clientX: 720 });
        if (cancel === 'dispose') h.controller.dispose(); else h.rail.emit(cancel, { key: 'Escape' });
        assert.equal(h.view.start, 200); assert.equal(h.logs.filter(item => item === 'commit').length, 0);
        h.rail.emit('pointerup', { clientX: 850 }); assert.equal(h.view.start, 200);
    }
});

test('左右按钮、键盘和滚轮保持跨度，禁用及其他指针不改变时间', () => {
    const h = fixture(); h.previous.emit('click'); assert.equal(h.view.start, 175);
    h.next.emit('click'); assert.equal(h.view.start, 200);
    h.rail.emit('keydown', { key: 'PageDown' }); assert.equal(h.view.start, 290);
    h.rail.emit('keydown', { key: 'End' }); assert.equal(h.view.start, 900);
    h.rail.emit('keydown', { key: 'Home' }); assert.equal(h.view.start, 0);
    h.rail.emit('wheel', { deltaX: 0, deltaY: 1, deltaMode: 2 }); assert.equal(h.view.start, 100);
    h.rail.emit('pointerdown', { button: 2 }); h.rail.emit('pointermove', { clientX: 800 }); assert.equal(h.view.start, 100);
    h.block(true); h.rail.emit('keydown', { key: 'End' }); assert.equal(h.view.start, 100);
    assert.equal(h.rail.attributes['aria-disabled'], 'true'); assert.equal(h.previous.disabled, true);
    assert.match(h.rail.attributes['aria-valuetext'], /100 ns → 200 ns/);
});

test('真实页面控制器将拖动、缩放、全程和时间跳转同步到滚动条，拖动查询仍有界', async () => {
    const h = clientHarness({ fileKey: 'test', start: 20, span: 20 }); await h.flush();
    const rail = h.node('timeScrollbar'); assert.equal(rail.attributes['aria-valuenow'], '20');
    const saved = h.saves.length, g = N.scrollGeometry(h.state.view, 100, rail.clientWidth), anchor = 250 + g.left + g.thumb / 2;
    rail.listeners.pointerdown({ pointerId: 1, button: 0, clientX: anchor, preventDefault() {}, stopPropagation() {} });
    for (let index = 0; index < 20; index++) rail.listeners.pointermove({ pointerId: 1, clientX: anchor + index * 30, preventDefault() {}, stopPropagation() {} });
    assert.equal(h.saves.length, saved); assert.ok(h.messages.filter(message => message.type === 'window' && !message.done).length <= 1);
    h.runFrame(); assert.equal(h.node('namesResize').attributes['aria-disabled'], 'true');
    rail.listeners.pointerup({ pointerId: 1, clientX: 250 + rail.clientWidth, preventDefault() {}, stopPropagation() {} }); await h.flush();
    assert.equal(h.node('namesResize').attributes['aria-disabled'], 'false');
    assert.equal(h.state.view.start, 80); assert.equal(h.state.view.span, 20); assert.equal(h.persisted().start, 80);
    assert.equal(rail.attributes['aria-valuenow'], '80');
    h.node('fit').click(); await h.flush(); assert.equal(rail.attributes['aria-disabled'], 'true'); assert.equal(h.state.view.span, 100);
    h.node('zoomIn').click(); await h.flush(); assert.equal(rail.attributes['aria-disabled'], 'false');
    h.node('jumpTime').value = '90 ns'; h.node('jump').click(); await h.flush();
    assert.equal(Number(rail.attributes['aria-valuenow']), h.state.view.start);
    assert.ok(h.messages.filter(message => message.type === 'window').every(message => message.params.ids.length <= 256 && message.params.pixels <= 4096));
});

test('滚动条键盘不触发边沿导航，窗口失焦取消拖动并恢复已保存范围', async () => {
    const h = clientHarness({ fileKey: 'test', start: 20, span: 20 }); await h.flush();
    const rail = h.node('timeScrollbar');
    h.documentListeners.keydown({ target: rail, key: 'ArrowRight', preventDefault() {} });
    assert.equal(h.messages.filter(message => message.type === 'edge').length, 0);
    rail.listeners.pointerdown({ pointerId: 1, button: 0, clientX: 520, preventDefault() {}, stopPropagation() {} });
    rail.listeners.pointermove({ pointerId: 1, clientX: 850, preventDefault() {}, stopPropagation() {} });
    h.windowListeners.blur(); assert.equal(h.state.view.start, 20); await h.flush(); assert.equal(rail.attributes['aria-valuenow'], '20');
});
