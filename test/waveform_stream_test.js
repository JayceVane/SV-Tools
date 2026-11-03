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
