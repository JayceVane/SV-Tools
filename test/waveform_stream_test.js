'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVcdParser, parseVcd, buildSignalTree } = require('../src/waveform/parser');
const { VcdSession } = require('../src/waveform/session');

const header = '$date 中文日期 $end\r\n$version stream contract $end $timescale 10 ps $end\r\n' +
    '$scope module tb $end $var wire 1 ! clk $end $var wire 17 # bus [16:0] $end $var real 1 % temp $end\r\n' +
    '$scope module dut $end $var wire 1 ! clk_alias $end $upscope $end $upscope $end $enddefinitions $end\r\n';
const body = '$dumpvars 0! b1x0z # r-3.25 % $end #10 1! b10101010101010101 # r1.25e+3 % #20 $dumpall 0! $end';

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
    // real 值：Rust 后端（wellen）只保留 f64，VCD 原文排版 `1.25e+3` 不可恢复。
    // 数值语义必须一致；前端渲染路径全程走 Number()，显示无差异。
    const values = (await session.values({ ids: ['!', '#', '%'], time: 10 })).values;
    assert.equal(values['!'], '1');
    assert.equal(values['#'], '10101010101010101');
    assert.equal(Number(values['%']), 1250, 'real 值数值语义一致（原文排版为已知信息损失）');
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

// ── worker 的 changes / sample 路由与游标翻页 ─────────────────────────
//
// 这几个用例是删掉 VcdStore 白盒单测后的等价覆盖：改写前它们直接断言
// `store.changes(...)` / `store.sample(...)`，现在同样的语义必须由
// 「VcdSession → worker → Rust」这条真实链路保证。

/** 时钟每 10 tick 翻转、总线每 10 tick 递增的夹具。 */
const pagedHeader = '$scope module tb $end $var wire 1 ! clk $end $var wire 8 # bus [7:0] $end $upscope $end $enddefinitions $end\n';
const pagedBody = 'b0 # 0!\n#10 1!\nb1 #\n#20 0!\nb10 #\n#30 1!\nb11 #\n#40 0!\nb100 #\n';

test('changes 路由：total 为窗口全数，分页游标不重不漏，边界与非法窗口明确拒绝', async t => {
    const filePath = await fixture(t, pagedHeader + pagedBody);
    const session = new VcdSession();
    t.after(() => session.dispose());
    const metadata = await session.open(filePath);
    const busId = metadata.vars.find(variable => variable.name === 'bus').id;

    const page1 = await session.changes({ ids: [busId], from: -1, to: 40, limit: 2 });
    assert.equal(page1.series[0].total, 5, 'total 是该信号在窗口内的全部事件数，不受 limit 影响');
    assert.deepEqual(page1.series[0].events.map(event => event.t), [0, 10]);
    assert.notEqual(page1.series[0].next, null, '还有剩余事件时必须给游标');

    // 按游标续查直到取齐：next 是内部左开游标（最后一条已返回的事件），直接回传即可。
    const collected = [...page1.series[0].events.map(event => event.t)];
    let cursor = page1.series[0].next;
    for (let guard = 0; cursor !== null && guard < 10; guard++) {
        const page = await session.changes({ ids: [busId], from: cursor, to: 40, limit: 2 });
        collected.push(...page.series[0].events.map(event => event.t));
        cursor = page.series[0].next;
    }
    assert.deepEqual(collected, [0, 10, 20, 30, 40], '翻页必须覆盖全部事件且不重复');

    // 左开下界：from=10 不重复 t=10 的事件；limit 截断后 total 仍是窗口全数。
    const tail = await session.changes({ ids: [busId], from: 10, to: 40, limit: 1 });
    assert.equal(tail.series[0].total, 3);
    assert.deepEqual(tail.series[0].events.map(event => event.t), [20]);
    // 未知信号必须显式报错（静默过滤会让 series 与 ids 下标错位）。
    await assert.rejects(session.changes({ ids: ['missing'], from: -1, to: 40 }),
        error => error.code === 'SIGNAL_NOT_FOUND');

    await assert.rejects(session.changes({ ids: [busId], from: 40, to: 40, limit: 1 }), /from/);
});

test('sample 路由：rise/fall/both 沿、X/Z 不构成沿、时钟校验与游标分页', async t => {
    const filePath = await fixture(t, pagedHeader + pagedBody);
    const session = new VcdSession();
    t.after(() => session.dispose());
    const metadata = await session.open(filePath);
    const clockId = metadata.vars.find(variable => variable.name === 'clk').id;
    const busId = metadata.vars.find(variable => variable.name === 'bus').id;

    const rising = await session.sample({ clock: clockId, edge: 'rise', ids: [busId], from: -1, to: 40 });
    assert.deepEqual(rising.samples.map(sample => sample.t), [10, 30]);
    assert.equal(rising.next, null);

    const falling = await session.sample({ clock: clockId, edge: 'fall', ids: [busId], from: -1, to: 40 });
    assert.deepEqual(falling.samples.map(sample => sample.t), [20, 40]);

    // limit 截断：worker 返回的 next 是内部左开游标（最后一条已返回的沿），
    // 直接回传即可续查，且下一轮必须包含紧随其后的沿。
    const page1 = await session.sample({ clock: clockId, edge: 'both', ids: [busId], from: -1, to: 40, limit: 2 });
    assert.deepEqual(page1.samples.map(sample => sample.t), [10, 20]);
    assert.equal(page1.next, 20, 'next 是最后一条已返回的沿时刻');
    const page2 = await session.sample({ clock: clockId, edge: 'both', ids: [busId], from: page1.next, to: 40, limit: 2 });
    assert.deepEqual(page2.samples.map(sample => sample.t), [30, 40], '续查必须取到后续全部沿');
    assert.equal(page2.next, null);

    // 时钟经过 X 不构成沿：0 → x → 1 没有任何 rise/fall。
    const glitchPath = await fixture(t, '$scope module tb $end $var wire 1 ! clk $end $var wire 8 # bus [7:0] $end $upscope $end $enddefinitions $end\n0!\nb0 #\n#10 x!\n#20 1!\nb1 #\n#30 z!\n#40 0!\nb10 #\n');
    const glitch = new VcdSession();
    t.after(() => glitch.dispose());
    const glitchMeta = await glitch.open(glitchPath);
    const glitchClock = glitchMeta.vars.find(variable => variable.name === 'clk').id;
    const glitchBus = glitchMeta.vars.find(variable => variable.name === 'bus').id;
    const edges = await glitch.sample({ clock: glitchClock, edge: 'both', ids: [glitchBus], from: -1, to: 40 });
    assert.deepEqual(edges.samples.map(sample => sample.t), [], 'X/Z 不构成任何沿');

    await assert.rejects(session.sample({ clock: 'missing', ids: [busId], to: 40 }), /信号不存在/);
    await assert.rejects(session.sample({ clock: busId, ids: [busId], to: 40 }), /1 位标量/);
});

test('window 路由：每像素只传真实首末事件，dense 显式计数，查询预算超限拒绝', async t => {
    let source = '$scope module tb $end $var wire 1 ! clk $end $upscope $end $enddefinitions $end\n';
    for (let time = 0; time < 1000; time++) source += '#' + time + '\n' + (time % 2) + '!\n';
    const filePath = await fixture(t, source);
    const session = new VcdSession();
    t.after(() => session.dispose());
    const metadata = await session.open(filePath);
    const clockId = metadata.vars[0].id;
    const series = (await session.window({ ids: [clockId], start: 0, end: 999, pixels: 10 })).series[0];
    assert.ok(series.changes.length <= 21, '每桶最多首末两条，不能让稠密信号全量穿过线程边界');
    assert.equal(series.dense.length, 10, '每个桶都应标记为密集');
    assert.equal(series.dense.reduce((sum, bucket) => sum + bucket.count, 0), 999, 'dense 计数之和等于折叠掉的事件数');
    // 同一信号的精确查询不受降采样影响。
    assert.equal((await session.values({ ids: [clockId], time: 555 })).values[clockId], '1');
    assert.deepEqual(await session.edge({ id: clockId, time: 555, direction: 'next' }), { time: 556, value: '0' });
    await assert.rejects(session.window({ ids: [clockId], start: 3, end: 2, pixels: 10 }), /视窗/);
    await assert.rejects(session.window({ ids: [clockId], start: 0, end: 2, pixels: 10000 }), /像素/);
});
