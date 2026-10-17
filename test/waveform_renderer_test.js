'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const model = require('../src/waveform/model');
const layout = require('../src/waveform/row-layout');
const columns = require('../src/waveform/column-layout');

const rendererSource = fs.readFileSync(path.join(__dirname, '../src/waveform/renderer.js'), 'utf8');
const dark = {
    bg: '#111820', panel: '#17212c', border: '#2b3a49', fg: '#dbe6ef', dim: '#8b9fb2', grid: '#253442',
    accent: '#52d4ac', bus: '#e5ba76', x: '#ff737c', z: '#9ba8ff', a: '#5ab8ff', b: '#f5bc68',
    selection: '#203b43', labelText: '#e5d2af', labelHalo: '#111820'
};
const light = {
    ...dark, bg: '#ffffff', panel: '#f3f6f9', fg: '#182e41', bus: '#996000',
    x: '#c82c43', z: '#555fc2', labelText: '#744b10', labelHalo: '#ffffff'
};

// 记录实际 Canvas 命令和样式，验证字形、边沿与背景的绘制关系。
function recordingContext() {
    const calls = [], stack = [];
    const ctx = { calls, globalAlpha: 1, lineWidth: 1, fillStyle: '', strokeStyle: '', lineJoin: 'miter' };
    let currentPath = [];
    function record(op, args) {
        calls.push({ op, args, fill: ctx.fillStyle, stroke: ctx.strokeStyle, alpha: ctx.globalAlpha,
            lineWidth: ctx.lineWidth, lineJoin: ctx.lineJoin, path: currentPath.slice() });
    }
    ctx.save = () => stack.push({ fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle,
        globalAlpha: ctx.globalAlpha, lineWidth: ctx.lineWidth, lineJoin: ctx.lineJoin });
    ctx.restore = () => Object.assign(ctx, stack.pop());
    ctx.beginPath = () => { currentPath = []; };
    for (const op of ['moveTo', 'lineTo', 'rect', 'closePath']) ctx[op] = (...args) => currentPath.push({ op, args });
    for (const op of ['fillRect', 'strokeRect', 'fillText', 'strokeText', 'stroke', 'clip', 'setTransform', 'setLineDash']) {
        ctx[op] = (...args) => record(op, args);
    }
    ctx.measureText = value => ({ width: [...String(value)].reduce((width, char) => width + (/[^\x00-\x7f]/.test(char) ? 11 : 6), 0) });
    return ctx;
}

function fixture({ width = 1000, height = 90, rowHeight = 44, changes = [{ t: 0, value: '1' }],
    dense = [], label, signalWidth = 64, palette = dark, modelOverrides = {} } = {}) {
    const context = recordingContext(), axis = recordingContext();
    const canvas = { style: {}, getContext: () => context }, ruler = { style: {}, getContext: () => axis };
    const tracks = { clientWidth: width, clientHeight: height, scrollTop: 0 };
    const signal = { id: '#', path: 'tb.data', name: 'data', width: signalWidth, type: 'wire', range: `[${signalWidth - 1}:0]` };
    const key = model.signalKey(signal), row = { key, signal, y: 0, height: rowHeight };
    const state = { view: { start: 0, span: 100 }, rows: [row], formats: {}, groups: {}, multi: new Set(),
        series: new Map([[signal.id, { changes, dense }]]), seriesKey: 'current', windowKey: 'current',
        valuesA: {}, valuesB: {}, cursorA: null, cursorB: null, secondsPerTick: 1e-9, fullName: false };
    let activePalette = palette;
    const sandbox = { window: { devicePixelRatio: 1, WaveRowLayout: layout, WaveColumnLayout: columns }, document: { body: {} },
        getComputedStyle: () => ({ getPropertyValue: name => activePalette[name.slice(2)] || '' }) };
    vm.runInNewContext(rendererSource, sandbox, { filename: 'renderer.js' });
    const renderModel = { ...model, ...(label === undefined ? {} : { formatValue: () => label }), ...modelOverrides };
    const renderer = sandbox.window.createWaveRenderer({ canvas, ruler, tracks, state, model: renderModel });
    return { context, axis, canvas, ruler, tracks, signal, row, key, state, renderer,
        setPalette(next) { activePalette = next; renderer.colors(); },
        draw() { context.calls.length = 0; axis.calls.length = 0; renderer.draw(); },
        labels() { return context.calls.filter(call => call.op === 'fillText' && call.args[1] > renderer.geometry().names); } };
}

test('总线内部使用主题文字和细轮廓，保留淡填充但没有数值矩形底板', () => {
    const view = fixture({ label: '-1.7976931348623157e+308' });
    view.draw();
    const label = view.labels().find(call => call.args[0] === '-1.7976931348623157e+308');
    assert.ok(label);
    assert.equal(label.fill, dark.labelText);
    const halo = view.context.calls.find(call => call.op === 'strokeText' && call.args[0] === label.args[0]);
    assert.equal(halo.stroke, dark.labelHalo);
    assert.ok(halo.lineWidth > 0 && halo.lineWidth <= 2);
    assert.equal(halo.lineJoin, 'round');
    const plotRects = view.context.calls.filter(call => call.op === 'fillRect' && call.args[0] >= view.renderer.geometry().names);
    assert.equal(plotRects.length, 1);
    assert.equal(plotRects[0].fill, dark.bus);
    assert.equal(plotRects[0].alpha, .08);
    assert.equal(label.args.length, 3, '自然字形不传入 Canvas maxWidth 压缩参数');
});

test('数值省略由真实文字宽度决定，窄段和长数值不遮住转折边沿', () => {
    const label = '-123456789.123456789012345';
    const view = fixture({ width: 460, label, changes: [{ t: 0, value: '0' }, { t: 22, value: '1' }, { t: 58, value: '0' }] });
    view.draw();
    const segments = [[0, 22], [22, 58], [58, 100]];
    const labels = view.labels();
    assert.equal(labels.length, segments.length);
    for (const [index, call] of labels.entries()) {
        const left = view.renderer.x(segments[index][0]), right = view.renderer.x(segments[index][1]);
        assert.ok(call.args[0].endsWith('…'));
        assert.equal(call.args.length, 3);
        assert.ok(call.args[1] >= left + 4);
        assert.ok(call.args[1] + view.context.measureText(call.args[0]).width <= right - 4);
    }
});

test('窄段与 A/B 读值省略科学计数尾数时始终保留完整指数和符号', () => {
    for (const label of ['1.401298464324817e-45', '-4.9406564584124654e-324', '1.7976931348623157e+308']) {
        const view = fixture({ width: 600, label, changes: [{ t: 0, value: '0' }, { t: 22, value: '1' }, { t: 58, value: '0' }] });
        view.state.cursorA = 20; view.state.cursorB = 80;
        view.draw();
        const suffix = label.match(/[eE][+-]?\d+$/)[0];
        const values = view.context.calls.filter(call => call.op === 'fillText'
            && (call.args[1] > view.renderer.geometry().names || call.fill === dark.a || call.fill === dark.b));
        assert.equal(values.length, 5);
        assert.ok(values.filter(call => call.args[0].includes('…')).length >= 3);
        for (const call of values) {
            assert.ok(call.args[0].endsWith(suffix), call.args[0]);
            assert.ok(call.args[0] === label || call.args[0].includes('…'), call.args[0]);
            assert.equal(call.args[0].startsWith('-'), label.startsWith('-'));
            assert.ok(/^-?\d/.test(call.args[0]));
            assert.equal(call.args.length, 3);
        }
    }
});

test('极窄科学计数段省略整项，不能只显示失去指数的尾数', () => {
    const view = fixture({ width: 460, label: '-4.9406564584124654e-324', changes: [{ t: 0, value: '0' }, { t: 15, value: '1' }] });
    view.draw();
    assert.equal(view.labels().length, 1);
    assert.equal(view.labels()[0].args[0], '-4.9406564584124654e-324');
    assert.ok(view.labels()[0].args[1] > view.renderer.x(15));
});

test('格式注释显示目录中的人类名称，旧 model 缺少 formatLabel 时显示原 ID', () => {
    const view = fixture({ signalWidth: 8 });
    view.state.formats[view.key] = 'fp8e3m4'; view.draw();
    const description = view.context.calls.find(call => call.op === 'fillText' && call.args[1] === 12 && call.args[2] === 31);
    assert.equal(description.args[0], '[7:0] · FP8 (E3M4)');
    const fallback = fixture({ signalWidth: 8, modelOverrides: { formatLabel: undefined } });
    fallback.state.formats[fallback.key] = 'fp8e3m4'; fallback.draw();
    assert.equal(fallback.context.calls.find(call => call.op === 'fillText' && call.args[1] === 12 && call.args[2] === 31).args[0], '[7:0] · fp8e3m4');
});

test('短于可读字符的波形段不画压扁的标签，宽段保留完整科学计数和 NaN', () => {
    const narrow = fixture({ width: 460, label: 'NaN', changes: [{ t: 0, value: '0' }, { t: 1, value: '1' }] });
    narrow.draw();
    assert.equal(narrow.labels().length, 1);
    for (const value of ['NaN', '-Inf', '4.9406564584124654e-324']) {
        const wide = fixture({ label: value });
        wide.draw();
        assert.equal(wide.labels()[0].args[0], value);
    }
});

test('X、Z 和未初始化的总线值保留状态颜色及轮廓，不被普通数值色覆盖', () => {
    const view = fixture({ changes: [{ t: 25, value: 'xxxxxxxx' }, { t: 50, value: 'zzzzzzzz' }, { t: 75, value: '1' }] });
    view.draw();
    assert.deepEqual(view.labels().map(call => call.fill), [dark.dim, dark.x, dark.z, dark.labelText]);
    assert.equal(view.context.calls.filter(call => call.op === 'strokeText').length, 4);
    const fills = view.context.calls.filter(call => call.op === 'fillRect' && call.alpha === .08);
    assert.deepEqual(fills.map(call => call.fill), [dark.dim, dark.x, dark.z, dark.bus]);
});

test('主题切换即时更新标签和轮廓色，旧宿主缺少新变量时使用主题前景与背景', () => {
    const view = fixture({ label: '1.25' });
    view.draw();
    assert.equal(view.labels()[0].fill, dark.labelText);
    view.setPalette(light); view.draw();
    assert.equal(view.labels()[0].fill, light.labelText);
    assert.equal(view.context.calls.find(call => call.op === 'strokeText').stroke, light.labelHalo);
    view.setPalette({ ...light, labelText: '', labelHalo: '' }); view.draw();
    assert.equal(view.labels()[0].fill, light.fg);
    assert.equal(view.context.calls.find(call => call.op === 'strokeText').stroke, light.bg);
});

test('多选高亮、A/B 游标标签和密集区域背景继续绘制', () => {
    const view = fixture({ dense: [{ start: 40, end: 60 }] });
    view.state.multi.add(view.key); view.state.activeKey = view.key;
    view.state.cursorA = 20; view.state.cursorB = 80;
    view.draw();
    const rects = view.context.calls.filter(call => call.op === 'fillRect');
    assert.ok(rects.some(call => call.args[0] === 0 && call.args[2] === view.renderer.geometry().names && call.fill === dark.selection));
    assert.ok(rects.some(call => call.args[0] === 0 && call.args[2] === 3 && call.fill === dark.accent));
    assert.ok(rects.some(call => call.fill === dark.bg && call.args[0] === view.renderer.x(40)));
    assert.ok(rects.some(call => call.alpha === .35 && call.args[0] === view.renderer.x(40)));
    assert.deepEqual(view.axis.calls.filter(call => call.op === 'fillRect' && call.args[2] === 14).map(call => call.fill), [dark.a, dark.b]);
    assert.ok(view.labels().some(call => call.args[0] === '密集'));
});

test('滚动后只有可见行画标签，行内文字始终位于总线的上下边沿之间', () => {
    const view = fixture({ label: '1.25', height: 50, rowHeight: 58 });
    view.state.rows = [0, 58, 116].map(y => ({ ...view.row, y }));
    view.tracks.scrollTop = 59;
    view.draw();
    const labels = view.labels();
    assert.equal(labels.length, 1);
    assert.equal(labels[0].args[2], 31);
    assert.ok(labels[0].args[2] - 11 > 9);
    assert.ok(labels[0].args[2] + 1 < 47);
    assert.equal(view.canvas.height, 50);
});

test('模拟量底边显示实际像素高度与可发现握柄，悬停强调底边；数字行没有缩放握柄', () => {
    const view = fixture({ rowHeight: 160, height: 180 });
    view.state.formats[view.key] = 'analog'; view.draw();
    const handle = view.context.calls.find(call => call.op === 'fillText' && call.args[0] === '↕ 160 px');
    assert.equal(handle.fill, dark.dim);
    assert.ok(view.context.calls.some(call => call.op === 'stroke' && call.path.some(point => point.op === 'moveTo' && point.args[1] === 154)));
    view.state.rowPresentation = { hoverResizeKey: view.key }; view.draw();
    assert.equal(view.context.calls.find(call => call.op === 'fillText' && call.args[0] === '↕ 160 px').fill, dark.accent);
    assert.ok(view.context.calls.some(call => call.op === 'stroke' && call.stroke === dark.accent
        && call.path.some(point => point.op === 'lineTo' && point.args[0] === 1000 && point.args[1] === 159)));
    delete view.state.formats[view.key]; view.draw();
    assert.equal(view.context.calls.some(call => call.op === 'fillText' && call.args[0].startsWith('↕')), false);
});

test('排序选择集变淡并有名称轮廓，插入边界与目标 y 一致，不清除 A/B 标记', () => {
    const view = fixture(); view.state.multi.add(view.key);
    view.state.rowPresentation = { dragKeys: new Set([view.key]), insertionY: 44 };
    view.state.cursorA = 20; view.state.cursorB = 80; view.draw();
    const outline = view.context.calls.find(call => call.op === 'strokeRect');
    assert.equal(outline.stroke, dark.accent); assert.equal(outline.alpha, .6);
    assert.ok(view.context.calls.some(call => call.op === 'stroke' && call.lineWidth === 2
        && call.path.some(point => point.op === 'moveTo' && point.args[0] === 0 && point.args[1] === 44)));
    assert.equal(view.context.calls.find(call => call.op === 'fillRect' && call.fill === dark.bus).alpha, .08 * .6);
    assert.deepEqual(view.axis.calls.filter(call => call.op === 'fillRect' && call.args[2] === 14).map(call => call.fill), [dark.a, dark.b]);
});

test('2000 条实际 Canvas 行仅绘制可见投影，位图仍是视口高度', () => {
    const view = fixture({ label: '1.25', height: 380, rowHeight: 38 });
    view.state.rows = Array.from({ length: 2000 }, (_, index) => ({ key: 'tb.s' + index,
        signal: { ...view.signal, name: 's' + index, path: 'tb.s' + index }, y: index * 38, height: 38 }));
    view.tracks.scrollTop = 3800; view.draw();
    assert.equal(view.labels().length, 10); assert.equal(view.canvas.height, 380);
    view.state.rowPresentation = { positions: new Map([['tb.s0', 3850], ['tb.s100', 0]]) }; view.draw();
    assert.equal(view.labels().length, 11); assert.equal(view.canvas.height, 380);
});

test('背景颜色贯穿名称和波形，选择时仍保留，未修改原始波形颜色及字形', () => {
    const view=fixture(); view.state.highlights={[view.key]:'sky'}; view.state.multi.add(view.key); view.draw();
    const tints=view.context.calls.filter(call=>call.op==='fillRect'&&call.fill==='#1684d6'&&call.alpha===.16);
    assert.equal(tints.length,2); assert.ok(tints.some(call=>call.args[0]===0));
    assert.ok(tints.some(call=>call.args[0]===view.renderer.geometry().names));
    assert.ok(view.context.calls.some(call=>call.op==='fillRect'&&call.fill===dark.bus&&call.alpha===.08));
});
test('派生bit实际绘制为单线，A/B提取父总线对应位，内部无伪总线数值', () => {
    const view=fixture({signalWidth:4,changes:[{t:0,value:'1000'},{t:30,value:'1001'},{t:60,value:'0001'}]});
    const bit=model.signalDisplay.bitSignals(view.signal)[0]; view.row.signal=bit;view.row.key=bit.key;
    view.state.valuesA['#']='1000';view.state.valuesB['#']='0001';view.state.cursorB=100;
    view.draw();
    const a=view.context.calls.find(call=>call.op==='fillText'&&call.fill===dark.a&&call.args[1]===view.renderer.geometry().names-96);
    const b=view.context.calls.find(call=>call.op==='fillText'&&call.fill===dark.b&&call.args[1]===view.renderer.geometry().names-96);
    assert.equal(a.args[0],'1'); assert.equal(b.args[0],'0');
    assert.equal(view.context.calls.filter(call=>call.op==='fillRect'&&call.fill===dark.bus&&call.alpha===.08).length,0);
});
