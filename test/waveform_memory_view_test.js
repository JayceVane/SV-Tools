'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../src/waveform/model');
const memory = require('../src/waveform/memory');

/** 仅实现控制器用到的 DOM 边界，事件与请求仍运行真实控制器代码。 */
function element() {
    const classes = new Set();
    return { children: [], textContent: '', value: '', hidden: false, disabled: false, attributes: {},
        classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
        replaceChildren(...children) { this.children = children; },
        appendChild(child) { this.children.push(child); return child; }, append(...children) { this.children.push(...children); },
        setAttribute(name, value) { this.attributes[name] = value; } };
}
function fixture() {
    const nodes = new Map(), queries = [], additions = [];
    const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
    const window = { WaveModel: model, WaveMemory: memory };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/waveform/memory-view.js'), 'utf8'), { window, document });
    const view = window.createMemoryInspector({ request(type, params) {
        let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        queries.push({ type, params, resolve, reject }); return promise;
    }, addSignals(keys) { additions.push(...keys); }, onChange() {} });
    return { view, queries, additions, node: id => document.getElementById(id) };
}
function signals(rows = 24, columns = 9) {
    return model.prepareSignals(Array.from({ length: rows * columns }, (_, index) => {
        const row = Math.floor(index / columns), column = index % columns, name = `mem[${row}][${column}]`;
        return { name, path: 'tb.' + name, scopePath: 'tb', width: 8, type: 'reg', id: 'id' + index };
    }));
}
function response(query, value = '1') { query.resolve({ values: Object.fromEntries(query.params.ids.map(id => [id, value])) }); }
function buttons(h) { return h.node('memoryBody').children.flatMap(row => row.children.flatMap(td => td.children)).filter(item => item.className === 'memoryWord'); }

test('关闭存储器不查询；打开只查询当前64单元，单击使用原始信号行标识', async () => {
    const h = fixture(); h.view.initialize(signals(), null); h.view.refresh(10, null, 1e-9);
    assert.equal(h.queries.length, 0); h.view.toggle();
    assert.equal(h.queries.length, 1); assert.equal(h.queries[0].type, 'values');
    assert.equal(h.queries[0].params.ids.length, 64); assert.equal(h.queries[0].params.time, 10);
    response(h.queries[0]); await nextTurn();
    const cell = buttons(h)[0]; assert.equal(cell.children[0].textContent, 'A 0x01');
    cell.onclick(); assert.deepEqual(h.additions, ['tb.mem[0][0]']);
});

test('存储器浮点格式复用精确游标原值，格式切换不重新查询', async () => {
    const h = fixture(); h.view.initialize(signals(2, 2).map(signal => ({ ...signal, width: 32 })), null);
    h.view.refresh(0, 100, 1e-9); h.view.toggle();
    const before = h.queries.length;
    response(h.queries[0], BigInt('0x3fc00000').toString(2)); response(h.queries[1], BigInt('0x80000000').toString(2)); await nextTurn();
    h.node('memoryRadix').value = 'fp32'; h.node('memoryRadix').onchange();
    const cell = buttons(h)[0]; assert.equal(cell.children[0].textContent, 'A 1.5'); assert.equal(cell.children[1].textContent, 'B -0');
    assert.equal(h.queries.length, before); assert.equal(h.view.snapshot().radix, 'fp32');
    const options = h.node('memoryRadix').children.flatMap(section => section.children);
    assert.equal(options.find(option => option.value === 'fp64').disabled, true);
    assert.equal(options.find(option => option.value === 'tf32').disabled, false);
    h.node('memoryRadix').value = 'fp64'; h.node('memoryRadix').onchange();
    assert.equal(h.view.snapshot().radix, 'fp32'); assert.equal(h.node('memoryRadix').value, 'fp32');
});

test('存储器恢复浮点格式时校验字宽，FP8 的特殊值与未知位不同', async () => {
    const h = fixture(); h.view.initialize(signals(1, 2), { radix: 'fp32', open: true });
    assert.equal(h.view.snapshot().radix, 'hex');
    response(h.queries[0], '01110000'); await nextTurn();
    h.node('memoryRadix').value = 'fp8e3m4'; h.node('memoryRadix').onchange();
    assert.equal(buttons(h)[0].children[0].textContent, 'A +Inf');
    h.view.refresh(10, null, 1e-9); response(h.queries[1], 'x'); await nextTurn();
    assert.equal(buttons(h)[0].children[0].textContent, 'A X');
    assert.equal(buttons(h)[0].children[0].classList.contains('unknown'), true);
});

test('快速翻页合并查询，旧页响应不覆盖新页，新页错误保留明确失败信息', async () => {
    const h = fixture(); h.view.initialize(signals(), null); h.view.toggle();
    h.node('memoryNextRow').onclick(); h.node('memoryNextRow').onclick();
    assert.equal(h.queries.length, 1); assert.equal(h.view.snapshot().rowStart, 16);
    response(h.queries[0], '11111111'); await nextTurn();
    assert.equal(h.queries.length, 2); assert.equal(h.queries[1].params.ids[0], 'id144');
    assert.equal(buttons(h)[0].children[0].textContent, 'A —');
    h.queries[1].reject(new Error('预算超限')); await nextTurn();
    assert.equal(h.node('memoryReadStatus').textContent, '读取失败：预算超限');
});

test('A/B读值显示未知与变化；缺失初值不被标作变化，进制切换不重复查询', async () => {
    const h = fixture(); h.view.refresh(10, 20, 1e-9); h.view.initialize(signals(1, 2), { open: true });
    assert.equal(h.queries.length, 2); assert.deepEqual(h.queries.map(query => query.params.time), [10, 20]);
    h.queries[0].resolve({ values: { id0: 'x', id1: null } });
    h.queries[1].resolve({ values: { id0: '1', id1: '1' } }); await nextTurn();
    const cells = buttons(h); assert.equal(cells[0].children[0].textContent, 'A 0xXX');
    assert.equal(cells[0].children[1].textContent, 'B 0x01'); assert.ok(cells[0].classList.contains('changed'));
    assert.ok(cells[0].children[0].classList.contains('unknown')); assert.equal(cells[0].children[1].classList.contains('unknown'), false);
    assert.equal(cells[1].children[0].textContent, 'A —'); assert.equal(cells[1].classList.contains('changed'), false);
    assert.equal(cells[1].children[1].classList.contains('unknown'), false);
    h.node('memoryRadix').value = 'bin'; h.node('memoryRadix').onchange();
    assert.equal(h.queries.length, 2); assert.equal(cells[0].children[0].textContent, 'A xxxxxxxx');
});

test('关闭抑制迟到响应；地址定位保留真实索引，非法地址不改变页面', async () => {
    const h = fixture(); h.view.initialize(signals(), null); h.view.toggle(); h.node('memoryClose').onclick();
    response(h.queries[0]); await nextTurn(); assert.equal(h.node('memoryPanel').hidden, true);
    h.view.toggle(); h.node('memoryAddress').value = '12,8'; h.node('memoryJump').onclick();
    assert.equal(h.view.snapshot().rowStart, 12); assert.equal(h.view.snapshot().columnStart, 8);
    assert.equal(buttons(h).length, 8);
    h.node('memoryAddress').value = '1200000,8'; h.node('memoryJump').onclick();
    assert.equal(h.view.snapshot().rowStart, 12); assert.match(h.node('memoryReadStatus').textContent, /没有索引记录/);
    response(h.queries[1]); await nextTurn(); response(h.queries[2]); await nextTurn();
});

test('无数组时禁用入口；同文件恢复选择、分页、进制和打开状态', async () => {
    const empty = fixture(); empty.view.initialize([], null); empty.view.toggle();
    assert.equal(empty.node('memoryToggle').disabled, true); assert.equal(empty.queries.length, 0);
    const vars = signals(), key = memory.indexMemories(vars).groups[0].key, h = fixture();
    h.view.initialize(vars, { key, open: true, rowStart: 8, columnStart: 8, radix: 'sdec' });
    assert.equal(h.view.snapshot().key, key); assert.equal(h.view.snapshot().radix, 'sdec');
    assert.equal(h.view.snapshot().columnStart, 8); assert.equal(h.node('memoryPanel').hidden, false);
    assert.equal(h.queries[0].params.ids.length, 8); response(h.queries[0]); await nextTurn();
});
