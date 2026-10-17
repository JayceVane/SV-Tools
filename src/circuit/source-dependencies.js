'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { parseDocument } = require('../editor/completion/syntax');
const MAX_SCAN_FILES = 4096, MAX_FILE_BYTES = 2 * 1024 * 1024, MAX_SCAN_BYTES = 32 * 1024 * 1024;
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const unitKinds = new Set(['module', 'interface', 'package', 'program']);
const packageKinds = new Set(['package']), interfaceKinds = new Set(['interface']), moduleKinds = new Set(['module', 'interface', 'program']);
const inside = (file, root) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

function sourceFacts(file, text) {
    const model = parseDocument(text), units = model.scopes.filter(scope => unitKinds.has(scope.kind)).map(scope => ({ name: scope.name, kind: scope.kind }));
    const modules = new Set(model.instances.filter(instance => instance.name && instance.ports).map(instance => instance.type));
    const packages = new Set(model.imports.map(entry => entry.package));
    const interfaces = new Set(model.symbols.filter(symbol => {
        const scope = model.scopes[symbol.scope];
        return symbol.kind === 'port' || scope?.kind === 'module' && symbol.start < scope.headerEnd;
    }).map(symbol => String(symbol.type || '').match(/^[A-Za-z_$][\w$]*/)?.[0]));
    const tokens = model.significantTokens;
    for (let i = 1; i < tokens.length; i++) if (tokens[i].value === '::' && tokens[i - 1].kind === 'identifier') packages.add(tokens[i - 1].value);
    const includes = [];
    for (let i = 0; i < model.tokens.length - 1; i++) if (model.tokens[i].value === '`include') {
        let cursor = i + 1; while (model.tokens[cursor]?.kind === 'comment') cursor++;
        const next = model.tokens[cursor];
        if (next?.kind === 'string' && next.closed) includes.push(next.value.slice(1, -1).replace(/\\([\\"])/g, '$1'));
    }
    return { file, units, modules, packages, interfaces, includes };
}

/**
 * @param {{root:string,files:string[],documents?:object[],current:string,top:string}} options 有界工作区候选和调用时的编辑器正文。
 * @returns {Promise<string[]>} 文件依赖闭包，package和子模块在使用方之前；不修改源码或推导generate结果。
 */
async function resolveSourceClosure({ root, files, documents = [], current, top, includeDirs = [] }) {
    if (!Array.isArray(files) || files.length > MAX_SCAN_FILES) throw new Error('电路自动源扫描超过4096文件，请显式配置 svtools.circuit.sources');
    const realRoot = await fs.realpath(root), overlays = new Map(documents.map(document => [key(path.resolve(document.file)), document.text]));
    const candidates = [...new Set([...files, current].map(file => path.resolve(file)))].sort();
    if (candidates.length > MAX_SCAN_FILES) throw new Error('电路自动源扫描超过4096文件，请显式配置 svtools.circuit.sources');
    const records = new Map(), definitions = new Map(); let total = 0;
    for (const file of candidates) {
        if (!inside(file, path.resolve(root))) throw new Error('自动电路源文件位于当前工作区之外：' + file);
        const real = await fs.realpath(file);
        if (!inside(real, realRoot)) throw new Error('自动电路源文件链接到工作区之外，请显式配置 sources：' + file);
        let text = overlays.get(key(file));
        if (text === undefined) {
            const stat = await fs.stat(real);
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('电路自动扫描只支持不超过2 MiB的普通源文件，请显式配置 sources：' + file);
            const chunks = []; let length = 0;
            for await (const chunk of createReadStream(real)) {
                length += chunk.length; if (length > Math.min(MAX_FILE_BYTES, MAX_SCAN_BYTES - total)) throw new Error('电路自动扫描超过单文件2 MiB或总量32 MiB：' + file);
                chunks.push(chunk);
            }
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
            catch (error) { throw new Error('电路自动扫描源文件不是有效UTF-8：' + file + '；' + error.message); }
        }
        const bytes = Buffer.byteLength(text, 'utf8'); total += bytes;
        if (bytes > MAX_FILE_BYTES || total > MAX_SCAN_BYTES) throw new Error('电路自动扫描超过单文件2 MiB或总量32 MiB，请显式配置 svtools.circuit.sources');
        const record = sourceFacts(file, text); records.set(key(file), record);
        for (const unit of record.units) {
            if (!definitions.has(unit.name)) definitions.set(unit.name, []);
            const entries = definitions.get(unit.name);
            if (!entries.some(entry => key(entry.file) === key(file))) entries.push({ file, kind: unit.kind });
        }
    }
    function definition(name, kinds) {
        const entries = (definitions.get(name) || []).filter(entry => kinds.has(entry.kind));
        if (entries.length > 1) throw new Error('电路依赖重复定义 ' + name + '，请用 svtools.circuit.sources 指定本次源文件：' + entries.slice(0, 4).map(entry => entry.file).join('；'));
        return entries[0]?.file;
    }
    const result = [], visiting = new Set(), visited = new Set(), included = new Set();
    function dependencies(record) {
        const files = [];
        for (const name of record.includes) {
            const file = [path.dirname(record.file), ...includeDirs].map(directory => path.resolve(directory, name)).find(candidate => records.has(key(candidate)));
            if (file) { included.add(key(file)); files.push(file); }
        }
        for (const [names, kinds] of [[record.packages, packageKinds], [record.interfaces, interfaceKinds], [record.modules, moduleKinds]]) {
            for (const name of names) { const file = definition(name, kinds); if (file) files.push(file); }
        }
        return files;
    }
    function visit(file) {
        const stack = [{ file, expanded: false }];
        while (stack.length) {
            const frame = stack.pop(), id = key(frame.file);
            if (frame.expanded) { visiting.delete(id); visited.add(id); result.push(frame.file); continue; }
            if (visiting.has(id) || visited.has(id)) continue;
            visiting.add(id); stack.push({ ...frame, expanded: true });
            const children = dependencies(records.get(id));
            for (let i = children.length - 1; i >= 0; i--) stack.push({ file: children[i], expanded: false });
        }
    }
    // 检查入口本身的重名，避免工作区同名设计被扫描顺序悄悄选中。
    const entry = definition(top, moduleKinds);
    visit(path.resolve(current)); if (entry) visit(entry);
    return result.filter(file => !included.has(key(file)) || key(file) === key(path.resolve(current)));
}
module.exports = { MAX_SCAN_FILES, MAX_FILE_BYTES, MAX_SCAN_BYTES, resolveSourceClosure };
