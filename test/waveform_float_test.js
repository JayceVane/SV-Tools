'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const values = require('../src/waveform/value-format');

const signal = width => ({ width, type: 'wire' });
const binary = (hex, width) => BigInt('0x' + hex).toString(2).padStart(width, '0');

/** 用平台 DataView 的 IEEE 解码验证位模式，不共享被测模块的尾数计算。 */
function expectNumber(actual, expected, message) {
    if (Number.isNaN(expected)) {
        assert.equal(actual.status, 'nan', message);
        assert.equal(Number.isNaN(actual.value), true, message);
    } else {
        assert.equal(actual.value, expected, message);
        assert.equal(Object.is(actual.value, -0), Object.is(expected, -0), message);
        assert.equal(actual.status, Number.isFinite(expected) ? expected === 0 ? 'zero' : 'finite' : 'infinity', message);
    }
}

test('浮点目录只有六种请求格式，并以声明宽度拒绝隐式截断和 real 位转换', () => {
    assert.deepEqual(values.FORMAT_OPTIONS.map(option => option.id), ['fp64', 'fp32', 'tf32', 'bf16', 'fp16', 'fp8e3m4']);
    assert.equal(values.formats, values.FORMAT_OPTIONS);
    assert.equal(Object.isFrozen(values.formats), true);
    for (const option of values.formats) {
        assert.equal(Object.isFrozen(option), true);
        assert.equal(Object.isFrozen(option.widths), true);
        assert.equal(values.isFloat(option.id), true);
        for (const width of option.widths) assert.equal(values.supports(signal(width), option.id), true);
        assert.equal(values.supports(signal(128), option.id), false);
        assert.equal(values.supports({ width: option.widths[0], type: 'real' }, option.id), false);
        assert.equal(values.supports({ width: option.widths[0], type: 'shortreal' }, option.id), false);
        assert.equal(values.supports({ width: String(option.widths[0]), type: 'wire' }, option.id), false);
    }
    assert.equal(values.isFloat('hex'), false);
    assert.equal(values.isFloat('fp8e3m4fn'), false);
    assert.equal(values.supports(undefined, 'fp64'), false);
    assert.equal(values.format('1', signal(32), 'fp64'), '位宽不匹配');
    assert.equal(values.format('1', { width: 32, type: 'real' }, 'fp32'), '非位向量');
});

test('独立已知编码验证六种浮点的正常数、非正规数和有限边界', () => {
    const vectors = [
        ['fp64', 64, '3ff0000000000000', 1, 'normal'],
        ['fp64', 64, 'c004000000000000', -2.5, 'normal'],
        ['fp64', 64, '0000000000000001', Number.MIN_VALUE, 'subnormal'],
        ['fp64', 64, '0010000000000000', 2 ** -1022, 'normal'],
        ['fp64', 64, '7fefffffffffffff', Number.MAX_VALUE, 'normal'],
        ['fp32', 32, '3f800000', 1, 'normal'],
        ['fp32', 32, 'c0200000', -2.5, 'normal'],
        ['fp32', 32, '00000001', 2 ** -149, 'subnormal'],
        ['fp32', 32, '00800000', 2 ** -126, 'normal'],
        ['fp32', 32, '7f7fffff', 3.4028234663852886e38, 'normal'],
        ['tf32', 19, '1fc00', 1, 'normal'],
        ['tf32', 19, '60100', -2.5, 'normal'],
        ['tf32', 19, '00001', 2 ** -136, 'subnormal'],
        ['tf32', 19, '00400', 2 ** -126, 'normal'],
        ['tf32', 19, '3fbff', 3.4011621342146535e38, 'normal'],
        ['bf16', 16, '3f80', 1, 'normal'],
        ['bf16', 16, 'c020', -2.5, 'normal'],
        ['bf16', 16, '0001', 2 ** -133, 'subnormal'],
        ['bf16', 16, '0080', 2 ** -126, 'normal'],
        ['bf16', 16, '7f7f', 3.3895313892515355e38, 'normal'],
        ['fp16', 16, '3c00', 1, 'normal'],
        ['fp16', 16, 'c100', -2.5, 'normal'],
        ['fp16', 16, '0001', 2 ** -24, 'subnormal'],
        ['fp16', 16, '0400', 2 ** -14, 'normal'],
        ['fp16', 16, '7bff', 65504, 'normal'],
        ['fp8e3m4', 8, '30', 1, 'normal'],
        ['fp8e3m4', 8, 'c4', -2.5, 'normal'],
        ['fp8e3m4', 8, '01', 1 / 64, 'subnormal'],
        ['fp8e3m4', 8, '10', 1 / 4, 'normal'],
        ['fp8e3m4', 8, '6f', 15.5, 'normal']
    ];
    for (const [id, width, hex, expected, classification] of vectors) {
        const actual = values.decode(binary(hex, width), signal(width), id);
        expectNumber(actual, expected, `${id}: 0x${hex}`);
        assert.equal(actual.classification, classification, `${id}: 0x${hex}`);
        assert.equal(values.format(binary(hex, width), signal(width), id), String(expected));
    }
});

test('FP64 符号、全部指数区间和伪随机 64 位模式与 DataView 一致', () => {
    const view = new DataView(new ArrayBuffer(8));
    let state = 0xcafef00d12345678n;
    const patterns = [0n, 1n, 0x8000000000000000n, 0x7ff0000000000000n,
        0xfff0000000000000n, 0x7ff0000000000001n, 0x7ff8000000000000n,
        0x000fffffffffffffn, 0x7fefffffffffffffn];
    for (let exponent = 0; exponent < 2048; exponent++) {
        patterns.push(BigInt(exponent) << 52n);
        patterns.push(0x8000000000000000n | BigInt(exponent) << 52n | 0x000fffffffffffffn);
    }
    for (let index = 0; index < 4096; index++) {
        state ^= state << 13n;
        state ^= state >> 7n;
        state ^= state << 17n;
        state = BigInt.asUintN(64, state);
        patterns.push(state);
    }
    for (const pattern of patterns) {
        view.setBigUint64(0, pattern);
        expectNumber(values.decode(pattern.toString(2), signal(64), 'fp64'), view.getFloat64(0), pattern.toString(16));
    }
});

test('FP32 全部指数区间及伪随机 32 位模式与 DataView 一致', () => {
    const view = new DataView(new ArrayBuffer(4));
    let state = 0x12345678;
    for (let index = 0; index < 32768; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        view.setUint32(0, state);
        expectNumber(values.decode(state.toString(2), signal(32), 'fp32'), view.getFloat32(0), state.toString(16));
    }
    for (let exponent = 0; exponent < 256; exponent++) {
        const pattern = ((exponent << 23) | 0x80000000 | 0x007fffff) >>> 0;
        view.setUint32(0, pattern);
        expectNumber(values.decode(pattern.toString(2), signal(32), 'fp32'), view.getFloat32(0));
    }
});

/** 将 half 的位域精确提升到 binary32，再由平台解码，兼容没有 getFloat16 的运行时。 */
function referenceFloat16(pattern, view) {
    const sign = (pattern & 0x8000) << 16;
    let exponent = (pattern >>> 10) & 0x1f;
    let fraction = pattern & 0x3ff;
    if (exponent === 0 && fraction !== 0) {
        exponent = 113;
        while ((fraction & 0x400) === 0) { fraction <<= 1; exponent--; }
        fraction &= 0x3ff;
    } else if (exponent === 31) exponent = 255;
    else if (exponent !== 0) exponent += 112;
    view.setUint32(0, (sign | (exponent << 23) | (fraction << 13)) >>> 0);
    return view.getFloat32(0);
}

test('FP16 全部 65536 个编码与精确提升后的平台 Float32 解码一致', () => {
    const view = new DataView(new ArrayBuffer(4));
    const half = new DataView(new ArrayBuffer(2));
    for (let pattern = 0; pattern <= 0xffff; pattern++) {
        const expected = referenceFloat16(pattern, view);
        if (typeof half.getFloat16 === 'function') {
            half.setUint16(0, pattern);
            assert.equal(expected, half.getFloat16(0), pattern.toString(16));
        }
        expectNumber(values.decode(pattern.toString(2), signal(16), 'fp16'), expected, pattern.toString(16));
    }
});

test('BF16 全部 65536 个编码与左对齐 Float32 位模式一致', () => {
    const view = new DataView(new ArrayBuffer(4));
    for (let pattern = 0; pattern <= 0xffff; pattern++) {
        view.setUint32(0, (pattern << 16) >>> 0);
        expectNumber(values.decode(pattern.toString(2), signal(16), 'bf16'), view.getFloat32(0), pattern.toString(16));
    }
});

test('TF32 的 19 位与零填充 32 位布局相同，不允许将任意 FP32 静默截断', () => {
    const view = new DataView(new ArrayBuffer(4));
    let state = 0x20304;
    const patterns = [0, 1, 0x40000, 0x3fc00, 0x7fc00, 0x3fc01, 0x3fe00, 0x3fbff];
    for (let index = 0; index < 8192; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) & 0x7ffff;
        patterns.push(state);
    }
    for (const pattern of patterns) {
        const container = (pattern << 13) >>> 0;
        view.setUint32(0, container);
        const expected = view.getFloat32(0);
        expectNumber(values.decode(pattern.toString(2), signal(19), 'tf32'), expected);
        expectNumber(values.decode(container.toString(2), signal(32), 'tf32'), expected);
    }
    assert.equal(values.format(binary('3f800001', 32), signal(32), 'tf32'), '非规范 TF32');
    assert.equal(values.decode(binary('3f800001', 32), signal(32), 'tf32').status, 'invalid');
    assert.equal(values.format('0'.repeat(31) + 'x', signal(32), 'tf32'), 'X');
    assert.equal(values.format('0'.repeat(31) + 'z', signal(32), 'tf32'), 'Z');
});

test('FP8 E3M4 全部 256 编码匹配独立真值表，指数 111 保留 Inf/NaN', () => {
    const positive = [
        0, .015625, .03125, .046875, .0625, .078125, .09375, .109375,
        .125, .140625, .15625, .171875, .1875, .203125, .21875, .234375,
        .25, .265625, .28125, .296875, .3125, .328125, .34375, .359375,
        .375, .390625, .40625, .421875, .4375, .453125, .46875, .484375,
        .5, .53125, .5625, .59375, .625, .65625, .6875, .71875,
        .75, .78125, .8125, .84375, .875, .90625, .9375, .96875,
        1, 1.0625, 1.125, 1.1875, 1.25, 1.3125, 1.375, 1.4375,
        1.5, 1.5625, 1.625, 1.6875, 1.75, 1.8125, 1.875, 1.9375,
        2, 2.125, 2.25, 2.375, 2.5, 2.625, 2.75, 2.875,
        3, 3.125, 3.25, 3.375, 3.5, 3.625, 3.75, 3.875,
        4, 4.25, 4.5, 4.75, 5, 5.25, 5.5, 5.75,
        6, 6.25, 6.5, 6.75, 7, 7.25, 7.5, 7.75,
        8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5,
        12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5,
        Infinity, ...Array(15).fill(NaN)
    ];
    assert.equal(positive.length, 128);
    for (let pattern = 0; pattern <= 255; pattern++) {
        const expected = pattern < 128 ? positive[pattern] : -positive[pattern - 128];
        expectNumber(values.decode(pattern.toString(2), signal(8), 'fp8e3m4'), expected, pattern.toString(16));
    }
    assert.equal(values.format('1110000', signal(8), 'fp8e3m4'), '+Inf');
    assert.equal(values.format('1111111', signal(8), 'fp8e3m4'), 'NaN');
});

test('正负零、Inf、quiet/signaling NaN 与 X/Z 状态相互区分', () => {
    for (const option of values.formats) {
        const width = option.widths[0];
        const zero = '0'.repeat(width), negativeZero = '1' + zero.slice(1);
        const exponent = '1'.repeat(option.exponentBits);
        const infinity = '0' + exponent + '0'.repeat(option.fractionBits);
        const quiet = '0' + exponent + '1' + '0'.repeat(option.fractionBits - 1);
        const signaling = '0' + exponent + '0'.repeat(option.fractionBits - 1) + '1';
        assert.equal(values.format(zero, signal(width), option.id), '0');
        assert.equal(values.format(negativeZero, signal(width), option.id), '-0');
        assert.equal(Object.is(values.decode(negativeZero, signal(width), option.id).value, -0), true);
        assert.equal(values.format(infinity, signal(width), option.id), '+Inf');
        assert.equal(values.format('1' + infinity.slice(1), signal(width), option.id), '-Inf');
        assert.equal(values.decode(quiet, signal(width), option.id).classification, 'qNaN');
        assert.equal(values.decode(signaling, signal(width), option.id).classification, 'sNaN');
        assert.equal(values.format(quiet, signal(width), option.id), 'NaN');
        assert.equal(values.decode('x', signal(width), option.id).status, 'unknown');
        assert.equal(values.format('x', signal(width), option.id), 'X');
        assert.equal(values.format('z', signal(width), option.id), 'Z');
        assert.equal(values.format('xz', signal(width), option.id), 'X/Z');
    }
});

test('缩短 VCD 位串按零或首 X/Z 扩展，非法和超长输入不猜测数值', () => {
    assert.equal(values.decode('1', signal(16), 'fp16').value, 2 ** -24);
    assert.equal(values.decode('X01', signal(16), 'fp16').bits, 'x'.repeat(13) + 'x01');
    assert.equal(values.decode('Z01', signal(16), 'fp16').bits, 'z'.repeat(13) + 'z01');
    for (const input of ['', ' 1', 'b1', '102', '-1', '0x3c00', '1'.repeat(17), 'x'.repeat(100000), 1, {}, []]) {
        assert.equal(values.decode(input, signal(16), 'fp16').status, 'invalid');
    }
    assert.equal(values.format(null, signal(16), 'fp16'), '—');
    assert.equal(values.format(undefined, signal(16), 'fp16'), '—');
    assert.equal(values.decode('1', signal(16), 'unknown').status, 'unsupported');
    assert.equal(values.decode('1', { width: Infinity, type: 'wire' }, 'fp64').status, 'unsupported');
});

test('webview UMD 与 Node 共享同一纯格式模块', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(require.resolve('../src/waveform/value-format'), 'utf8'), context);
    assert.equal(context.WaveValueFormats.format(binary('3ff0000000000000', 64), signal(64), 'fp64'), '1');
    assert.equal(context.WaveValueFormats.supports(signal(19), 'tf32'), true);
    assert.equal(context.WaveValueFormats.formats.length, 6);
});
