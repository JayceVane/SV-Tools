'use strict';
const M = require('../waveform/model');
const D = require('../waveform/signal-display');
const { MAX_LINK_BITS, cleanName, compatibleRange } = require('./bit-ranges');
const MAX_LINK_VARIABLES = 100000, MAX_SCOPE_COMPONENTS = 1000000;

/** @param {object} signal 原始VCD声明。 @returns {object} 声明范围；缺少总线范围时不猜测非零下标。 */
function waveDeclaration(signal) {
    if (!signal || /real|string|parameter/i.test(signal.type) || !Number.isSafeInteger(signal.width) || signal.width < 1) throw new Error('该VCD声明不是可关联的位信号');
    let name = cleanName(signal.name), left = 0, right = 0;
    const range = /^\[([+-]?\d+):([+-]?\d+)\]$/.exec(signal.range || '');
    if (range) { left = Number(range[1]); right = Number(range[2]); }
    else if (signal.referenceName) {
        const suffix = name.slice(cleanName(signal.referenceName).length), bit = /^\[([+-]?\d+)\]$/.exec(suffix);
        if (!bit) throw new Error('VCD位声明没有可验证的下标');
        name = cleanName(signal.referenceName); left = right = Number(bit[1]);
    } else if (signal.width > 1) throw new Error('VCD没有记录该总线的声明范围，无法验证位映射');
    if (![left,right].every(Number.isSafeInteger) || Math.abs(left - right) + 1 !== signal.width) throw new Error('VCD声明范围与位宽不一致');
    return { name, width: signal.width, left, right };
}

/** @param {object} metadata Worker元数据。 @returns {object} 有界索引；scope分段保留带点的转义标识符身份。 */
function createWaveCatalog(metadata) {
    if (!Array.isArray(metadata?.vars) || metadata.vars.length > MAX_LINK_VARIABLES || !Array.isArray(metadata.scopes) || metadata.scopes.length > MAX_LINK_VARIABLES) throw new Error('波形关联最多索引100000条声明和作用域，请选择较小的VCD');
    const scopes = metadata.scopes, paths = [], scopeKeys = new Map(), byScopedName = new Map(); let components = 0;
    for (const [id, scope] of scopes.entries()) {
        if (!Object.hasOwn(scope, 'parentId') || scope.parentId !== null && (!Number.isInteger(scope.parentId) || scope.parentId < 0 || scope.parentId >= id)) throw new Error('VCD缺少可验证的层级分段，请重新打开波形');
        const parts = [...(scope.parentId === null ? [] : paths[scope.parentId]), cleanName(scope.name)];
        if ((components += parts.length) > MAX_SCOPE_COMPONENTS) throw new Error('波形关联层级索引超过预算');
        paths.push(parts); const key = JSON.stringify(parts);
        if (!scopeKeys.has(key)) scopeKeys.set(key, []); scopeKeys.get(key).push(id);
    }
    const variables = M.prepareSignals(metadata.vars), byKey = new Map(variables.map(signal => [signal.key, signal]));
    for (const signal of variables) {
        if (signal.scopeId !== null && !paths[signal.scopeId]) throw new Error('VCD声明引用了未知作用域');
        let declaration; try { declaration = waveDeclaration(signal); } catch { continue; } // 不可验证声明仍可在原波形中查看。
        const key = JSON.stringify([signal.scopeId, declaration.name]);
        if (!byScopedName.has(key)) byScopedName.set(key, []);
        const list = byScopedName.get(key); if (!list.some(item => item.signal.key === signal.key)) list.push({ signal, declaration });
    }
    function select(key) {
        if (typeof key !== 'string' || key.length > 131072) throw new Error('波形行身份无效');
        let signal = byKey.get(key), parent = signal;
        if (!signal) {
            let tuple; try { tuple = JSON.parse(key); } catch { throw new Error('波形行已不存在'); }
            parent = Array.isArray(tuple) && tuple[0] === '$bit' && byKey.get(tuple[1]);
            if (!parent) throw new Error('波形行已不存在');
            const temporary = new Map([[parent.key, parent]]); D.restoreBits([key], temporary, D.MAX_TRACKS); signal = temporary.get(key);
        }
        if (!signal) throw new Error('波形位选择无效');
        const declaration = waveDeclaration(parent);
        if (!Number.isInteger(signal.bitOffset) && declaration.width > MAX_LINK_BITS) throw new Error('整条波形超过4096位，请选择逐位行再追踪');
        const indices = Number.isInteger(signal.bitOffset) ? [signal.bitIndex] : Array.from({ length: declaration.width }, (_, i) => declaration.right + i * (declaration.left >= declaration.right ? 1 : -1));
        return { signal, parent, declaration, indices, scope: parent.scopeId === null ? [] : paths[parent.scopeId] };
    }
    return { variables, byKey, paths, scopes, scopeKeys, byScopedName, select };
}

/** @param {object} target 经过电路Worker验证的声明和选定位。 @param {object} catalog VCD索引。 @param {number} rootId 人工确认的VCD根作用域。 @returns {object[]} 精确范围候选；不以相同VCD id合并不同声明。 */
function matchCircuitSignal(target, catalog, rootId) {
    const root = catalog.paths[rootId]; if (!root) throw new Error('VCD根层级已失效');
    if (!Array.isArray(target.indices) || !target.indices.length || target.indices.length > MAX_LINK_BITS) throw new Error('电路位选择应为1–4096位');
    const objectPath = target.nameParts || [cleanName(target.name)], scope = [...root, ...target.instanceNames.map(cleanName), ...objectPath.slice(0,-1)];
    const ids = catalog.scopeKeys.get(JSON.stringify(scope)) || [], result = [];
    for (const id of ids) for (const { signal, declaration } of catalog.byScopedName.get(JSON.stringify([id,objectPath.at(-1)])) || []) {
        if (!compatibleRange(target, declaration)) continue;
        const offsets = [...new Set(target.indices.map(index => (index - declaration.right) * (declaration.left >= declaration.right ? 1 : -1)))];
        if (offsets.some(offset => !Number.isInteger(offset) || offset < 0 || offset >= signal.width)) continue;
        const keys = offsets.length === signal.width ? [signal.key] : offsets.sort((a,b)=>b-a).map(offset => JSON.stringify(['$bit',signal.key,offset]));
        if (keys.length > D.MAX_TRACKS) throw new Error('切片需要超过2000条逐位波形，请缩小位选择');
        result.push({ key: signal.key, keys, path: signal.path, range: signal.range || '', width: signal.width, indices: [...target.indices] });
        if (result.length >= 256) throw new Error('同名波形候选超过256项，请缩小设计');
    }
    return result;
}

/** @param {object} selected 可信VCD声明。 @param {object} catalog 索引。 @param {number} rootId 根作用域。 @returns {object} 发送给电路Worker的声明请求，不包含文件路径。 */
function waveCircuitRequest(selected, catalog, rootId) {
    const root = catalog.paths[rootId];
    if (!root || root.some((name,i)=>selected.scope[i] !== name)) throw new Error('所选波形不在已确认的DUT根层级下，请重新关联');
    return { scopes: selected.scope.slice(root.length), ...selected.declaration, indices: selected.indices };
}
module.exports = { MAX_LINK_VARIABLES, MAX_LINK_BITS, cleanName, waveDeclaration, compatibleRange, createWaveCatalog, matchCircuitSignal, waveCircuitRequest };
