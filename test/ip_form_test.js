'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseLayout } = require('../src/vivado/xgui');
const { buildForm } = require('../src/vivado/ip-form');

const GUI = [
    'package require xilinx::board 1.0',
    'proc init_gui {IPINST} {',
    '\tset Page0 [ipgui::add_page $IPINST -name "IP Configuration" -layout vertical]',
    '\tset group1 [ipgui::add_group $IPINST -parent $Page0 -name "GPIO" -layout vertical]',
    '\tset_property display_name "GPIO 通道 1" $group1',
    '\tset C_IS_DUAL [ipgui::add_param $IPINST -parent $Page0 -name C_IS_DUAL -widget checkBox]',
    '\tset_property tooltip "启用双通道" $C_IS_DUAL',
    '\tset C_GPIO_WIDTH [ipgui::add_param $IPINST -parent $group1 -name C_GPIO_WIDTH]',
    '\tset_property tooltip "GPIO 位宽" $C_GPIO_WIDTH',
    '\tipgui::add_static_text $IPINST -parent $group1 -name hint -text "[0x0,0xFFFFFFFF]"',
    '}',
    ''
].join('\n');

test('XGUI 解析：页面/分组/控件/提示与静态说明', () => {
    const layout = parseLayout(GUI);
    assert.equal(layout.params.size, 2);
    assert.equal(layout.params.get('C_IS_DUAL').widget, 'checkBox');
    assert.equal(layout.params.get('C_IS_DUAL').help, '启用双通道');
    assert.equal(layout.params.get('C_GPIO_WIDTH').group, 'IP Configuration / GPIO 通道 1');
    assert.deepEqual([...layout.notes], [['IP Configuration / GPIO 通道 1', ['[0x0,0xFFFFFFFF]']]]);
});

test('表单模型按页面与分组合并，缺分组参数归入“其他参数”', () => {
    const form = buildForm([
        { key: 'CONFIG.A', group: 'IP Configuration / GPIO' },
        { key: 'CONFIG.B', group: 'IP Configuration / GPIO' },
        { key: 'CONFIG.C', group: 'IP Configuration / GPIO 2' },
        { key: 'CONFIG.D' },
        { key: 'CONFIG.E', group: 'Other Page' }
    ], [{ group: 'IP Configuration / GPIO', texts: ['说明'] }]);
    assert.equal(form.total, 5);
    assert.deepEqual(form.pages.map(page => page.title), ['IP Configuration', 'Other Page', '其他参数']);
    const gpio = form.pages[0].groups[0];
    assert.equal(gpio.rows.length, 2);
    assert.deepEqual(gpio.notes, ['说明']);
    assert.equal(form.pages[0].groups[1].title, 'GPIO 2');
    assert.equal(form.pages[1].groups[0].title, '常规');
    assert.equal(form.pages[2].groups[0].title, '其他参数');
});

function harness() {
    const nodes = new Map(), messages = [], listeners = {};
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.dataset = {};
            this.textContent = ''; this.className = ''; this.hidden = false; this.disabled = false;
            this.value = ''; this.checked = false; this.title = ''; this.className = '';
            this.classList = { add() {}, remove() {}, toggle() {} };
        }
        append(...items) { for (const item of items) { this.children.push(item); item.parent = this; } }
        replaceChildren(...items) { this.children = []; this.append(...items); }
        addEventListener(name, callback) { this.listeners[name] = callback; }
        setAttribute(name, value) { this[name] = value; }
        scrollIntoView() {}
    }
    const document = {
        body: new Element('body'),
        createElement: tag => new Element(tag),
        getElementById: id => {
            if (!nodes.has(id)) { const element = new Element(id === 'search' ? 'input' : 'div'); element.id = id; nodes.set(id, element); }
            return nodes.get(id);
        },
        querySelectorAll: () => [],
        addEventListener() {}
    };
    const window = { addEventListener(name, callback) { listeners[name] = callback; } };
    let saved = null;
    const context = { document, window,
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: handle => clearTimeout(handle),
        acquireVsCodeApi: () => ({
            postMessage: message => messages.push(message),
            getState: () => saved,
            setState: value => { saved = value; }
        }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'vivado', 'ip-form-client.js'), 'utf8'), context);
    // 表单现在按页面包一层容器，行需要递归收集。
    const rows = () => {
        const found = [];
        const walk = item => { for (const child of item.children || []) {
            if (child.className === 'row') found.push(child); else walk(child); } };
        walk(nodes.get('form'));
        return found;
    };
    return { nodes, messages, listeners, rows };
}

const info = {
    name: 'gpio_0', vlnv: 'xilinx.com:ip:axi_gpio:2.0', locked: false, preview: false,
    parameters: [
        { key: 'CONFIG.C_IS_DUAL', value: 'false', choices: ['false', 'true'], label: '双通道', help: '启用双通道', widget: 'checkBox', group: 'IP Configuration' },
        { key: 'CONFIG.C_GPIO_WIDTH', value: '8', choices: [], label: 'GPIO 位宽', help: 'GPIO 位宽', widget: '', group: 'IP Configuration / GPIO' },
        { key: 'CONFIG.C_DATA_WIDTH', value: '8', choices: ['8', '16', '32'], label: '数据位宽', widget: 'comboBox', group: 'IP Configuration / GPIO' }
    ],
    notes: []
};

test('定制表单渲染控件并在应用时提交修改', () => {
    const ui = harness();
    assert.deepEqual(JSON.parse(JSON.stringify(ui.messages[0])), { action: 'ready' });
    const form = buildForm(info.parameters, []);
    ui.listeners.message({ data: { type: 'form', revision: 3, info, form, busy: false, status: '' } });
    const rows = ui.rows();
    assert.equal(rows.length, 3);
    assert.equal(ui.nodes.get('name').textContent, 'gpio_0', '标题显示 IP 实例名');
    assert.match(ui.nodes.get('subtitle').textContent, /IP 定制 · xilinx\.com:ip:axi_gpio:2\.0/u);
    const dual = rows[0].children[1].children[0];
    assert.equal(dual.tagName, 'INPUT');
    assert.equal(dual.type, 'checkbox');
    const value = rows[1].children[1].children[0];
    assert.equal(value.tagName, 'INPUT');
    const width = rows[2].children[1].children[0];
    assert.equal(width.tagName, 'SELECT');
    dual.checked = true;
    dual.onchange();
    assert.equal(ui.nodes.get('apply').disabled, false);
    assert.match(ui.nodes.get('changed').textContent, /1 项待应用/);
    width.value = '16';
    width.onchange();
    assert.match(ui.nodes.get('changed').textContent, /2 项待应用/);
    ui.nodes.get('apply').onclick();
    const applied = ui.messages.at(-1);
    assert.equal(applied.action, 'apply');
    assert.equal(applied.revision, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(applied.edits)),
        [{ key: 'CONFIG.C_IS_DUAL', value: 'true' }, { key: 'CONFIG.C_DATA_WIDTH', value: '16' }]);
    ui.listeners.message({ data: { type: 'applied' } });
    ui.listeners.message({ data: { type: 'form', revision: 4, info: { ...info, parameters: [
        { ...info.parameters[0], value: 'true' }, info.parameters[1], { ...info.parameters[2], value: '16' }
    ] }, form, busy: false, status: '已应用 2 项修改' } });
    assert.equal(ui.nodes.get('apply').disabled, true);
    assert.equal(ui.nodes.get('status').textContent, '已应用 2 项修改');
    ui.nodes.get('revert').onclick();
    assert.equal(ui.nodes.get('apply').disabled, true);
    ui.nodes.get('close').onclick();
    assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.at(-1))), { action: 'close' });
});

test('依赖不满足的参数禁用并提示来源', () => {
    const ui = harness();
    const dependent = { ...info.parameters[1], dependency: [['CONFIG.C_IS_DUAL', ['false']]] };
    const parameters = [{ ...info.parameters[0], value: 'true' }, dependent];
    ui.listeners.message({ data: { type: 'form', revision: 1, info: { ...info, parameters },
        form: buildForm(parameters, []), busy: false, status: '' } });
    const rows = ui.rows();
    const field = rows[1].children[1].children[0];
    assert.equal(field.disabled, true);
    const note = rows[1].children[1].children[2];
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /C_IS_DUAL/);
});

function fakeHost() {
    const posted = [], listeners = [], disposals = [];
    const panel = {
        webview: {
            html: '', cspSource: 'vscode-resource:',
            asWebviewUri: uri => ({ toString: () => 'file:///' + uri.fsPath.replace(/\\/gu, '/') }),
            onDidReceiveMessage(callback) { listeners.push(callback); return { dispose() {} }; },
            postMessage(message) { posted.push(message); }
        },
        reveal() {},
        onDidDispose(callback) { disposals.push(callback); return { dispose() {} }; },
        dispose() { for (const callback of disposals) callback(); }
    };
    const vscode = {
        Uri: { joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
        ViewColumn: { Active: -1 },
        window: { createWebviewPanel: () => panel }
    };
    const context = { extensionUri: { fsPath: 'C:/ext' }, subscriptions: [] };
    return { panel, posted, listeners, vscode, context };
}

test('对话框宿主：读取、应用与错误状态都经消息往返', async () => {
    const { openIpFormPanels } = require('../src/vivado/ip-form-view');
    const ui = fakeHost();
    const calls = [];
    let parameters = info.parameters;
    const open = openIpFormPanels(ui.context, ui.vscode, {
        async load(key) {
            calls.push(['load', key]);
            return { ...info, parameters, notes: [] };
        },
        async apply(key, edits) {
            calls.push(['apply', key, edits]);
            parameters = parameters.map(parameter => {
                const edit = edits.find(item => item.key === parameter.key);
                return edit ? { ...parameter, value: edit.value } : parameter;
            });
            return { info: { ...info, parameters }, message: '已应用 1 项修改' };
        }
    });
    open({ key: 'k1', title: 'IP 定制', subtitle: 'xilinx.com:ip:axi_gpio:2.0' });
    assert.equal(ui.listeners.length, 1);
    ui.listeners[0]({ action: 'ready' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(calls[0], ['load', 'k1']);
    const first = ui.posted.at(-1);
    assert.equal(first.type, 'form');
    assert.equal(first.form.pages.length, 1);
    assert.equal(first.form.pages[0].groups.length, 2);
    assert.equal(first.info.name, 'gpio_0');
    ui.listeners[0]({ action: 'apply', revision: first.revision, edits: [{ key: 'CONFIG.C_IS_DUAL', value: 'true' }] });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.at(-1)[0], 'apply');
    assert.equal(calls.at(-1)[2][0].key, 'CONFIG.C_IS_DUAL');
    const applied = ui.posted.filter(message => message.type === 'applied');
    assert.equal(applied.length, 1);
    assert.equal(ui.posted.at(-1).info.parameters[0].value, 'true');
    assert.equal(ui.posted.at(-1).status, '已应用 1 项修改');
    ui.listeners[0]({ action: 'close' });
});

test('Vivado 判定禁用的参数置灰，数值参数带范围', () => {
    const ui = harness();
    const parameters = [
        { key: 'CONFIG.A', value: '8', choices: [], label: 'A', format: 'long', min: '1', max: '32', group: 'Page' },
        { key: 'CONFIG.B', value: 'x', choices: [], label: 'B', disabled: true, group: 'Page' }
    ];
    ui.listeners.message({ data: { type: 'form', revision: 1, info: { ...info, parameters },
        form: buildForm(parameters, []), busy: false, status: '' } });
    const rows = ui.rows();
    const ranged = rows[0].children[1].children[0];
    assert.equal(ranged.type, 'number');
    assert.equal(ranged.min, '1');
    assert.equal(ranged.max, '32');
    const disabled = rows[1].children[1].children[0];
    assert.equal(disabled.disabled, true);
    const note = rows[1].children[1].children[2];
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /Vivado 按当前参数值禁用/u);
    assert.equal(ui.nodes.get('apply').disabled, true);
});

test('修改参数后防抖回问 Vivado，并用结果刷新禁用与隐藏', async () => {
    const ui = harness();
    const parameters = [
        { key: 'CONFIG.C_IS_DUAL', value: 'false', choices: ['false', 'true'], label: '双通道', group: 'Page' },
        { key: 'CONFIG.C_GPIO2_WIDTH', value: '32', choices: [], label: 'GPIO2 位宽', group: 'Page' }
    ];
    ui.listeners.message({ data: { type: 'form', revision: 2, info: { ...info, parameters, hidden: { pages: [], groups: [], params: [] } },
        form: buildForm(parameters, []), busy: false, status: '' } });
    const dual = ui.rows()[0].children[1].children[0];
    dual.checked = true;
    dual.onchange();
    const before = ui.messages.length;
    await new Promise(resolve => setTimeout(resolve, 360));
    const evaluation = ui.messages.slice(before).find(message => message.action === 'evaluate');
    assert.ok(evaluation, '应发出 evaluate 消息');
    assert.equal(evaluation.seq, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(evaluation.values)),
        [['CONFIG.C_IS_DUAL', 'true'], ['CONFIG.C_GPIO2_WIDTH', '32']]);
    ui.listeners.message({ data: { type: 'state', seq: evaluation.seq,
        disabled: ['C_GPIO2_WIDTH'], hidden: { pages: [], groups: [], params: [] } } });
    const second = ui.rows()[1].children[1].children[0];
    assert.equal(second.disabled, true);
    ui.listeners.message({ data: { type: 'state', seq: evaluation.seq + 1, disabled: [],
        hidden: { pages: [], groups: [], params: ['c_gpio2_width'] } } });
    assert.equal(ui.rows()[1].hidden, true, '隐藏参数就地隐藏，不重建节点');
});

test('对话框宿主：依赖求值结果以 state 消息回推', async () => {
    const { openIpFormPanels } = require('../src/vivado/ip-form-view');
    const ui = fakeHost();
    const calls = [];
    const open = openIpFormPanels(ui.context, ui.vscode, {
        async load() { return { ...info, parameters: info.parameters, notes: [] }; },
        async apply() { return { info, message: 'ok' }; },
        async evaluate(key, values) {
            calls.push([key, values]);
            return { disabled: ['C_GPIO2_WIDTH'], hidden: { pages: ['AXI'], groups: [], params: [] } };
        }
    });
    open({ key: 'k2' });
    ui.listeners[0]({ action: 'ready' });
    await new Promise(resolve => setTimeout(resolve, 10));
    ui.listeners[0]({ action: 'evaluate', seq: 7, values: [['CONFIG.C_IS_DUAL', 'true']] });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['k2', [['CONFIG.C_IS_DUAL', 'true']]]]);
    const state = ui.posted.filter(message => message.type === 'state').at(-1);
    assert.equal(state.seq, 7);
    assert.deepEqual(JSON.parse(JSON.stringify(state.disabled)), ['C_GPIO2_WIDTH']);
    assert.deepEqual(JSON.parse(JSON.stringify(state.hidden)), { pages: ['AXI'], groups: [], params: [] });
});

test('隐藏的页面与分组同时从树和表单移除', () => {
    const ui = harness();
    const parameters = [
        { key: 'CONFIG.A', value: '1', choices: [], label: 'A', group: '常用 / 基本' },
        { key: 'CONFIG.B', value: '2', choices: [], label: 'B', group: 'AXI / 通道' }
    ];
    ui.listeners.message({ data: { type: 'form', revision: 1,
        info: { ...info, parameters, hidden: { pages: ['axi'], groups: [], params: [] } },
        form: buildForm(parameters, []), busy: false, status: '' } });
    const treeText = ui.nodes.get('pages').children.map(item => item.textContent || '').join('|');
    assert.equal(treeText.includes('AXI'), false);
    const rows = ui.rows();
    assert.equal(rows.length, 2, '隐藏用 hidden 标记，不删节点');
    assert.equal(rows[1].hidden, true);
    assert.equal(rows[0].hidden, false);
    ui.listeners.message({ data: { type: 'form', revision: 1,
        info: { ...info, parameters, hidden: { pages: [], groups: ['axi / 通道'], params: [] } },
        form: buildForm(parameters, []), busy: false, status: '' } });
    assert.equal(ui.rows()[1].hidden, true);
});

test('求值结果只打补丁：控件节点不变、焦点保留', () => {
    const ui = harness();
    const parameters = [
        { key: 'CONFIG.A', value: '1', choices: [], label: 'A', group: 'Page' },
        { key: 'CONFIG.B', value: '2', choices: [], label: 'B', group: 'Page' }
    ];
    ui.listeners.message({ data: { type: 'form', revision: 1,
        info: { ...info, parameters, hidden: { pages: [], groups: [], params: [] } },
        form: buildForm(parameters, []), busy: false, status: '' } });
    const field = ui.rows()[1].children[1].children[0];
    field.focused = true;
    ui.listeners.message({ data: { type: 'state', seq: 1, disabled: ['B'],
        hidden: { pages: [], groups: [], params: [] } } });
    assert.equal(ui.rows()[1].children[1].children[0], field, '同一控件节点');
    assert.equal(field.disabled, true);
    assert.equal(field.focused, true, '焦点没有被重建抢走');
    ui.listeners.message({ data: { type: 'state', seq: 2, disabled: [],
        hidden: { pages: [], groups: ['page'], params: [] } } });
    assert.equal(ui.rows()[1].hidden, true);
});
