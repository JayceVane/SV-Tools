'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const L = require('../src/waveform/row-layout');

function fixture() {
    const signals = new Map(['a', 'b', 'c', 'd', 'e'].map(key => [key, { id: key, type: key === 'b' ? 'real' : 'wire' }]));
    const order = [...signals.keys()];
    return { signals, order, rows: L.buildRows(order, signals, {}, {}) };
}

test('模拟量行高约束及恢复拒绝非法类型，数字显示不会误用模拟量高度', () => {
    const { signals, order } = fixture();
    const heights = L.restoreHeights({ a: 479.8, b: 10000, c: -1, d: '200', e: NaN, gone: 200 }, signals);
    assert.deepEqual({ ...heights }, { a: 480, b: 480 });
    for (const value of [undefined, NaN, Infinity, -40, 0, '200', {}, []]) assert.equal(L.analogHeight(value), 100);
    assert.equal(L.analogHeight(1), 60); assert.equal(L.analogHeight(121.6), 122);
    const rows = L.buildRows(order, signals, {}, heights);
    assert.deepEqual(rows.map(row => row.height), [38, 480, 38, 38, 38]);
    assert.equal(L.buildRows(order, signals, { a: 'analog', b: 'hex' }, heights)[0].height, 480);
    assert.equal(L.buildRows(order, signals, { b: 'hex' }, heights)[1].height, 38);
});

test('命中坐标是半开区间，模拟量底边在两侧可拖，数字底边不能缩放', () => {
    const { rows } = fixture();
    assert.equal(L.rowAt(rows, 37).key, 'a'); assert.equal(L.rowAt(rows, 38).key, 'b');
    assert.equal(L.rowAt(rows, -1), undefined); assert.equal(L.rowAt(rows, L.totalHeight(rows)), undefined);
    for (const y of [132, 138, 144]) assert.equal(L.resizeAt(rows, y).key, 'b');
    assert.equal(L.resizeAt(rows, 37), undefined); assert.equal(L.resizeAt(rows, 150), undefined);
});

test('剩余行的前后边界支持多选整体插入，不依赖旧拖动方向且保留原内部顺序', () => {
    const { order, signals } = fixture(), targets = ['d', 'b'];
    assert.deepEqual(L.insertBlock(order, targets, 0), ['b', 'd', 'a', 'c', 'e']);
    assert.deepEqual(L.insertBlock(order, targets, 2), ['a', 'c', 'b', 'd', 'e']);
    assert.deepEqual(L.insertBlock(order, targets, 999), ['a', 'c', 'e', 'b', 'd']);
    const preview = L.buildRows(L.insertBlock(order, targets, 1), signals, {}, {});
    const c = preview.find(row => row.key === 'c');
    assert.equal(L.insertionSlot(preview, targets, c.y + c.height / 2 - .1), 1);
    assert.equal(L.insertionSlot(preview, targets, c.y + c.height / 2), 2);
    assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e']);
});

test('行位移动画连续且最终精确归位，零时长提供 reduced-motion 直接落点', () => {
    const from = new Map([['a', 0], ['b', 38]]), to = new Map([['a', 38], ['b', 0]]);
    const start = L.motionPositions(from, to, 0), mid = L.motionPositions(from, to, 90), end = L.motionPositions(from, to, 180);
    assert.deepEqual([...start.positions], [...from]);
    assert.ok(mid.positions.get('a') > 0 && mid.positions.get('a') < 38);
    assert.ok(mid.positions.get('b') > 0 && mid.positions.get('b') < 38);
    assert.equal(mid.done, false); assert.equal(end.done, true); assert.deepEqual([...end.positions], [...to]);
    assert.deepEqual([...L.motionPositions(from, to, 0, 0).positions], [...to]);
});

test('只取视口或动画路径上可见行，Canvas 高度不随行数扩大', () => {
    const rows = Array.from({ length: 2000 }, (_, index) => ({ key: String(index), y: index * 38, height: 38 }));
    const visible = L.visibleRows(rows, 3800, 380);
    assert.equal(visible.length, 10); assert.equal(visible[0].key, '100'); assert.equal(visible.at(-1).key, '109');
    const positions = new Map([['0', 3850], ['100', 0]]), animated = L.visibleRows(rows, 3800, 380, positions);
    assert.equal(animated.length, 11); assert.ok(animated.some(row => row.key === '0' && row.y === 3850));
    assert.ok(animated.some(row => row.key === '100' && row.y === 0), '目标位于视口的行保留，以免动画途中闪断');
});

test('边缘自动滚动速度有界，中间和小视口不触发突跳', () => {
    assert.equal(L.edgeScroll(200, 400), 0); assert.equal(L.edgeScroll(-50, 400), -600);
    assert.equal(L.edgeScroll(500, 400), 600); assert.equal(L.edgeScroll(5, 0), 0);
    assert.ok(L.edgeScroll(20, 400) < 0); assert.ok(L.edgeScroll(380, 400) > 0);
});
