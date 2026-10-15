/* 浮点位模式只解释声明宽度，不将 VCD real 值重新按位转换。 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WaveValueFormats = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';

    const FORMAT_OPTIONS = Object.freeze([
        { id: 'fp64', label: 'FP64', widths: [64], exponentBits: 11, fractionBits: 52, bias: 1023 },
        { id: 'fp32', label: 'FP32', widths: [32], exponentBits: 8, fractionBits: 23, bias: 127 },
        { id: 'tf32', label: 'TF32', widths: [19, 32], exponentBits: 8, fractionBits: 10, bias: 127 },
        { id: 'bf16', label: 'BF16', widths: [16], exponentBits: 8, fractionBits: 7, bias: 127 },
        { id: 'fp16', label: 'FP16', widths: [16], exponentBits: 5, fractionBits: 10, bias: 15 },
        // E3M4 是本项目约定：偏置 3，全 1 指数表示 Inf/NaN，并非 IEEE 754 规定格式。
        { id: 'fp8e3m4', label: 'FP8 (E3M4)', widths: [8], exponentBits: 3, fractionBits: 4, bias: 3 }
    ].map(option => Object.freeze({ ...option, widths: Object.freeze(option.widths) })));
    const optionsById = new Map(FORMAT_OPTIONS.map(option => [option.id, option]));
    const MAX_INPUT_BITS = 64;
    const TF32_PADDING_BITS = 13;

    /** @param {string} id 格式 ID。@returns {boolean} 是否为受支持的浮点格式。 */
    function isFloat(id) {
        return optionsById.has(id);
    }

    /**
     * @param {{width:number,type?:string}} signal VCD 信号声明。
     * @param {string} id 格式 ID。
     * @returns {boolean} 声明宽度必须精确匹配；real/realtime/shortreal 不按位解释。
     */
    function supports(signal, id) {
        const option = optionsById.get(id);
        return !!(option && signal && !/real/i.test(signal.type || '')
            && Number.isInteger(signal.width) && option.widths.includes(signal.width));
    }

    /**
     * @typedef {Object} DecodedValue
     * @property {string} status finite/zero/infinity/nan/unknown/invalid/unavailable/unsupported。
     * @property {string} text 可直接显示的数值或明确失败原因。
     * @property {number} [value] 解码值；零保持符号，NaN 与 X/Z 分开。
     * @property {number} [sign] 1 或 -1。
     * @property {string} [classification] normal/subnormal/zero/infinity/qNaN/sNaN。
     * @property {string} [bits] 零扩展或 X/Z 扩展后的完整声明宽度位串。
     */

    /**
     * @param {string|null|undefined} value VCD 二进制位串，不包含 b 前缀。
     * @param {{width:number,type?:string}} signal VCD 信号声明。
     * @param {string} id 格式 ID。
     * @returns {DecodedValue} 纯解码；非法输入不抛异常，也不会截断多余位或猜测编码。
     */
    function decode(value, signal, id) {
        if (value === null || value === undefined) return { status: 'unavailable', text: '—' };
        const option = optionsById.get(id);
        if (!option) return { status: 'unsupported', text: '不支持的格式' };
        if (signal && /real/i.test(signal.type || '')) return { status: 'unsupported', text: '非位向量' };
        if (!supports(signal, id)) return { status: 'unsupported', text: '位宽不匹配' };
        // 先限制长度，防止把异常输入交给正则或 BigInt 进行无界处理。
        if (typeof value !== 'string' || !value.length || value.length > MAX_INPUT_BITS
            || value.length > signal.width || !/^[01xz]+$/i.test(value)) {
            return { status: 'invalid', text: '无效位值' };
        }
        const raw = value.toLowerCase();
        const bits = raw.padStart(signal.width, /^[xz]/.test(raw) ? raw[0] : '0');
        if (/[xz]/.test(bits)) {
            const hasX = bits.includes('x'), hasZ = bits.includes('z');
            return { status: 'unknown', text: hasX && hasZ ? 'X/Z' : hasX ? 'X' : 'Z', bits };
        }
        // 32 位 TF32 是显式 RTL 布局：S31 E30:23 M22:13，低 13 位必须为零。
        // 这不是 NVIDIA 定义的存储 ABI，不能将任意 FP32 静默截断成 TF32。
        if (id === 'tf32' && signal.width === 32 && /1/.test(bits.slice(-TF32_PADDING_BITS))) {
            return { status: 'invalid', text: '非规范 TF32', bits };
        }
        const payload = id === 'tf32' && signal.width === 32 ? bits.slice(0, -TF32_PADDING_BITS) : bits;
        const sign = payload[0] === '1' ? -1 : 1;
        const exponent = parseInt(payload.slice(1, 1 + option.exponentBits), 2);
        const fraction = BigInt('0b' + payload.slice(1 + option.exponentBits));
        const maximumExponent = 2 ** option.exponentBits - 1;
        if (exponent === maximumExponent) {
            if (fraction === 0n) {
                return { status: 'infinity', classification: 'infinity', value: sign * Infinity,
                    sign, bits, text: sign < 0 ? '-Inf' : '+Inf' };
            }
            const quietBit = 1n << BigInt(option.fractionBits - 1);
            return { status: 'nan', classification: fraction & quietBit ? 'qNaN' : 'sNaN',
                value: NaN, sign, bits, text: 'NaN' };
        }
        if (exponent === 0 && fraction === 0n) {
            return { status: 'zero', classification: 'zero', value: sign * 0, sign, bits,
                text: sign < 0 ? '-0' : '0' };
        }
        const significand = exponent === 0 ? fraction : (1n << BigInt(option.fractionBits)) + fraction;
        // significand 最多 53 位，转换为 Number 仍然精确；避免先转换整个 64 位编码。
        const power = (exponent || 1) - option.bias - option.fractionBits;
        const number = sign * Number(significand) * 2 ** power;
        return { status: 'finite', classification: exponent === 0 ? 'subnormal' : 'normal',
            value: number, sign, bits, text: String(number) };
    }

    /**
     * @param {string|null|undefined} value VCD 位串。
     * @param {{width:number,type?:string}} signal VCD 信号声明。
     * @param {string} id 浮点格式 ID。
     * @returns {string} 人类可读文本；保留负零、未知状态和非规范 TF32 提示。
     */
    function format(value, signal, id) {
        return decode(value, signal, id).text;
    }

    return { FORMAT_OPTIONS, formats: FORMAT_OPTIONS, isFloat, supports, decode, format };
});
