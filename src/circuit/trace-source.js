'use strict';
const path = require('node:path');
const { parseDocument } = require('../editor/completion/syntax');
const ALLOWED = new Set(['port', 'net', 'variable']);
const MAX_CONTEXT_VISITS = 4096, MAX_CONTEXTS = 256, MAX_INSTANCE_DEPTH = 64;
const keyPath = file => { const normalized = path.resolve(file).replace(/\\/g, '/'); return process.platform === 'win32' ? normalized.toLowerCase() : normalized; };
const cleanName = name => name.startsWith('\\') ? name.slice(1).trimEnd() : name;
const factCache = new WeakMap();
function upperBound(values, offset, position = value => value) {
    let low = 0, high = values.length;
    while (low < high) { const middle = (low + high) >>> 1; if (position(values[middle]) <= offset) low = middle + 1; else high = middle; }
    return low;
}
function facts(model) {
    if (factCache.has(model)) return factCache.get(model);
    const lines = [0], directives = []; let depth = 0;
    for (let i = 0; i < model.text.length; i++) if (model.text[i] === '\n') lines.push(i + 1);
    for (const token of model.tokens) if (['define', 'macro'].includes(token.kind)) {
        if (/^`ifn?def\b/.test(token.value.trim())) depth++;
        else if (/^`endif\b/.test(token.value.trim())) depth = Math.max(0, depth - 1);
        else continue;
        directives.push({ offset: token.start, depth });
    }
    const result = { lines, directives }; factCache.set(model, result); return result;
}

function declarationIdentity(model, symbol) {
    if (!ALLOWED.has(symbol.kind) || !/^[\w\s:$]+$/.test(symbol.type)) return null;
    let scope = model.scopes[symbol.scope]; const names = [];
    while (scope && scope.kind !== 'module') {
        if (scope.kind !== 'block' || !scope.name) return null;
        names.unshift(cleanName(scope.name)); scope = model.scopes[scope.parent];
    }
    if (!scope) return null;
    const positions = facts(model), line = upperBound(positions.lines, symbol.start);
    const conditionalDepth = positions.directives[upperBound(positions.directives, symbol.start, directive => directive.offset) - 1]?.depth || 0;
    return { signalName: cleanName(symbol.name), qualifiedName: [...names, cleanName(symbol.name)].join('.'),
        moduleName: scope.name, moduleLine: upperBound(positions.lines, scope.start), declLine: line,
        declColumn: symbol.start - positions.lines[line - 1] + 1, conditional: conditionalDepth > 0, kind: symbol.kind };
}

/** @param {object} model 只读解析模型。 @returns {object[]} 同一次解析的有界声明事实复用。 */
function declarationsOf(model) {
    const cached = facts(model);
    cached.declarations ||= model.symbols.map(symbol => declarationIdentity(model, symbol)).filter(Boolean);
    return cached.declarations;
}

/** @param {string} text 当前源码。 @param {{offset?:number,previous?:object}} options 光标或刷新时的声明身份。 @returns {object} 经过词法与作用域校验的声明选择。 */
function traceSelection(text, { offset, previous } = {}) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw new RangeError('追踪源码扫描超过16MiB');
    const model = parseDocument(text);
    if (previous) {
        const candidates = declarationsOf(model).filter(candidate => candidate
            && candidate.moduleName === previous.moduleName && candidate.qualifiedName === previous.qualifiedName);
        if (candidates.length !== 1) throw new Error('原追踪声明已变化或存在歧义，请重新选择信号');
        return { ...candidates[0], indices: previous.indices, dynamicSelect: previous.dynamicSelect };
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new TypeError('追踪光标位置无效');
    const token = model.tokens.find(token => token.start <= offset && token.end >= offset && token.kind === 'identifier');
    if (!token) throw new Error('请在RTL信号标识符上执行追踪');
    const lexical = model.tokens.filter(token => !['comment', 'string'].includes(token.kind)), tokenIndex = lexical.indexOf(token);
    if (['.', '::'].includes(lexical[tokenIndex - 1]?.value) || ['.', '::'].includes(lexical[tokenIndex + 1]?.value)) {
        throw new Error('层级引用或成员访问需要明确实例映射，请在电路中选择实际端口追踪');
    }
    let scope = model.scopeAt(token.start), identities = [];
    while (scope) {
        // 解析器可能把赋值右侧误记为变量；只忽略这类非法类型，合法局部遮蔽不能退回同名模块信号。
        const declarations = scope.symbols.filter(symbol => symbol.name === token.value && /^[\w\s:$]+$/.test(symbol.type));
        identities = declarations.map(symbol => declarationIdentity(model, symbol)).filter(Boolean);
        if (identities.length) break;
        if (declarations.length) throw new Error('当前标识符属于局部声明，不能映射到同名模块信号');
        scope = model.scopes[scope.parent];
    }
    if (identities.length !== 1) throw new Error('当前标识符没有唯一的模块信号声明');
    const tail = text.slice(token.end), selector = /^\s*\[\s*(-?\d+)\s*(?::\s*(-?\d+)\s*)?\]/.exec(tail);
    let indices;
    if (selector) {
        const left = Number(selector[1]), right = selector[2] === undefined ? left : Number(selector[2]);
        if (![left, right].every(Number.isSafeInteger) || Math.abs(left - right) >= 4096) throw new RangeError('追踪切片超过4096位');
        indices = Array.from({ length: Math.abs(left - right) + 1 }, (_, i) => right + i * (left >= right ? 1 : -1));
    }
    return { ...identities[0], indices, dynamicSelect: !selector && /^\s*\[/.test(tail) };
}

function instanceContexts(design, target) {
    const contexts = [], modules = new Map(design.modules.map(module => [module.id, module]));
    const queue = [{ id: design.top, path: [], names: [], ancestors: [] }]; let truncated = false;
    for (let cursor = 0; cursor < queue.length; cursor++) {
        if (contexts.length >= MAX_CONTEXTS) return { contexts, truncated: true };
        const current = queue[cursor];
        if (current.id === target) contexts.push({ instancePath: current.path, label: current.names.join('/') || 'top' });
        if (current.ancestors.includes(current.id)) continue;
        for (const cell of modules.get(current.id)?.cells || []) if (cell.moduleId) {
            if (current.path.length >= MAX_INSTANCE_DEPTH || queue.length >= MAX_CONTEXT_VISITS) { truncated = true; continue; }
            queue.push({ id: cell.moduleId, path: [...current.path, cell.id], names: [...current.names, cell.name], ancestors: [...current.ancestors, current.id] });
        }
    }
    return { contexts, truncated };
}

/** @param {object} design 已验证设计。 @param {object} target 声明与源码身份。 @param {Map} snapshots 生成时的源码快照。 @returns {object} 真实网络和实例候选，不按模块名称推测实例。 */
function traceCandidates(design, target, snapshots) {
    if (!target || typeof target.path !== 'string' || typeof target.qualifiedName !== 'string'
        || ![target.moduleLine, target.declLine].every(Number.isSafeInteger)) throw new TypeError('源码追踪声明无效');
    const snapshot = snapshots.get(keyPath(target.path));
    if (!snapshot) throw new Error('该文件没有生成时的源码快照（未参与生成、过大或非UTF-8编码），无法从源码发起追踪，可在电路中选择引脚');
    if (snapshot.hash !== target.sourceHash) throw new Error('源码选择与生成快照不一致，请重新执行追踪');
    const candidates = []; let truncated = false;
    for (const module of design.modules) {
        if (!module.source || keyPath(module.source.path) !== keyPath(target.path) || module.source.line !== target.moduleLine) continue;
        for (const signal of module.signals) {
            if (cleanName(signal.name) !== target.qualifiedName) continue;
            if (signal.source && (keyPath(signal.source.path) !== keyPath(target.path) || signal.source.line !== target.declLine)) continue;
            if (!signal.source && target.conditional) continue;
            const port = module.ports.find(port => cleanName(port.name) === target.qualifiedName
                && JSON.stringify(port.bits) === JSON.stringify(signal.bits));
            const object = port || signal, instances = instanceContexts(design, module.id); truncated ||= instances.truncated;
            for (const context of instances.contexts.length ? instances.contexts : [{ instancePath: undefined, label: '模块定义' }]) {
                if (candidates.length >= 256) { truncated = true; break; }
                candidates.push({ moduleId: module.id, moduleName: module.name, objectId: object.id, name: object.name,
                    width: object.bits.length, offset: object.offset || 0, upto: object.upto || false,
                    ...context, source: { path: target.path, line: target.declLine, column: target.declColumn, expectedHash: snapshot.hash } });
            }
        }
    }
    return { candidates, truncated, reason: candidates.length ? undefined : target.conditional
        ? '条件编译声明缺少可验证的工具位置，请在电路中选择实际引脚' : '工具没有保留该声明的网络或模块位置，可在电路中直接选择引脚追踪' };
}

module.exports = { keyPath, cleanName, declarationIdentity, declarationsOf, traceSelection, traceCandidates, instanceContexts };
