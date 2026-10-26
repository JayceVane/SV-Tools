'use strict';
const MAX_LINK_BITS = 4096;
const cleanName = name => name.startsWith('\\') ? name.slice(1).trimEnd() : name;

/** @param {object} target 电路声明。 @param {object} wave VCD声明。 @returns {boolean} 只允许同向且处于原声明内部的已记录切片。 */
function compatibleRange(target, wave) {
    const lower = target.offset || 0, upper = lower + target.width - 1;
    return wave.width <= target.width && Math.min(wave.left, wave.right) >= lower && Math.max(wave.left, wave.right) <= upper
        && (wave.width === 1 || (wave.left < wave.right) === !!target.upto);
}
module.exports = { MAX_LINK_BITS, cleanName, compatibleRange };
