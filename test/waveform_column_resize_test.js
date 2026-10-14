'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function fixture({ requested = { names: 420 }, defaults = { catalog: 252, names: 270 } } = {}) {
    const values = { ...requested }, limits = { catalog: { min: 175, max: 600 }, names: { min: 160, max: 900 } };
    const logs = [], nodes = [], handles = [], activeClasses = new Set(); let blocked = false;
    class Element {
        constructor() {
            this.listeners = new Map(); this.attributes = {}; this.capture = new Set(); this.classes = new Set(); this.tagName = 'DIV';
            this.classList = { toggle: (key, value) => value ? this.classes.add(key) : this.classes.delete(key) };
        }
        addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); }
        removeEventListener(type, callback) { this.listeners.set(type, this.listeners.get(type).filter(item => item !== callback)); }
        setAttribute(key, value) { this.attributes[key] = String(value); }
        focus(options) { this.focused = options; }
        setPointerCapture(id) { this.capture.add(id); }
        hasPointerCapture(id) { return this.capture.has(id); }
        releasePointerCapture(id) { this.capture.delete(id); this.emit('lostpointercapture', { pointerId: id }); }
        emit(type, props = {}) {
            const event = { clientX: 300, pointerId: 1, button: 0, target: this, ...props,
                preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
            for (const callback of this.listeners.get(type) || []) callback(event);
            return event;
        }
    }
    for (const key of ['catalog', 'names']) {
        const element = new Element(); nodes.push(element);
        handles.push({ key, element, label: key === 'catalog' ? '调整信号目录宽度' : '调整名称与 A/B 栏宽度',
            getWidth: () => values[key], getEffectiveWidth: () => Math.max(limits[key].min, Math.min(values[key] ?? defaults[key], limits[key].max)),
            setWidth: value => { if (value === undefined) delete values[key]; else values[key] = value; }, bounds: () => limits[key], reset: () => delete values[key] });
    }
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/waveform/column-resize.js'), 'utf8'), { window });
    const controller = window.createWaveColumnResize({ handles, blocked: () => blocked,
        onStart(handle) { activeClasses.add(handle.key); logs.push(['start', handle.key]); },
        onPreview: handle => logs.push(['preview', handle.key]), onCommit: handle => logs.push(['commit', handle.key]),
        onCancel: handle => logs.push(['cancel', handle.key]), onEnd(handle) { activeClasses.delete(handle.key); logs.push(['end', handle.key]); } });
    return { controller, handles, nodes, values, limits, logs, activeClasses, block(value) { blocked = value; controller.sync(); },
        count: name => logs.filter(item => item[0] === name).length, event: (key, type, props) => nodes[key === 'catalog' ? 0 : 1].emit(type, props) };
}

test('两个分隔线独立预览，pointerup 用最终位置提交一次，捕获出界鼠标并结束样式', () => {
    const h = fixture();
    h.event('catalog', 'pointerdown'); assert.equal(h.controller.active, true); assert.equal(h.nodes[0].hasPointerCapture(1), true);
    h.event('catalog', 'pointermove', { clientX: 380 }); assert.equal(h.values.catalog, 332); assert.equal(h.values.names, 420);
    assert.equal(h.count('commit'), 0);
    h.event('catalog', 'pointerup', { clientX: 1500 });
    assert.equal(h.values.catalog, 600); assert.equal(h.count('commit'), 1); assert.equal(h.count('end'), 1);
    assert.equal(h.controller.active, false); assert.equal(h.nodes[0].hasPointerCapture(1), false);
    assert.equal(h.activeClasses.size, 0); assert.equal(h.nodes[0].classes.size, 0);
});

test('原位释放与先拖动后回原位无提交，生命周期仍结束且默认缺省请求被保留', () => {
    for (const moves of [[], [420, 300]]) {
        const h = fixture(); h.event('catalog', 'pointerdown');
        for (const clientX of moves) h.event('catalog', 'pointermove', { clientX });
        h.event('catalog', 'pointerup');
        assert.equal(h.values.catalog, undefined); assert.equal(h.count('commit'), 0); assert.equal(h.count('end'), 1);
        assert.equal(h.count('start'), 1); assert.equal(h.activeClasses.size, 0); assert.equal(h.nodes[0].classes.size, 0);
    }
});

test('取消恢复原始请求宽度而不是临时有效 clamp，pointerup 迟到不提交', () => {
    const h = fixture({ requested: { names: 750 } }); h.limits.names.max = 300; h.controller.sync();
    h.event('names', 'pointerdown'); h.event('names', 'pointermove', { clientX: 270 });
    assert.equal(h.values.names, 270);
    assert.equal(h.controller.cancel(), true); assert.equal(h.values.names, 750);
    assert.equal(h.nodes[1].attributes['aria-valuenow'], '300'); assert.equal(h.count('commit'), 0); assert.equal(h.count('cancel'), 1);
    assert.equal(h.count('end'), 1); assert.equal(h.controller.cancel(), false);
    h.event('names', 'pointerup', { clientX: 500 }); assert.equal(h.count('commit'), 0);
});

for (const type of ['pointercancel', 'lostpointercapture']) {
    test(`${type} 回滚宽度，不把未提交预览写成最终请求`, () => {
        const h = fixture(); h.event('names', 'pointerdown'); h.event('names', 'pointermove', { clientX: 500 });
        h.event('names', type);
        assert.equal(h.values.names, 420); assert.equal(h.controller.active, false);
        assert.equal(h.count('cancel'), 1); assert.equal(h.count('commit'), 0); assert.equal(h.count('end'), 1);
        assert.equal(h.activeClasses.size, 0);
    });
}

test('Esc 取消聚焦分隔线的手势，输入框按键与其他 pointerId 不被拦截', () => {
    const h = fixture(); h.event('names', 'pointerdown'); h.event('names', 'pointermove', { clientX: 500 });
    h.event('names', 'pointermove', { clientX: 800, pointerId: 2 }); h.event('names', 'pointerup', { clientX: 800, pointerId: 2 });
    assert.equal(h.values.names, 620); assert.equal(h.controller.active, true);
    const input = h.event('names', 'keydown', { key: 'Escape', target: { tagName: 'INPUT' } });
    assert.equal(input.prevented, undefined); assert.equal(h.controller.active, true);
    const escape = h.event('names', 'keydown', { key: 'Escape' });
    assert.equal(escape.prevented, true); assert.equal(escape.stopped, true); assert.equal(h.values.names, 420);
    assert.equal(h.count('commit'), 0);
});

test('主指针和互斥 blocked 守卫，不启动第二个同时拖动的分隔线', () => {
    const h = fixture(); h.event('catalog', 'pointerdown', { isPrimary: false }); h.event('catalog', 'pointerdown', { button: 2 });
    assert.equal(h.count('start'), 0); h.block(true); assert.equal(h.nodes[0].attributes['aria-disabled'], 'true');
    h.event('catalog', 'pointerdown'); h.event('catalog', 'keydown', { key: 'ArrowRight' }); h.event('names', 'dblclick');
    assert.equal(h.count('start'), 0); h.block(false);
    h.event('catalog', 'pointerdown'); h.event('names', 'pointerdown', { pointerId: 2 });
    assert.equal(h.count('start'), 1); assert.equal(h.nodes[1].hasPointerCapture(2), false); h.controller.cancel();
});

test('左右键默认8px，Shift32px；双击与 Home 回默认，按键阻止传播到波形快捷键', () => {
    const h = fixture();
    let event = h.event('names', 'keydown', { key: 'ArrowRight' }); assert.equal(h.values.names, 428); assert.equal(event.stopped, true);
    h.event('names', 'keydown', { key: 'ArrowLeft', shiftKey: true }); assert.equal(h.values.names, 396);
    assert.equal(h.count('commit'), 2); assert.equal(h.count('end'), 2); assert.equal(h.activeClasses.size, 0);
    event = h.event('names', 'keydown', { key: 'Home' }); assert.equal(h.values.names, undefined); assert.equal(event.prevented, true);
    assert.equal(h.nodes[1].attributes['aria-valuenow'], '270'); assert.equal(h.count('commit'), 3);
    h.event('names', 'keydown', { key: 'ArrowRight' }); assert.equal(h.values.names, 278);
    h.event('names', 'dblclick'); assert.equal(h.values.names, undefined); assert.equal(h.count('commit'), 5); assert.equal(h.count('end'), 5);
    h.event('names', 'dblclick'); assert.equal(h.count('start'), 5); assert.equal(h.count('commit'), 5);
});

test('临时 clamp 到边界的键盘操作不提交也不残留活动样式，不覆盖更大保存偏好', () => {
    const h = fixture({ requested: { names: 750 } }); h.limits.names.max = 300; h.controller.sync();
    h.event('names', 'keydown', { key: 'ArrowRight', shiftKey: true });
    assert.equal(h.values.names, 750); assert.equal(h.count('start'), 0); assert.equal(h.count('commit'), 0); assert.equal(h.activeClasses.size, 0);
    h.limits.names.min = 300;
    h.event('names', 'keydown', { key: 'ArrowLeft' }); assert.equal(h.values.names, 750); assert.equal(h.count('start'), 0);
});

test('ARIA 与 title 随有效边界同步，保留请求值；销毁移除监听并回滚在途手势', () => {
    const h = fixture({ requested: { names: 750 } }), element = h.nodes[1];
    assert.equal(element.attributes.role, 'separator'); assert.equal(element.attributes['aria-orientation'], 'vertical');
    assert.equal(element.attributes.tabindex, '0'); assert.match(element.attributes.title, /Shift 每次 32px/);
    assert.equal(element.attributes['aria-valuenow'], '750');
    h.limits.names.max = 350; h.controller.sync(); assert.equal(element.attributes['aria-valuenow'], '350'); assert.equal(h.values.names, 750);
    h.event('names', 'pointerdown'); h.event('names', 'pointermove', { clientX: 270 });
    h.controller.dispose(); assert.equal(h.values.names, 750); assert.equal(h.count('end'), 1);
    for (const node of h.nodes) assert.ok([...node.listeners.values()].every(list => list.length === 0));
    h.event('names', 'pointerdown'); assert.equal(h.controller.active, false); h.controller.dispose(); assert.equal(h.count('cancel'), 1);
});

test('提交回调失败仍结束捕获与活动样式，错误向调用方传播', () => {
    const element = fixture().nodes[0], window = {}; let width = 252, ended = 0;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/waveform/column-resize.js'), 'utf8'), { window });
    // 独立节点，避免其它 fixture 的控制器绑定影响错误路径。
    const fresh = new element.constructor();
    const controller = window.createWaveColumnResize({ handles: [{ element: fresh, getWidth: () => width,
        getEffectiveWidth: () => width, setWidth: value => { width = value; }, bounds: () => ({ min: 175, max: 600 }) }],
        onCommit() { throw new Error('保存失败'); }, onEnd() { ended++; } });
    fresh.emit('pointerdown'); fresh.emit('pointermove', { clientX: 400 });
    assert.throws(() => fresh.emit('pointerup', { clientX: 400 }), /保存失败/);
    assert.equal(controller.active, false); assert.equal(ended, 1); assert.equal(fresh.hasPointerCapture(1), false); assert.equal(fresh.classes.size, 0);
});
