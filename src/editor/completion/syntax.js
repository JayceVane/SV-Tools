'use strict';

// 补全需要保留未完成语句的边界；这里建立轻量语义索引，不执行预处理或 elaboration。
const OPEN_SCOPES = new Map([
    ['module', 'endmodule'], ['macromodule', 'endmodule'], ['interface', 'endinterface'],
    ['package', 'endpackage'], ['program', 'endprogram'], ['class', 'endclass'],
    ['function', 'endfunction'], ['task', 'endtask'], ['covergroup', 'endgroup'],
    ['property', 'endproperty'], ['sequence', 'endsequence'], ['clocking', 'endclocking'],
    ['checker', 'endchecker'], ['primitive', 'endprimitive'], ['config', 'endconfig'],
    ['specify', 'endspecify'],
    ['generate', 'endgenerate'], ['begin', 'end'], ['fork', 'join']
]);
const CLOSE_SCOPES = new Set([...OPEN_SCOPES.values(), 'join_any', 'join_none']);
const DIRECTIONS = new Set(['input', 'output', 'inout', 'ref']);
const QUALIFIERS = new Set(['const', 'var', 'static', 'automatic', 'local', 'protected', 'rand', 'randc', 'virtual']);
const NET_TYPES = new Set(['wire', 'tri', 'tri0', 'tri1', 'triand', 'trior', 'trireg', 'wand', 'wor', 'uwire', 'supply0', 'supply1', 'interconnect']);
const BUILTIN_TYPES = new Set(['bit', 'logic', 'reg', 'byte', 'shortint', 'int', 'longint', 'integer', 'time', 'shortreal', 'real', 'realtime', 'string', 'chandle', 'event', 'void', 'signed', 'unsigned']);
const NON_DECLARATIONS = new Set([
    ...OPEN_SCOPES.keys(), ...CLOSE_SCOPES, 'if', 'else', 'for', 'foreach', 'while', 'repeat',
    'forever', 'do', 'case', 'casex', 'casez', 'endcase', 'assign', 'deassign', 'force',
    'release', 'always', 'always_ff', 'always_comb', 'always_latch', 'initial', 'final',
    'return', 'break', 'continue', 'wait', 'disable', 'assert', 'assume', 'cover',
    'expect', 'restrict', 'bind', 'export', 'default', 'solve', 'constraint'
]);
const MULTI_OPERATORS = ['<<<', '>>>', '===', '!==', '==?', '!=?', '|->', '|=>', '##', '::', '->', '=>', '.*', '++', '--', '<=', '>=', '==', '!=', '&&', '||', '<<', '>>', '**', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '~&', '~|', '~^', '^~', '+:', '-:'];

/** @param {string} text @returns {Array<object>} 保留偏移和注释/字符串，容忍 EOF 前未闭合内容。 */
function tokenize(text) {
    const tokens = [];
    let offset = 0;
    while (offset < text.length) {
        if (/\s/.test(text[offset])) { offset++; continue; }
        const start = offset;
        let kind = 'operator';
        let closed = true;
        if (text.startsWith('//', offset)) {
            kind = 'comment';
            offset = text.indexOf('\n', offset);
            if (offset < 0) offset = text.length;
        } else if (text.startsWith('/*', offset)) {
            kind = 'comment';
            const end = text.indexOf('*/', offset + 2);
            closed = end >= 0;
            offset = closed ? end + 2 : text.length;
        } else if (text[offset] === '"') {
            kind = 'string';
            offset++;
            closed = false;
            while (offset < text.length) {
                if (text[offset] === '\\') { offset += Math.min(2, text.length - offset); continue; }
                if (text[offset++] === '"') { closed = true; break; }
            }
        } else if (text[offset] === '\\') {
            kind = 'identifier';
            offset++;
            while (offset < text.length && !/\s/.test(text[offset])) offset++;
        } else if (text[offset] === '`') {
            kind = 'macro';
            offset++;
            while (offset < text.length && /[A-Za-z0-9_$]/.test(text[offset])) offset++;
            if (text.slice(start, offset) === '`define') {
                kind = 'define';
                while (offset < text.length) {
                    const newline = text.indexOf('\n', offset);
                    if (newline < 0) { offset = text.length; break; }
                    let end = newline;
                    if (text[end - 1] === '\r') end--;
                    if (text[end - 1] !== '\\') { offset = newline; break; }
                    offset = newline + 1;
                }
            }
        } else if (text[offset] === '$' && /[A-Za-z_]/.test(text[offset + 1] || '')) {
            kind = 'system';
            offset++;
            while (offset < text.length && /[A-Za-z0-9_$]/.test(text[offset])) offset++;
        } else if (/[A-Za-z_]/.test(text[offset])) {
            kind = 'identifier';
            offset++;
            while (offset < text.length && /[A-Za-z0-9_$]/.test(text[offset])) offset++;
        } else if (/\d/.test(text[offset]) || /^'[sS]?[bBoOdDhH01xXzZ]/.test(text.slice(offset))) {
            kind = 'number';
            const number = text.slice(offset).match(/^(?:\d[\d_]*(?:'[sS]?[bBoOdDhH]\s*[\da-fA-F_xXzZ?]+|(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?(?:fs|ps|ns|us|ms|s)?)|'[sS]?[bBoOdDhH]\s*[\da-fA-F_xXzZ?]+|'[01xXzZ])/);
            offset += number ? number[0].length : 1;
        } else {
            const operator = MULTI_OPERATORS.find(value => text.startsWith(value, offset));
            offset += operator ? operator.length : 1;
        }
        tokens.push({ kind, value: text.slice(start, offset), start, end: offset, closed });
    }
    return tokens;
}

/** @param {Array<object>} tokens @returns {Map<number,number>} 双向配对表；不完整括号保持未配对。 */
function matchDelimiters(tokens) {
    const pairs = new Map();
    const stack = [];
    const openers = { ')': '(', ']': '[', '}': '{' };
    for (let index = 0; index < tokens.length; index++) {
        const value = tokens[index].value;
        if (['(', '[', '{'].includes(value)) stack.push(index);
        else if (Object.hasOwn(openers, value)) {
            let candidate = stack.length - 1;
            while (candidate >= 0 && tokens[stack[candidate]].value !== openers[value]) candidate--;
            if (candidate < 0) continue;
            const begin = stack[candidate];
            stack.length = candidate;
            pairs.set(begin, index);
            pairs.set(index, begin);
        }
    }
    return pairs;
}

function joinType(tokens) {
    return tokens.map(token => token.value).join(' ').replace(/\s*::\s*/g, '::').replace(/\s*\.\s*/g, '.').trim();
}

function splitTopLevel(tokens, separator = ',') {
    const groups = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < tokens.length; index++) {
        const value = tokens[index].value;
        if (['(', '[', '{'].includes(value)) depth++;
        else if ([')', ']', '}'].includes(value)) depth--;
        if (value === separator && depth === 0) { groups.push(tokens.slice(start, index)); start = index + 1; }
    }
    groups.push(tokens.slice(start));
    return groups;
}

function beforeAssignment(tokens) {
    let depth = 0;
    for (let index = 0; index < tokens.length; index++) {
        const value = tokens[index].value;
        if (['(', '[', '{'].includes(value)) depth++;
        else if ([')', ']', '}'].includes(value)) depth--;
        else if (value === '=' && depth === 0) return tokens.slice(0, index);
    }
    return tokens;
}

function dimensionsAfter(tokens, nameIndex) {
    const dimensions = [];
    for (let index = nameIndex + 1; index < tokens.length; index++) {
        if (tokens[index].value !== '[') break;
        const begin = index++;
        while (index < tokens.length && tokens[index].value !== ']') index++;
        const contents = tokens.slice(begin + 1, index);
        const raw = joinType(contents);
        const kind = contents.length === 0 ? 'dynamic' : contents[0].value === '$' || raw.startsWith('$') ? 'queue'
            : raw === '*' || BUILTIN_TYPES.has(contents[0]?.value) ? 'associative' : 'fixed';
        dimensions.push({ kind, text: raw });
    }
    return dimensions.length ? { kind: dimensions[0].kind, dimensions } : undefined;
}

function unpackedNameIndex(tokens) {
    let depth = 0;
    let result = -1;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (['(', '[', '{'].includes(token.value)) depth++;
        else if ([')', ']', '}'].includes(token.value)) depth--;
        else if (depth === 0 && token.kind === 'identifier') result = index;
    }
    return result;
}

function stripPacked(tokens) {
    const output = [];
    let depth = 0;
    for (const token of tokens) {
        if (token.value === '[') { depth++; continue; }
        if (token.value === ']') { depth--; continue; }
        if (depth === 0 && !QUALIFIERS.has(token.value) && !DIRECTIONS.has(token.value)
            && !['parameter', 'localparam', 'typedef'].includes(token.value)) output.push(token);
    }
    return output;
}

function declarationSymbols(tokens, scope, inherited = null, forcedKind = null) {
    if (!tokens.length || NON_DECLARATIONS.has(tokens[0].value) || ['.', '@', '#', ':'].includes(tokens[0].value)
        || ['system', 'macro', 'define'].includes(tokens[0].kind)) return [];
    const symbols = [];
    let previous = inherited;
    for (const group of splitTopLevel(tokens)) {
        const declaration = beforeAssignment(group);
        const nameIndex = unpackedNameIndex(declaration);
        if (nameIndex < 0) continue;
        const name = declaration[nameIndex];
        let typeTokens = declaration.slice(0, nameIndex);
        // 表达式不是声明；不把 obj.method()、a+b 或 pkg::value 写入符号表。
        if (stripPacked(typeTokens).some(token => ['=', '+', '-', '!', '?', '&&', '||'].includes(token.value))
            || ['.', '::'].includes(typeTokens[typeTokens.length - 1]?.value)
            || (declaration[nameIndex + 1] && !['['].includes(declaration[nameIndex + 1].value))) continue;
        const hasType = typeTokens.some(token => token.kind === 'identifier' && !QUALIFIERS.has(token.value)
            && !DIRECTIONS.has(token.value) && !['parameter', 'localparam', 'typedef'].includes(token.value));
        if (!hasType && !previous && !typeTokens.some(token => DIRECTIONS.has(token.value) || ['parameter', 'localparam'].includes(token.value))) continue;
        const values = new Set(typeTokens.map(token => token.value));
        const kind = (values.has('localparam') || !hasType && previous?.kind === 'localparam') ? 'localparam' : forcedKind || (values.has('typedef') ? 'typedef'
            : values.has('parameter') ? 'parameter' : [...DIRECTIONS].some(value => values.has(value)) ? 'port'
                : [...NET_TYPES].some(value => values.has(value)) ? 'net' : previous?.kind || 'variable');
        const type = hasType ? joinType(stripPacked(typeTokens)) : previous?.type || (kind === 'port' ? 'logic' : 'int');
        const symbol = {
            name: name.value, kind, type, scope, start: name.start, end: name.end,
            static: values.has('static') || previous?.static || false,
            visibility: values.has('local') ? 'local' : values.has('protected') ? 'protected' : previous?.visibility || 'public'
        };
        if (values.has('rand') || values.has('randc') || previous?.random) symbol.random = true;
        const array = dimensionsAfter(declaration, nameIndex);
        if (array) symbol.array = array;
        const direction = [...DIRECTIONS].find(value => values.has(value)) || previous?.direction;
        if (direction) symbol.direction = direction;
        symbols.push(symbol);
        previous = symbol;
    }
    return symbols;
}

function scopeHeader(tokens, start, pairs, textLength) {
    for (let index = start; index < tokens.length; index++) {
        const value = tokens[index].value;
        if (['(', '[', '{'].includes(value)) {
            const close = pairs.get(index);
            if (close !== undefined) { index = close; continue; }
        }
        if (value === ';') return { index, end: tokens[index].end };
        if (CLOSE_SCOPES.has(value)) return { index: index - 1, end: tokens[index].start };
    }
    return { index: tokens.length, end: textLength };
}

function headerName(tokens, index, header, pairs) {
    const kind = tokens[index].value;
    if (['begin', 'fork', 'generate', 'specify'].includes(kind)) return tokens[index + 1]?.value === ':' ? tokens[index + 2] : null;
    if (kind === 'function' || kind === 'task') {
        let end = header.index;
        for (let cursor = index + 1; cursor < header.index; cursor++) {
            if (tokens[cursor].value === '#') { const close = pairs.get(cursor + 1); if (close !== undefined) cursor = close; }
            else if (tokens[cursor].value === '(') { end = cursor; break; }
        }
        for (let cursor = end - 1; cursor > index; cursor--) if (tokens[cursor]?.kind === 'identifier') return tokens[cursor];
        return null;
    }
    let cursor = index + 1;
    while (['automatic', 'static', 'virtual'].includes(tokens[cursor]?.value)) cursor++;
    return tokens[cursor]?.kind === 'identifier' ? tokens[cursor] : null;
}

function modifiersBefore(tokens, index) {
    const modifiers = [];
    while (index > 0 && ['pure', 'virtual', 'extern', 'local', 'protected', 'static', 'automatic'].includes(tokens[index - 1].value)) {
        modifiers.unshift(tokens[--index].value);
    }
    return modifiers;
}

function scopeRangeContains(scope, offset, textLength) {
    return offset >= scope.start && (offset < scope.end || (scope.end === textLength && offset === textLength));
}

function firstTokenAt(tokens, offset) {
    let low = 0;
    let high = tokens.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (tokens[middle].start < offset) low = middle + 1;
        else high = middle;
    }
    return low;
}

function loopBodyEnd(tokens, bodyIndex, pairs, textLength) {
    if (tokens[bodyIndex]?.value === 'begin') {
        let depth = 1;
        for (let index = bodyIndex + 1; index < tokens.length; index++) {
            if (tokens[index].value === 'begin') depth++;
            else if (tokens[index].value === 'end' && --depth === 0) return tokens[index].end;
        }
        return textLength;
    }
    for (let index = bodyIndex; index < tokens.length; index++) {
        if (['(', '[', '{'].includes(tokens[index].value)) {
            const close = pairs.get(index);
            if (close !== undefined) index = close;
        } else if (tokens[index].value === ';') return tokens[index].end;
        else if (CLOSE_SCOPES.has(tokens[index].value)) return tokens[index].start;
    }
    return textLength;
}

function parseScopes(model) {
    const { significantTokens: tokens, delimiterPairs: pairs, text, scopes } = model;
    const stack = [scopes[0]];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        while (stack.length > 1 && stack[stack.length - 1].end <= token.start) stack.pop();
        if (token.value === 'constraint' && tokens[index + 1]?.kind === 'identifier' && tokens[index + 2]?.value === '{') {
            const close = pairs.get(index + 2);
            const scope = { id: scopes.length, kind: 'block', name: '', parent: stack[stack.length - 1].id,
                start: token.start, end: close === undefined ? text.length : tokens[close].end,
                headerEnd: tokens[index + 2].end, symbols: [], imports: [], terminator: null };
            scopes.push(scope);
            const name = tokens[index + 1];
            const modifiers = modifiersBefore(tokens, index);
            const symbol = { name: name.value, kind: 'constraint', type: 'constraint', scope: scope.parent,
                bodyScope: scope.id, start: name.start, end: name.end,
                visibility: modifiers.includes('local') ? 'local' : modifiers.includes('protected') ? 'protected' : 'public', static: false };
            model.symbols.push(symbol);
            scopes[scope.parent].symbols.push(symbol);
            scope.symbol = symbol;
            stack.push(scope);
            continue;
        }
        if (['coverpoint', 'cross'].includes(token.value) && tokens[index - 1]?.value === ':' && tokens[index - 2]?.kind === 'identifier') {
            const name = tokens[index - 2];
            let body = index + 1;
            while (body < tokens.length && !['{', ';', 'endgroup'].includes(tokens[body].value)) body++;
            const close = tokens[body]?.value === '{' ? pairs.get(body) : body;
            const scope = { id: scopes.length, kind: 'block', name: '', parent: stack[stack.length - 1].id,
                start: name.start, end: close === undefined ? text.length : tokens[close]?.end || text.length,
                headerEnd: tokens[body]?.end || text.length, symbols: [], imports: [], terminator: null };
            scopes.push(scope);
            const symbol = { name: name.value, kind: token.value, type: token.value, scope: scope.parent,
                bodyScope: scope.id, start: name.start, end: name.end, visibility: 'public', static: false };
            model.symbols.push(symbol);
            scopes[scope.parent].symbols.push(symbol);
            scope.symbol = symbol;
            stack.push(scope);
            continue;
        }
        if (['for', 'foreach'].includes(token.value) && tokens[index + 1]?.value === '(') {
            const close = pairs.get(index + 1);
            if (close !== undefined) {
                const scope = { id: scopes.length, kind: 'block', name: '', parent: stack[stack.length - 1].id,
                    start: token.start, end: loopBodyEnd(tokens, close + 1, pairs, text.length), headerEnd: tokens[close].end,
                    symbols: [], imports: [], terminator: null, loopKind: token.value,
                    loopHeader: tokens.slice(index + 2, close) };
                scopes.push(scope);
                stack.push(scope);
            }
            continue;
        }
        if (CLOSE_SCOPES.has(token.value)) {
            let closeIndex = stack.length - 1;
            while (closeIndex > 0 && stack[closeIndex].terminator !== token.value
                && !(stack[closeIndex].terminator === 'join' && token.value.startsWith('join'))) closeIndex--;
            if (closeIndex === 0) continue;
            for (let inner = stack.length - 1; inner >= closeIndex; inner--) scopes[stack[inner].id].end = token.end;
            stack.length = closeIndex;
            continue;
        }
        if (!OPEN_SCOPES.has(token.value)) continue;
        // virtual interface 是数据类型，typedef class 是前向声明，interface class 的 class 才开启作用域。
        if (token.value === 'interface' && ['virtual', 'typedef'].includes(tokens[index - 1]?.value)) continue;
        if (token.value === 'interface' && tokens[index + 1]?.value === 'class') continue;
        if (tokens[index - 1]?.value === 'typedef') continue;
        // assert property / cover sequence 的调用不声明新作用域。
        if (['property', 'sequence'].includes(token.value) && tokens[index + 1]?.value === '(') continue;
        const header = ['begin', 'fork', 'generate', 'specify'].includes(token.value)
            ? { index, end: tokens[index + (tokens[index + 1]?.value === ':' ? 2 : 0)]?.end || token.end }
            : scopeHeader(tokens, index + 1, pairs, text.length);
        const nameToken = headerName(tokens, index, header, pairs);
        const kind = token.value === 'macromodule' ? 'module' : ['begin', 'fork'].includes(token.value) ? 'block' : token.value;
        const parent = stack[stack.length - 1];
        const modifiers = modifiersBefore(tokens, index);
        let statementStart = index - 1;
        while (statementStart >= 0 && ![';', 'endclass', 'endfunction', 'endtask'].includes(tokens[statementStart].value)) statementStart--;
        const isDpi = ['function', 'task'].includes(kind) && tokens.slice(statementStart + 1, index).some(item => item.value === 'import' || item.value === 'export');
        const prototype = ['function', 'task'].includes(kind) && (modifiers.includes('extern') || modifiers.includes('pure') || isDpi);
        const scope = {
            id: scopes.length, kind, name: nameToken?.value || '', start: token.start, end: prototype ? header.end : text.length,
            headerEnd: header.end, parent: parent.id, symbols: [], imports: [], terminator: OPEN_SCOPES.get(token.value)
        };
        scopes.push(scope);
        if (nameToken) {
            const symbol = { name: nameToken.value, kind, type: '', scope: parent.id, bodyScope: scope.id,
                start: nameToken.start, end: nameToken.end, static: modifiers.includes('static'),
                visibility: modifiers.includes('local') ? 'local' : modifiers.includes('protected') ? 'protected' : 'public', members: scope.symbols };
            if (kind === 'function' || kind === 'task') {
                const nameIndex = tokens.indexOf(nameToken);
                let ownerStart = nameIndex;
                while (tokens[ownerStart - 1]?.value === '::' && tokens[ownerStart - 2]?.kind === 'identifier') ownerStart -= 2;
                const returnTokens = tokens.slice(index + 1, ownerStart);
                if (ownerStart < nameIndex) symbol.owner = joinType(tokens.slice(ownerStart, nameIndex - 1));
                if (kind === 'function') {
                    symbol.type = joinType(stripPacked(returnTokens)) || (nameToken.value === 'new' ? symbol.owner || parent.name : 'logic');
                    symbol.returnType = symbol.type;
                }
            }
            if (kind === 'class') {
                const extendsIndex = tokens.slice(index + 1, header.index).findIndex(item => item.value === 'extends');
                if (extendsIndex >= 0) {
                    const from = index + 2 + extendsIndex;
                    let end = from;
                    while (end < header.index && tokens[end].value !== 'implements') end++;
                    scope.base = joinType(tokens.slice(from, end));
                    symbol.base = scope.base;
                }
            }
            model.symbols.push(symbol);
            parent.symbols.push(symbol);
            scope.symbol = symbol;
        }
        if (!prototype) stack.push(scope);
    }
    for (const scope of scopes) if (scope.symbol) {
        scope.symbol.nameEnd = scope.symbol.end;
        scope.symbol.end = scope.end;
    }
}

function addSymbols(model, symbols) {
    for (const symbol of symbols) {
        const scope = model.scopes[symbol.scope];
        const key = symbol.kind + ':' + symbol.name;
        const known = model.symbolKeys.get(scope.id);
        if (known.has(key)) continue;
        known.add(key);
        scope.symbols.push(symbol);
        model.symbols.push(symbol);
    }
}

function parseHeaderDeclarations(model, scope) {
    if (scope.loopHeader) {
        if (scope.loopKind === 'for') addSymbols(model, declarationSymbols(splitTopLevel(scope.loopHeader, ';')[0], scope.id));
        else {
            const bracket = scope.loopHeader.findIndex(token => token.value === '[');
            for (const token of scope.loopHeader.slice(bracket + 1)) if (token.kind === 'identifier') addSymbols(model, [{
                name: token.value, kind: 'variable', type: 'int', scope: scope.id, start: token.start, end: token.end,
                visibility: 'public', static: false, iteratorKind: 'foreachIndex'
            }]);
        }
        return;
    }
    if (!['module', 'interface', 'program', 'checker', 'primitive', 'function', 'task', 'class', 'covergroup'].includes(scope.kind)) return;
    const tokens = model.significantTokens;
    const start = firstTokenAt(tokens, scope.start);
    for (let index = start + 1; index < tokens.length && tokens[index].start < scope.headerEnd; index++) {
        if (tokens[index].value !== '(') continue;
        const extendsIndex = tokens.slice(start + 1, index).findIndex(token => token.value === 'extends');
        if (scope.kind === 'class' && extendsIndex >= 0) continue;
        let inherited = null;
        const close = model.delimiterPairs.get(index);
        const end = close ?? tokens.findIndex((token, candidate) => candidate > index && token.start >= scope.headerEnd);
        const list = tokens.slice(index + 1, end < 0 ? tokens.length : end);
        const isParameter = tokens[index - 1]?.value === '#';
        for (const group of splitTopLevel(list)) {
            const symbols = declarationSymbols(group, scope.id, inherited, isParameter ? 'parameter'
                : ['function', 'task', 'covergroup'].includes(scope.kind) ? 'port' : null);
            addSymbols(model, symbols);
            if (!isParameter && ['function', 'task'].includes(scope.kind) && scope.symbol) {
                scope.symbol.arguments ||= [];
                scope.symbol.arguments.push(...symbols);
            }
            if (isParameter && scope.symbol) {
                scope.symbol.parameters ||= [];
                scope.symbol.parameters.push(...symbols.filter(symbol => symbol.kind === 'parameter'));
                for (const symbol of symbols) {
                    const equals = group.findIndex(token => token.value === '=');
                    if (equals >= 0) symbol.default = joinType(group.slice(equals + 1));
                }
            }
            if (symbols.length) inherited = symbols[symbols.length - 1];
        }
        if (close !== undefined) index = close;
    }
}

function parseImportsAndMacros(model) {
    const tokens = model.significantTokens;
    for (const token of model.tokens) {
        if (token.kind !== 'define') continue;
        const definition = token.value.match(/^`define\s+(\w+)(\(([^\r\n]*?)\))?/);
        if (!definition) continue;
        model.macros.push({ name: definition[1], kind: 'macro', type: '', start: token.start, end: token.end,
            scope: model.scopeAt(token.start).id, parameters: definition[3] === undefined ? null : definition[3].split(',').map(value => value.trim()).filter(Boolean),
            definitionBody: token.value.slice(definition[0].length).trim() });
    }
    for (let index = 0; index < tokens.length; index++) {
        if (tokens[index].value !== 'import') continue;
        let end = index + 1;
        while (end < tokens.length && tokens[end].value !== ';') end++;
        // DPI import 的字符串后方为函数原型；不把其参数当包导入。
        for (const group of splitTopLevel(tokens.slice(index + 1, end))) {
            const separator = group.findIndex(token => token.value === '::');
            if (separator < 0 || !group[separator + 1]) continue;
            const scope = model.scopeAt(tokens[index].start);
            const entry = { package: joinType(group.slice(0, separator)), name: group[separator + 1].value,
                wildcard: group[separator + 1].value === '*',
                scope: scope.id, start: tokens[index].start, end: tokens[end]?.end || model.text.length };
            model.imports.push(entry);
            scope.imports.push(entry);
        }
    }
}

function compoundSymbols(tokens, scope) {
    const compoundIndex = tokens.findIndex(token => ['struct', 'union', 'enum'].includes(token.value));
    const braceIndex = tokens.findIndex(token => token.value === '{');
    if (compoundIndex < 0 || braceIndex < 0) return null;
    let depth = 1;
    let close = braceIndex + 1;
    while (close < tokens.length && depth > 0) {
        if (tokens[close].value === '{') depth++;
        else if (tokens[close].value === '}') depth--;
        if (depth > 0) close++;
    }
    if (close >= tokens.length) return { symbols: [], enumMembers: [] };
    const members = [];
    const enumMembers = [];
    const isEnum = tokens[compoundIndex].value === 'enum';
    if (isEnum) {
        for (const group of splitTopLevel(tokens.slice(braceIndex + 1, close))) {
            const name = group.find(token => token.kind === 'identifier');
            if (name) members.push({ name: name.value, kind: 'enumMember', type: '', scope,
                start: name.start, end: name.end, visibility: 'public', static: true });
        }
        enumMembers.push(...members);
    } else {
        for (const group of splitTopLevel(tokens.slice(braceIndex + 1, close), ';')) {
            const nested = compoundSymbols(group, scope);
            if (nested) {
                members.push(...nested.symbols);
                enumMembers.push(...nested.enumMembers);
            } else members.push(...declarationSymbols(group, scope));
        }
    }
    const tails = tokens.slice(close + 1);
    const typedef = tokens[0].value === 'typedef';
    const symbols = [];
    for (const group of splitTopLevel(tails)) {
        const name = group.find(token => token.kind === 'identifier');
        if (!name) continue;
        const symbol = { name: name.value, kind: typedef ? 'typedef' : 'variable', type: tokens[compoundIndex].value,
            members, scope, start: name.start, end: name.end, visibility: 'public', static: false };
        if (tokens.slice(0, compoundIndex).some(token => ['rand', 'randc'].includes(token.value))) symbol.random = true;
        const array = dimensionsAfter(group, group.indexOf(name));
        if (array) symbol.array = array;
        symbols.push(symbol);
        if (isEnum) for (const member of members) member.type = name.value;
    }
    return { symbols, enumMembers };
}

function parseCompoundDeclaration(model, tokens, scope) {
    const compound = compoundSymbols(tokens, scope);
    if (!compound) return false;
    addSymbols(model, [...compound.enumMembers, ...compound.symbols]);
    return true;
}

function modportSymbol(group, scope) {
    const name = group[0];
    if (name?.kind !== 'identifier') return null;
    const open = group.findIndex(token => token.value === '(');
    const contents = open < 0 ? [] : group.slice(open + 1, group[group.length - 1]?.value === ')' ? -1 : undefined);
    const exposed = [];
    let direction = 'input';
    for (const entry of splitTopLevel(contents)) {
        if (!entry.length) continue;
        if (DIRECTIONS.has(entry[0].value) || ['import', 'export', 'clocking'].includes(entry[0].value)) direction = entry[0].value;
        const openCall = entry.findIndex(token => token.value === '(');
        const names = (openCall < 0 ? entry : entry.slice(0, openCall)).filter(token => token.kind === 'identifier'
            && !DIRECTIONS.has(token.value) && !BUILTIN_TYPES.has(token.value) && !['import', 'export', 'function', 'task', 'clocking'].includes(token.value));
        const exposedName = names[names.length - 1];
        if (!exposedName) continue;
        const aliased = entry.slice(0, openCall < 0 ? entry.length : openCall).some(token => token.value === '.');
        exposed.push({ name: exposedName.value, sourceName: aliased ? entry.slice(openCall + 1).find(token => token.kind === 'identifier')?.value : exposedName.value,
            kind: ['import', 'export'].includes(direction) ? 'function' : 'port', direction, start: exposedName.start, end: exposedName.end });
    }
    return { name: name.value, kind: 'modport', type: scope.name, scope: scope.id, start: name.start, end: name.end,
        visibility: 'public', static: false, exposed, members: [] };
}

function resolveModportMembers(model) {
    for (const scope of model.scopes) {
        if (scope.kind !== 'interface') continue;
        const symbols = new Map(scope.symbols.map(symbol => [symbol.name, symbol]));
        for (const symbol of scope.symbols) {
            if (symbol.kind !== 'modport') continue;
            symbol.exposedNames = symbol.exposed.map(exposed => exposed.name);
            symbol.members = symbol.exposed.map(exposed => {
                const source = symbols.get(exposed.sourceName);
                return { ...source, ...exposed, kind: source && ['function', 'task', 'clocking'].includes(source.kind) ? source.kind : exposed.kind,
                    type: source?.type || 'logic', scope: scope.id, visibility: 'public', static: source?.static || false };
            });
        }
    }
}

function parseBodyDeclarations(model, scope) {
    const tokens = model.significantTokens;
    const childScopes = model.childrenByScope.get(scope.id) || [];
    const childByStart = new Map(childScopes.map(child => [child.start, child]));
    let statement = [];
    let depth = 0;
    const begin = scope.kind === 'root' ? scope.start : scope.headerEnd;
    for (let index = firstTokenAt(tokens, begin); index < tokens.length && tokens[index].start < scope.end; index++) {
        const token = tokens[index];
        const child = childByStart.get(token.start);
        if (child) {
            statement = [];
            depth = 0;
            while (index + 1 < tokens.length && tokens[index + 1].start < child.end) index++;
            continue;
        }
        if (CLOSE_SCOPES.has(token.value)) { statement = []; continue; }
        if (token.kind === 'macro' && statement.length === 0) {
            if (tokens[index + 1]?.value === '(') {
                const close = model.delimiterPairs.get(index + 1);
                if (close !== undefined) index = close;
            }
            continue;
        }
        if (['(', '[', '{'].includes(token.value)) depth++;
        else if ([')', ']', '}'].includes(token.value)) depth = Math.max(0, depth - 1);
        if (token.value === '}' && depth === 0 && statement[0]?.value === 'constraint') { statement = []; continue; }
        if (token.value === ';' && depth === 0) {
            if (!parseCompoundDeclaration(model, statement, scope.id)) {
                if (statement[0]?.value === 'modport') {
                    for (const group of splitTopLevel(statement.slice(1))) {
                        const symbol = modportSymbol(group, scope);
                        if (symbol) addSymbols(model, [symbol]);
                    }
                } else addSymbols(model, declarationSymbols(statement, scope.id));
            }
            statement = [];
        } else statement.push(token);
    }
    // 正在输入的声明也参与索引，但不把孤立类型名误当变量。
    if (statement.length && depth === 0) addSymbols(model, declarationSymbols(statement, scope.id));
}

function connectionRange(model, open, close) {
    const tokens = model.significantTokens;
    const usedNames = [];
    let depth = 0;
    for (let index = open + 1; index < (close ?? tokens.length); index++) {
        const value = tokens[index].value;
        if (['(', '[', '{'].includes(value)) depth++;
        else if ([')', ']', '}'].includes(value)) depth--;
        if (value === '.' && depth === 0 && tokens[index + 1]?.kind === 'identifier') usedNames.push(tokens[index + 1].value);
    }
    return { start: tokens[open].start, end: close === undefined ? model.text.length : tokens[close].end,
        usedNames, openToken: open, closeToken: close };
}

function parseInstances(model) {
    const { significantTokens: tokens, delimiterPairs: pairs } = model;
    for (let index = 0; index < tokens.length; index++) {
        const first = tokens[index];
        if (first.kind !== 'identifier' || NON_DECLARATIONS.has(first.value) || BUILTIN_TYPES.has(first.value)
            || DIRECTIONS.has(first.value) || QUALIFIERS.has(first.value) || NET_TYPES.has(first.value)
            || ['typedef', 'parameter', 'localparam', 'import', 'modport'].includes(first.value)) continue;
        // 类型只允许在语句边界出现，避免把参数表达式中的 function call 当实例。
        const previous = tokens[index - 1];
        if (previous && ![';', 'end', 'endgenerate', ':', 'begin', ')'].includes(previous.value)) continue;
        const scope = model.scopeAt(first.start);
        if (!['module', 'interface', 'program', 'generate', 'block', 'root'].includes(scope.kind)) continue;
        if (first.start < scope.headerEnd) continue;
        let cursor = index + 1;
        while (tokens[cursor]?.value === '::' && tokens[cursor + 1]?.kind === 'identifier') cursor += 2;
        const type = joinType(tokens.slice(index, cursor));
        let parameters;
        if (tokens[cursor]?.value === '#' && tokens[cursor + 1]?.value === '(') {
            const open = cursor + 1;
            const close = pairs.get(open);
            parameters = connectionRange(model, open, close);
            if (close === undefined) {
                model.instances.push({ type, name: '', scope: scope.id, start: first.start, end: model.text.length, parameters });
                continue;
            }
            cursor = close + 1;
        }
        // 一个类型可以声明多个实例；参数区间归属于每个实例。
        while (tokens[cursor]?.kind === 'identifier') {
            const name = tokens[cursor++];
            while (tokens[cursor]?.value === '[') {
                const close = pairs.get(cursor);
                if (close === undefined) break;
                cursor = close + 1;
            }
            if (tokens[cursor]?.value !== '(') break;
            const open = cursor;
            const close = pairs.get(open);
            const ports = connectionRange(model, open, close);
            const instance = { type, name: name.value, scope: scope.id, start: first.start,
                end: close === undefined ? model.text.length : tokens[close].end, ports };
            if (parameters) instance.parameters = parameters;
            model.instances.push(instance);
            addSymbols(model, [{ name: name.value, kind: 'instance', type, scope: scope.id, start: name.start,
                end: name.end, static: false, visibility: 'public' }]);
            if (close === undefined) break;
            cursor = close + 1;
            if (tokens[cursor]?.value !== ',') break;
            cursor++;
        }
    }
}

function classPath(model, symbol) {
    const owners = [symbol.name];
    for (let scope = model.scopes[symbol.scope]; scope; scope = scope.parent === null ? null : model.scopes[scope.parent]) {
        if (['package', 'class'].includes(scope.kind) && scope.name) owners.unshift(scope.name);
    }
    return owners.join('::');
}

function mergeExternalMethods(model) {
    const classes = model.symbols.filter(symbol => symbol.kind === 'class');
    const byPath = new Map(classes.map(symbol => [classPath(model, symbol), symbol]));
    const byName = new Map();
    for (const symbol of classes) {
        if (!byName.has(symbol.name)) byName.set(symbol.name, []);
        byName.get(symbol.name).push(symbol);
    }
    const membersByScope = new Map();
    const moved = new Map();
    const removed = new Set();
    for (const method of model.symbols.filter(symbol => ['function', 'task'].includes(symbol.kind) && symbol.owner)) {
        const simple = byName.get(method.owner) || [];
        const owner = byPath.get(method.owner) || byPath.get(classPath(model, { name: method.owner, scope: method.scope }))
            || (simple.length === 1 ? simple[0] : null);
        if (!owner) continue;
        const original = model.scopes[method.scope];
        const destination = model.scopes[owner.bodyScope];
        if (!membersByScope.has(destination.id)) membersByScope.set(destination.id, new Map(destination.symbols.map(symbol => [symbol.kind + ':' + symbol.name, symbol])));
        const memberKey = method.kind + ':' + method.name;
        const existing = membersByScope.get(destination.id).get(memberKey);
        if (!moved.has(original.id)) moved.set(original.id, new Set());
        moved.get(original.id).add(method);
        method.scope = destination.id;
        // childrenByScope 保留文档物理区间；parent 让类外方法查询回到类的语义作用域。
        model.scopes[method.bodyScope].parent = destination.id;
        if (existing) {
            const visibility = existing.visibility;
            const isStatic = existing.static;
            Object.assign(existing, method, { visibility, static: isStatic || method.static });
            model.scopes[method.bodyScope].symbol = existing;
            removed.add(method);
        } else {
            destination.symbols.push(method);
            membersByScope.get(destination.id).set(memberKey, method);
        }
        model.symbolKeys.get(destination.id).add(memberKey);
    }
    for (const [scopeId, methods] of moved) {
        const symbols = model.scopes[scopeId].symbols;
        let length = 0;
        for (const symbol of symbols) if (!methods.has(symbol)) symbols[length++] = symbol;
        symbols.length = length;
        model.symbolKeys.set(scopeId, new Set(symbols.map(symbol => symbol.kind + ':' + symbol.name)));
    }
    if (removed.size) model.symbols = model.symbols.filter(symbol => !removed.has(symbol));
}

/**
 * @param {string} text 源文本，可以包含未闭合括号和声明。
 * @returns {object} 位置索引、作用域树和声明信息；scope/parent 使用数字 id。
 */
function parseDocument(text) {
    const tokens = tokenize(text);
    const significantTokens = tokens.filter(token => !['comment', 'string', 'define'].includes(token.kind));
    const model = {
        text, tokens, significantTokens, delimiterPairs: matchDelimiters(significantTokens),
        scopes: [{ id: 0, kind: 'root', name: '', start: 0, end: text.length, headerEnd: 0, parent: null, symbols: [], imports: [] }],
        symbols: [], instances: [], macros: [], imports: [],
        childrenByScope: new Map(),
        symbolKeys: new Map(),
        scopeAt(offset) {
            let result = this.scopes[0];
            for (;;) {
                const children = this.childrenByScope.get(result.id) || [];
                let low = 0;
                let high = children.length;
                while (low < high) {
                    const middle = (low + high) >>> 1;
                    if (children[middle].start <= offset) low = middle + 1;
                    else high = middle;
                }
                const child = children[low - 1];
                if (!child || !scopeRangeContains(child, offset, this.text.length)) break;
                result = child;
            }
            return result;
        }
    };
    parseScopes(model);
    for (const scope of model.scopes) model.symbolKeys.set(scope.id, new Set(scope.symbols.map(symbol => symbol.kind + ':' + symbol.name)));
    for (const scope of model.scopes.slice(1)) {
        if (!model.childrenByScope.has(scope.parent)) model.childrenByScope.set(scope.parent, []);
        model.childrenByScope.get(scope.parent).push(scope);
    }
    parseImportsAndMacros(model);
    for (const scope of model.scopes) parseHeaderDeclarations(model, scope);
    for (const scope of model.scopes) parseBodyDeclarations(model, scope);
    resolveModportMembers(model);
    const typeNames = new Set(model.symbols.filter(symbol => ['class', 'typedef', 'enum', 'struct'].includes(symbol.kind)).map(symbol => symbol.name));
    for (const symbol of model.symbols) if (symbol.array) {
        for (const dimension of symbol.array.dimensions) if (typeNames.has(dimension.text)) dimension.kind = 'associative';
        symbol.array.kind = symbol.array.dimensions[0].kind;
    }
    parseInstances(model);
    mergeExternalMethods(model);
    return model;
}

function receiverBefore(model, tokenIndex) {
    const tokens = model.significantTokens;
    let index = tokenIndex - 1;
    const end = tokens[index]?.end;
    while (index >= 0) {
        const value = tokens[index].value;
        if ([')', ']'].includes(value)) {
            const open = model.delimiterPairs.get(index);
            if (open === undefined) break;
            index = open - 1;
            continue;
        }
        if (tokens[index].kind === 'identifier') {
            if (NON_DECLARATIONS.has(value) || tokens[index + 1]?.kind === 'identifier') break;
            index--;
            continue;
        }
        if (['.', '::', '#'].includes(value)) { index--; continue; }
        break;
    }
    return end === undefined ? '' : model.text.slice(tokens[index + 1]?.start ?? end, end).trim();
}

function namedConnectionAt(model, range, operatorIndex) {
    if (operatorIndex <= range.openToken || (range.closeToken !== undefined && operatorIndex >= range.closeToken)) return false;
    let depth = 0;
    for (let index = range.openToken + 1; index < operatorIndex; index++) {
        const value = model.significantTokens[index].value;
        if (['(', '[', '{'].includes(value)) depth++;
        else if ([')', ']', '}'].includes(value)) depth--;
    }
    return depth === 0 && ['(', ','].includes(model.significantTokens[operatorIndex - 1]?.value);
}

/** @param {object} model parseDocument 的结果 @param {number} offset @returns {object} 光标补全上下文和替换区间。 */
function contextAt(model, offset) {
    offset = Math.max(0, Math.min(offset, model.text.length));
    const scope = model.scopeAt(offset);
    const base = { kind: 'general', prefix: '', start: offset, end: offset, scope };
    // 热补全只定位光标附近 token，避免每个按键扫描整个源文件。
    const tokenIndex = firstTokenAt(model.tokens, offset) - 1;
    const previousToken = model.tokens[tokenIndex];
    const enclosing = previousToken && (offset < previousToken.end
        || (offset === previousToken.end && (!previousToken.closed || previousToken.kind === 'comment' && previousToken.value.startsWith('//')
            || previousToken.kind === 'define' && /\s/.test(previousToken.value)))) ? previousToken : null;
    if (enclosing?.kind === 'comment' || enclosing?.kind === 'define') return { ...base, kind: 'comment' };
    if (enclosing?.kind === 'string') {
        const before = model.text.slice(Math.max(0, model.text.lastIndexOf('\n', enclosing.start) + 1), enclosing.start);
        if (/`include\s*$/.test(before)) return { ...base, kind: 'include', prefix: model.text.slice(enclosing.start + 1, offset), start: enclosing.start + 1, end: enclosing.end - (enclosing.closed ? 1 : 0) };
        return { ...base, kind: 'string' };
    }
    const wordToken = previousToken?.end >= offset && (['identifier', 'macro', 'system'].includes(previousToken.kind)
        || ['$', '`'].includes(previousToken.value)) ? previousToken : null;
    if (wordToken) {
        base.prefix = model.text.slice(wordToken.start, offset);
        base.start = wordToken.start;
        base.end = wordToken.end;
    } else {
        // 光标恰好位于名称首字符时，仍替换整个名称。
        const nextToken = model.tokens[tokenIndex + 1];
        if (nextToken?.start === offset && nextToken.kind === 'identifier' && !nextToken.value.startsWith('\\')) base.end = nextToken.end;
    }
    if (base.prefix.startsWith('`')) return { ...base, kind: 'macro', prefix: base.prefix.slice(1), start: base.start + 1 };
    if (base.prefix.startsWith('$')) return { ...base, kind: 'system', prefix: base.prefix.slice(1), start: base.start + 1 };
    let operatorIndex = firstTokenAt(model.significantTokens, base.start) - 1;
    if (model.significantTokens[operatorIndex]?.end > base.start) operatorIndex--;
    const operator = model.significantTokens[operatorIndex]?.value;
    if (operator === '.' || operator === '::') {
        if (operator === '.') for (const instance of model.instances) {
            for (const [key, kind] of [['parameters', 'parameter'], ['ports', 'port']]) {
                const range = instance[key];
                if (range && namedConnectionAt(model, range, operatorIndex)) return { ...base, kind, instance, usedNames: range.usedNames };
            }
        }
        return { ...base, kind: operator === '.' ? 'member' : 'scope', receiver: receiverBefore(model, operatorIndex) };
    }
    return base;
}

module.exports = { tokenize, matchDelimiters, parseDocument, contextAt };
