'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const model = require('../src/waveform/model');

test('长时间轴保留单 tick 差异和安全整数端点，时间标签不截断有效位', () => {
    assert.equal(model.formatTime(16524331, 1e-9), '16.524331 ms');
    assert.equal(model.formatTime(16524332, 1e-9), '16.524332 ms');
    assert.equal(model.formatTime(Number.MAX_SAFE_INTEGER, 1e-9), '9007199.254740991 s');
    assert.equal(model.formatTime(Number.MAX_SAFE_INTEGER, null), '9007199254740991 ticks');
    assert.equal(model.formatTime(-35, 1e-9), '-35 ns');
});

test('超宽总线显示原始 VCD 缩略表达，不伪造截断后的进制值', () => {
    assert.equal(model.binaryValue('x', 100000).length, 100000);
    assert.equal(model.formatValue('x', { width: 100000, type: 'wire' }, 'hex'), '100000b VCD x');
});

test('同名不同向量切片有独立持久化行标识，保留可读层级和范围检索', () => {
    const source = [
        { path: 'tb.data', name: 'data', scopePath: 'tb', id: 'a', range: '[7:4]', width: 4, type: 'wire' },
        { path: 'tb.data', name: 'data', scopePath: 'tb', id: 'b', range: '[3:0]', width: 4, type: 'wire' }
    ];
    const prepared = model.prepareSignals(source), keys = prepared.map(model.signalKey);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(source[0].key, undefined);
    assert.deepEqual(model.filterSignals(prepared, '[7:4]', '', false).map(model.signalKey), [keys[0]]);
    const restored = model.restoreState({ fileKey: 'capture', selected: keys }, { vars: prepared, endTime: 100 }, 'capture');
    assert.deepEqual(restored.selected, keys);
});

function bus(width, type = 'wire') { return { width, type }; }

test('128 位总线的 hex/unsigned/signed 显示不丢失低位精度', () => {
    const bits = '1' + '0'.repeat(126) + '1';
    const signal = bus(128);
    assert.equal(model.formatValue(bits, signal, 'hex'), '0x80000000000000000000000000000001');
    assert.equal(model.formatValue(bits, signal, 'dec'), '170141183460469231731687303715884105729');
    assert.equal(model.formatValue(bits, signal, 'sdec'), '-170141183460469231731687303715884105727');
    assert.equal(model.formatValue(bits, signal, 'bin'), bits);
});

test('二补码按声明宽度解释，短二进制向量先零扩展', () => {
    assert.equal(model.formatValue('1'.repeat(64), bus(64), 'sdec'), '-1');
    assert.equal(model.formatValue('1'.repeat(64), bus(64), 'dec'), '18446744073709551615');
    assert.equal(model.formatValue('10000000', bus(8), 'sdec'), '-128');
    assert.equal(model.formatValue('01111111', bus(8), 'sdec'), '127');
    assert.equal(model.binaryValue('1', 8), '00000001');
    assert.equal(model.formatValue('1', bus(8), 'sdec'), '1');
});

test('短 X/Z 向量用首状态扩展，混合未知 nibble 不被当成有效数字', () => {
    assert.equal(model.binaryValue('X1', 8), 'xxxxxxx1');
    assert.equal(model.binaryValue('z1', 6), 'zzzzz1');
    assert.equal(model.formatValue('x1', bus(8), 'hex'), '0xXX');
    assert.equal(model.formatValue('z1', bus(8), 'hex'), '0xZZ');
    assert.equal(model.formatValue('1x0z', bus(8), 'hex'), '0x0X');
    assert.equal(model.formatValue('1x0z', bus(8), 'dec'), 'X');
    assert.equal(model.formatValue('z', bus(8), 'sdec'), 'Z');
});

test('缺失值显示未知标记，真实实数与无法解析的文本不会伪造零', () => {
    assert.equal(model.formatValue(null, bus(128)), '—');
    assert.equal(model.formatValue(undefined, bus(8)), '—');
    assert.equal(model.formatValue('-3.25', bus(1, 'real'), 'hex'), '-3.25');
    assert.equal(model.formatValue('unparsed', bus(8)), 'unparsed');
});

test('未知 timescale 只显示/解析 ticks，不猜测物理时间单位', () => {
    assert.equal(model.formatTime(125, null), '125 ticks');
    assert.equal(model.formatTime(0, null), '0 ticks');
    assert.equal(model.formatTime(null, 1e-12), '—');
    assert.equal(model.formatTime(Infinity, 1e-12), '—');
    assert.equal(model.parseTime('1e3 ticks', null), 1000);
    assert.equal(model.parseTime('125', null), 125);
    assert.equal(model.parseTime('1 ns', null), null);
});

test('已知时间尺度可用物理单位往返，非法或不安全时间拒绝解析', () => {
    assert.equal(model.formatTime(1200, 1e-12), '1.2 ns');
    assert.equal(model.parseTime('1.2 ns', 1e-12), 1200);
    assert.equal(model.parseTime('2 us', 1e-9), 2000);
    for (const text of ['-1 ticks', 'NaN', '1 elephants', '1e309 ticks', '9007199254740992']) {
        assert.equal(model.parseTime(text, 1e-9), null, text);
    }
});

test('valueAt 采用左闭时间，首次记录之前返回未知，同 tick 采用最后记录', () => {
    const changes = [{ t: 5, value: '0' }, { t: 10, value: '1' }, { t: 10, value: 'x' }, { t: 15, value: 'z' }];
    assert.equal(model.valueAt([], 10), null);
    assert.equal(model.valueAt(changes, 4), null);
    assert.equal(model.valueAt(changes, 5), '0');
    assert.equal(model.valueAt(changes, 10), 'x');
    assert.equal(model.valueAt(changes, 100), 'z');
});

test('视口 clamp 保持文件边界和一 tick 最小范围', () => {
    assert.deepEqual(model.clampView(-20, 1000, 100), { start: 0, span: 100 });
    assert.deepEqual(model.clampView(90, 20, 100), { start: 80, span: 20 });
    assert.deepEqual(model.clampView(50, 0, 100), { start: 50, span: 1 });
    assert.deepEqual(model.clampView(Infinity, NaN, 100), { start: 0, span: 100 });
    assert.deepEqual(model.clampView(10, 50, 0), { start: 0, span: 1 });
});

test('锚点缩放保持鼠标对应时间，越界时视口仍在文件中', () => {
    const original = { start: 20, span: 40 };
    const zoomed = model.zoomView(original, 0.5, 0.25, 100);
    assert.deepEqual(zoomed, { start: 25, span: 20 });
    assert.equal(original.start + original.span * 0.25, zoomed.start + zoomed.span * 0.25);
    assert.deepEqual(model.zoomView({ start: 90, span: 10 }, 2, 1, 100), { start: 80, span: 20 });
});

const signals = [
    { path: 'tb.clk', scopePath: 'tb', id: '!', type: 'wire' },
    { path: 'tb.dut.clk_alias', scopePath: 'tb.dut', id: '!', type: 'wire' },
    { path: 'tb.dut.deep.data', scopePath: 'tb.dut.deep', id: '#', type: 'wire' },
    { path: 'tb.idle', scopePath: 'tb', id: '%', type: 'wire', hasChanges: false },
    { path: 'tb.WIDTH', scopePath: 'tb', id: '&', type: 'parameter' },
    { path: 'tb.LIMIT', scopePath: 'tb', id: '*', type: 'specparameter' },
    { path: 'tb2.clk', scopePath: 'tb2', id: '?', type: 'wire' },
];

test('过滤保留 alias 路径，同 id 不去重，也不误隐藏无变化线网', () => {
    const filtered = model.filterSignals(signals, 'CLK', 'tb', false);
    assert.deepEqual(filtered.map(signal => signal.path), ['tb.clk', 'tb.dut.clk_alias']);
    assert.equal(filtered[0].id, filtered[1].id);
    assert.ok(model.filterSignals(signals, '', 'tb', false).some(signal => signal.path === 'tb.idle'));
    assert.equal(model.filterSignals(signals, '', 'tb', false).some(signal => /parameter/.test(signal.type)), false);
    assert.equal(model.filterSignals(signals, '', 'tb', true).filter(signal => /parameter/.test(signal.type)).length, 2);
});

test('作用域过滤只包含自身及后代，路径搜索不改变 alias 元数据', () => {
    assert.deepEqual(model.filterSignals(signals, '', 'tb.dut', false).map(signal => signal.path), ['tb.dut.clk_alias', 'tb.dut.deep.data']);
    assert.deepEqual(model.filterSignals(signals, 'dut.clk', '', false).map(signal => signal.path), ['tb.dut.clk_alias']);
    assert.strictEqual(model.filterSignals(signals, 'dut.clk', '', false)[0], signals[1]);
});

test('同文件恢复剔除失效路径并去重，视口和游标 clamp 到新文件范围', () => {
    const metadata = { vars: signals, endTime: 100 };
    const saved = { fileKey: 'capture-a', selected: ['gone', 'tb.dut.clk_alias', 'tb.clk', 'tb.clk'], start: -10, span: 500, cursorA: 150, cursorB: -8 };
    assert.deepEqual(model.restoreState(saved, metadata, 'capture-a'), {
        selected: ['tb.dut.clk_alias', 'tb.clk'], view: { start: 0, span: 100 }, cursorA: 100, cursorB: 0
    });
});

test('不同文件不沿用旧选择/视口，非法保存值恢复为安全默认值', () => {
    const metadata = { vars: signals, endTime: 100 };
    const saved = { fileKey: 'old', selected: ['tb.clk'], start: 80, span: 5, cursorA: 90, cursorB: 95 };
    const defaults = { selected: [], view: { start: 0, span: 100 }, cursorA: 0, cursorB: null };
    assert.deepEqual(model.restoreState(saved, metadata, 'new'), defaults);
    assert.deepEqual(model.restoreState({ fileKey: 'new', selected: 'invalid', start: Infinity, span: NaN, cursorA: Infinity, cursorB: NaN }, metadata, 'new'), defaults);
});

test('同文件截短后恢复保留有效选择，但 viewport/cursors 不越界', () => {
    const metadata = { vars: signals.filter(signal => signal.path === 'tb.clk'), endTime: 50 };
    const saved = { fileKey: 'capture-a', selected: ['tb.clk', 'tb.dut.clk_alias'], start: 80, span: 40, cursorA: 80, cursorB: 60 };
    assert.deepEqual(model.restoreState(saved, metadata, 'capture-a'), {
        selected: ['tb.clk'], view: { start: 10, span: 40 }, cursorA: 50, cursorB: 50
    });
});

const { buildWaveformHtml } = require('../src/waveform/view');

function bootFrom(html) {
    const script = html.match(/<script\b[^>]*>const BOOT=([\s\S]*?);<\/script>/);
    assert.ok(script, '页面应有单一 BOOT 元数据脚本');
    return JSON.parse(script[1]);
}

function htmlMetadata() {
    return { headers: [], scopes: [{ path: 'tb' }], timescale: '1 ns', endTime: 10, eventCount: 2, fileBytes: 100,
        vars: [{ name: 'clk', path: 'tb.clk', scopePath: 'tb', width: 1, type: 'wire', id: '!' },
            { name: 'clk_alias', path: 'tb.clk_alias', scopePath: 'tb', width: 1, type: 'wire', id: '!' }] };
}

test('HTML 的 filename/header/scope/信号名不能结束脚本或注入标签', () => {
    const payload = '</script><script nonce="attackNonce">globalThis.injected=true</script><img src=x onerror="inject()">';
    const metadata = htmlMetadata();
    metadata.headers = [{ key: '$comment', value: payload }];
    metadata.scopes[0].path = payload;
    metadata.vars[0].name = payload; metadata.vars[0].path = payload;
    const html = buildWaveformHtml(metadata, { fileName: payload + '.vcd', fileKey: payload });
    const baseline = buildWaveformHtml(null, { fileName: 'normal.vcd' });
    assert.equal((html.match(/<script\b/gi) || []).length, (baseline.match(/<script\b/gi) || []).length);
    assert.doesNotMatch(html, /<script nonce="attackNonce"|<img\b/i);
    const boot = bootFrom(html);
    assert.equal(boot.fileName, payload + '.vcd'); assert.equal(boot.fileKey, payload);
    assert.equal(boot.metadata.headers[0].value, payload);
    assert.equal(boot.metadata.vars[0].name, payload);
});

test('HTML 使用同一 nonce 约束脚本和样式，无 unsafe-inline 和事件属性', () => {
    const nonce = 'c0ffee112233445566778899';
    const html = buildWaveformHtml(null, { fileName: 'capture.vcd', nonce });
    assert.match(html, /default-src 'none'/);
    assert.ok(html.includes("script-src 'nonce-" + nonce + "'"));
    assert.ok(html.includes("style-src 'nonce-" + nonce + "'"));
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
    for (const match of html.matchAll(/<(script|style)\b([^>]*)>/gi)) assert.ok(match[2].includes('nonce="' + nonce + '"'));
    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    assert.doesNotMatch(markup, /\son[a-z]+\s*=/i);
    const first = buildWaveformHtml(null, { fileName: 'one.vcd' }).match(/<script nonce="([^"]+)"/)[1];
    const second = buildWaveformHtml(null, { fileName: 'two.vcd' }).match(/<script nonce="([^"]+)"/)[1];
    assert.notEqual(first, second);
});

test('HTML 仅包含元数据和 alias 定义，changes/alias events 不随文件事件量复制', () => {
    const metadata = htmlMetadata();
    const eventMarker = 'EVENT_PAYLOAD_MUST_STAY_IN_WORKER_017391';
    metadata.changes = new Map([['!', Array.from({ length: 1000 }, (_, t) => ({ t, value: eventMarker }))]]);
    metadata.aliases = new Map([['tb.clk_alias', metadata.changes.get('!')]]);
    const html = buildWaveformHtml(metadata, { fileName: 'capture.vcd' });
    const boot = bootFrom(html);
    assert.doesNotMatch(html, new RegExp(eventMarker));
    assert.equal(Object.hasOwn(boot.metadata, 'changes'), false);
    assert.equal(Object.hasOwn(boot.metadata, 'aliases'), false);
    assert.deepEqual(boot.metadata.vars.map(signal => [signal.path, signal.id, signal.changeCount]), [
        ['tb.clk', '!', 1000], ['tb.clk_alias', '!', 1000]
    ]);
    assert.ok(JSON.stringify(boot).length < 1000);
    assert.equal(Object.hasOwn(bootFrom(buildWaveformHtml(null, { fileName: 'loading.vcd' })), 'metadata'), false);
});

test('零时间显示已知 timescale 的基准单位，无尺度时仍是 ticks', () => {
    assert.equal(model.formatTime(0, 1e-9), '0 ns');
    assert.equal(model.formatTime(0, 1e-11), '0 ps');
    assert.equal(model.formatTime(0, null), '0 ticks');
});

test('1-bit 显式 SDec 按二补码解释，默认标量显示与未知状态保留', () => {
    const signal = bus(1);
    assert.equal(model.formatValue('1', signal, 'sdec'), '-1');
    assert.equal(model.formatValue('0', signal, 'sdec'), '0');
    assert.equal(model.formatValue('x', signal, 'sdec'), 'X');
    assert.equal(model.formatValue('z', signal, 'sdec'), 'Z');
    assert.equal(model.formatValue('1', signal), '1');
    assert.equal(model.formatValue('1', signal, 'bin'), '1');
});
