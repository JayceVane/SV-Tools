'use strict';

const TYPE_KINDS = new Set(['class', 'typedef', 'enum', 'struct', 'union', 'module', 'interface', 'package', 'program', 'covergroup']);
const ref = (symbol, record = null) => ({ symbol, record });
const scopeTables = new WeakMap();

function scopeTable(scope) {
    if (!scopeTables.has(scope)) scopeTables.set(scope, new Map(scope.symbols.map(symbol => [symbol.name, symbol])));
    return scopeTables.get(scope);
}

/** 按顶层分隔符切分表达式，括号内的泛型、索引和调用参数保持完整。 */
function splitAccess(text) {
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i--) {
        if (')]}'.includes(text[i])) depth++;
        else if ('([{'.includes(text[i])) depth--;
        else if (depth === 0 && text[i] === '.') return [text.slice(0, i), text.slice(i + 1), '.'];
        else if (depth === 0 && text.slice(i - 1, i + 1) === '::') return [text.slice(0, i - 1), text.slice(i + 1), '::'];
    }
    return null;
}

function typeName(type) {
    return String(type || '').replace(/\b(?:input|output|inout|ref|const|var|static|automatic|virtual|local|protected|rand|randc|signed|unsigned|packed)\b/g, '')
        .replace(/\[[^\]]*\]/g, '').trim().replace(/\s*#\s*\([\s\S]*$/, '').trim();
}

function typeArguments(type) {
    const match = String(type || '').match(/#\s*\(([\s\S]*)\)\s*$/);
    if (!match) return [];
    const values = [], text = match[1];
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i++) {
        if ('([{'.includes(text[i])) depth++;
        else if (')]}'.includes(text[i])) depth--;
        else if (text[i] === ',' && depth === 0) { values.push(text.slice(start, i).trim()); start = i + 1; }
    }
    values.push(text.slice(start).trim());
    return values;
}

function substitute(type, bindings = {}) {
    return String(type || '').replace(/\b[A-Za-z_]\w*\b/g, name => bindings[name] ?? name);
}

function bindingsFor(symbol, type) {
    const args = typeArguments(type), bindings = {};
    for (let i = 0; i < (symbol.parameters || []).length; i++) {
        const parameter = symbol.parameters[i];
        bindings[parameter.name] = args[i] || substitute(parameter.default || parameter.type || parameter.name, bindings);
    }
    return bindings;
}

/** 语义查找与补全排序解耦；引用保留定义文档，跨文件成员不会串用当前作用域。 */
function createResolver(snapshot, context, catalog) {
    const current = snapshot.current, model = current.model;
    const uvm = catalog.uvm || { symbols: [], functions: [], constants: [] };
    const globals = snapshot.records.flatMap(record => record.model.scopes[0].symbols.map(symbol => ref(symbol, record)));
    const uvmRefs = [...(uvm.symbols || []), ...(uvm.functions || []), ...(uvm.constants || [])].map(symbol => ref(symbol));
    const standardRefs = (catalog.standardSymbols || []).filter(symbol => !symbol.scope).map(symbol => ref(symbol));

    function enclosing(scope, record = current) {
        const result = [];
        for (let cursor = scope; cursor; cursor = cursor.parent == null ? null : record.model.scopes[cursor.parent]) result.push(cursor);
        return result;
    }

    function packageMembers(name) {
        if (name === 'uvm_pkg') return uvmRefs;
        if (name === 'std') return [...standardRefs, ...(catalog.standardFunctions || []).map(symbol => ref(symbol))];
        const packages = globals.filter(item => item.symbol.kind === 'package' && item.symbol.name === name);
        return packages.flatMap(item => (item.symbol.members || item.record.model.scopes[item.symbol.bodyScope]?.symbols || []).map(symbol => ref(symbol, item.record)));
    }

    function visible(scope = context.scope, record = current, offset = context.start, prefix = '', limit = Infinity) {
        const found = new Map();
        let incomplete = false;
        const add = item => {
            if (found.has(item.symbol.name)) return;
            if (found.size >= limit) { incomplete = true; return; }
            found.set(item.symbol.name, item);
        };
        const needle = prefix.toLowerCase();
        const matches = name => !needle || name.toLowerCase().startsWith(needle);
        for (const layer of enclosing(scope, record)) {
            for (const symbol of layer.symbols || []) {
                if (!matches(symbol.name)) continue;
                if (['function', 'task', 'block'].includes(layer.kind) && symbol.start > offset) continue;
                add(ref(symbol, record));
                if (incomplete) break;
            }
            if (layer.kind === 'class') {
                const cls = record.model.symbols.find(symbol => symbol.bodyScope === layer.id);
                if (cls) for (const item of members({ ref: ref(cls, record) }, false, true)) if (matches(item.symbol.name)) add(item);
            }
            for (const imported of record.model.imports || []) {
                if (imported.scope !== layer.id || imported.start > offset) continue;
                for (const item of packageMembers(imported.package)) {
                    if (!(imported.wildcard || imported.name === '*' || imported.name === item.symbol.name)) continue;
                    if (matches(item.symbol.name)) add(item);
                }
            }
        }
        for (const item of globals) {
            if (matches(item.symbol.name) && TYPE_KINDS.has(item.symbol.kind)) add(item);
        }
        for (const item of standardRefs) if (matches(item.symbol.name)) add(item);
        if (standardRefs.length && matches('std')) add(ref({ name: 'std', kind: 'package' }));
        const result = [...found.values()]; result.incomplete = incomplete;
        return result;
    }

    function findType(type, record = current, scope = context.scope) {
        const name = typeName(type), access = splitAccess(name);
        if (access?.[2] === '.') {
            const owner = findType(access[0], record, scope);
            if (owner?.symbol.kind === 'interface') return owner;
        }
        if (access?.[2] === '::') {
            const owner = findType(access[0], record, scope);
            return owner ? members({ ref: owner }, true, true).find(item => item.symbol.name === access[1]) : null;
        }
        for (const layer of enclosing(scope, record)) {
            const direct = scopeTable(layer).get(name);
            if (direct && TYPE_KINDS.has(direct.kind)) return ref(direct, record);
            for (const imported of record.model.imports || []) {
                if (imported.scope !== layer.id) continue;
                const found = packageMembers(imported.package).find(item => item.symbol.name === name && TYPE_KINDS.has(item.symbol.kind) && (imported.wildcard || imported.name === '*' || imported.name === name));
                if (found) return found;
            }
        }
        return globals.find(item => item.symbol.name === name && TYPE_KINDS.has(item.symbol.kind))
            || uvmRefs.find(item => item.symbol.name === name && TYPE_KINDS.has(item.symbol.kind))
            || standardRefs.find(item => item.symbol.name === name) || null;
    }

    function findVisible(name) {
        for (const layer of enclosing(context.scope)) {
            const direct = scopeTable(layer).get(name);
            if (direct && (!['function', 'task', 'block'].includes(layer.kind) || direct.start <= context.start)) return ref(direct, current);
            if (layer.kind === 'class') {
                const cls = model.symbols.find(symbol => symbol.bodyScope === layer.id);
                const inherited = cls && members({ ref: ref(cls, current) }, false, true).find(item => item.symbol.name === name);
                if (inherited) return inherited;
            }
            for (const imported of model.imports || []) {
                if (imported.scope !== layer.id || imported.start > context.start) continue;
                const item = packageMembers(imported.package).find(candidate => candidate.symbol.name === name);
                if (item && (imported.wildcard || imported.name === '*' || imported.name === name)) return item;
            }
        }
        return globals.find(item => item.symbol.name === name) || standardRefs.find(item => item.symbol.name === name) || null;
    }

    function factoryMembers(owner) {
        const cls = owner.symbol;
        if (cls.kind !== 'class' || !owner.record) return [];
        const source = owner.record.model.text.slice(cls.start, cls.end);
        if (!/`uvm_(?:object|component)(?:_param)?_utils(?:_begin)?\b/.test(source)) return [];
        const factory = { name: 'type_id', kind: 'typedef', static: true, members: [
            { name: 'create', kind: 'function', static: true, returnType: cls.name, signature: 'create(string name, uvm_component parent = null)', body: 'create(${1:name}, ${2:parent})' },
            { name: 'get', kind: 'function', static: true, returnType: 'uvm_object_wrapper', signature: 'get()', body: 'get()' }
        ] };
        return [ref(factory, owner.record), ref({ name: 'get_type', kind: 'function', static: true, returnType: 'uvm_object_wrapper', signature: 'get_type()', body: 'get_type()' }, owner.record),
            ref({ name: 'get_type_name', kind: 'function', returnType: 'string', signature: 'get_type_name()', body: 'get_type_name()' }, owner.record)];
    }

    function members(target, staticOnly = false, internal = false, visited = new Set()) {
        if (!target?.ref) return [];
        const owner = target.ref, symbol = owner.symbol;
        const key = (owner.record?.uri?.toString() || 'uvm') + ':' + symbol.name;
        if (visited.has(key)) return [];
        visited.add(key);
        let own = symbol.members || owner.record?.model.scopes[symbol.bodyScope]?.symbols || [];
        if (symbol.kind === 'package' && symbol.name === 'uvm_pkg') return uvmRefs;
        if (symbol.kind === 'package' && symbol.name === 'std') return packageMembers('std');
        const bindings = target.bindings || bindingsFor(symbol, target.type);
        const result = own.filter(member => (!staticOnly || symbol.kind === 'package' || member.static || TYPE_KINDS.has(member.kind) || member.kind === 'enumMember' || member.kind === 'parameter' || member.kind === 'localparam')
            && (member.visibility !== 'local' || internal === true) && (member.visibility !== 'protected' || internal))
            .map(member => ref({ ...member, type: substitute(member.type, bindings), returnType: substitute(member.returnType, bindings),
                arguments: member.arguments?.map(argument => ({ ...argument, type: substitute(argument.type, bindings) })),
                signature: member.signature ? substitute(member.signature, bindings) : undefined }, owner.record));
        for (const nested of catalog.standardSymbols || []) if (nested.scope === symbol.name) result.push(ref(nested));
        result.push(...factoryMembers(owner).filter(item => !staticOnly || item.symbol.static));
        if (symbol.base) {
            const baseType = substitute(symbol.base, bindings);
            const base = findType(baseType, owner.record || current, owner.record?.model.scopes[symbol.scope] || context.scope);
            if (base) result.push(...members({ ref: base, type: baseType }, staticOnly, internal ? 'inherited' : false, visited));
        }
        const unique = new Map();
        for (const item of result) if (!unique.has(item.symbol.name)) unique.set(item.symbol.name, item);
        return [...unique.values()];
    }

    function value(item, type = null) {
        if (!item) return null;
        const symbol = item.symbol, rawType = type || symbol.returnType || symbol.type;
        let definition = TYPE_KINDS.has(symbol.kind) ? item : findType(rawType, item.record || current,
            item.record?.model.scopes[symbol.scope] || context.scope);
        let resolvedType = rawType || symbol.name, array = symbol.array;
        const interfaceAccess = splitAccess(typeName(resolvedType));
        if (definition?.symbol.kind === 'interface' && interfaceAccess?.[2] === '.') {
            const modport = members({ ref: definition }, false, true).find(member => member.symbol.kind === 'modport' && member.symbol.name === interfaceAccess[1]);
            if (modport) definition = ref({ ...definition.symbol, members: modport.symbol.members || [] }, definition.record);
        }
        const aliases = new Set();
        while (definition?.symbol.kind === 'typedef' && !definition.symbol.members?.length && definition.symbol.type && !aliases.has(definition.symbol.name)) {
            aliases.add(definition.symbol.name);
            resolvedType = definition.symbol.type; array ||= definition.symbol.array;
            definition = findType(resolvedType, definition.record || current, definition.record?.model.scopes[definition.symbol.scope] || context.scope);
        }
        if (array) {
            const ownerRecord = item.record || current, ownerScope = ownerRecord.model.scopes[symbol.scope] || context.scope;
            const dimensions = array.dimensions.map(dimension => {
                if (!/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(dimension.text || '')) return dimension;
                if (findType(dimension.text, ownerRecord, ownerScope)) return { ...dimension, kind: 'associative' };
                const bound = scopeTable(ownerScope).get(dimension.text);
                return bound && ['parameter', 'localparam'].includes(bound.kind) ? { ...dimension, kind: 'fixed' } : dimension;
            });
            array = { kind: dimensions[0].kind, dimensions };
        }
        return { ref: definition || (symbol.members && !['function', 'task'].includes(symbol.kind) ? item : null), source: item, type: resolvedType, array,
            bindings: definition ? bindingsFor(definition.symbol, resolvedType) : {} };
    }

    function resolve(expression) {
        let text = String(expression || '').trim();
        const access = splitAccess(text);
        if (access) {
            const owner = resolve(access[0]);
            if (!owner) return null;
            const childName = access[1].replace(/\([\s\S]*$/, '').replace(/\[[\s\S]*$/, '').trim();
            const child = members(owner, access[2] === '::', access[0] === 'this' ? true : access[0] === 'super' ? 'inherited' : false).find(item => item.symbol.name === childName);
            if (child) return applyIndices(value(child), access[1]);
            const builtin = builtinMembers(owner).find(member => member.name === childName);
            if (builtin) {
                const element = owner.bindings?.T || typeName(owner.type);
                const returned = builtin.returnType === 'self' ? owner.type : String(builtin.returnType || builtin.type || '').replace(/\belement\b/g, element);
                const remaining = owner.array?.dimensions.slice(1) || [];
                const dimensions = /\[\$\]$/.test(returned) ? [{ kind: 'queue', text: '$' }, ...remaining] : builtin.returnType === 'element' ? remaining : [];
                return { ...value(ref(builtin), returned), array: dimensions.length ? { kind: dimensions[0].kind, dimensions } : undefined };
            }
            return null;
        }
        if (text === 'this' || text === 'super') {
            const clsScope = enclosing(context.scope).find(scope => scope.kind === 'class');
            const cls = clsScope && model.symbols.find(symbol => symbol.bodyScope === clsScope.id);
            return cls ? { ref: text === 'super' ? findType(cls.base) : ref(cls, current), type: text === 'super' ? cls.base : cls.name } : null;
        }
        if (text === 'uvm_pkg' || text === 'std') return { ref: ref({ name: text, kind: 'package' }), type: text };
        const name = text.replace(/\[[\s\S]*$/, '').replace(/\s*#\s*\([\s\S]*$/, '').replace(/\([\s\S]*$/, '').trim();
        const item = findVisible(name) || findType(name);
        if (item) return applyIndices(value(item), text);
        if (catalog.builtins?.[name]) return { type: name };
        return null;
    }

    function applyIndices(target, text) {
        if (!target?.array) return target;
        const indices = (text.replace(/#\s*\([\s\S]*\)/g, '').match(/\[[^\]]*\]/g) || []).length;
        if (!indices) return target;
        const dimensions = (target.array.dimensions || []).slice(indices);
        return { ...target, array: dimensions.length ? { kind: dimensions[0].kind, dimensions } : null };
    }

    function builtinMembers(target) {
        const builtins = catalog.builtins || {}, kinds = [];
        if (target?.array) {
            const name = { dynamic: 'dynamicArray', associative: 'associativeArray', queue: 'queue', fixed: 'array' }[target.array.kind];
            kinds.push(name || 'array');
        } else {
            const name = typeName(target?.type);
            if (builtins[name]) kinds.push(name);
            if (target?.ref?.symbol.kind === 'enum' || target?.ref?.symbol.type === 'enum') kinds.push('enum');
            if (target?.ref?.symbol.kind === 'covergroup') kinds.push('covergroup');
            if (target?.ref?.symbol.kind === 'class') kinds.push('class', 'object');
            if (target?.ref?.symbol.kind === 'sequence') kinds.push('sequence');
            if (target?.source?.symbol.random) kinds.push('rand');
        }
        return [...new Map(kinds.flatMap(kind => builtins[kind] || []).map(member => [member.name, member])).values()];
    }

    return { visible, findType, resolve, members, builtinMembers, packageMembers, globals };
}

module.exports = { createResolver, splitAccess, typeName, typeArguments };
