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
        setAttribute(name, value) { this[name] = value; }
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
    currentRuns: { synthesis: 'synth_1', implementation: 'impl_1' },
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
    same(ui.messages[0], { action: 'ready', auto: true });
    assert.equal(ui.nodes.get('auto').checked, true);
    ui.listeners.message({ data: { type: 'summary', data: sample, at: Date.parse('2026-11-21T08:00:00Z') } });
    assert.equal(ui.nodes.get('project').textContent, 'demo');
    same(ui.nodes.get('meta').children.map(item => item.children.map(child => child.textContent)),
        [['器件', 'xc7a35tcsg324-1'], ['顶层模块', 'top']]);
    assert.equal(ui.nodes.get('directory').textContent, 'C:/demo');
    assert.equal(ui.nodes.get('runs').children.length, 2);
    assert.equal(ui.nodes.get('runs-empty').hidden, true);
    const impl = ui.nodes.get('runs').children[1];
    assert.equal(impl.children[0].children[0].textContent, 'impl_1');
    assert.match(impl.children[0].children[1].textContent, /布局布线 · 当前运行/u);
    assert.equal(impl.children[1].children[0].className, 'chip busy');
    assert.equal(impl.children[1].children[1].textContent, '待重跑');
    const log = impl.children[3].children[0];
    assert.equal(log.textContent, '日志');
    log.onclick();
    same(ui.messages.at(-1), { action: 'openRun', run: 'impl_1', kind: 'log' });
    const wns = ui.nodes.get('timing').children[0].children[0].children[1];
    assert.equal(wns.textContent, '-0.123 ns');
    assert.equal(wns.className, 'negative');
    assert.equal(ui.nodes.get('messages').children[0].children[1].textContent, '2');
    assert.match(ui.nodes.get('updated').textContent, /更新于/);
});

test('工程概览使用当前运行并保留轮询前的按钮焦点', () => {
    const ui = harness();
    const data = { ...sample, runs: [{ ...sample.runs[0], id: 'ooc' },
        { ...sample.runs[1], id: 'impl_old', timing: { wns: 2.35 } }, ...sample.runs] };
    ui.listeners.message({ data: { type: 'summary', data, at: 10 } });
    assert.equal(ui.nodes.get('cards').children[0].children[1].children[0].textContent, 'synth_1');
    assert.match(ui.nodes.get('timing-source').textContent, /impl_1/u);
    const row = ui.nodes.get('runs').children.at(-1);
    ui.listeners.message({ data: { type: 'summary', data: structuredClone(data), at: 20 } });
    assert.equal(ui.nodes.get('runs').children.at(-1), row);
    ui.listeners.message({ data: { type: 'reset' } });
    assert.equal(ui.nodes.get('content').hidden, true);
    assert.equal(ui.nodes.get('updated').textContent, '');
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

test('概览切换工程时丢弃在途结果，产物只打开新工程快照里的条目', async () => {
    const { openSummaryPanels } = require('../src/vivado/summary-view');
    const old = path.resolve('bin/old.xpr'), current = path.resolve('bin/new.xpr');
    const posted = [], opened = [], requests = [];
    let receive, dispose, finishOld;
    const panel = {
        visible: false, reveal() {}, onDidChangeViewState() {}, onDidDispose(handler) { dispose = handler; },
        webview: { cspSource: 'local', asWebviewUri: uri => uri, postMessage: message => posted.push(message),
            onDidReceiveMessage(handler) { receive = handler; } }
    };
    const vscode = { Uri: { joinPath: (...parts) => parts.join('/') }, ViewColumn: { Active: 1 },
        window: { createWebviewPanel: () => panel } };
    const panels = openSummaryPanels({ extensionUri: 'local' }, vscode, {
        load: file => {
            requests.push(file);
            return file === old ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve(sample);
        },
        openPath: file => opened.push(file)
    });
    panels.open(old);
    receive({ action: 'ready', auto: false });
    panels.open(current);
    receive({ action: 'openRun', kind: 'log', run: 'impl_1' });
    assert.deepEqual(opened, []);
    finishOld({ project: { name: 'old' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [old, current]);
    assert.deepEqual(posted.map(message => message.type), ['reset', 'summary']);
    assert.equal(posted[1].data.project.name, 'demo');
    receive({ action: 'openRun', kind: 'log', run: 'unlisted', path: 'arbitrary.log' });
    receive({ action: 'openRun', kind: 'log', run: 'impl_1', path: 'arbitrary.log' });
    assert.deepEqual(opened, [sample.paths.impl_1.log]);
    dispose();
});
