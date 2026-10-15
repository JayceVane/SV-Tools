'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVcdParser, parseVcd, buildSignalTree } = require('../src/waveform/parser');
const { VcdStore } = require('../src/waveform/store');
const { VcdSession } = require('../src/waveform/session');

const header = '$date 中文日期 $end\r\n$version stream contract $end $timescale 10 ps $end\r\n' +
    '$scope module tb $end $var wire 1 ! clk $end $var wire 17 # bus [16:0] $end $var real 1 % temp $end\r\n' +
    '$scope module dut $end $var wire 1 ! clk_alias $end $upscope $end $upscope $end $enddefinitions $end\r\n';
const body = '$dumpvars 0! b1x0z # r-3.25 % $end #10 1! b10101010101010101 # r1.25e+3 % #20 $dumpall 0! $end';

function storeFrom(text) {
    const store = new VcdStore();
    const parser = createVcdParser({ onVariable: variable => store.register(variable), onChange: (id, t, value) => store.add(id, t, value) });
    parser.write(text);
    return { store, metadata: store.metadata(parser.finish(), Buffer.byteLength(text)) };
}
async function fixture(t, text) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'svtools-vcd-'));
    const filePath = path.join(dir, 'trace.vcd');
    await fs.promises.writeFile(filePath, text);
    t.after(async () => { await fs.promises.unlink(filePath); await fs.promises.rmdir(dir); });
    return filePath;
}

for (const chunkSize of [1, 2, 3, 7, 31, 64]) {
    test('增量 token 解析任意 ' + chunkSize + ' 字符切分、CRLF、多 token 和跨行头', () => {
        const changes = new Map();
        const parser = createVcdParser({ onChange(id, t, value) {
            if (!changes.has(id)) changes.set(id, []);
            changes.get(id).push({ t, value });
        } });
        const source = header + body;
        for (let index = 0; index < source.length; index += chunkSize) parser.write(source.slice(index, index + chunkSize));
        assert.deepEqual({ ...parser.finish(), changes }, parseVcd(source));
    });
}

for (const [source, message] of [
    [header + '#-1 0!', /时间戳/], [header + '#3 0! #2 1!', /时间戳/],
    [header + '#9007199254740993 0!', /安全整数/], [header + 'b10x', /缺少信号标识/],
    [header + '$dumpall 1!', /缺少 \$end/], ['$scope module tb', /缺少 \$end/],
    [header + '0unknown', /未声明/], [header + 'b12 #', /非法二进制/]
]) {
    test('损坏或截断 VCD 提供诊断：' + message, () => {
        assert.throws(() => parseVcd(source), error => error.code === 'VCD_PARSE' && error.line > 0 && message.test(error.message));
    });
}

test('typed 存储去除无变化值，保留同 timestamp 最终状态和 alias 共享计数', () => {
    const { store, metadata } = storeFrom(header + '0! 1! 0! #5 1! 0! #10 1! 1! #20 0!');
    assert.equal(metadata.rawEventCount, 8);
    assert.equal(metadata.eventCount, 3);
    assert.deepEqual(metadata.vars.filter(v => v.id === '!').map(v => v.changeCount), [3, 3]);
    assert.deepEqual(store.window({ ids: ['!', '!'], start: 0, end: 20, pixels: 20 }).series[0].changes,
        [{ t: 0, value: '0' }, { t: 10, value: '1' }, { t: 20, value: '0' }]);
    assert.equal(buildSignalTree(metadata).children[0].children.find(node => node.path === 'tb.dut').children[0].hasChanges, true);
});

test('值池跨 typed chunk 保留宽向量、X/Z、实数和时间数值精度', () => {
    const store = new VcdStore();
    store.register({ id: '!', name: 'bus', path: 'bus', width: 300001 });
    const wide = '01xz'.repeat(75000) + '1';
    store.add('!', 0, wide);
    store.add('!', 4294967297, '-1.25e+30');
    assert.equal(store.values({ ids: ['!'], time: 0 }).values['!'], wide);
    assert.deepEqual(store.edge({ id: '!', time: 0, direction: 'next' }), { time: 4294967297, value: '-1.25e+30' });
});

test('事件分块边界上的同刻回退不破坏后续写入与二分导航', () => {
    const { store } = storeFrom(header);
    for (let time = 0; time < 65; time++) store.add('!', time, String(time % 2));
    store.add('!', 64, '1');
    store.add('!', 65, '0');
    assert.equal(store.signals.get('!').length, 65);
    assert.deepEqual(store.edge({ id: '!', time: 63, direction: 'next' }), { time: 65, value: '0' });
});

test('密集窗口每像素只传真实首尾事件，dense 显式计数；值和边沿仍精确', () => {
    let source = header;
    for (let time = 0; time < 1000; time++) source += '#' + time + ' ' + (time % 2) + '! ';
    const { store } = storeFrom(source);
    const series = store.window({ ids: ['!'], start: 0, end: 999, pixels: 10 }).series[0];
    assert.ok(series.changes.length <= 21);
    assert.equal(series.dense.length, 10);
    assert.equal(series.dense.reduce((sum, bucket) => sum + bucket.count, 0), 999);
    assert.equal(store.values({ ids: ['!'], time: 555.5 }).values['!'], '1');
    assert.deepEqual(store.edge({ id: '!', time: 555, direction: 'next' }), { time: 556, value: '0' });
    assert.deepEqual(store.edge({ id: '!', time: 555, direction: 'previous' }), { time: 554, value: '0' });
    assert.deepEqual(store.values({ ids: ['missing'], time: 0 }).values, Object.assign(Object.create(null), { missing: null }));
});

test('查询边界和资源预算明确拒绝超限，不能默默截断精确数据', () => {
    const store = new VcdStore({ maxStoreBytes: 400 });
    store.register({ id: '!', name: 's', path: 's', width: 1 });
    assert.throws(() => store.add('!', 0, '1'), error => error.code === 'VCD_RESOURCE_LIMIT');
    const regular = new VcdStore();
    assert.throws(() => regular.window({ ids: ['!'], start: 3, end: 2, pixels: 10 }), /视窗/);
    assert.throws(() => regular.window({ ids: ['!'], start: 0, end: 2, pixels: 10000 }), /像素/);
    assert.throws(() => regular.edge({ id: '!', time: 0, direction: 'wrong' }), /方向/);
});

test('worker 以单字节流正确处理 UTF-8、元数据、精确查询和进度', async t => {
    const filePath = await fixture(t, header + body);
    const progress = [];
    const session = new VcdSession({ readBufferBytes: 1, onProgress: value => progress.push(value) });
    t.after(() => session.dispose());
    const metadata = await session.open(filePath);
    assert.equal(metadata.headers[0].value, '中文日期');
    assert.equal(metadata.fileBytes, Buffer.byteLength(header + body));
    assert.equal(metadata.eventCount, 7);
    assert.equal(progress.at(-1).phase, 'ready');
    assert.deepEqual(await session.values({ ids: ['!', '#', '%'], time: 10 }), { values: { '!': '1', '#': '10101010101010101', '%': '1.25e+3' } });
    assert.deepEqual(await session.edge({ id: '!', time: 10, direction: 'next' }), { time: 20, value: '0' });
    const window = await session.window({ ids: ['!'], start: 10, end: 20, pixels: 5 });
    assert.deepEqual(window.series[0].changes, [{ t: 10, value: '1' }, { t: 20, value: '0' }]);
});

test('dispose 取消正在加载的文件并拒绝所有 pending；重复关闭无副作用', async t => {
    const filePath = await fixture(t, header + body);
    const session = new VcdSession();
    const opening = session.open(filePath);
    const rejected = assert.rejects(opening, error => error.code === 'VCD_DISPOSED');
    await session.dispose();
    await rejected;
    await assert.rejects(session.values({ ids: ['!'], time: 0 }), error => error.code === 'VCD_DISPOSED');
    await session.dispose();
});

test('worker 的格式与文件/存储资源错误保留可诊断 code', async t => {
    const filePath = await fixture(t, header + 'b101');
    for (const options of [{}, { maxFileBytes: 1 }, { maxStoreBytes: 100 }]) {
        const session = new VcdSession(options);
        t.after(() => session.dispose());
        await assert.rejects(session.open(filePath), error => ['VCD_PARSE', 'VCD_RESOURCE_LIMIT'].includes(error.code));
    }
});

test('会话限制 pending 数量，读取完成前的查询立即拒绝', async t => {
    const filePath = await fixture(t, header + body);
    const session = new VcdSession();
    t.after(() => session.dispose());
    await assert.rejects(session.values({ ids: ['!'], time: 0 }), error => error.code === 'VCD_NOT_READY');
    await session.open(filePath);
    const queries = Array.from({ length: 8 }, () => session.values({ ids: ['!'], time: 10 }));
    await assert.rejects(session.values({ ids: ['!'], time: 10 }), error => error.code === 'VCD_BUSY');
    await Promise.all(queries);
});

test('语义相同的短向量/填充位和 real 表示不创建伪边沿，0 扩展与 X 扩展保持区别', () => {
    const declaration = '$var wire 8 ! bus $end $var real 1 % real_value $end $enddefinitions $end ';
    const { store, metadata } = storeFrom(declaration + 'b0 ! r25.0 % #1 b00000000 ! r25.000 % #2 b1 ! #3 b00000001 ! #4 bx ! #5 bxxxxxxxx ! #6 b0x !');
    assert.equal(metadata.vars[0].changeCount, 4);
    assert.equal(metadata.vars[1].changeCount, 1);
    assert.deepEqual(store.edge({ id: '!', time: 0, direction: 'next' }), { time: 2, value: '1' });
    assert.deepEqual(store.edge({ id: '!', time: 4, direction: 'next' }), { time: 6, value: '0x' });
});

test('VCD 索引/数组 bit-dump 路径唯一，向量范围保留字段且不改变原 name/path', () => {
    const source = '$scope module tb $end ' +
        '$var wire 1 ! foo [7] $end $var wire 1 " foo [6] $end $var wire 1 ! copy [ 7 ] $end ' +
        '$var wire 8 # bus [15 : 8] $end $var wire 8 % array[3] [7:0] $end $var wire 8 & array [4] [7:0] $end ' +
        '$var wire 1 ( array[3] [7] $end $var wire 1 ) same_bit [7:7] $end ' +
        '$scope module dut $end $var wire 1 ! foo [7] $end $upscope $end $upscope $end $enddefinitions $end ' +
        '0! 1" b10101010 # b1 % b0 & 1( 0) #10 1!';
    const { metadata, store } = storeFrom(source);
    assert.deepEqual(metadata.vars.map(variable => [variable.name, variable.path, variable.range]), [
        ['foo[7]', 'tb.foo[7]', undefined], ['foo[6]', 'tb.foo[6]', undefined], ['copy[7]', 'tb.copy[7]', undefined],
        ['bus', 'tb.bus', '[15:8]'], ['array[3]', 'tb.array[3]', '[7:0]'], ['array[4]', 'tb.array[4]', '[7:0]'],
        ['array[3][7]', 'tb.array[3][7]', undefined], ['same_bit[7]', 'tb.same_bit[7]', undefined], ['foo[7]', 'tb.dut.foo[7]', undefined]
    ]);
    assert.equal(new Set(metadata.vars.map(variable => variable.path)).size, metadata.vars.length);
    assert.deepEqual(metadata.vars.filter(variable => variable.id === '!').map(variable => variable.changeCount), [2, 2, 2]);
    assert.equal(store.signals.size, 7);
    assert.deepEqual(store.values({ ids: ['!', '"'], time: 0 }).values, Object.assign(Object.create(null), { '!': '0', '"': '1' }));
    const tree = buildSignalTree(metadata);
    assert.equal(tree.children[0].children.find(variable => variable.name === 'bus').range, '[15:8]');
});

test('worker 元数据保留 range 和不同 bit 路径，alias 查询仍共享 id 数据', async t => {
    const source = '$var wire 1 ! bits [7] $end $var wire 1 " bits [6] $end $var wire 1 ! alias [7] $end ' +
        '$var wire 8 # vector [7:0] $end $enddefinitions $end 0! 1" b101 # #10 1!';
    const filePath = await fixture(t, source);
    const session = new VcdSession({ readBufferBytes: 3 });
    t.after(() => session.dispose());
    const metadata = await session.open(filePath);
    assert.deepEqual(metadata.vars.map(variable => variable.path), ['bits[7]', 'bits[6]', 'alias[7]', 'vector']);
    assert.equal(metadata.vars[3].range, '[7:0]');
    assert.deepEqual(metadata.vars.slice(0, 3).map(variable => variable.changeCount), [2, 1, 2]);
    assert.deepEqual(await session.values({ ids: ['!', '"'], time: 0 }), { values: { '!': '0', '"': '1' } });
});

test('一位 packed 切片保留原引用事实，数组地址与显示名称分离', () => {
    const metadata = parseVcd('$var wire 1 ! bus [3:3] $end $var reg 1 # mem[2] [0:0] $end $enddefinitions $end');
    assert.equal(metadata.vars[0].name, 'bus[3]'); assert.equal(metadata.vars[0].referenceName, 'bus');
    assert.equal(metadata.vars[1].name, 'mem[2][0]'); assert.equal(metadata.vars[1].referenceName, 'mem[2]');
    for (const suffix of ['[3:3][2:2]', '[3:3][2]']) assert.throws(() =>
        parseVcd('$var wire 1 ! bus ' + suffix + ' $end $enddefinitions $end'), error => error.code === 'VCD_PARSE');
});

for (const suffix of ['[15:0]', '[7:0]garbage', '[9007199254740993]']) {
    test('非法 range/index 不被忽略：' + suffix, () => {
        assert.throws(() => parseVcd('$var wire 8 ! bus ' + suffix + ' $end $enddefinitions $end'),
            error => error.code === 'VCD_PARSE' && error.line === 1);
    });
}

test('alias 位宽不一致的存储错误带 VCD 源码位置', () => {
    assert.throws(() => storeFrom('$var wire 1 ! bit $end $var wire 8 ! bus [7:0] $end $enddefinitions $end'),
        error => error.code === 'VCD_PARSE' && error.line === 1 && /alias/.test(error.message));
});

test('window/values/edge 超预算均在解码大值之前拒绝，累计信号响应也有界', () => {
    const store = new VcdStore({ maxResponseBytes: 256 });
    store.register({ id: '!', name: 'bus', path: 'bus', width: 512 });
    store.add('!', 1, '0'.repeat(511) + '1');
    let decoded = 0;
    store.valuesPool.get = () => { decoded++; throw new Error('不应解码超预算值'); };
    for (const query of [
        () => store.window({ ids: ['!'], start: 1, end: 2, pixels: 1 }),
        () => store.values({ ids: ['!'], time: 1 }),
        () => store.edge({ id: '!', time: 0, direction: 'next' })
    ]) assert.throws(query, error => error.code === 'VCD_RESOURCE_LIMIT');
    assert.equal(decoded, 0);
    const small = new VcdStore({ maxResponseBytes: 512 });
    for (const id of ['a', 'b', 'c']) { small.register({ id, name: id, path: id, width: 64 }); small.add(id, 0, '01'.repeat(32)); }
    assert.throws(() => small.values({ ids: ['a', 'b', 'c'], time: 0 }), error => error.code === 'VCD_RESOURCE_LIMIT');
});

test('接近 16 MiB 的单个 raw bus 不能绕过默认 32 MiB 预算', () => {
    const { DEFAULT_LIMITS } = require('../src/waveform/parser');
    const width = DEFAULT_LIMITS.maxSignalWidth;
    const store = new VcdStore();
    store.register({ id: 'wide', name: 'wide', path: 'wide', width });
    store.add('wide', 0, '0'.repeat(width - 1) + '1');
    let decoded = 0;
    store.valuesPool.get = () => { decoded++; throw new Error('不应创建超预算的 raw 值'); };
    for (const query of [
        () => store.values({ ids: ['wide'], time: 0 }),
        () => store.edge({ id: 'wide', time: 1, direction: 'previous' }),
        () => store.window({ ids: ['wide'], start: 0, end: 0, pixels: 1 })
    ]) assert.throws(query, error => error.code === 'VCD_RESOURCE_LIMIT');
    assert.equal(decoded, 0);
});

test('声明位宽、token/header/reference/解析器配置超过安全上限时给出资源诊断', () => {
    const { DEFAULT_LIMITS } = require('../src/waveform/parser');
    assert.throws(() => parseVcd('$var wire ' + (DEFAULT_LIMITS.maxSignalWidth + 1) + ' ! bus $end'),
        error => error.code === 'VCD_RESOURCE_LIMIT' && error.line === 1 && /位宽/.test(error.message));
    assert.throws(() => createVcdParser({ limits: { maxTokenLength: DEFAULT_LIMITS.maxTokenLength + 1 } }),
        error => error.code === 'VCD_RESOURCE_LIMIT' && /maxTokenLength/.test(error.message));
    assert.throws(() => createVcdParser({ limits: { maxHeaderLength: 0 } }), error => error.code === 'VCD_RESOURCE_LIMIT');
    for (const [limits, source] of [
        [{ maxTokenLength: 16 }, '$comment ' + 'x'.repeat(17) + ' $end'],
        [{ maxHeaderLength: 6 }, '$comment aaa bbb $end'],
        [{ maxReferenceLength: 8 }, '$var wire 1 ! long_name_here $end'],
        [{ maxSignalWidth: 8 }, '$var wire 9 ! bus $end'],
        [{ maxScopeDepth: 1 }, '$scope module a $end $scope module b $end']
    ]) {
        const parser = createVcdParser({ limits });
        assert.throws(() => { parser.write(source); parser.finish(); }, error => error.code === 'VCD_RESOURCE_LIMIT' && error.line > 0);
    }
});
