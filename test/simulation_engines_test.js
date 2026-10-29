'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSimulationEnginePicker } = require('../src/toolchains/simulation-engines');

test('引擎注册惰性执行，显示与派发来自同一快照并返回运行结果', async () => {
    let selected = 'second', calls = 0, options;
    const picker = createSimulationEnginePicker({ showQuickPick: async items => { options = items; return items.find(item => item.value === selected); } });
    picker.register({ id: 'first', label: 'First', run: () => assert.fail('不应启动first') });
    picker.register({ id: 'second', label: 'Second', description: 'Details', run: async () => { calls++; return 'done'; } });
    assert.equal(calls, 0); assert.equal(await picker.pick(), 'done'); assert.equal(calls, 1);
    assert.deepEqual(options.map(item => item.value), ['first','second']);
    assert.equal(options[1].description, 'Details'); assert.equal(Object.hasOwn(options[1], 'run'), false);
    const copy = picker.list(); copy[0].value = 'changed'; assert.equal(picker.list()[0].value, 'first');
    selected = undefined; assert.equal(await picker.pick(), undefined); assert.equal(calls, 1);
});

test('取消与未知选项不回退到另一引擎', async () => {
    for (const result of [undefined, { value: 'unknown' }]) {
        const picker = createSimulationEnginePicker({ showQuickPick: async () => result });
        picker.register({ id: 'first', label: 'First', run: () => assert.fail('不得回退执行') });
        await picker.pick();
    }
});

test('选择期间注销或同ID重新注册，不启动过期引擎', async () => {
    let accept;
    const picker = createSimulationEnginePicker({ showQuickPick: () => new Promise(resolve => { accept = resolve; }) });
    const first = picker.register({ id: 'engine', label: 'Old', run: () => assert.fail('过期引擎') });
    const pending = picker.pick(); first.dispose();
    picker.register({ id: 'engine', label: 'New', run: () => assert.fail('未展示的新引擎') });
    first.dispose(); assert.equal(picker.list().length, 1);
    accept({ value: 'engine' }); await pending;
});

test('重复和无效注册明确失败，关闭取消等待中的选择', async () => {
    let accept;
    const picker = createSimulationEnginePicker({ showQuickPick: () => new Promise(resolve => { accept = resolve; }) });
    const entry = { id: 'engine', label: 'Engine', run: () => assert.fail('已关闭') };
    picker.register(entry); assert.throws(() => picker.register(entry), /重复/);
    assert.throws(() => picker.register({ ...entry, id: '' }), /有效/);
    const pending = picker.pick(); picker.dispose(); accept({ value: 'engine' }); await pending;
    assert.deepEqual(picker.list(), []); assert.throws(() => picker.register(entry), /关闭/);
});

test('运行失败传播到调用者，不吞异常或启动其它引擎', async () => {
    const picker = createSimulationEnginePicker({ showQuickPick: async items => items[0] });
    picker.register({ id: 'broken', label: 'Broken', run() { throw new Error('actual failure'); } });
    await assert.rejects(picker.pick(), /actual failure/);
});
