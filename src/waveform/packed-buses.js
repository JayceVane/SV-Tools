'use strict';

/** 依RTL范围恢复逐位总线；边界、方向、空洞或重名无法确认时保留原声明。 */
function restorePackedBuses(vars, store) {
    const groups = new Map();
    for (const signal of vars) if (signal.packedBit) {
        const key = JSON.stringify([signal.scopePath, signal.packedBit.name]);
        if (!groups.has(key)) groups.set(key, []); groups.get(key).push(signal);
    }
    const replaced = new Map(), removed = new Set();
    const paths = new Set(vars.map(signal => signal.path));
    for (const declarations of groups.values()) {
        const unique = new Map(); let conflict = false;
        const bounds = declarations[0].packedBit.bounds;
        if (!bounds) continue;
        for (const bit of declarations) {
            if (bit.packedBit.bounds?.left !== bounds.left || bit.packedBit.bounds?.right !== bounds.right
                || !Number.isSafeInteger(bit.packedBit.index)) { conflict = true; break; }
            const previous = unique.get(bit.packedBit.index);
            if (previous && previous.id !== bit.id) conflict = true;
            if (!previous) unique.set(bit.packedBit.index, bit);
        }
        const bits = [...unique.values()];
        if (conflict || bits.length < 2 || bits.length > 65536) continue;
        bits.sort((a, b) => a.packedBit.index - b.packedBit.index);
        const indices = bits.map(signal => signal.packedBit.index), min = indices[0], max = indices.at(-1);
        if (indices.some((index, at) => at && index !== indices[at - 1] + 1)) continue;
        const leftKnown = Number.isSafeInteger(bounds.left), rightKnown = Number.isSafeInteger(bounds.right);
        let ascending;
        if (leftKnown && rightKnown) {
            if (min < Math.min(bounds.left, bounds.right) || max > Math.max(bounds.left, bounds.right) || bounds.left === bounds.right) continue;
            ascending = bounds.left < bounds.right;
        } else if (leftKnown && (bounds.left === min || bounds.left === max)) ascending = bounds.left === min;
        else if (rightKnown && (bounds.right === min || bounds.right === max)) ascending = bounds.right === max;
        else continue;
        if (!ascending) bits.reverse();
        const first = declarations[0], name = first.packedBit.name, path = first.scopePath ? first.scopePath + '.' + name : name;
        if (paths.has(path)) continue;
        const id = store.compose(bits.map(signal => signal.id));
        // 合成结果是「总线」，不再是某条成员向量的位切片：必须清掉 packedBit 与
        // packedSource，否则后端会把合成值当成单条向量的位投影去取
        // （Rust 后端实测会因为走位切片分支而返回 null）。
        replaced.set(first, { ...first, id, name, path, width: bits.length,
            range: '[' + bits[0].packedBit.index + ':' + bits.at(-1).packedBit.index + ']',
            packedBit: undefined, packedSource: undefined, bitPaths: bits.map(signal => signal.path) });
        declarations.filter(signal => signal !== first).forEach(signal => removed.add(signal));
    }
    return vars.filter(signal => !removed.has(signal)).map(signal => replaced.get(signal) || signal);
}
module.exports = { restorePackedBuses };
