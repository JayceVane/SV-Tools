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
    assert.deepEqual(form.pages.map(page => page.title), ['IP Configuration', '其他参数', 'Other Page']);
    const gpio = form.pages[0].groups[0];
    assert.equal(gpio.rows.length, 2);
    assert.deepEqual(gpio.notes, ['说明']);
    assert.equal(form.pages[0].groups[1].title, 'GPIO 2');
    assert.equal(form.pages[1].groups[0].title, '其他参数');
    assert.equal(form.pages[2].groups[0].title, '常规');
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
    const context = { document, window, acquireVsCodeApi: () => ({
        postMessage: message => messages.push(message),
        getState: () => saved,
        setState: value => { saved = value; }
    }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'vivado', 'ip-form-client.js'), 'utf8'), context);
    return { nodes, messages, listeners };
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
    const sections = ui.nodes.get('form').children;
    assert.equal(sections.length, 2);
    const rows = sections.flatMap(section => section.children.filter(child => child.className === 'row'));
    assert.equal(rows.length, 3);
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
    const rows = ui.nodes.get('form').children.flatMap(section => section.children.filter(child => child.className === 'row'));
    const field = rows[1].children[1].children[0];
    assert.equal(field.disabled, true);
    const note = rows[1].children[1].children[1];
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /C_IS_DUAL/);
});
