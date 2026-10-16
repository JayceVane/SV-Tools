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
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    removeChild(child) { const index = this.children.indexOf(child); if (index < 0) throw new Error('not a child'); this.children.splice(index, 1); child.parentNode = null; return child; }
    insertBefore(child, anchor) { if (child.parentNode) child.parentNode.removeChild(child); const index = anchor === null ? this.children.length : this.children.indexOf(anchor); if (index < 0) throw new Error('not an anchor'); this.children.splice(index, 0, child); child.parentNode = this; return child; }
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
    const frames = new Map();
    window.requestAnimationFrame = callback => { frames.set(++timerId, callback); return timerId; }; window.cancelAnimationFrame = id => frames.delete(id);
    window.paint = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); };
    window.frameCount = () => frames.size;
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
    assert.equal((first.match(/<script nonce=/g) || []).length, 4);
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
    const pin = findData(page, 'data-port-id', 'a-y'); clickObject(page, pin.children.find(e => e.classList.contains('pinHit')));
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


test('连续输入每帧只提交最新相机，滚轮热路径不读取页面布局', () => {
    const page = fakePage(); page.client.receive(graphMessage()); page.window.paint();
    const layer = page.ui('circuit').children[0], original = page.client.getState().camera;
    let writes = 0;
    const set = layer.setAttribute.bind(layer); layer.setAttribute = (name, value) => { if (name === 'transform') writes++; set(name, value); };
    page.ui('circuit').dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: 20 });
    for (let i = 0; i < 100; i++) page.ui('circuit').dispatch('pointermove', { pointerId: 1, clientX: 20 + i, clientY: 20 });
    assert.equal(writes, 0); assert.equal(page.window.frameCount(), 1);
    page.window.paint(); assert.equal(writes, 1); assert.equal(page.client.getState().camera.x, original.x + 109);
    page.ui('circuit').dispatch('pointerup', { pointerId: 1 });
    page.ui('circuit').getBoundingClientRect = () => { throw new Error('滚轮不应强制重排'); };
    const before = page.client.getState().camera, point = { x: 200, y: 150 };
    for (let i = 0; i < 8; i++) page.ui('circuit').dispatch('wheel', { clientX: point.x, clientY: point.y, deltaY: -10 });
    const expected = C.zoomCamera(before, Math.exp(.16), point), actual = page.client.getState().camera;
    for (const key of ['x', 'y', 'scale']) assert.ok(Math.abs(expected[key] - actual[key]) < 1e-8);
    assert.equal(page.window.frameCount(), 1); page.window.paint(); assert.equal(writes, 2);
    page.client.destroy();
});

test('取消、换图、加载和销毁不会留下相机帧或拖拽捕获', () => {
    const page = fakePage(); page.client.receive(graphMessage()); page.window.paint();
    const original = page.client.getState().camera;
    page.ui('circuit').dispatch('pointerdown', { pointerId: 7, button: 0, clientX: 10, clientY: 20 });
    page.ui('circuit').dispatch('pointermove', { pointerId: 7, clientX: 200, clientY: 80 });
    page.client.receive({ type: 'loading' }); assert.equal(page.window.frameCount(), 0);
    assert.deepEqual(page.client.getState().camera, original); assert.equal(page.ui('circuit').captures.size, 0);
    page.client.receive(graphMessage('another')); assert.equal(page.window.frameCount(), 1);
    page.client.receive(graphMessage('third')); assert.equal(page.window.frameCount(), 1);
    page.client.destroy(); assert.equal(page.window.frameCount(), 0);
    page.window.paint(); page.window.flush(); assert.equal(page.window.frameCount(), 0);
});

test('视口虚拟化保持屏外选择、连线和绘制顺序，搜索能够找回屏外节点', () => {
    const page = fakePage(), message = graphMessage();
    message.graph.nodes.push({ id: 'far', label: 'far_signal', kind: 'logic', x: 10000, y: 10000, width: 120, height: 80, ports: [] });
    const drawing = R.renderGraph(page.ui('circuit'), message.graph), original = JSON.stringify(message.graph);
    const far = drawing.nodes.get('far').element, first = drawing.nodes.get('a').element;
    drawing.setSelection({ type: 'node', id: 'far' });
    drawing.setViewport({ x: 0, y: 0, scale: 1 }, 900, 600);
    assert.equal(far.parentNode, null); assert.ok(first.parentNode);
    drawing.setViewport({ x: -9900, y: -9900, scale: 1 }, 900, 600);
    assert.ok(far.parentNode); assert.equal(first.parentNode, null); assert.ok(far.classList.contains('selected'));
    drawing.setViewport({ x: 0, y: 0, scale: .2 }, 900, 600);
    assert.equal(drawing.layer.getAttribute('data-detail'), 'overview');
    drawing.setViewport({ x: 0, y: 0, scale: .5 }, 900, 600);
    assert.equal(drawing.layer.getAttribute('data-detail'), 'compact');
    drawing.setViewport({ x: 0, y: 0, scale: 1 }, 900, 600);
    assert.equal(drawing.layer.getAttribute('data-detail'), 'full');
    assert.deepEqual(first.parentNode.children.map(item => item.getAttribute('data-node-id')), ['a', 'b', 'c']);
    const wire = drawing.edges.get('e1').element;
    drawing.setSelection({ type: 'edge', id: 'e1' });
    drawing.setViewport({ x: -9900, y: -9900, scale: 1 }, 900, 600); assert.equal(wire.parentNode, null);
    drawing.setViewport({ x: 0, y: 0, scale: 1 }, 900, 600); assert.ok(wire.parentNode);
    assert.ok(wire.classList.contains('selected')); assert.ok(drawing.ports.get('b-d').element.classList.contains('selected'));
    assert.deepEqual(wire.parentNode.children.map(item => item.getAttribute('data-edge-id')), ['e1', 'e2']);
    assert.equal(JSON.stringify(message.graph), original);
    page.client.receive(message); page.window.paint(); assert.equal(findData(page, 'data-node-id', 'far'), undefined);
    page.ui('search').value = 'far_signal'; page.ui('search').dispatch('input'); page.window.flush(); page.window.paint();
    assert.ok(findData(page, 'data-node-id', 'far')); assert.equal(page.ui('selectionName').textContent, 'far_signal');
    page.client.destroy();
});

test('选择和搜索只更新发生变化的对象，重复选择不重建详情', () => {
    const page = fakePage(), message = graphMessage(), drawing = R.renderGraph(page.ui('circuit'), message.graph);
    const unrelated = drawing.nodes.get('c').element;
    unrelated.classList.toggle = () => { throw new Error('无关节点不应写 class'); };
    drawing.setSelection({ type: 'node', id: 'a' }); drawing.setSelection({ type: 'node', id: 'b' }); drawing.setSelection(null);
    drawing.setSearch('$dff'); drawing.setSearch('$dff'); drawing.setSearch('');
    page.client.receive(message); const target = findData(page, 'data-node-id', 'a'); clickObject(page, target);
    const detail = page.ui('properties').children[0]; clickObject(page, target); assert.equal(page.ui('properties').children[0], detail);
    page.client.destroy();
});

test('手动相机在窗口改变后重新裁剪，保持平移和缩放', () => {
    const page = fakePage(); page.client.receive(graphMessage()); page.window.paint();
    page.ui('zoomIn').dispatch('click'); page.window.paint(); const camera = page.client.getState().camera;
    page.ui('circuit').clientWidth = 300; page.window.dispatch('resize'); page.window.paint();
    assert.deepEqual(page.client.getState().camera, camera); assert.equal(page.client.getState().isFit, false);
    page.client.destroy();
});


test('时钟三角与 CLK 端口对齐，低有效气泡与普通直线端点各自独立', () => {
    const page = fakePage(), message = graphMessage(), node = message.graph.nodes[1];
    node.width = 196; node.symbol = 'DFF'; node.description = 'D 型触发器 · 异步装载';
    node.parameters = { CLK_POLARITY: '1', ALOAD_POLARITY: '0' };
    node.ports.push({ id: 'clk', label: 'CLK', direction: 'input', role: 'clock', polarity: 1, description: '时钟，上升沿触发', x: -8, y: 16, width: 8, height: 8, bits: ['clk'] },
        { id: 'load', label: 'ALOAD', direction: 'input', role: 'control', polarity: 0, description: '异步装载，低电平有效；Q ← AD（常量 0）', x: -8, y: 60, width: 8, height: 8, bits: ['rst'] });
    page.client.receive(message);
    const clk = findData(page, 'data-port-id', 'clk'), low = findData(page, 'data-port-id', 'load');
    const mark = walk(clk).find(e => e.classList.contains('clockMark'));
    assert.ok(mark);
    assert.equal(mark.getAttribute('d'), 'M 0 15 L 7 20 L 0 25');
    assert.equal(walk(clk).find(e => e.classList.contains('pinDot')).getAttribute('d'), 'M -8 20 L 0 20');
    assert.equal(walk(page.ui('circuit')).filter(e => e.classList.contains('clockMark')).length, 1);
    assert.equal(walk(clk).filter(e => e.classList.contains('polarityBubble')).length, 0);
    assert.equal(walk(low).filter(e => e.classList.contains('polarityBubble')).length, 1);
    assert.equal(walk(low).filter(e => e.classList.contains('pinDot')).length, 0);
    assert.equal(walk(low).find(e => e.classList.contains('pinLabel')).textContent, 'ALOAD');
    clickObject(page, walk(low).find(e => e.classList.contains('polarityBubble')));
    assert.deepEqual(page.client.getState().selection, { type: 'port', id: 'load' });
    assert.match(page.ui('properties').textContent, /异步装载.*低电平/);
    clickObject(page, findData(page, 'data-node-id', node.id));
    assert.match(page.ui('properties').textContent, /异步装载/);
    assert.match(page.ui('properties').textContent, /ALOAD_POLARITY/);
    page.client.destroy();
});

test('下降沿 CLK 同时包含时钟三角与气泡，未知极性及无时钟寄存器不生成虚假三角', () => {
    for (const polarity of [0, undefined]) {
        const page = fakePage(), message = graphMessage(), node = message.graph.nodes[1];
        node.ports.push({ id: 'clk', label: 'CLK', role: 'clock', polarity, direction: 'input', x: -8, y: 16, width: 8, height: 8, bits: ['clk'] });
        page.client.receive(message);
        const clk = findData(page, 'data-port-id', 'clk');
        assert.equal(walk(clk).filter(e => e.classList.contains('clockMark')).length, polarity === 0 ? 1 : 0);
        assert.equal(walk(clk).filter(e => e.classList.contains('polarityBubble')).length, polarity === 0 ? 1 : 0);
        if (polarity === undefined) assert.equal(walk(clk).find(e => e.classList.contains('pinLabel')).textContent, 'CLK?');
        page.client.destroy();
    }
    const page = fakePage(); page.client.receive(graphMessage());
    assert.equal(walk(page.ui('circuit')).filter(e => e.classList.contains('clockMark')).length, 0);
    page.client.destroy();
});


test('普通输出端接线覆盖 ELK 端口外边缘到单元边框，端口中心不会留下断线', () => {
    const page = fakePage(), message = graphMessage(), node = message.graph.nodes[0];
    Object.assign(node.ports[0], { x: 160, y: 16, width: 8, height: 8 });
    page.client.receive(message);
    const pin = findData(page, 'data-port-id', 'a-y');
    assert.equal(walk(pin).find(e => e.classList.contains('pinDot')).getAttribute('d'), 'M 168 20 L 160 20');
    page.client.destroy();
});


test('长工具参数明确标记截断与总项数，不把部分参数伪装成完整值', () => {
    const message = graphMessage(), node = message.graph.nodes[1];
    node.parameters = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['P' + i, '0'.repeat(500)]));
    const detail = C.describeSelection(message.graph, { type: 'node', id: node.id });
    const value = detail.properties.find(([name]) => name === '工具参数')[1];
    assert.match(value, /共 500 字符/);
    assert.match(value, /P31:/);
    assert.doesNotMatch(value, /P32:/);
    assert.match(value, /仅显示前 32 项，共 40 项/);
    assert.ok(value.length < 10000);
    assert.equal(node.parameters.P0.length, 500);
});


test('总线依据真实位数添加斜杠与位宽，单比特名称中的范围不会造成误判', () => {
    const page = fakePage(), message = graphMessage();
    message.graph.edges[1].bits = ['b2']; message.graph.edges[1].label = 'single[31:0]';
    page.client.receive(message);
    const bus = findData(page, 'data-edge-id', 'e1'), scalar = findData(page, 'data-edge-id', 'e2');
    assert.ok(bus.classList.contains('bus'));
    assert.equal(bus.getAttribute('data-bit-width'), '2');
    const badge = walk(bus).find(e => e.classList.contains('busWidth'));
    assert.ok(badge); assert.equal(badge.textContent, '2');
    assert.equal(walk(bus).filter(e => e.classList.contains('busSlash')).length, 1);
    assert.equal(scalar.classList.contains('bus'), false);
    assert.equal(walk(scalar).filter(e => e.classList.contains('busWidth')).length, 0);
    const busPin = findData(page, 'data-port-id', 'a-y');
    assert.ok(busPin.classList.contains('bus'));
    clickObject(page, badge);
    assert.deepEqual(page.client.getState().selection, { type: 'edge', id: 'e1' });
    assert.match(page.ui('properties').textContent, /位宽2/);
    page.client.destroy();
});

test('多比特IO显示实际位宽，不根据名称补造向量范围', () => {
    for (const bits of [['b2'], Array.from({ length: 8 }, (_, i) => 'n:' + i)]) {
        const page = fakePage(), message = graphMessage(), node = message.graph.nodes[0];
        Object.assign(node, { kind: 'input', label: 'data[99:0]', height: 48 });
        node.ports[0].bits = bits;
        page.client.receive(message);
        const cell = findData(page, 'data-node-id', node.id), widths = walk(cell).filter(e => e.classList.contains('portWidth'));
        assert.equal(widths.length, bits.length > 1 ? 1 : 0);
        if (widths.length) assert.equal(widths[0].textContent, '8 bit');
        assert.equal(node.label, 'data[99:0]');
        page.client.destroy();
    }
});

test('总线装饰随所属连线裁剪恢复，选中及总览状态保留位宽身份', () => {
    const page = fakePage(), graph = graphMessage().graph, drawing = R.renderGraph(page.ui('circuit'), graph);
    const edge = drawing.edges.get('e1').element, badge = walk(edge).find(e => e.classList.contains('busWidth'));
    assert.ok(badge);
    drawing.setViewport({ x: -10000, y: -10000, scale: 1 }, 900, 600);
    assert.equal(edge.parentNode, null);
    drawing.setSelection({ type: 'edge', id: 'e1' });
    drawing.setViewport({ x: 0, y: 0, scale: .2 }, 900, 600);
    assert.ok(edge.parentNode); assert.ok(edge.classList.contains('selected')); assert.ok(edge.classList.contains('bus'));
    assert.equal(drawing.layer.getAttribute('data-detail'), 'overview');
    drawing.setViewport({ x: 0, y: 0, scale: 1 }, 900, 600);
    assert.equal(walk(edge).find(e => e.classList.contains('busWidth')), badge);
});

test('总线标记选择可读的正交长段，不在短线或无效折点上伪造标签', () => {
    const section = (startPoint, endPoint, bendPoints) => ({ startPoint, endPoint, bendPoints });
    assert.deepEqual(R.busMarker([section({ x: 10, y: 20 }, { x: 110, y: 20 })], 32), { x: 60, y: 20, vertical: false });
    assert.deepEqual(R.busMarker([section({ x: 20, y: 200 }, { x: 20, y: 0 })], 8), { x: 20, y: 100, vertical: true });
    assert.deepEqual(R.busMarker([section({ x: 0, y: 0 }, { x: 100, y: 300 }, [{ x: 100, y: 0 }])], 16), { x: 50, y: 0, vertical: false });
    for (const sections of [[], [section({ x: 0, y: 0 }, { x: 10, y: 0 })], [section({ x: NaN, y: 0 }, { x: 100, y: 0 })], [section({ x: 0, y: 0 }, { x: 100, y: 100 })]]) assert.equal(R.busMarker(sections, 32), null);
    assert.equal(R.busMarker([section({ x: 0, y: 0 }, { x: 100, y: 0 })], 1), null);
    assert.deepEqual(R.busMarker([section({ x: 0, y: 0 }, { x: 100, y: 0 }, [{ x: 40, y: 0 }, { x: 80, y: 0 }])], 32), { x: 50, y: 0, vertical: false });
});


test('高倍率仅位宽文字进入视口时仍保留总线，不按中心线提前裁剪', () => {
    const page = fakePage(), graph = graphMessage().graph;
    graph.edges[0].bits = Array.from({ length: 16 }, (_, i) => 'n:' + i);
    graph.edges[0].sections = [{ startPoint: { x: -22, y: 0 }, endPoint: { x: -22, y: 100 } }];
    const drawing = R.renderGraph(page.ui('circuit'), graph);
    drawing.setViewport({ x: 0, y: 0, scale: 8 }, 800, 600);
    assert.ok(drawing.edges.get('e1').element.parentNode);
    assert.equal(walk(drawing.edges.get('e1').element).find(e => e.classList.contains('busWidth')).textContent, '16');
});


test('ELK近似水平段可标注位宽，共线路由的不同位组不会覆盖彼此数字', () => {
    const V = require('../src/circuit/viewport');
    const almost = R.busMarker([{ startPoint: { x: 0, y: 20 }, endPoint: { x: 100, y: 20 + 1e-12 } }], 32);
    assert.ok(almost); assert.equal(almost.x, 50); assert.ok(Math.abs(almost.y - 20) < 1e-6);
    const edges = ['a', 'b'].map(id => ({ id, bits: Array(16).fill('n:1'), sections: [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 400, y: 0 } }] }));
    const markers = V.createBusMarkers(edges);
    assert.equal(markers.size, 2); assert.notDeepEqual(markers.get('a'), markers.get('b'));
    assert.deepEqual([...V.createBusMarkers(edges)], [...markers]);
    const avoided = V.createBusMarkers([{ ...edges[0], sections: [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 200, y: 0 } }] }], [{ x: 80, y: -30, width: 40, height: 60 }]);
    assert.equal(avoided.get('a').x, 150);
    assert.equal(V.createBusMarkers([], [{ x: 1e100, y: 0, width: 100, height: 50 }]).size, 0);
    const shared = ['low', 'high'].map(id => ({ id, bits: Array(8).fill('n:1'), sections: [{ startPoint: { x: 0, y: 100 }, bendPoints: [{ x: 0, y: 0 }], endPoint: { x: 80, y: 0 } }] }));
    const placed = V.createBusMarkers(shared);
    assert.equal(placed.size, 2); assert.equal(placed.get('low').vertical, false); assert.equal(placed.get('high').vertical, true);
});
