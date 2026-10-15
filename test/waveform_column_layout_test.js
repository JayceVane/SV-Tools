'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const C = require('../src/waveform/column-layout');
const L = require('../src/waveform/row-layout');

test('未设置列宽时保留目录与波形栏默认比例，全名和窄视口遵循原习惯', () => {
    assert.equal(C.catalogGeometry(undefined, 1400).width, 252);
    assert.equal(C.catalogGeometry(undefined, 800).width, 185);
    assert.equal(C.waveGeometry(1000, undefined).names, 270);
    assert.equal(C.waveGeometry(1000, undefined, true).names, 340);
    assert.equal(C.waveGeometry(460, undefined).names, 460 * .42);
    assert.equal(C.waveGeometry(600, undefined, true).names, 600 * .42);
});

test('请求宽度保存与有效 clamp 分离，收窄后扩大视口恢复原宽度', () => {
    const saved = { catalog: 550, names: 650 }, restored = C.restoreColumns(saved);
    assert.equal(C.catalogGeometry(restored.catalog, 1600).width, 550);
    assert.equal(C.catalogGeometry(restored.catalog, 700).width, 315);
    assert.equal(C.catalogGeometry(restored.catalog, 1600).width, 550);
    assert.equal(C.waveGeometry(1000, restored.names).names, 650);
    assert.equal(C.waveGeometry(460, restored.names).names, 288);
    assert.equal(C.waveGeometry(1000, restored.names).names, 650);
    assert.deepEqual(saved, { catalog: 550, names: 650 }); assert.deepEqual(restored, saved);
});

test('目录至少175px且不超过45vw，正常空间给右侧留320px，小视口渐进压缩', () => {
    const normal = C.catalogGeometry(900, 1600, 800);
    assert.deepEqual(normal, { width: 480, min: 175, max: 480, defaultWidth: 252 });
    assert.equal(C.catalogGeometry(1, 1600).width, 175);
    const narrow = C.catalogGeometry(500, 400);
    assert.equal(narrow.width, 140); assert.equal(narrow.min, 140);
    assert.ok(400 - narrow.width >= 250);
});

test('名称/A-B 栏优先保留160px波形，设置像素宽度不随全名模式被覆盖', () => {
    const normal = C.waveGeometry(900, 999);
    assert.equal(normal.names, 728); assert.equal(normal.plot, 160);
    assert.equal(C.waveGeometry(900, 1).names, 160);
    assert.equal(C.waveGeometry(900, 420).names, 420);
    assert.equal(C.waveGeometry(900, 420, true).names, 420);
    assert.equal(C.waveGeometry(320, 420).names, 148);
    assert.equal(C.waveGeometry(320, 420).plot, 160);
    const tiny = C.waveGeometry(100, 420);
    assert.equal(tiny.names, 35); assert.equal(tiny.plot, 53);
});

test('恢复仅接受已知自有属性的合法数字，非法存储值不损坏几何', () => {
    assert.deepEqual(C.restoreColumns({ catalog: 261.8, names: 401.2, other: 300 }), { catalog: 262, names: 401 });
    assert.deepEqual(C.restoreColumns(Object.create({ catalog: 300, names: 400 })), {});
    for (const value of [null, undefined, '300', [], { catalog: NaN, names: Infinity }, { catalog: -30, names: 0 }, { catalog: 1e308 }]) {
        assert.deepEqual(C.restoreColumns(value), {});
    }
    assert.equal(C.waveGeometry(900, '500').names, 270);
});

test('极端视口下列宽与时间轴总宽守恒，范围有限且没有负宽或零波形', () => {
    for (const width of [NaN, Infinity, -10, 0, 1, 2, 12, 100, 250, 332, 600, 1920]) {
        for (const requested of [undefined, -1, 0, 175, 550, 2000, Infinity]) {
            const wave = C.waveGeometry(width, requested), catalog = C.catalogGeometry(requested, width);
            for (const value of Object.values(wave)) assert.ok(Number.isFinite(value));
            assert.ok(wave.names >= 0 && wave.plot >= 1 && wave.gutter >= 0);
            assert.ok(Math.abs(wave.names + wave.plot + wave.gutter - wave.width) < 1e-9);
            assert.ok(wave.names >= wave.min && wave.names <= wave.max);
            assert.ok(catalog.width >= catalog.min && catalog.width <= catalog.max);
            assert.ok(catalog.width >= 0);
        }
    }
});

test('真实 renderer 几何与拖动分隔线共享纯规则，x 坐标跟随有效栏宽且不回写请求', () => {
    const state = { columns: { names: 500 }, view: { start: 0, span: 100 }, fullName: false }, tracks = { clientWidth: 900, clientHeight: 400 };
    const sandbox = { window: { WaveColumnLayout: C, WaveRowLayout: L }, document: { body: {} },
        getComputedStyle: () => ({ getPropertyValue: () => '' }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/waveform/renderer.js'), 'utf8'), sandbox);
    const renderer = sandbox.window.createWaveRenderer({ canvas: {}, ruler: {}, tracks, state, model: {} });
    assert.equal(renderer.geometry().names, 500); assert.equal(renderer.x(0), 500); assert.equal(renderer.x(100), 888);
    tracks.clientWidth = 300;
    assert.equal(renderer.geometry().names, 128); assert.equal(renderer.geometry().plot, 160);
    assert.equal(state.columns.names, 500);
    tracks.clientWidth = 900; assert.equal(renderer.geometry().names, 500);
});
