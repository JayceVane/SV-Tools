'use strict';
const { tokenize, matchDelimiters, splitTopLevel } = require('../editor/completion/syntax');
const MAX_WIDTH = 4096;
const PRECEDENCE = new Map([
    ['||', 1], ['&&', 2], ['|', 3], ['^', 4], ['&', 5], ['==', 6], ['!=', 6], ['===', 6], ['!==', 6],
    ['<', 7], ['<=', 7], ['>', 7], ['>=', 7], ['<<', 8], ['>>', 8], ['+', 9], ['-', 9], ['*', 10], ['/', 10], ['%', 10], ['**', 11]
]);
const lexical = text => tokenize(text).filter(token => !['comment', 'define'].includes(token.kind));
function literal(value) {
    if (value.length > 4096) {
        return undefined;
    }
    const clean = value.replace(/_/g, '').replace(/\s/g, '');
    if (/^'[01]$/.test(clean)) {
        return Number(clean[1]);
    }
    if (/^\d+$/.test(clean)) {
        const result=Number(clean);
        return Number.isSafeInteger(result)?result:undefined;
    }
    const match = /^(\d*)'([sS]?)([bBoOdDhH])([0-9a-fA-F]+)$/.exec(clean);
    if (!match) {
        return undefined;
    }
    const radix = { b: 2, o: 8, d: 10, h: 16 }[match[3].toLowerCase()];
    if ([...match[4]].some(character => parseInt(character, 16) >= radix)) {
        return undefined;
    }
    let result = parseInt(match[4], radix);
    const width = match[1] ? Number(match[1]) : 32;
    if (width < 1 || width > 52 || !Number.isSafeInteger(result)) {
        return undefined;
    }
    result %= 2 ** width;
    if (match[2] && result >= 2 ** (width - 1)) {
        result -= 2 ** width;
    }
    return result;
}
function binary(operator, left, right) {
    if (left === undefined || right === undefined) {
        return undefined;
    }
    if (['==', '===', '!=', '!=='].includes(operator)) {
        return Number(operator.startsWith('!') ? left !== right : left === right);
    }
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
        return undefined;
    }
    const operations = {
        '+': () => left + right, '-': () => left - right, '*': () => left * right, '/': () => right ? Math.trunc(left / right) : undefined, '%': () => right ? left % right : undefined,
        '**': () => Math.abs(right) <= 31 ? left ** right : undefined,
        '<<': () => right >= 0 && right <= 52 ? Number(BigInt(left) << BigInt(right)) : undefined,
        '>>': () => right >= 0 && right <= 52 ? Number(BigInt(left) >> BigInt(right)) : undefined,
        '&': () => Number(BigInt(left) & BigInt(right)), '|': () => Number(BigInt(left) | BigInt(right)), '^': () => Number(BigInt(left) ^ BigInt(right)),
        '<': () => Number(left < right), '<=': () => Number(left <= right), '>': () => Number(left > right), '>=': () => Number(left >= right),
        '&&': () => Number(!!left && !!right), '||': () => Number(!!left || !!right)
    };
    const result = operations[operator]?.();
    return Number.isSafeInteger(result) ? result : undefined;
}
/** @param {string|object[]} expression 常量表达式。 @param {Map} values 已知参数。 @returns {number|string|undefined} 只解析受支持的整数/字符串，不执行JS或宏。 */
function constantValue(expression, values = new Map()) {
    const tokens = typeof expression === 'string' ? lexical(expression) : expression;
    if (tokens.length > 512) {
        return undefined;
    }
    let cursor = 0, depth = 0;
    function primary() {
        if (++depth > 64) {
            return undefined;
        }
        const token = tokens[cursor++];
        let result;
        if (!token) {
            result = undefined;
        }
        else if (token.value === '(') {
            result = parse(0);
            if (tokens[cursor++]?.value !== ')') {
                result = undefined;
            }
        }
        else if (['+', '-', '!', '~'].includes(token.value)) {
            const value = primary();
            if (typeof value === 'number') {
                result = token.value === '+' ? value : token.value === '-' ? -value : token.value === '!' ? Number(!value) : Number(~BigInt(value));
            }
        }
        else if (token.kind === 'number') {
            result = literal(token.value);
        }
        else if (token.kind === 'string' && token.value.length<=4096 && /^"[^"\\]*"$/.test(token.value)) {
            result = token.value.slice(1, -1);
        }
        else if (token.value === '$clog2' && tokens[cursor++]?.value === '(') {
            const value = parse(0);
            if (tokens[cursor++]?.value === ')' && typeof value === 'number' && value >= 0) {
                result = value <= 1 ? 0 : Math.ceil(Math.log2(value));
            }
        }
        else if (token.kind === 'identifier') {
            result = values.get(token.value);
        }
        depth--;
        return result;
    }
    function parse(minimum) {
        let left = primary();
        while (PRECEDENCE.has(tokens[cursor]?.value) && PRECEDENCE.get(tokens[cursor].value) >= minimum) {
            const operator = tokens[cursor++].value, precedence = PRECEDENCE.get(operator);
            left = binary(operator, left, parse(precedence + (operator === '**' ? 0 : 1)));
        }
        if (minimum === 0 && tokens[cursor]?.value === '?') {
            cursor++;
            const yes = parse(0);
            if (tokens[cursor++]?.value !== ':') {
                return undefined;
            }
            const no = parse(0);
            left = left === undefined ? undefined : left ? yes : no;
        }
        return left;
    }
    const result = parse(0);
    return cursor === tokens.length && (typeof result === 'string' || Number.isSafeInteger(result)) ? result : undefined;
}
function numberBits(token, expectedWidth) {
    if (token.value.length > 4096) {
        return null;
    }
    const clean = token.value.replace(/[_\s]/g, '');
    if (/^'[01xXzZ]$/.test(clean)) {
        return Array(expectedWidth || 1).fill('c:' + clean[1].toLowerCase());
    }
    const match = /^(\d+)'[sS]?([bBoOdDhH])([0-9a-fA-FxXzZ?]+)$/.exec(clean);
    if (match) {
        const width = Number(match[1]);
        if (width < 1 || width > MAX_WIDTH) {
            return null;
        }
        const radix = { b: 2, o: 8, d: 10, h: 16 }[match[2].toLowerCase()];
        if (/[xz?]/i.test(match[3])) {
            if (radix === 10) {
                return null;
            }
            const digits = radix === 2 ? 1 : radix === 8 ? 3 : 4, bits = [];
            for (const character of [...match[3]].reverse()) {
                if (/[xz?]/i.test(character)) {
                    bits.push(...Array(digits).fill('c:' + (character === '?' ? 'z' : character.toLowerCase())));
                }
                else {
                    const value = parseInt(character, radix);
                    if (!Number.isFinite(value)) {
                        return null;
                    }
                    for (let index = 0; index < digits; index++)
                        bits.push('c:' + ((value >> index) & 1));
                }
            }
            return Array.from({ length: width }, (_, index) => bits[index] || 'c:0');
        }
        try {
            const prefixes = { 2: '0b', 8: '0o', 10: '', 16: '0x' }, value = BigInt(prefixes[radix] + match[3]);
            return Array.from({ length: width }, (_, index) => 'c:' + Number((value >> BigInt(index)) & 1n));
        }
        catch {
            return null;
        }
    }
    if (/^\d+$/.test(clean)) {
        const value = BigInt(clean), width = expectedWidth || 32;
        return Array.from({ length: width }, (_, index) => 'c:' + Number((value >> BigInt(index)) & 1n));
    }
    return null;
}
/**
 * 解析直接网络表达式，输出LSB-first位；运算、动态下标和越界返回null。
 * @param {object[]} tokens 词法token。 @param {Map} signals 声明位向量。 @param {Map} values 参数。 @param {number} [expectedWidth]
 * @returns {string[]|null} 拒绝猜测截断、符号扩展或不确定连接。
 */
function connectionBits(tokens, signals, values, expectedWidth, depth = 0) {
    if (!tokens.length || depth > 32 || tokens.length > 16384) {
        return null;
    }
    const pairs = matchDelimiters(tokens);
    if (tokens[0].value === '(' && pairs.get(0) === tokens.length - 1) {
        return connectionBits(tokens.slice(1, -1), signals, values, expectedWidth, depth + 1);
    }
    if (tokens[0].value === '{' && pairs.get(0) === tokens.length - 1) {
        const content = tokens.slice(1, -1), nested = content.findIndex(token => token.value === '{');
        if (nested > 0 && matchDelimiters(content).get(nested) === content.length - 1 && !content.slice(0, nested).some(token => token.value === ',')) {
            const count = constantValue(content.slice(0, nested), values), bits = connectionBits(content.slice(nested), signals, values, undefined, depth + 1);
            if (!Number.isSafeInteger(count) || count < 1 || !bits || count * bits.length > MAX_WIDTH) {
                return null;
            }
            return Array.from({ length: count }, () => bits).flat();
        }
        const groups = splitTopLevel(content).map(group => connectionBits(group, signals, values, undefined, depth + 1));
        if (groups.some(group => !group) || groups.reduce((count, group) => count + group.length, 0) > MAX_WIDTH) {
            return null;
        }
        return groups.reverse().flat();
    }
    if (tokens.length === 1 && tokens[0].kind === 'number') {
        return numberBits(tokens[0], expectedWidth);
    }
    const object = signals.get(tokens[0].value);
    if (!object || tokens[0].kind !== 'identifier') {
        return null;
    }
    if (tokens.length === 1) {
        return object.bits;
    }
    if (tokens[1]?.value !== '[' || pairs.get(1) !== tokens.length - 1) {
        return null;
    }
    const content = tokens.slice(2, -1), separator = content.findIndex(token => [':', '+:', '-:'].includes(token.value));
    const first = constantValue(separator < 0 ? content : content.slice(0, separator), values);
    if (!Number.isSafeInteger(first)) {
        return null;
    }
    let left = first, right = first;
    if (separator >= 0) {
        const second = constantValue(content.slice(separator + 1), values);
        if (!Number.isSafeInteger(second)) {
            return null;
        }
        const operator = content[separator].value;
        if (operator === ':') {
            left = first;
            right = second;
            if (left !== right && (left < right) !== !!object.upto) {
                return null;
            }
        }
        else {
            if (second < 1 || second > MAX_WIDTH) {
                return null;
            }
            const low = operator === '+:' ? first : first - second + 1, high = operator === '+:' ? first + second - 1 : first;
            left = object.upto ? low : high;
            right = object.upto ? high : low;
        }
    }
    const width = Math.abs(left - right) + 1;
    if (width > MAX_WIDTH) {
        return null;
    }
    const result = [];
    for (let index = 0; index < width; index++) {
        const hdl = right + index * (left >= right ? 1 : -1), position = object.upto ? object.offset + object.bits.length - 1 - hdl : hdl - object.offset;
        if (!Number.isSafeInteger(position) || position < 0 || position >= object.bits.length) {
            return null;
        }
        result.push(object.bits[position]);
    }
    return result;
}
module.exports = { constantValue, connectionBits, lexical, MAX_WIDTH };
