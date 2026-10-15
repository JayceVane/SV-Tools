'use strict';

const isLayout = code => code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a;

/**
 * @param {string} source 原始全文或选区。
 * @param {unknown} candidate 原生模块的输出。
 * @returns {boolean} 仅忽略空格、Tab、CR、LF，按UTF-16码元比较其余字符的值、数量和顺序。
 */
function preservesCharacters(source, candidate) {
    if (typeof candidate !== 'string') return false;
    let left = 0, right = 0;
    while (true) {
        while (left < source.length && isLayout(source.charCodeAt(left))) left++;
        while (right < candidate.length && isLayout(candidate.charCodeAt(right))) right++;
        if (left === source.length || right === candidate.length) return left === source.length && right === candidate.length;
        if (source.charCodeAt(left++) !== candidate.charCodeAt(right++)) return false;
    }
}

module.exports = { preservesCharacters };
