'use strict';

const path = require('node:path');
const { contextAt } = require('./syntax');
const { getCatalog } = require('./catalog');
const { createResolver } = require('./resolve');
const { templatesFor } = require('./templates');
const standardRegions = new WeakMap();

function entryFor(symbol, priority = 0, record = null) {
    let body = symbol.kind === 'macro' ? undefined : symbol.body, signature = symbol.signature;
    const args = symbol.arguments || (symbol.kind === 'macro' ? symbol.parameters : null);
    if (!body && args && ['function', 'task', 'macro'].includes(symbol.kind)) {
        const name = symbol.name.startsWith('\\') ? symbol.name.replace(/\\/g, '\\\\') + ' ' : symbol.name;
        body = name + '(' + args.map((argument, index) => '${' + (index + 1) + ':' + String(argument.name || argument).replace(/[\\$}]/g, '\\$&') + '}').join(', ') + ')';
        signature ||= symbol.name + '(' + args.map(argument => argument.type ? argument.type + ' ' + argument.name : argument.name || argument).join(', ') + ')';
    }
    return { ...symbol, body, signature, kind: symbol.kind || 'variable', detail: signature || symbol.detail || [symbol.kind, symbol.type, symbol.name].filter(Boolean).join(' '),
        priority, sourceUri: record?.uri?.toString(), sourceOffset: symbol.start };
}

/** `begin_keywords 的词法版本覆盖只作用于对应区间，与编译器开关保持独立。 */
function standardAt(model, offset, configured) {
    if (configured && configured !== 'auto') return configured;
    let standard;
    const stack = [];
    if (!standardRegions.has(model)) {
        const regions = [];
        for (let i = 0; i < model.tokens.length; i++) if (model.tokens[i].kind === 'macro' && ['`begin_keywords', '`end_keywords'].includes(model.tokens[i].value)) regions.push({ token: model.tokens[i], version: model.tokens[i + 1] });
        standardRegions.set(model, regions);
    }
    for (const { token, version } of standardRegions.get(model)) {
        if (token.start >= offset) break;
        if (token.kind === 'macro' && token.value === '`begin_keywords') {
            stack.push(standard);
            if (version?.kind === 'string') standard = version.value.slice(1, -1);
        } else if (token.kind === 'macro' && token.value === '`end_keywords') standard = stack.pop();
    }
    return standard;
}

/** 生成领域补全项，VS Code 类和替换区间在适配层中处理。 */
function complete(snapshot, offset, options = {}) {
    const model = snapshot.current.model, context = options.context || contextAt(model, offset);
    const catalog = getCatalog({ language: options.language || 'systemverilog', uvm: options.uvm || '1.2', standard: standardAt(model, offset, options.standard) });
    const effectiveOptions = { ...options, standard: catalog.metadata.standard, keywords: new Set(catalog.keywords), language: catalog.metadata.standard.startsWith('1364-') ? 'verilog' : 'systemverilog' };
    if (['comment', 'string'].includes(context.kind)) return { context, items: [], incomplete: false };
    const resolver = createResolver(snapshot, context, catalog);
    const maxItems = Math.max(1, Math.min(10000, options.maxItems || 1000));
    let items = [], incomplete = !!snapshot.incomplete;
    switch (context.kind) {
        case 'system': {
            const scopes = new Set();
            for (let scope = context.scope; scope; scope = scope.parent == null ? null : model.scopes[scope.parent]) scopes.add(scope.kind);
            items = catalog.systems.filter(entry => !entry.contexts || entry.contexts.some(kind => scopes.has(kind))).map(entry => ({ ...entry, name: entry.name.replace(/^\$/, ''), body: entry.body?.replace(/^\\?\$/, ''), kind: 'function', priority: 0 }));
            break;
        }
        case 'macro': {
            const macros = snapshot.records.flatMap(record => record.model.macros.map(symbol => entryFor(symbol, 0, record)));
            items = [...macros, ...catalog.directives.map(entry => ({ ...entry, name: entry.name.replace(/^`/, ''), body: entry.body?.replace(/^`/, ''), kind: 'keyword', priority: 1 })),
                ...(catalog.uvm?.macros || []).map(entry => ({ ...entry, name: entry.name.replace(/^`/, ''), body: entry.body?.replace(/^`/, ''), kind: 'function', priority: 1 }))];
            break;
        }
        case 'include': {
            const source = snapshot.current.uri.fsPath;
            items = snapshot.fileUris.filter(uri => uri.toString() !== snapshot.current.uri.toString()).map(uri => {
                const relative = path.relative(path.dirname(source), uri.fsPath).replace(/\\/g, '/');
                return { name: relative, kind: 'file', detail: uri.fsPath, priority: 0 };
            });
            break;
        }
        case 'port': case 'parameter': {
            const definition = resolver.findType(context.instance.type);
            if (!definition) break;
            const wanted = context.kind === 'port' ? ['port'] : ['parameter'];
            const candidates = resolver.members({ ref: definition }, false, true);
            const used = new Set(context.usedNames || []);
            // 当前编辑中的 .name(...) 保持可选，其他已连接的命名项去重。
            used.delete(model.text.slice(context.start, context.end));
            items = candidates.filter(item => wanted.includes(item.symbol.kind) && !used.has(item.symbol.name)).map(item => ({ ...entryFor(item.symbol, 0, item.record),
                body: /^\s*\(/.test(model.text.slice(context.end)) ? item.symbol.name : item.symbol.name + '(${1})' }));
            break;
        }
        case 'member': case 'scope': {
            const target = resolver.resolve(context.receiver);
            if (!target) break;
            const internal = context.receiver === 'this' ? true : context.receiver === 'super' ? 'inherited' : false;
            items = target.array ? [] : resolver.members(target, context.kind === 'scope', internal).map(item => entryFor(item.symbol, 0, item.record));
            if (context.kind === 'member') {
                items.push(...resolver.builtinMembers(target).map(entry => ({ ...entry, kind: entry.kind || 'function', priority: 0 })));
            } else if (context.kind === 'scope') {
                items.push(...resolver.builtinMembers(target).filter(entry => entry.static).map(entry => ({ ...entry, kind: entry.kind || 'function', priority: 0 })));
            }
            break;
        }
        default: {
            const visible = resolver.visible(context.scope, snapshot.current, context.start, context.prefix, maxItems);
            incomplete ||= visible.incomplete;
            items = visible.map(item => entryFor(item.symbol, 0, item.record));
            items.push(...catalog.keywords.map(name => ({ name, kind: 'keyword', detail: 'IEEE ' + catalog.metadata.standard, priority: 2 })));
            items.push(...templatesFor(context, effectiveOptions).map(entry => ({ ...entry, priority: 3 })));
            if (effectiveOptions.language !== 'verilog') items.push(...(catalog.snippets || []).map(entry => ({ ...entry, name: entry.name || entry.label, kind: 'snippet', priority: 3 })));
        }
    }
    const unique = new Map();
    for (const entry of items) {
        if (!entry.name || context.prefix && !entry.name.toLowerCase().startsWith(context.prefix.toLowerCase())) continue;
        const key = entry.kind === 'snippet' ? 'snippet:' + entry.name : entry.name;
        if (entry.body && ['function', 'task', 'macro'].includes(entry.kind) && /^\s*\(/.test(model.text.slice(context.end))) entry.body = undefined;
        if (!unique.has(key)) unique.set(key, entry);
    }
    incomplete ||= unique.size > maxItems;
    return { context, items: [...unique.values()].slice(0, maxItems), incomplete };
}

module.exports = { complete, entryFor, standardAt };
