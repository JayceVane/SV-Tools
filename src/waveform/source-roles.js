'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { parseDocument, matchDelimiters, splitTopLevel } = require('../editor/completion/syntax');
const { constantValue } = require('../project/rtl-expression');
const { SOURCE_EXCLUDE_GLOB, isExcludedSourcePath } = require('../workspace/source-policy');
const MAX_FILES = 512, MAX_FILE_BYTES = 1024 * 1024, MAX_BYTES = 8 * 1024 * 1024;
const UNIT_KINDS = new Set(['module', 'interface', 'program']);
const DIRECTIONS = new Set(['input', 'output', 'inout']);

// 只接受独立整数字面量：参数可在实例化时覆盖，复杂表达式的位宽和符号语义不可猜测。
function literalBound(tokens) {
    if (tokens.length === 2 && ['+', '-'].includes(tokens[0].value)) {
        if (tokens[1].kind !== 'number' || tokens[1].value.includes("'")) return undefined;
    } else if (tokens.length !== 1 || tokens[0].kind !== 'number') return undefined;
    const result = constantValue(tokens);
    return Number.isSafeInteger(result) ? result : undefined;
}

/** 取得显式的一维packed范围，缺失或无法确定的端点不按参数默认值推断。 */
function packedRanges(model, scope, positions) {
    const tokens = model.significantTokens, pairs = model.delimiterPairs, result = new Map();
    let previousIndex = -1, inherited;
    for (const symbol of [...scope.symbols].sort((a, b) => a.start - b.start)) {
        const index = positions.get(symbol.start);
        if (index === undefined) { previousIndex = -1; inherited = undefined; continue; }
        let start = index;
        while (start > 0) {
            const previous = tokens[start - 1];
            if ([',', ';', '('].includes(previous.value)) break;
            if ([')', ']', '}'].includes(previous.value) && pairs.has(start - 1)) { start = pairs.get(start - 1); continue; }
            start--;
        }
        const prefix = tokens.slice(start, index), delimiters = matchDelimiters(prefix), ranges = [];
        for (let cursor = 0; cursor < prefix.length; cursor++) if (prefix[cursor].value === '[') {
            const end = delimiters.get(cursor);
            if (end === undefined) { ranges.push(null); break; }
            ranges.push(prefix.slice(cursor + 1, end)); cursor = end;
        }
        const between = previousIndex < 0 ? [] : tokens.slice(previousIndex + 1, index);
        const canInherit = !prefix.length && between.at(-1)?.value === ',' && !between.some(token => token.value === ';');
        let bounds;
        if (ranges.length === 1 && ranges[0]) {
            const sides = splitTopLevel(ranges[0], ':');
            if (sides.length === 2) bounds = { left: literalBound(sides[0]), right: literalBound(sides[1]) };
        } else if (!ranges.length && canInherit) bounds = inherited;
        result.set(symbol, bounds); inherited = bounds; previousIndex = index;
    }
    return result;
}

/** @param {object[]} records 已解析源码。@returns {Map<string,object[]>} 紧凑作用域事实；不进行预处理或详细化。 */
function createRoleIndex(records) {
    const units = new Map();
    for (const { model } of records) {
        const positions = new Map(model.significantTokens.map((token, index) => [token.start, index]));
        const facts = new Map(model.scopes.map(scope => {
            const ranges = packedRanges(model, scope, positions);
            return [scope.id, { name: scope.name, symbols: scope.symbols.map(symbol =>
                ({ name: symbol.name, kind: symbol.kind, direction: symbol.direction, type: symbol.type, array: symbol.array, packedRange: ranges.get(symbol) })), children: new Map(), instances: new Map() }];
        }));
        for (const fact of facts.values()) {
            const symbols = new Map();
            for (const symbol of fact.symbols) { if (!symbols.has(symbol.name)) symbols.set(symbol.name, []); symbols.get(symbol.name).push(symbol); }
            fact.symbols = symbols;
        }
        for (const scope of model.scopes) {
            if (scope.parent !== null && scope.name && !UNIT_KINDS.has(scope.kind)) {
                const children = facts.get(scope.parent).children;
                if (!children.has(scope.name)) children.set(scope.name, []);
                children.get(scope.name).push(facts.get(scope.id));
            }
        }
        for (const instance of model.instances) if (instance.name) {
            const instances = facts.get(instance.scope).instances;
            if (!instances.has(instance.name)) instances.set(instance.name, []);
            instances.get(instance.name).push(instance.type);
        }
        for (const scope of model.scopes.filter(scope => UNIT_KINDS.has(scope.kind))) {
            const conditional = model.tokens.some(token => token.start >= scope.start && token.start < scope.end && /^`(?:ifdef|ifndef|elsif|else|include)$/.test(token.value));
            const entry = conditional ? null : facts.get(scope.id);
            if (!units.has(scope.name)) units.set(scope.name, []);
            units.get(scope.name).push(entry);
        }
    }
    return units;
}
const unique = entries => entries?.length === 1 ? entries[0] : null;

/** @param {object[]} vars VCD别名各自保留路径。@param {Map} units @returns {object[]} 仅精确且唯一的层级匹配可标注方向；其它为unknown。 */
function classifySignals(vars, units) {
    const scopes = new Map();
    function scopeAt(scopePath) {
        if (scopes.has(scopePath)) return scopes.get(scopePath);
        const parts = scopePath.split('.');
        let scope = /\\/.test(scopePath) ? null : unique(units.get(parts[0]));
        for (const part of parts.slice(1)) {
            const name = part.replace(/\[[+-]?\d+\]$/, '');
            const type = unique(scope?.instances.get(name));
            scope = type ? unique(units.get(type)) : unique(scope?.children.get(name));
        }
        scopes.set(scopePath, scope); return scope;
    }
    return vars.map(signal => {
        const scope = scopeAt(signal.scopePath), name = signal.referenceName || signal.name;
        let declarations = scope?.symbols.get(name) || [];
        if (!declarations.length && !name.startsWith('\\')) declarations = scope?.symbols.get(name.replace(/(?:\[[+-]?\d+\])+$/, '')) || [];
        const directions = new Set(declarations.filter(symbol => symbol.kind === 'port').map(symbol => symbol.direction));
        const direction = unique([...directions]);
        const role = DIRECTIONS.has(direction) ? direction : directions.size ? 'unknown'
            : declarations.some(symbol => ['net', 'variable'].includes(symbol.kind)) ? 'internal' : 'unknown';
        // 位级声明有两种形态，都必须能参与 packed 总线恢复：
        // ① JS parser 产出：name 形如 `data[3]`、range 为空、无 referenceName；
        // ② Rust 后端按原始声明表拆出的：name/path 带 `[3]`、range='[3]'、referenceName='data'。
        // 旧条件要求 `!signal.range && !signal.referenceName`，会把 ② 排除在外，
        // 导致逐位 dump 在 Rust 后端下永远合不回总线。
        const bit = signal.width === 1 && name.match(/^([^\\\[\]]+)\[([+-]?\d+)\]$/);
        const bounds = declarations[0]?.packedRange;
        const packedBit = bit && bounds && (Number.isSafeInteger(bounds.left) || Number.isSafeInteger(bounds.right))
            && declarations.every(symbol => !symbol.array && ['net', 'variable', 'port'].includes(symbol.kind)
                && symbol.packedRange && symbol.packedRange.left === bounds.left && symbol.packedRange.right === bounds.right)
            ? { name: bit[1], index: Number(bit[2]), bounds } : undefined;
        return { ...signal, role, ...(role !== 'unknown' ? { roleSource: 'RTL' } : {}), ...(packedBit ? { packedBit } : {}) };
    });
}

/** @param {object} vscode @param {string} filePath @returns {Promise<object>} 只发现路径，不打开文档，避免触发自动lint。 */
async function collectSourceContext(vscode, filePath, sourceCatalog, sourceFile, { signal } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        const context = await collectOnce(vscode, filePath, sourceCatalog, sourceFile);
        signal?.throwIfAborted();
        if (!context.invalidated || attempt === 2) return context;
        await delay(50 * (attempt + 1), undefined, { signal });
    }
}

async function collectOnce(vscode, filePath, sourceCatalog, sourceFile) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    const folders = folder ? [folder] : vscode.workspace.workspaceFolders || [];
    const files = new Set(), sourceRoots = new Set(folders.map(root => root.uri.fsPath)); let truncated = false, invalidated = false;
    for (const root of folders) {
        const pattern = new vscode.RelativePattern(root, '**/*.{sv,v,svh,vh}');
        const shared = sourceCatalog ? await sourceCatalog.discover({ root: root.uri.fsPath, file: sourceFile || filePath, limit: MAX_FILES }) : null;
        truncated ||= !!shared?.truncated;
        invalidated ||= !!shared?.invalidated;
        for (const directory of shared?.roots || []) sourceRoots.add(directory);
        for (const uri of shared ? shared.uris : await vscode.workspace.findFiles(pattern, SOURCE_EXCLUDE_GLOB, MAX_FILES + 1)) {
            if (isExcludedSourcePath(uri.fsPath)) continue;
            if (files.size < MAX_FILES) files.add(uri.fsPath); else if (!files.has(uri.fsPath)) truncated = true;
        }
    }
    const documents = []; let bytes = 0;
    for (const document of vscode.workspace.textDocuments) if (document.isDirty && files.has(document.uri.fsPath)) {
        const text = document.getText(), size = Buffer.byteLength(text);
        if (size <= MAX_FILE_BYTES && bytes + size <= MAX_BYTES) { documents.push({ file: document.uri.fsPath, text }); bytes += size; } else truncated = true;
    }
    return { roots: [...sourceRoots], files: [...files], documents, truncated, ...(invalidated ? { invalidated: true } : {}) };
}
const inside = (file, root) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

/** @param {object[]} vars @param {object} context 宿主发现的只读路径。@returns {Promise<object>} 在VCD worker中解析有界源码，失败仅降级方向图标。 */
async function readSignalRoles(vars, context) {
    if (!context?.roots?.length) return { vars, sourceRoleNote: '方向未知：未找到工作区RTL' };
    if (context.invalidated) return { vars, sourceRoleNote: '方向暂不可用：RTL源码清单正在变化，将在稳定后重试' };
    if (context.truncated || context.files?.length > MAX_FILES) return { vars, sourceRoleNote: '方向未知：RTL候选或脏缓冲区超过扫描预算' };
    const roots = await Promise.all(context.roots.map(root => fs.realpath(root)));
    const overlays = new Map((context.documents || []).map(item => [path.resolve(item.file), item.text]));
    const units = new Map(), warnings = []; let bytes = 0, skipped = 0;
    for (const file of (context.files || []).slice(0, MAX_FILES)) {
        try {
            if (isExcludedSourcePath(file)) continue;
            const real = await fs.realpath(file);
            if (!roots.some(root => inside(real, root))) { skipped++; continue; }
            const stat = await fs.stat(real);
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { skipped++; continue; }
            let text = overlays.get(path.resolve(file));
            if (text === undefined) {
                const chunks = []; let size = 0;
                for await (const chunk of createReadStream(real)) {
                    size += chunk.length;
                    if (size > Math.min(MAX_FILE_BYTES, MAX_BYTES - bytes)) throw new Error('RTL读取超过单文件1MiB或总量8MiB预算');
                    chunks.push(chunk);
                }
                text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            }
            bytes += Buffer.byteLength(text);
            if (Buffer.byteLength(text) > MAX_FILE_BYTES || bytes > MAX_BYTES) { skipped++; break; }
            for (const [name, entries] of createRoleIndex([{ file, model: parseDocument(text) }])) {
                if (!units.has(name)) units.set(name, []);
                units.get(name).push(...entries);
            }
        } catch (error) { skipped++; if (warnings.length < 4) warnings.push(path.basename(file) + ': ' + error.message); }
    }
    // 扫描不完整时不能排除漏读文件中的重复定义，统一保留未知。
    if (skipped) return { vars, sourceRoleNote: `方向未知：RTL扫描不完整（${skipped}个文件不可读取或超预算）${warnings.length ? ' · ' + warnings.join('；') : ''}` };
    const result = classifySignals(vars, units), matched = result.filter(signal => signal.role !== 'unknown').length;
    return { vars: result, sourceRoleNote: `RTL方向匹配 ${matched}/${vars.length}；其余方向未知` };
}
module.exports = { createRoleIndex, classifySignals, collectSourceContext, readSignalRoles };
