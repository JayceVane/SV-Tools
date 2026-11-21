'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
// VM 内创建的对象来自另一份内置构造器，JSON 归一化后再比较结构。
const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** 只替换 DOM 与消息边界，运行真实的 summary-client.js。 */
function harness() {
    const nodes = new Map(), messages = [], listeners = {};
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.dataset = {};
            this.textContent = ''; this.className = ''; this.hidden = false; this.disabled = false;
            this.value = ''; this.checked = false; this.title = '';
        }
        append(...items) { for (const item of items) { this.children.push(item); item.parent = this; } }
        replaceChildren(...items) { this.children = []; this.append(...items); }
        addEventListener(name, callback) { this.listeners = { ...(this.listeners || {}), [name]: callback }; }
    }
    const document = {
        createElement: tag => new Element(tag),
        getElementById: id => {
            if (!nodes.has(id)) { const element = new Element(['auto'].includes(id) ? 'input' : 'div'); element.id = id; nodes.set(id, element); }
            return nodes.get(id);
        },
        addEventListener() {}
    };
    const window = { addEventListener(name, callback) { listeners[name] = callback; } };
    let state;
    const context = { document, window, acquireVsCodeApi: () => ({
        postMessage: message => messages.push(message),
        getState: () => state,
        setState: value => { state = value; }
    }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'vivado', 'summary-client.js'), 'utf8'), context);
    return { nodes, messages, listeners, context };
}

const sample = {
    project: { name: 'demo', part: 'xc7a35tcsg324-1', directory: 'C:/demo', top: 'top', board: '' },
    runs: [
        { id: 'synth_1', status: 'synth_design Complete!', progress: '100%', strategy: 'Vivado Synthesis Defaults',
            needsRefresh: false, step: 'synth_design', elapsed: '00:01:02', timing: { wns: null, tns: null, whs: null, ths: null }, power: null, implementation: false },
        { id: 'impl_1', status: 'Running place_design...', progress: '0%', strategy: 'Performance',
            needsRefresh: true, step: 'place_design', elapsed: '00:00:31', timing: { wns: -0.123, tns: -1.25, whs: 0.05, ths: 0 }, power: 1.2, implementation: true }
    ],
    messages: { errors: 2, warnings: 7 },
    paths: { impl_1: { directory: 'C:/demo/demo.runs/impl_1', log: 'C:/demo/demo.runs/impl_1/runme.log' } }
};

test('工程概览前端渲染运行状态、时序与日志入口', () => {
    const ui = harness();
    same(ui.messages[0], { action: 'ready' });
    assert.equal(ui.nodes.get('auto').checked, true);
    ui.listeners.message({ data: { type: 'summary', data: sample, at: Date.parse('2026-11-21T08:00:00Z') } });
    assert.equal(ui.nodes.get('project').textContent, 'demo');
    assert.match(ui.nodes.get('meta').textContent, /xc7a35tcsg324-1/);
    assert.match(ui.nodes.get('meta').textContent, /顶层 top/);
    assert.equal(ui.nodes.get('runs').children.length, 2);
    assert.equal(ui.nodes.get('runs-empty').hidden, true);
    const impl = ui.nodes.get('runs').children[1];
    assert.equal(impl.children[0].textContent, 'impl_1');
    assert.equal(impl.children[1].textContent, '实现');
    assert.equal(impl.children[2].children[0].className, 'chip busy');
    const log = impl.children[7].children[0];
    assert.equal(log.textContent, '日志');
    log.onclick();
    same(ui.messages.at(-1), { action: 'openLog', path: 'C:/demo/demo.runs/impl_1/runme.log' });
    assert.match(ui.nodes.get('timing').children[0].children[0].textContent, /-0.123 ns/);
    assert.match(ui.nodes.get('timing').children[0].children[0].className, /bad/);
    assert.equal(ui.nodes.get('messages').children[0].textContent, '2 个 Error');
    assert.match(ui.nodes.get('status').textContent, /最近读取/);
});

test('工程概览前端在读取失败时保留上次内容并提示原因', () => {
    const ui = harness();
    ui.listeners.message({ data: { type: 'summary', data: sample, at: Date.now() } });
    ui.listeners.message({ data: { type: 'error', message: 'Vivado 正在执行其他任务' } });
    assert.equal(ui.nodes.get('status').textContent, 'Vivado 正在执行其他任务');
    assert.equal(ui.nodes.get('runs').children.length, 2);
    ui.nodes.get('auto').checked = false;
    ui.nodes.get('auto').onchange();
    same(ui.messages.at(-1), { action: 'auto', enabled: false });
    assert.equal(ui.messages.some(message => message.action === 'refresh'), false);
    ui.nodes.get('refresh').onclick();
    same(ui.messages.at(-1), { action: 'refresh' });
});
