'use strict';

/** 仅合并RTL确认无unpacked维度的逐位声明；缺源码、空洞、冲突与乱序均不猜。 */
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
        for (const bit of declarations) {
            const previous = unique.get(bit.packedBit.index);
            if (previous && previous.id !== bit.id) conflict = true;
            if (!previous) unique.set(bit.packedBit.index, bit);
        }
        const bits = [...unique.values()];
        if (conflict) continue;
        if (bits.length < 2 || bits.length > 65536) continue;
        const indices = bits.map(signal => signal.packedBit.index), step = indices[1] - indices[0];
        if (Math.abs(step) !== 1 || indices.some((index, at) => at && index !== indices[at - 1] + step)) continue;
        const first = bits[0], name = first.packedBit.name, path = first.scopePath ? first.scopePath + '.' + name : name;
        if (paths.has(path)) continue;
        const id = store.compose(bits.map(signal => signal.id));
        replaced.set(first, { ...first, id, name, path, width: bits.length, range: '[' + indices[0] + ':' + indices.at(-1) + ']',
            packedBit: undefined, bitPaths: bits.map(signal => signal.path) });
        declarations.filter(signal => signal !== first).forEach(signal => removed.add(signal));
    }
    return vars.filter(signal => !removed.has(signal)).map(signal => replaced.get(signal) || signal);
}
module.exports = { restorePackedBuses };
