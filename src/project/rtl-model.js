'use strict';
const { parseDocument, matchDelimiters, splitTopLevel } = require('../editor/completion/syntax');
const { createDesign } = require('../circuit/model');
const { constantValue, connectionBits, MAX_WIDTH } = require('./rtl-expression');
const MAX_TOKENS = 500000, MAX_MODULES = 512, MAX_BITS = 250000;
const SIGNAL_KINDS = new Set(['port', 'net', 'variable']);
const SCALAR_WIDTHS = { bit: 1, logic: 1, reg: 1, wire: 1, tri: 1, wand: 1, wor: 1, uwire: 1, byte: 8, shortint: 16, int: 32, integer: 32, longint: 64, time: 64 };
function sourceAt(document, offset) {
    let low = 0, high = document.lines.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (document.lines[middle] <= offset) {
            low = middle + 1;
        }
        else {
            high = middle;
        }
    }
    return { path: document.path, line: low, column: offset - document.lines[low - 1] + 1 };
}
function protectedRanges(tokens, defines) {
    const ranges = [], stack = [];
    // 标准文件头include guard不决定硬件分支；其它条件宏保持不确定边界。
    const significant = tokens.filter(token => token.kind !== 'comment');
    let depth = 0, outerAlternative = false;
    for (const token of significant) {
        if (['`ifdef', '`ifndef'].includes(token.value)) {
            depth++;
        }
        if (['`else', '`elsif'].includes(token.value) && depth === 1) {
            outerAlternative = true;
        }
        if (token.value === '`endif') {
            depth--;
        }
    }
    const guarded = significant[0]?.value === '`ifndef' && significant[1]?.kind === 'identifier'
        && significant[2]?.kind === 'define' && /^`define\s+([^\s]+)/.exec(significant[2].value)?.[1] === significant[1].value
        && significant.at(-1)?.value === '`endif' && !outerAlternative;
    const guardDisabled = defines.some(value => value.split('=')[0] === significant[1]?.value);
    for (const token of tokens) {
        if (['`ifdef', '`ifndef'].includes(token.value)) {
            stack.push(token.start);
        }
        if (token.value === '`endif' && stack.length) {
            const start = stack.pop();
            if (!(guarded && !guardDisabled && start === significant[0].start)) {
                ranges.push([start, token.end]);
            }
        }
    }
    for (const start of stack)
        ranges.push([start, Infinity]);
    return offset => ranges.some(([start, end]) => offset >= start && offset < end);
}
function prefixOf(document, index) {
    const { tokens, pairs } = document;
    let start = index;
    while (start > 0) {
        const previous = tokens[start - 1];
        if ([',', ';', '('].includes(previous.value)) {
            break;
        }
        if ([')', ']', '}'].includes(previous.value) && pairs.has(start - 1)) {
            start = pairs.get(start - 1);
            continue;
        }
        start--;
    }
    return tokens.slice(start, index);
}
function initializer(document, symbol) {
    const index = document.positions.get(symbol.start), tokens = document.tokens;
    if (tokens[index + 1]?.value !== '=') {
        return [];
    }
    let end = index + 2;
    for (; end < tokens.length; end++) {
        if ([',', ';', ')'].includes(tokens[end].value)) {
            break;
        }
        if (['(', '[', '{'].includes(tokens[end].value) && document.pairs.has(end)) {
            end = document.pairs.get(end);
        }
    }
    return tokens.slice(index + 2, end);
}
function bindings(document, range, orderedNames) {
    if (!range) {
        return new Map();
    }
    const tokens = document.tokens.filter(token => token.start > range.start && token.end < range.end), groups = splitTopLevel(tokens), result = new Map();
    let position = 0;
    for (const group of groups) {
        if (!group.length) {
            position++;
            continue;
        }
        if (group[0].value === '.*') {
            result.set('*', []);
            continue;
        }
        let name, value;
        if (group[0].value === '.' && group[1]?.kind === 'identifier') {
            name = group[1].value;
            if (group.length === 2) {
                value = [group[1]];
            }
            else if (group[2]?.value === '(' && matchDelimiters(group).get(2) === group.length - 1) {
                value = group.slice(3, -1);
            }
            else {
                throw new Error('连接语法不能静态确定');
            }
        }
        else {
            name = orderedNames[position++];
            value = group;
        }
        if (!name || result.has(name)) {
            throw new Error('重复或无法确定顺序的端口/参数连接');
        }
        result.set(name, value);
    }
    return result;
}
/**
 * 将直接RTL声明、连续别名和实例端口映射到同一连接合同；不进行综合或逻辑推断。
 * @param {{path:string,text:string}[]} documents 分别解析的编译输入。
 * @param {{defines?:string[]}} options 宏配置（宏未展开）。
 * @returns {{build:Function}} 复用只读词法索引，分别构建指定根的参数化模型与提示。
 */
function createRTLIndex(documents, { defines = [] } = {}) {
    const definitions = new Map(), issues = new Set();
    let tokenCount = 0;
    const issue = (message) => {
        if (issues.size < 256) {
            issues.add(message);
        }
    };
    for (const input of documents) {
        const parsed = parseDocument(input.text);
        tokenCount += parsed.tokens.length;
        if (tokenCount > MAX_TOKENS) {
            throw new Error('静态RTL索引超过500000个token，请缩小工程文件集合');
        }
        const tokens = parsed.tokens.filter(token => !['comment', 'define'].includes(token.kind)), lines = [0];
        for (let index = 0; index < input.text.length; index++)
            if (input.text[index] === '\n') {
                lines.push(index + 1);
            }
        const document = { ...input, parsed, tokens, pairs: matchDelimiters(tokens), positions: new Map(tokens.map((token, index) => [token.start, index])), lines, conditional: protectedRanges(parsed.tokens, defines) };
        for (const scope of parsed.scopes.filter(scope => scope.kind === 'module')) {
            if (document.conditional(scope.start)) {
                issue(input.path + '：条件宏中的模块未选择分支');
                continue;
            }
            if (!definitions.has(scope.name)) {
                definitions.set(scope.name, []);
            }
            definitions.get(scope.name).push({ document, scope });
        }
    }
    const indexIssues = [...issues];
    return { build(top) {
            const modules = [], cache = new Map(), issues = new Set(indexIssues);
            let totalBits = 0, sequence = 0;
            const issue = message => {
                if (issues.size < 256) {
                    issues.add(message);
                }
            };
            function definition(name) {
                const found = definitions.get(name) || [];
                if (found.length !== 1) {
                    throw new Error(found.length ? '模块定义重复，静态分析不能选择：' + name : '工程中没有可解析的模块定义：' + name);
                }
                return found[0];
            }
            function instantiate(name, overrides = new Map(), ancestors = []) {
                if (ancestors.includes(name) || ancestors.length >= 64) {
                    throw new Error('静态实例层级存在递归或超过64层：' + name);
                }
                const { document, scope } = definition(name), symbols = document.parsed.symbols.filter(symbol => symbol.scope === scope.id).sort((a, b) => a.start - b.start);
                const parameters = symbols.filter(symbol => ['parameter', 'localparam'].includes(symbol.kind)), values = new Map();
                for (const key of overrides.keys())
                    if (!parameters.some(symbol => symbol.kind === 'parameter' && symbol.name === key)) {
                        throw new Error(name + '没有参数：' + key);
                    }
                for (const symbol of parameters)
                    values.set(symbol.name, overrides.has(symbol.name) ? overrides.get(symbol.name) : constantValue(initializer(document, symbol), values));
                const key = JSON.stringify([document.path, scope.id, [...values]]);
                if (cache.has(key)) {
                    return cache.get(key);
                }
                if (modules.length >= MAX_MODULES) {
                    throw new Error('静态RTL模型超过512种参数化模块，请缩小工程');
                }
                const id = 'rtl:' + modules.length, module = { id, name, source: sourceAt(document, scope.start), ports: [], signals: [], cells: [] }, signals = new Map(), parents = new Map();
                const aliases = [], drivers = new Map(), uncertain = new Set();
                modules.push(module);
                cache.set(key, module);
                function find(bit) {
                    let root = bit;
                    while (parents.has(root))
                        root = parents.get(root);
                    while (parents.has(bit)) {
                        const next = parents.get(bit);
                        parents.set(bit, root);
                        bit = next;
                    }
                    return root;
                }
                function merge(a, b) {
                    a = find(a);
                    b = find(b);
                    if (a === b) {
                        return;
                    }
                    if (a.startsWith('c:') && b.startsWith('c:')) {
                        issue(name + '：连续赋值存在冲突常量，已在边界止步');
                        return;
                    }
                    if (a.startsWith('c:')) {
                        parents.set(b, a);
                    }
                    else {
                        parents.set(a, b);
                    }
                }
                function drive(bits, isUncertain = false) {
                    for (const bit of bits || [])
                        if (bit.startsWith('n:')) {
                            drivers.set(bit, (drivers.get(bit) || 0) + 1);
                            if (isUncertain) {
                                uncertain.add(bit);
                            }
                        }
                }
                function assignmentGroups(index) {
                    let end = index + 1;
                    while (end < document.tokens.length && document.tokens[end].value !== ';')
                        end++;
                    return splitTopLevel(document.tokens.slice(index + 1, end));
                }
                function markUncertain(groups) {
                    for (const group of groups) {
                        const equals = group.findIndex(token => token.value === '=');
                        if (equals < 0) {
                            continue;
                        }
                        const left = group.slice(0, equals), bits = connectionBits(left, signals, values);
                        if (bits) {
                            drive(bits, true);
                        }
                        else {
                            for (const token of left)
                                if (token.kind === 'identifier') {
                                    drive(signals.get(token.value)?.bits, true);
                                }
                        }
                    }
                }
                function uncertainInstance(instance) {
                    if (!instance.ports) {
                        return;
                    }
                    const content = document.tokens.filter(token => token.start > instance.ports.start && token.end < instance.ports.end);
                    for (const group of splitTopLevel(content)) {
                        if (group[0]?.value === '.*') {
                            for (const object of signals.values())
                                drive(object.bits, true);
                            continue;
                        }
                        const expression = group[0]?.value === '.' ? (group.length === 2 ? [group[1]] : group.slice(3, -1)) : group;
                        const bits = connectionBits(expression, signals, values);
                        if (bits) {
                            drive(bits, true);
                        }
                        else {
                            for (const token of expression)
                                if (token.kind === 'identifier') {
                                    drive(signals.get(token.value)?.bits, true);
                                }
                        }
                    }
                }
                let inherited, previousEnd = -1;
                for (const symbol of symbols.filter(symbol => SIGNAL_KINDS.has(symbol.kind))) {
                    if (document.conditional(symbol.start) || symbol.array) {
                        issue(name + '.' + symbol.name + '：条件宏或非打包数组未展开');
                        inherited = undefined;
                        previousEnd = symbol.end;
                        continue;
                    }
                    const index = document.positions.get(symbol.start);
                    if (index === undefined) {
                        continue;
                    }
                    const prefix = prefixOf(document, index), ranges = [];
                    for (let cursor = 0; cursor < prefix.length; cursor++)
                        if (prefix[cursor].value === '[') {
                            const end = matchDelimiters(prefix).get(cursor);
                            if (end === undefined) {
                                break;
                            }
                            ranges.push(prefix.slice(cursor + 1, end));
                            cursor = end;
                        }
                    const between = document.text.slice(previousEnd, symbol.start);
                    const canInherit = !prefix.length && between.trim().endsWith(',') && !between.includes(';'), previousRange = inherited;
                    previousEnd = symbol.end;
                    inherited = undefined;
                    let range, width, upto = false, offset = 0;
                    if (ranges.length > 1) {
                        issue(name + '.' + symbol.name + '：多维打包范围未展开');
                        continue;
                    }
                    if (ranges.length) {
                        const colon = ranges[0].findIndex(token => token.value === ':');
                        const left = constantValue(ranges[0].slice(0, colon), values), right = constantValue(ranges[0].slice(colon + 1), values);
                        if (colon < 0 || !Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
                            issue(name + '.' + symbol.name + '：声明位宽未能静态求值');
                            continue;
                        }
                        width = Math.abs(left - right) + 1;
                        offset = Math.min(left, right);
                        upto = left < right;
                        range = { width, offset, upto };
                    }
                    else if (canInherit) {
                        if (!previousRange) {
                            issue(name + '.' + symbol.name + '：声明范围无法确定');
                            continue;
                        }
                        range = previousRange;
                    }
                    else {
                        const type = String(symbol.type || 'logic').split(/\s+/).filter(word => !['signed', 'unsigned', 'var', 'const'].includes(word));
                        const base = type.find(word => Object.hasOwn(SCALAR_WIDTHS, word));
                        if (type.some(word => !Object.hasOwn(SCALAR_WIDTHS, word)) || !base) {
                            issue(name + '.' + symbol.name + '：用户类型的位宽未知');
                            continue;
                        }
                        range = { width: SCALAR_WIDTHS[base], offset: 0, upto: false };
                    }
                    inherited = range;
                    previousEnd = symbol.end;
                    ({ width, offset, upto } = range);
                    if (width < 1 || width > MAX_WIDTH) {
                        issue(name + '.' + symbol.name + '：位宽超过4096位');
                        continue;
                    }
                    totalBits += width;
                    if (totalBits > MAX_BITS) {
                        throw new Error('静态RTL模型超过250000位，请缩小工程');
                    }
                    const object = { id: id + '/signal:' + symbol.name, name: symbol.name, bits: Array.from({ length: width }, () => 'n:' + sequence++), offset, upto, source: sourceAt(document, symbol.start) };
                    if (signals.has(symbol.name)) {
                        issue(name + '.' + symbol.name + '：重复声明未合并');
                        continue;
                    }
                    signals.set(symbol.name, object);
                    module.signals.push(object);
                    if (symbol.direction) {
                        module.ports.push({ ...object, id: id + '/port:' + symbol.name, direction: ['input', 'output', 'inout'].includes(symbol.direction) ? symbol.direction : 'unknown' });
                    }
                }
                // 只处理模块直接连续赋值，不把过程赋值、时序或generate分支当透传。
                for (const port of module.ports)
                    if (['input', 'inout'].includes(port.direction)) {
                        drive(port.bits);
                    }
                for (const symbol of symbols.filter(symbol => symbol.kind === 'net')) {
                    const object = signals.get(symbol.name), tokens = initializer(document, symbol);
                    if (!object || !tokens.length || document.conditional(symbol.start)) {
                        continue;
                    }
                    const bits = connectionBits(tokens, signals, values, object.bits.length);
                    drive(object.bits);
                    if (bits && bits.length === object.bits.length) {
                        aliases.push({ left: object.bits, right: bits });
                    }
                    else {
                        issue(name + '.' + symbol.name + '：网线声明赋值不属于可确定透传');
                    }
                }
                for (let index = 0; index < document.tokens.length; index++) {
                    const token = document.tokens[index];
                    if (token.value === 'assign' && token.start >= scope.headerEnd && token.start < scope.end
                        && (document.conditional(token.start) || document.parsed.scopeAt(token.start).id !== scope.id)) {
                        issue(name + '：条件宏/生成作用域中的赋值未作为确定透传');
                        markUncertain(assignmentGroups(index));
                        continue;
                    }
                    if (token.start < scope.headerEnd || token.start >= scope.end || document.conditional(token.start) || document.parsed.scopeAt(token.start).id !== scope.id) {
                        continue;
                    }
                    if (token.value !== 'assign') {
                        continue;
                    }
                    if (![';', 'end', 'endgenerate', 'endcase'].includes(document.tokens[index - 1]?.value)) {
                        issue(name + '：条件或过程连续赋值未作为透传');
                        markUncertain(assignmentGroups(index));
                        continue;
                    }
                    let end = index + 1;
                    while (end < document.tokens.length && document.tokens[end].value !== ';')
                        end++;
                    for (const group of splitTopLevel(document.tokens.slice(index + 1, end))) {
                        const equals = group.findIndex(token => token.value === '=');
                        if (equals < 0) {
                            continue;
                        }
                        const left = connectionBits(group.slice(0, equals), signals, values), right = connectionBits(group.slice(equals + 1), signals, values, left?.length);
                        if (left) {
                            drive(left);
                        }
                        else {
                            markUncertain([group]);
                        }
                        if (!left || !right || left.some(bit => bit.startsWith('c:')) || left.length !== right.length) {
                            issue(name + '：含运算或位宽不确定的连续赋值作为透传边界');
                            continue;
                        }
                        aliases.push({ left, right });
                    }
                    index = end;
                }
                const declaredNames = [...new Set(symbols.filter(symbol => symbol.direction).map(symbol => symbol.name))];
                module.portOrder = declaredNames;
                const header = document.tokens.filter(token => token.start >= scope.start && token.start < scope.headerEnd);
                let close = header.length - 1;
                while (close >= 0 && header[close].value !== ')')
                    close--;
                if (close >= 0) {
                    const open = matchDelimiters(header).get(close);
                    if (open !== undefined && header[open - 1]?.value !== '#') {
                        const names = splitTopLevel(header.slice(open + 1, close)).map(group => group.filter(token => declaredNames.includes(token.value)).at(-1)?.value).filter(Boolean);
                        module.portOrder = [...names, ...declaredNames.filter(name => !names.includes(name))];
                        module.ports.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
                    }
                }
                for (const instance of document.parsed.instances) {
                    if (instance.start < scope.headerEnd || instance.start >= scope.end) {
                        continue;
                    }
                    if (instance.scope !== scope.id || document.conditional(instance.start)) {
                        issue(name + '.' + instance.name + '：条件/生成作用域未展开');
                        uncertainInstance(instance);
                        continue;
                    }
                    const instanceStart = document.positions.get(instance.start);
                    if (![';', 'end', 'endgenerate', 'endcase'].includes(document.tokens[instanceStart - 1]?.value)) {
                        issue(name + '.' + instance.name + '：条件实例未展开');
                        uncertainInstance(instance);
                        continue;
                    }
                    const nameSymbol = symbols.find(symbol => symbol.kind === 'instance' && symbol.name === instance.name && symbol.start >= instance.start && symbol.start < instance.ports.start);
                    if (!nameSymbol || document.text.slice(nameSymbol.end, instance.ports.start).trim()) {
                        issue(name + '.' + instance.name + '：实例数组或不完整连接未展开');
                        uncertainInstance(instance);
                        continue;
                    }
                    try {
                        const childDefinition = definition(instance.type), childParameters = childDefinition.document.parsed.symbols.filter(symbol => symbol.scope === childDefinition.scope.id && symbol.kind === 'parameter');
                        const parameterBindings = bindings(document, instance.parameters, childParameters.map(symbol => symbol.name)), childValues = new Map();
                        for (const [parameter, tokens] of parameterBindings)
                            childValues.set(parameter, constantValue(tokens, values));
                        const child = instantiate(instance.type, childValues, [...ancestors, name]), connections = bindings(document, instance.ports, child.portOrder);
                        if ([...connections.keys()].some(key => key !== '*' && !child.portOrder.includes(key))) {
                            throw new Error('连接到不存在的端口');
                        }
                        const ports = [];
                        for (const port of child.ports) {
                            const tokens = connections.get(port.name) || (connections.has('*') ? [{ kind: 'identifier', value: port.name }] : undefined);
                            if (!tokens?.length) {
                                continue;
                            }
                            const bits = connectionBits(tokens, signals, values, port.bits.length);
                            if (!bits || bits.length !== port.bits.length) {
                                issue(name + '.' + instance.name + '.' + port.name + '：连接表达式或位宽不确定，已停止');
                                continue;
                            }
                            ports.push({ ...port, id: id + '/cell:' + instance.name + '/port:' + port.name, bits });
                        }
                        module.cells.push({ id: id + '/cell:' + instance.name, name: instance.name, type: instance.type, kind: 'instance', moduleId: child.id, ports, source: sourceAt(document, nameSymbol.start) });
                        for (const port of ports)
                            if (['output', 'inout', 'unknown'].includes(port.direction)) {
                                drive(port.bits);
                            }
                    }
                    catch (error) {
                        issue(name + '.' + instance.name + '：' + error.message);
                        uncertainInstance(instance);
                    }
                }
                for (const alias of aliases)
                    for (let index = 0; index < alias.left.length; index++) {
                        const bit = alias.left[index];
                        if ((drivers.get(bit) || 0) > 1 || uncertain.has(bit)) {
                            issue(name + '：多驱动或条件驱动位已作为透传边界');
                            continue;
                        }
                        merge(bit, alias.right[index]);
                    }
                for (const object of [...module.signals, ...module.ports, ...module.cells.flatMap(cell => cell.ports)])
                    object.bits = object.bits.map(find);
                return module;
            }
            if (defines.length) {
                issue('静态分析未展开工程宏；依赖宏的位宽或连接会在边界停止');
            }
            const main = instantiate(top);
            const design = createDesign({ schemaVersion: 1, title: top, top: main.id, provenance: { engine: 'rtl-static', version: '1', stage: 'source-connections' }, modules });
            return { design, issues: [...issues] };
        } };
}
/** @param {{path:string,text:string}[]} documents 源码。 @param {{top:string,defines?:string[]}} options 顶层与宏。 @returns {object} 独立静态模型。 */
function buildRTLDesign(documents, options) {
    return createRTLIndex(documents, options).build(options.top);
}
module.exports = { buildRTLDesign, createRTLIndex, protectedRanges, sourceAt, MAX_TOKENS, MAX_MODULES, MAX_BITS };
