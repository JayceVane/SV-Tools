'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createCircuitHtml } = require('../src/circuit/view');
const R = require('../src/circuit/renderer');
const C = require('../src/circuit/client');

class FakeElement {
    constructor(ownerDocument, tagName) {
        this.ownerDocument = ownerDocument; this.tagName = tagName.toUpperCase(); this.attributes = new Map(); this.children = []; this.parentNode = null; this.dataset = {}; this.listeners = new Map(); this.value = ''; this.disabled = false; this.hidden = false; this.clientWidth = 900; this.clientHeight = 600; this.text = ''; this.captures = new Set();
        this.classList = { toggle: (name, active) => { const set = new Set((this.getAttribute('class') || '').split(' ').filter(Boolean)); if (active) set.add(name); else set.delete(name); this.setAttribute('class', [...set].join(' ')); }, add: name => this.classList.toggle(name, true), remove: name => this.classList.toggle(name, false), contains: name => (this.getAttribute('class') || '').split(' ').includes(name) };
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { throw new Error(`HTML injection: ${value}`); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.text = ''; for (const child of children) this.appendChild(child); }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatch(type, properties = {}) { const event = { type, target: this, preventDefault() { this.defaultPrevented = true; }, ...properties }; for (const listener of this.listeners.get(type) || []) listener(event); return event; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); }
    focus() { this.ownerDocument.activeElement = this; }
    select() { this.isSelected = true; }
}

function fakePage(saved) {
    const document = { elements: new Map(), createElement(tag) { return new FakeElement(this, tag); }, createElementNS(_ns, tag) { return this.createElement(tag); }, createTextNode(value) { const element = this.createElement('#text'); element.textContent = value; return element; }, getElementById(id) { if (!this.elements.has(id)) this.elements.set(id, this.createElement(['search'].includes(id) ? 'input' : id === 'modules' ? 'select' : id === 'circuit' ? 'svg' : 'div')); return this.elements.get(id); } };
    document.body = document.createElement('body'); document.events = document.createElement('events'); document.addEventListener = (...args) => document.events.addEventListener(...args); document.removeEventListener = (...args) => document.events.removeEventListener(...args);
    const timers = new Map(), window = document.createElement('window'); let timerId = 0;
    window.setTimeout = callback => { timers.set(++timerId, callback); return timerId; }; window.clearTimeout = id => timers.delete(id);
    window.flush = () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); };
    const sent = [], bridge = { postMessage(message) { sent.push(message); }, getState() { return saved; }, setState(state) { this.saved = state; } };
    const client = C.createClient(document, window, bridge, R);
    return { document, window, bridge, sent, client, ui: id => document.getElementById(id), key: properties => document.events.dispatch('keydown', properties) };
}

function graphMessage(id = 'design-a') {
    return { type: 'graph', design: { id, title: '<img src=x onerror=alert(1)>', top: 'top', provenance: { engine: 'Yosys', stage: 'RTL', flat: false }, modules: [{ id: 'top', name: 'top' }, { id: 'child', name: 'child' }] }, breadcrumbs: [{ id: 'top', name: 'top' }], graph: { id: 'top', name: 'top', width: 500, height: 300, signals: [{ id: 'n', name: 'data', bits: ['b2', 'b3'], offset: 4, upto: false }], nodes: [
        { id: 'a', x: 20, y: 30, width: 160, height: 100, label: '<script>alert(1)</script>', kind: 'instance', cellId: 'cell-a', moduleId: 'child', source: { path: 'src/top.sv', line: 9 }, ports: [{ id: 'a-y', label: 'Y', direction: 'output', x: 160, y: 30, width: 0, height: 0, bits: ['b2', 'b3'] }] },
        { id: 'b', x: 300, y: 30, width: 160, height: 100, label: 'q_reg', detail: '$dff', kind: 'register', cellId: 'cell-b', ports: [{ id: 'b-d', label: 'D', direction: 'input', x: 0, y: 30, width: 0, height: 0, bits: ['b2', 'b3'] }] },
        { id: 'c', x: 300, y: 190, width: 160, height: 70, label: 'out', kind: 'output', ports: [{ id: 'c-y', label: 'out', direction: 'input', x: 0, y: 25, bits: ['b2', 'b3'] }] }
    ], edges: [
        { id: 'e1', netId: 'net-data', label: 'data', bits: ['b2', 'b3'], source: 'a-y', target: 'b-d', sections: [{ startPoint: { x: 180, y: 60 }, endPoint: { x: 300, y: 60 } }] },
        { id: 'e2', netId: 'net-data', label: 'data', bits: ['b2', 'b3'], source: 'a-y', target: 'c-y', sections: [{ startPoint: { x: 180, y: 60 }, bendPoints: [{ x: 240, y: 60 }, { x: 240, y: 215 }], endPoint: { x: 300, y: 215 } }] }
    ] } };
}

function walk(element) { return [element, ...element.children.flatMap(walk)]; }
function findData(page, attribute, value) { return walk(page.ui('circuit')).find(element => element.getAttribute(attribute) === value); }
function clickObject(page, target) { page.ui('circuit').dispatch('pointerdown', { target, button: 0, pointerId: 1, clientX: 10, clientY: 20 }); page.ui('circuit').dispatch('pointerup', { pointerId: 1 }); }

test('端口详情使用声明方向，保持内部布局驱动方向独立', () => {
    const message = graphMessage();
    message.graph.nodes[0].kind = 'input';
    message.graph.nodes[0].ports[0].declaredDirection = 'input';
    const selection = C.describeSelection(message.graph, { type: 'port', id: 'a-y' });
    assert.equal(selection.kind, '模块端口');
    assert.deepEqual(selection.properties.find(([name]) => name === '方向'), ['方向', 'input']);
    assert.equal(message.graph.nodes[0].ports[0].direction, 'output');
});

test('操作符图形不把OR或未知逻辑画成AND，宽总线详情有明确长度上限', () => {
    for (const [detail, expected] of [['$or', 'OR'], ['$add', '+'], ['$lut', 'LOGIC'], ['constructor', 'LOGIC']]) {
        const page = fakePage(), message = graphMessage();
        Object.assign(message.graph.nodes[0], { kind: detail === '$add' ? 'arithmetic' : 'logic', detail });
        page.client.receive(message);
        assert.ok(walk(page.ui('circuit')).some(element => element.getAttribute('class') === 'cellSymbol' && element.textContent === expected));
        page.client.destroy();
    }
    const message = graphMessage();
    message.graph.nodes[0].ports[0].bits = Array.from({ length: 4096 }, (_, index) => 'n:' + index);
    const selection = C.describeSelection(message.graph, { type: 'port', id: 'a-y' });
    assert.deepEqual(selection.properties.find(([name]) => name === '位宽'), ['位宽', '4096']);
    assert.match(selection.properties.find(([name]) => name === '位 ID（LSB → MSB）')[1], /仅显示前 256 位/);
});

test('页面不内嵌网表，CSP nonce 随页面变化且无需加载 VS Code 模块', () => {
    const first = createCircuitHtml(), second = createCircuitHtml();
    assert.match(first, /default-src 'none'/);
    assert.match(first, /script-src 'nonce-[a-f0-9]+'/);
    assert.doesNotMatch(first, /(?:src|href)\s*=\s*["']https?:\/\//);
    assert.doesNotMatch(first, /url\(\s*["']?https?:\/\//);
    assert.doesNotMatch(first, /innerHTML\s*=/);
    assert.notEqual(first.match(/nonce-([a-f0-9]+)/)[1], second.match(/nonce-([a-f0-9]+)/)[1]);
    assert.equal((first.match(/<script nonce=/g) || []).length, 2);
});

test('相机适配、缩放锚点及非法持久化数值保持有限', () => {
    const fit = C.fitCamera({ width: 1000, height: 500 }, 1080, 680);
    assert.deepEqual(fit, { x: 40, y: 90, scale: 1 });
    const point = { x: 320, y: 160 }, zoom = C.zoomCamera(fit, 2, point);
    assert.equal((point.x - fit.x) / fit.scale, (point.x - zoom.x) / zoom.scale);
    assert.equal((point.y - fit.y) / fit.scale, (point.y - zoom.y) / zoom.scale);
    assert.deepEqual(C.cleanCamera({ x: Infinity, y: NaN, scale: -8 }), { x: 0, y: 0, scale: .0001 });
    assert.equal(C.zoomCamera(fit, 1000, point).scale, 8);
});

test('相同模块不同内容 SHA 不共享视图；恢复状态只接受有界相机', () => {
    assert.notEqual(C.graphStateKey({ id: 'a' }, { id: 'top' }), C.graphStateKey({ id: 'b' }, { id: 'top' }));
    const page = fakePage(); page.client.receive(graphMessage()); page.ui('zoomIn').dispatch('click'); page.window.flush();
    const zoomed = page.client.getState().camera.scale;
    page.client.receive(graphMessage('design-b')); assert.notEqual(page.client.getState().camera.scale, zoomed);
    page.client.receive(graphMessage()); assert.equal(page.client.getState().camera.scale, zoomed);
    page.client.destroy();
});

test('SVG 按文字显示 RTL 标签，端口点击优先于所属单元，不执行 HTML', () => {
    const page = fakePage(); page.client.receive(graphMessage());
    const elements = walk(page.ui('circuit'));
    assert.equal(elements.some(element => ['SCRIPT', 'IMG'].includes(element.tagName)), false);
    assert.match(page.ui('designTitle').textContent, /<img/);
    const pin = findData(page, 'data-port-id', 'a-y'); clickObject(page, pin.children[0]);
    assert.deepEqual(page.client.getState().selection, { type: 'port', id: 'a-y' });
    assert.equal(page.ui('selectionName').textContent, 'Y');
    assert.match(page.ui('properties').textContent, /LSB → MSB/);
    assert.match(page.ui('properties').textContent, /data \[5:4\]/);
    page.client.destroy();
});

test('选择网络同时高亮分支、引脚及所有端点单元', () => {
    const page = fakePage(); page.client.receive(graphMessage()); clickObject(page, findData(page, 'data-edge-id', 'e1').children[1]);
    for (const id of ['e1', 'e2']) assert.equal(findData(page, 'data-edge-id', id).classList.contains('selected'), true);
    for (const id of ['a-y', 'b-d', 'c-y']) assert.equal(findData(page, 'data-port-id', id).classList.contains('selected'), true);
    for (const id of ['a', 'b', 'c']) assert.equal(findData(page, 'data-node-id', id).classList.contains('connected'), true);
    assert.match(page.ui('properties').textContent, /q_reg.D/);
    page.key({ key: 'Escape' }); assert.equal(page.client.getState().selection, null);
    assert.equal(findData(page, 'data-edge-id', 'e1').classList.contains('selected'), false);
    page.client.destroy();
});

test('层级、来源、重载消息遵循协议；未知源码和无 moduleId 的实例不执行动作', () => {
    const page = fakePage(); assert.deepEqual(page.sent, [{ type: 'ready' }]); page.client.receive(graphMessage());
    clickObject(page, findData(page, 'data-node-id', 'a'));
    page.ui('enterInstance').dispatch('click'); page.ui('openSource').dispatch('click');
    assert.deepEqual(page.sent.slice(-2), [{ type: 'navigate', cellId: 'cell-a' }, { type: 'source', cellId: 'cell-a' }]);
    page.ui('circuit').dispatch('dblclick', { target: page.ui('circuit') }); assert.deepEqual(page.sent.at(-1), { type: 'navigate', cellId: 'cell-a' });
    page.ui('modules').value = 'child'; page.ui('modules').dispatch('change'); assert.deepEqual(page.sent.at(-1), { type: 'module', moduleId: 'child' });
    clickObject(page, findData(page, 'data-node-id', 'b')); assert.equal(page.ui('openSource').disabled, true); assert.equal(page.ui('enterInstance').hidden, true);
    const before = page.sent.length; page.ui('enterInstance').dispatch('click'); page.ui('openSource').dispatch('click'); assert.equal(page.sent.length, before);
    page.ui('reload').dispatch('click'); assert.deepEqual(page.sent.at(-1), { type: 'reload' });
    page.client.destroy();
});

test('层级面包屑驱动返回按钮，loading 与 error 不允许旧画布交互', () => {
    const page = fakePage(), message = graphMessage(); message.breadcrumbs.push({ id: 'child', name: 'u_child' }); page.client.receive(message);
    page.ui('back').dispatch('click'); assert.deepEqual(page.sent.at(-1), { type: 'back' });
    page.client.receive({ type: 'loading', message: 'ELK 正在布局' }); assert.equal(page.ui('reload').disabled, true); assert.equal(page.ui('back').disabled, true);
    const before = page.sent.length; page.ui('home').dispatch('click'); assert.equal(page.sent.length, before);
    page.client.receive({ type: 'error', message: '<script>bad</script>' }); assert.equal(page.ui('messageDetail').textContent, '<script>bad</script>'); assert.equal(page.ui('message').getAttribute('role'), 'alert'); assert.equal(page.ui('reload').disabled, false);
    page.client.destroy();
});

test('当前模块使用 moduleId，展示图身份可以独立于领域模块身份', () => {
    const page = fakePage(), message = graphMessage(); message.graph.id = 'graph:opaque'; message.graph.moduleId = 'top'; page.client.receive(message);
    assert.equal(page.ui('modules').value, 'top');
    const before = page.sent.length; page.ui('modules').dispatch('change'); assert.equal(page.sent.length, before);
    page.ui('modules').value = 'child'; page.ui('modules').dispatch('change'); assert.deepEqual(page.sent.at(-1), { type: 'module', moduleId: 'child' });
    page.client.destroy();
});

test('布局失败时模块列表仍可切换，旧画布继续禁止交互', () => {
    const page = fakePage();
    page.client.receive({ type: 'design', design: graphMessage().design });
    page.client.receive({ type: 'error', message: 'display node budget' });
    assert.equal(page.ui('modules').disabled, false);
    assert.equal(page.ui('fit').disabled, true);
    page.ui('modules').value = 'child';
    page.ui('modules').dispatch('change');
    assert.deepEqual(page.sent.at(-1), { type: 'module', moduleId: 'child' });
    page.client.destroy();
});

test('拖动超过阈值才平移，取消或失去捕获恢复原相机并释放手势', () => {
    const page = fakePage(); page.client.receive(graphMessage()); const original = page.client.getState().camera;
    page.ui('circuit').dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 20, clientY: 30 }); page.ui('circuit').dispatch('pointermove', { pointerId: 7, clientX: 22, clientY: 31 }); assert.deepEqual(page.client.getState().camera, original);
    page.ui('circuit').dispatch('pointermove', { pointerId: 7, clientX: 90, clientY: 50 }); assert.equal(page.client.getState().camera.x, original.x + 70);
    page.key({ key: 'Escape' }); assert.deepEqual(page.client.getState().camera, original); assert.equal(page.ui('viewport').classList.contains('panning'), false);
    page.ui('circuit').dispatch('pointermove', { pointerId: 7, clientX: 100, clientY: 100 }); assert.deepEqual(page.client.getState().camera, original);
    page.client.destroy();
});

test('搜索名称与端口，网络分支只返回一次，键盘在输入框不移动画布', () => {
    const message = graphMessage(); assert.deepEqual(C.searchGraph(message.graph, 'data'), [{ type: 'edge', id: 'e1' }]); assert.deepEqual(C.searchGraph(message.graph, 'Y'), [{ type: 'node', id: 'a' }]);
    const page = fakePage(); page.client.receive(message); page.ui('search').value = 'data'; page.ui('search').dispatch('input'); page.window.flush();
    assert.deepEqual(page.client.getState().selection, { type: 'edge', id: 'e1' }); assert.equal(page.ui('searchCount').textContent, '1/1');
    const camera = page.client.getState().camera; page.key({ key: 'ArrowLeft', target: page.ui('search') }); assert.deepEqual(page.client.getState().camera, camera);
    page.key({ key: 'ArrowLeft' }); assert.equal(page.client.getState().camera.x, camera.x + 32);
    page.key({ key: 'f', ctrlKey: true }); assert.equal(page.document.activeElement, page.ui('search'));
    page.client.destroy();
});

test('详情明确常量、数组范围以及 LSB-first 位序，不把源代码中的索引猜成位 ID', () => {
    const message = graphMessage(); message.graph.nodes[0].ports[0].bits = ['c:1', 'c:x', 'c:z', 'c:0'];
    const details = C.describeSelection(message.graph, { type: 'port', id: 'a-y' });
    assert.deepEqual(details.properties.find(([name]) => name === '位 ID（LSB → MSB）'), ['位 ID（LSB → MSB）', 'c:1, c:x, c:z, c:0']);
    assert.deepEqual(details.properties.find(([name]) => name === '常量位（位置:值）'), ['常量位（位置:值）', '0:1, 1:X, 2:Z, 3:0']);
    assert.match(C.provenanceText({ engine: 'Vivado', stage: 'RTL elaborated', flattened: true }), /Vivado.*RTL elaborated.*平面网表/);
});

test('无效折点不会生成非法 SVG，销毁后不再响应宿主消息或重复绑定', () => {
    assert.equal(R.edgePath([{ startPoint: { x: 1, y: 2 }, endPoint: { x: NaN, y: 3 } }]), '');
    assert.equal(R.edgePath([{ startPoint: { x: 1, y: 2 }, endPoint: { x: 3, y: 4 } }]), 'M 1 2 L 3 4');
    const page = fakePage(); page.client.receive(graphMessage()); page.client.destroy(); page.window.dispatch('message', { data: graphMessage('b') });
    assert.equal(page.client.getState().graph.id, 'top'); assert.equal(page.window.listeners.get('message').size, 0); assert.equal(page.document.events.listeners.get('keydown').size, 0);
});
