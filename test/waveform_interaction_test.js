'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const I = require('../src/waveform/interaction');
const { clientHarness } = require('./helpers/waveform-client-harness');

test('Shift 范围锚点保持稳定，收缩范围不会残留上一次选中行', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    const initial = I.selectSignals(order, [], 'a', null);
    const extended = I.selectSignals(order, initial.keys, 'd', initial.anchor, { shiftKey: true });
    assert.deepEqual(extended, { keys: ['a', 'b', 'c', 'd'], anchor: 'a', activeKey: 'd' });
    const shrunk = I.selectSignals(order, extended.keys, 'b', extended.anchor, { shiftKey: true });
    assert.deepEqual(shrunk, { keys: ['a', 'b'], anchor: 'a', activeKey: 'b' });
    const reversed = I.selectSignals(order, ['e'], 'b', 'e', { shiftKey: true });
    assert.deepEqual(reversed.keys, ['b', 'c', 'd', 'e']);
});

test('Ctrl/Meta 切换单行；Ctrl+Shift 扩展范围保留离散选择', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    const toggled = I.selectSignals(order, ['a', 'd'], 'b', 'a', { ctrlKey: true });
    assert.deepEqual(toggled.keys, ['a', 'b', 'd']);
    assert.deepEqual(I.selectSignals(order, toggled.keys, 'a', 'b', { metaKey: true }).keys, ['b', 'd']);
    assert.deepEqual(I.selectSignals(order, ['a', 'd'], 'e', 'd', { ctrlKey: true, shiftKey: true }).keys, ['a', 'd', 'e']);
    assert.deepEqual(I.selectSignals(order, ['a', 'b', 'd'], 'c', 'b').keys, ['c']);
});

test('右键已选行保留多选与锚点，未选行成为唯一操作目标', () => {
    const order = ['a', 'b', 'c', 'd'];
    assert.deepEqual(I.selectContextTargets(order, ['d', 'b', 'gone'], 'd', 'b'), { keys: ['b', 'd'], anchor: 'b', activeKey: 'd' });
    assert.deepEqual(I.selectContextTargets(order, ['b', 'd'], 'c', 'b'), { keys: ['c'], anchor: 'c', activeKey: 'c' });
    const old = new Set(['d', 'b']);
    const snapshot = I.orderedTargets(order, old); old.clear(); old.add('a');
    assert.deepEqual(snapshot, ['b', 'd']);
});

test('新分组和加入已有分组形成连续块，按原行顺序并入而不改变输入', () => {
    const order = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const groups = { d: 'AXI', f: 'AXI', e: '其他组' };
    const assigned = I.assignGroup(order, groups, ['e', 'b'], ' AXI ');
    assert.deepEqual(assigned.order, ['a', 'b', 'd', 'e', 'f', 'c', 'g']);
    assert.equal(assigned.groups.b, 'AXI'); assert.equal(assigned.groups.e, 'AXI');
    assert.equal(groups.e, '其他组'); assert.equal(groups.b, undefined);
    assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    const fresh = I.assignGroup(order, groups, ['e', 'c'], '计算');
    assert.deepEqual(fresh.order, ['a', 'b', 'c', 'e', 'd', 'f', 'g']);
    assert.deepEqual(I.assignGroup(order, groups, ['gone'], '空组').order, order);
});

test('分组名拒绝空白、控制字符和超长输入，特殊属性名仍安全保存', () => {
    for (const label of [' ', '', 'a\nline', 'a\u0000', 'a'.repeat(81)]) assert.throws(() => I.groupName(label));
    assert.equal(I.groupName('  数据路径  '), '数据路径');
    const grouped = I.assignGroup(['__proto__', 'constructor', 'toString'], {}, ['__proto__'], 'constructor');
    assert.equal(Object.getPrototypeOf(grouped.groups), null);
    assert.equal(grouped.groups.__proto__, 'constructor');
});

test('拖拽移动整个多选集，上下移动保留内部顺序，拖到已选行不拆组', () => {
    const order = ['a', 'b', 'c', 'd', 'e', 'f'];
    assert.deepEqual(I.moveSignals(order, ['d', 'b'], 'f'), ['a', 'c', 'e', 'f', 'b', 'd']);
    assert.deepEqual(I.moveSignals(order, ['d', 'f'], 'a'), ['d', 'f', 'a', 'b', 'c', 'e']);
    assert.deepEqual(I.moveSignals(order, ['b', 'd'], 'd'), order);
    assert.deepEqual(I.moveSignals(order, [], 'a'), order);
    assert.deepEqual(I.moveSignals(order, ['b'], 'gone'), order);
});

test('混合宽度格式只在整个选集兼容时启用，使用同一个模型规则', () => {
    const calls = [], supports = (signal, id) => { calls.push([signal.width, id]); return signal.width === 32; };
    const option = { id: 'fp32' };
    assert.deepEqual(I.formatAvailability(option, [{ width: 32 }, { width: 16 }], supports), { disabled: true, compatible: 1, total: 2, detail: '仅适用 1/2' });
    assert.deepEqual(calls, [[32, 'fp32'], [16, 'fp32']]);
    assert.deepEqual(I.formatAvailability(option, [{ width: 32 }, { width: 32 }], supports), { disabled: false, compatible: 2, total: 2, detail: '' });
    assert.deepEqual(I.formatAvailability(option, [], supports), { disabled: true, compatible: 0, total: 0, detail: '' });
});

test('菜单位置限制在视口内，左边和上边不会因小坐标变为负值', () => {
    assert.deepEqual(I.menuPosition(999, 999, 220, 120, 800, 600), { x: 574, y: 474 });
    assert.deepEqual(I.menuPosition(-50, -50, 220, 120, 800, 600), { x: 6, y: 6 });
});

function menuHarness() {
    const document = { activeElement: null };
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.dataset = {}; this.listeners = {}; this.disabled = false; }
        get offsetWidth() { return this.className?.includes('menu') ? 240 : 220; }
        get offsetHeight() { return this.children.length * 32 + 10; }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        getAttribute(name) { return this.attributes[name]; }
        append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
        appendChild(child) { this.append(child); return child; }
        addEventListener(name, handler) { this.listeners[name] = handler; }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
        contains(target) { return this === target || this.children.some(child => child.contains(target)); }
        focus() { document.activeElement = this; }
        click() { if (!this.disabled) this.onclick?.(); }
        getBoundingClientRect() {
            const left = Number.parseFloat(this.parent?.style.left || 0), top = Number.parseFloat(this.parent?.style.top || 0);
            return { left: left + 5, right: left + 235, top: top + 35 };
        }
    }
    document.createElement = tag => new Element(tag); document.body = new Element('body');
    const window = { WaveInteractions: I, innerWidth: 600, innerHeight: 400 };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/waveform/menu.js'), 'utf8'), { window, document });
    const canvas = new Element('canvas'); let closes = 0, applies = 0;
    const menu = window.createWaveMenu({ x: 580, y: 390, title: '已选 2 条信号', returnFocus: canvas, onClose: () => closes++,
        items: [{ id: 'format', label: '显示格式', submenu: [
            { id: 'hex', label: 'Hex', checked: true, action: () => applies++ },
            { id: 'fp32', label: 'FP32', checked: false, disabled: true, detail: '仅适用 1/2', action: () => assert.fail('禁用格式不能应用') },
            { id: 'bin', label: 'Bin', checked: false, action: () => applies++ }
        ] }, { id: 'new-group', label: '新建分组', action: () => applies++ }] });
    const key = (element, name) => {
        let prevented = false, stopped = false;
        element.onkeydown({ key: name, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
        assert.equal(prevented, true, name); assert.equal(stopped, true, name);
    };
    return { document, window, canvas, menu, key, counts: () => ({ closes, applies }) };
}

test('菜单具备单选语义与禁用提示；方向键展开子菜单并跳过不兼容格式', () => {
    const h = menuHarness(), root = h.document.body.children[0], format = root.children[1];
    assert.equal(root.getAttribute('role'), 'menu'); assert.equal(h.document.activeElement, format);
    h.key(format, 'ArrowRight');
    const submenu = h.document.body.children[1], [hex, fp32, bin] = submenu.children;
    assert.equal(hex.getAttribute('role'), 'menuitemradio'); assert.equal(hex.getAttribute('aria-checked'), 'true');
    assert.equal(fp32.getAttribute('aria-disabled'), 'true'); assert.equal(fp32.children[2].textContent, '仅适用 1/2');
    assert.equal(format.getAttribute('aria-expanded'), 'true');
    assert.equal(h.document.activeElement, hex);
    h.key(hex, 'ArrowDown'); assert.equal(h.document.activeElement, bin);
    h.key(bin, 'ArrowDown'); assert.equal(h.document.activeElement, hex);
    h.key(hex, 'ArrowLeft'); assert.equal(h.document.activeElement, format); assert.equal(h.document.body.children.length, 1);
    assert.equal(format.getAttribute('aria-expanded'), 'false');
});

test('Enter/Space 执行菜单操作一次并恢复波形焦点；关闭是幂等操作', () => {
    const h = menuHarness(), root = h.document.body.children[0];
    h.key(root.children[1], 'ArrowDown'); assert.equal(h.document.activeElement, root.children[2]);
    h.key(h.document.activeElement, ' ');
    assert.deepEqual(h.counts(), { closes: 1, applies: 1 });
    assert.equal(h.document.activeElement, h.canvas); assert.equal(h.document.body.children.length, 0);
    h.menu.close(); assert.deepEqual(h.counts(), { closes: 1, applies: 1 });
});

test('鼠标悬停打开子菜单，Escape 逐层收起，所有层都计入外部点击判断', () => {
    const h = menuHarness(), root = h.document.body.children[0], format = root.children[1];
    format.listeners.pointerenter(); const submenu = h.document.body.children[1], hex = submenu.children[0];
    assert.equal(h.menu.contains(hex), true); assert.equal(h.menu.contains(h.canvas), false);
    h.key(hex, 'Escape'); assert.equal(h.document.activeElement, format); assert.equal(h.document.body.children.length, 1);
    h.key(format, 'Escape'); assert.equal(h.document.body.children.length, 0); assert.equal(h.document.activeElement, h.canvas);
});

test('右侧边缘子菜单向左展开，各层始终约束在视口中', () => {
    const h = menuHarness(), root = h.document.body.children[0], format = root.children[1];
    h.key(format, 'ArrowRight'); const submenu = h.document.body.children[1];
    assert.ok(Number.parseFloat(submenu.style.left) < Number.parseFloat(root.style.left));
    for (const level of h.document.body.children) {
        assert.ok(Number.parseFloat(level.style.left) >= 6);
        assert.ok(Number.parseFloat(level.style.left) + level.offsetWidth <= h.window.innerWidth - 6);
        assert.ok(Number.parseFloat(level.style.top) + level.offsetHeight <= h.window.innerHeight - 6);
    }
});

test('实际控制器：右键批量格式使用冻结目标，改变显示不重读窗口/游标数据', async () => {
    const h = clientHarness(); await h.flush();
    assert.deepEqual(h.messages.map(message => message.type), ['window', 'values']);
    h.pointer('tb.a'); h.pointer('tb.b', { ctrlKey: true });
    const menu = h.contextMenu('tb.a'); assert.equal(menu.title, '已选 2 条信号');
    const fp32 = menu.items[0].submenu.find(item => item.id === 'format-fp32');
    assert.equal(fp32.disabled, false);
    h.state.multi = new Set(['tb.c']); fp32.action(); await h.flush();
    assert.equal(h.state.formats['tb.a'], 'fp32'); assert.equal(h.state.formats['tb.b'], 'fp32'); assert.equal(h.state.formats['tb.c'], undefined);
    assert.equal(h.messages.length, 2); assert.match(h.node('status').textContent, /2 条信号/);
});

test('实际控制器：独立分组对话框保留选择，Enter创建、Escape取消', async () => {
    const h = clientHarness(); await h.flush(); h.pointer('tb.a'); h.pointer('tb.c', { ctrlKey: true });
    const menu = h.contextMenu('tb.c'); menu.items.find(item => item.id === 'new-group').action();
    const input = h.find('waveGroupName'); assert.equal(h.document.activeElement, input);
    input.value = ' DATA ';
    const overlay = h.document.body.children[0];
    overlay.onkeydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} }); await h.flush();
    assert.equal(h.state.groups['tb.a'], 'DATA'); assert.equal(h.state.groups['tb.c'], 'DATA');
    assert.equal(h.state.groups['tb.b'], undefined); assert.deepEqual([...h.state.multi], ['tb.a', 'tb.c']);
    assert.deepEqual(Array.from(h.state.selected), ['tb.a', 'tb.c', 'tb.b']); assert.equal(h.document.activeElement, h.canvas);
    assert.equal(h.messages.length, 2, '分组未改变可见信号集合，不应重读数据');
    const repeat = h.contextMenu('tb.a'); repeat.items.find(item => item.id === 'new-group').action();
    h.find('waveGroupName').value = 'CANCELLED'; h.document.body.children[0].onkeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(h.state.groups['tb.a'], 'DATA'); assert.equal(h.document.body.children.length, 0);
});

test('实际控制器：Ctrl+A仅波形焦点生效，输入框快捷键不触发；恢复时剔除非法格式', async () => {
    const h = clientHarness({ fileKey: 'test', selected: ['tb.a', 'tb.b'], formats: { 'tb.a': 'fp16', 'tb.b': 'fp32', gone: 'hex' } });
    await h.flush(); assert.equal(h.state.formats['tb.a'], undefined); assert.equal(h.state.formats['tb.b'], 'fp32'); assert.equal(h.state.formats.gone, undefined);
    let prevented = false;
    h.documentListeners.keydown({ target: h.node('search'), key: 'a', ctrlKey: true, preventDefault() { prevented = true; } });
    assert.equal(prevented, false); assert.equal(h.state.multi.size, 0);
    h.documentListeners.keydown({ target: h.canvas, key: 'a', ctrlKey: true, preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.deepEqual([...h.state.multi], ['tb.a', 'tb.b']);
    h.documentListeners.keydown({ target: h.canvas, key: 'Escape' }); assert.equal(h.state.multi.size, 0); assert.equal(h.state.selectionAnchor, null);
});
