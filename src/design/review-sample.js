'use strict';

const { binaryValue } = require('../waveform/model');

const MAX_EXPECTATION_WIDTH = 4096;
const decimalPattern = /^(?:0|[1-9]\d*|-[1-9]\d*)$/;

function validExpectedValue(encoding, value) {
    if (typeof value !== 'string') return false;
    if (encoding === 'bits') return value.length <= MAX_EXPECTATION_WIDTH && /^[01]+$/.test(value);
    return (encoding === 'unsigned' || encoding === 'signed') && value.length <= 128
        && decimalPattern.test(value) && (encoding !== 'unsigned' || !value.startsWith('-'));
}

function comparison(value, expectation) {
    if (value === undefined || value === null) return { status: 'missing' };
    const { width, bits, type } = value;
    if (!Number.isSafeInteger(width) || width < 1 || width > MAX_EXPECTATION_WIDTH
        || /^(real|realtime|string|event)$/i.test(type || '')) return { status: 'unavailable' };
    const input = binaryValue(bits, width);
    if (!input || input.length !== width) return { status: 'unavailable' };
    const { encoding, value: expected } = expectation;
    if (encoding === 'bits') {
        if (expected.length !== width) return { status: 'invalid' };
        if (/[xz]/.test(input)) return { status: 'unknown', actual: input.toUpperCase() };
        return { status: expected === input ? 'match' : 'mismatch', actual: input };
    }
    const number = BigInt(expected);
    const wrap = encoding === 'signed' ? BigInt.asIntN : BigInt.asUintN;
    if (wrap(width, number) !== number) return { status: 'invalid' };
    if (/[xz]/.test(input)) return { status: 'unknown' };
    const actual = wrap(width, BigInt('0b' + input));
    return { status: actual === number ? 'match' : 'mismatch', actual: String(actual) };
}

function compareReviewSample(values, bindings) {
    return bindings.map(({ signal, expected }) => ({
        signal, expected, ...comparison(values[signal], expected),
    }));
}

module.exports = { validExpectedValue, compareReviewSample };
