'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { parseDocument } = require('../editor/completion/syntax');
const { SOURCE_EXCLUDE_GLOB, isExcludedSourcePath } = require('../workspace/source-policy');
const MAX_FILES = 512, MAX_FILE_BYTES = 1024 * 1024, MAX_BYTES = 8 * 1024 * 1024;
const UNIT_KINDS = new Set(['module', 'interface', 'program']);
const DIRECTIONS = new Set(['input', 'output', 'inout']);

/** @param {object[]} records 已解析源码。@returns {Map<string,object[]>} 紧凑作用域事实；不进行预处理或详细化。 */
function createRoleIndex(records) {
    const units = new Map();
    for (const { model } of records) {
        const facts = new Map(model.scopes.map(scope => [scope.id, { name: scope.name, symbols: scope.symbols.map(symbol =>
            ({ name: symbol.name, kind: symbol.kind, direction: symbol.direction, type: symbol.type })), children: new Map(), instances: new Map() }]));
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
        return { ...signal, role, ...(role !== 'unknown' ? { roleSource: 'RTL' } : {}) };
    });
}

/** @param {object} vscode @param {string} filePath @returns {Promise<object>} 只发现路径，不打开文档，避免触发自动lint。 */
async function collectSourceContext(vscode, filePath) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    const folders = folder ? [folder] : vscode.workspace.workspaceFolders || [];
    const files = new Set(); let truncated = false;
    for (const root of folders) {
        const pattern = new vscode.RelativePattern(root, '**/*.{sv,v,svh,vh}');
        for (const uri of await vscode.workspace.findFiles(pattern, SOURCE_EXCLUDE_GLOB, MAX_FILES + 1)) {
            if (isExcludedSourcePath(uri.fsPath)) continue;
            if (files.size < MAX_FILES) files.add(uri.fsPath); else if (!files.has(uri.fsPath)) truncated = true;
        }
    }
    const documents = []; let bytes = 0;
    for (const document of vscode.workspace.textDocuments) if (document.isDirty && files.has(document.uri.fsPath)) {
        const text = document.getText(), size = Buffer.byteLength(text);
        if (size <= MAX_FILE_BYTES && bytes + size <= MAX_BYTES) { documents.push({ file: document.uri.fsPath, text }); bytes += size; } else truncated = true;
    }
    return { roots: folders.map(folder => folder.uri.fsPath), files: [...files], documents, truncated };
}
const inside = (file, root) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

/** @param {object[]} vars @param {object} context 宿主发现的只读路径。@returns {Promise<object>} 在VCD worker中解析有界源码，失败仅降级方向图标。 */
async function readSignalRoles(vars, context) {
    if (!context?.roots?.length) return { vars, sourceRoleNote: '方向未知：未找到工作区RTL' };
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
