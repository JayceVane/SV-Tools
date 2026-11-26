'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { tokenize, parseDocument, matchDelimiters } = require('../editor/completion/syntax');
const { buildRTLDesign, bindings, protectedRanges } = require('../project/rtl-model');
const { constantValue, MAX_WIDTH } = require('../project/rtl-expression');
const { createNativeLoader } = require('../native-loader');
const { resolveContext, assertCurrent } = require('../agent/context');
const { fail, result } = require('../agent/protocol');
const { relative } = require('./workflow-contract');
const { create } = require('./workflow-files');

const loader = createNativeLoader();
const position = (text, offset) => {
    const prefix = text.slice(0, offset);
    return { line: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n') };
};
const nameOf = (root, file) => path.relative(root, file).split(path.sep).join('/');
const digest = content => createHash('sha256').update(content).digest('hex');

/** Normalize only literal standalone body omissions. Comments and string tokens are preserved. */
function normalize(source, replacement = '   ') {
    const tokens = tokenize(source);
    let output = '', previous = 0;
    for (let index = 1; index + 2 < tokens.length; index++) {
        const token = tokens[index];
        if (token.value !== '.' || source.slice(token.start, token.start + 3) !== '...' || tokens[index + 2].value !== '.') continue;
        const before = tokens[index - 1], after = tokens[index + 3];
        const separateLine = /^\s*$/.test(source.slice(source.lastIndexOf('\n', token.start) + 1, token.start));
        if (!separateLine && before.value !== ';' && before.value !== 'begin') continue;
        if (after && !/^(?:;|end(?:module|interface|package|generate)?)$/u.test(after.value) && !source.slice(token.start + 3, after.start).includes('\n')) continue;
        output += source.slice(previous, token.start) + replacement;
        previous = token.start + 3;
        index += 2;
    }
    return output + source.slice(previous);
}

function parseFiles(workspace, input, native = loader.load()) {
    const diagnostics = [];
    const sources = input.map(item => {
        const normalized = normalize(item.text);
        const parsed = parseDocument(normalized);
        const local = nameOf(workspace, item.path);
        const syntax = native.extractSymbols(normalized);
        for (const error of syntax.errors) {
            if (diagnostics.length >= 128) break;
            diagnostics.push({ code: 'ARCH_SYNTAX', severity: 'error', message: error, source: { path: local, line: +(error.match(/^Line (\d+)/)?.[1] || 1), column: 1 } });
        }
        return { ...item, normalized, local, parsed, tokens: parsed.significantTokens, pairs: matchDelimiters(parsed.significantTokens) };
    });
    const units = new Map();
    for (const source of sources) for (const scope of source.parsed.scopes) {
        if (!['module', 'interface', 'package'].includes(scope.kind) || scope.parent !== 0 || !scope.name) continue;
        const at = { path: source.local, ...position(source.text, scope.start) };
        if (units.has(scope.name)) fail('AMBIGUOUS_MODULE', '结构声明重名：' + scope.name, { source: at });
        const symbols = source.parsed.symbols.filter(symbol => symbol.scope === scope.id).sort((a, b) => a.start - b.start);
        const ports = symbols.filter(symbol => symbol.kind === 'port' || scope.kind === 'module'
            && symbol.kind === 'variable' && symbol.start < scope.headerEnd && symbol.type)
            .map(symbol => symbol.kind === 'port' ? symbol : { ...symbol, kind: 'port' });
        const parameters = symbols.filter(symbol => ['parameter', 'localparam'].includes(symbol.kind));
        const members = symbols.filter(symbol => ['net', 'variable'].includes(symbol.kind));
        const modports = symbols.filter(symbol => symbol.kind === 'modport');
        const typedefs = symbols.filter(symbol => symbol.kind === 'typedef');
        const instances = source.parsed.instances.filter(instance => source.parsed.scopes.find(item => item.id === instance.scope)?.start >= scope.start
            && instance.end <= scope.end && instance.start >= scope.headerEnd);
        const empty = tokenize(source.normalized.slice(scope.headerEnd, scope.end)).every(token => token.kind === 'comment'
            || ['endmodule', 'endinterface', 'endpackage', ';'].includes(token.value));
        units.set(scope.name, { scope, source, location: at, ports, parameters, members, modports, typedefs, instances, empty });
    }
    return { sources, units, diagnostics };
}

function scalarWidth(unit, symbol, values, previous) {
    const { tokens, pairs } = unit.source;
    const index = tokens.findIndex(token => token.start === symbol.start);
    const end = index - 1;
    if (symbol.array || tokens[index + 1]?.value === '[') return;
    if (tokens[end]?.value === ',' && previous?.type === symbol.type) return previous.width;
    const scalar = ({ bit: 1, logic: 1, wire: 1, reg: 1, byte: 8, shortint: 16, int: 32, integer: 32, longint: 64, time: 64 })[symbol.type];
    if (scalar === undefined) return;
    if (tokens[end]?.value === ']' && pairs.has(end)) {
        if (tokens[pairs.get(end) - 1]?.value === ']') return;
        const dimension = tokens.slice(pairs.get(end) + 1, end), colon = dimension.findIndex(token => token.value === ':');
        if (colon < 1) return;
        const left = constantValue(dimension.slice(0, colon), values), right = constantValue(dimension.slice(colon + 1), values);
        const width = (Math.abs(left - right) + 1) * scalar;
        if (Number.isSafeInteger(left) && Number.isSafeInteger(right) && width <= MAX_WIDTH) return width;
        return;
    }
    return scalar;
}

function unitInterface(unit, overrides = new Map()) {
    const values = new Map();
    for (const parameter of unit.parameters) values.set(parameter.name, overrides.has(parameter.name)
        ? overrides.get(parameter.name) : constantValue(parameter.default || '', values));
    const members = [];
    for (const member of unit.members) members.push({ name: member.name, type: member.type, width: scalarWidth(unit, member, values, members.at(-1)) });
    const width = members.some(member => member.width === undefined) ? undefined : members.reduce((total, member) => total + member.width, 0);
    return { members, width, modports: unit.modports.map(port => ({ name: port.name,
        members: port.members.map(member => ({ name: member.sourceName || member.name, direction: member.direction })) })) };
}

function interfaceOverrides(parent, instance, definition, values = new Map()) {
    const names = definition.parameters.filter(parameter => parameter.kind === 'parameter').map(parameter => parameter.name);
    try {
        return new Map([...bindings(parent.source, instance.parameters, names)].map(([name, tokens]) => [name, constantValue(tokens, values)]));
    } catch {
        return new Map(names.map(name => [name, undefined]));
    }
}

const symbolOut = ({ name, type, direction, default: fallback }) => ({ name, type, direction, default: fallback });
function publicUnit(unit, units) {
    const { scope, location, ports, parameters, typedefs, instances, empty } = unit;
    return { id: scope.kind + ':' + scope.name, name: scope.name, kind: scope.kind, source: location, empty,
        parameters: parameters.map(symbolOut), ports: ports.map(port => {
            const [name, modport] = port.type.split('.');
            return units.get(name)?.scope.kind === 'interface' ? { ...symbolOut(port), direction: 'inout', interface: { name, modport } } : symbolOut(port);
        }), typedefs: typedefs.map(type => ({ ...symbolOut(type), members: type.members?.map(symbolOut) })),
        instances: instances.map(instance => ({ name: instance.name, type: instance.type, ports: instance.ports?.usedNames || [],
            source: { path: location.path, ...position(unit.source.text, instance.start) } })),
        ...(scope.kind === 'interface' ? unitInterface(unit) : {}) };
}

function checkInterfaceConnections(unit, parsed) {
    const typeOf = symbol => symbol.type.split('.');
    const isInterface = type => parsed.units.get(type)?.scope.kind === 'interface';
    const instances = unit.instances.filter(instance => instance.scope === unit.scope.id);
    const visible = new Map([...unit.ports, ...instances].map(symbol => [symbol.name, typeOf(symbol)]));
    for (const instance of instances) {
        const target = parsed.units.get(instance.type);
        if (target?.scope.kind !== 'module') continue;
        let connections;
        const sites = new Map();
        try { connections = bindings(unit.source, instance.ports, target.ports.map(port => port.name), sites); }
        catch { continue; } // The structural projection reports unresolvable connection expressions.
        for (const port of target.ports) {
            const [expected, expectedView] = typeOf(port);
            if (!isInterface(expected)) continue;
            const tokens = connections.get(port.name);
            const actualName = tokens === undefined && connections.has('*') ? port.name : tokens?.length === 1 ? tokens[0].value : undefined;
            const [actual, actualView] = visible.get(actualName) || [];
            if (!isInterface(actual)) continue;
            const wrongType = actual !== expected;
            const wrongView = !wrongType && expectedView && actualView && actualView !== expectedView;
            if (!wrongType && !wrongView) continue;
            const expectedPort = wrongView ? expected + '.' + expectedView : expected;
            const actualPort = wrongView ? actual + '.' + actualView : actual;
            parsed.diagnostics.push({ code: wrongType ? 'ARCH_INTERFACE_TYPE' : 'ARCH_MODPORT_MISMATCH', severity: 'error',
                message: `实例 ${instance.name} 的 ${port.name} 端口要求 ${expectedPort}，实际连接 ${actualPort}`,
                source: { file: unit.source.local, ...position(unit.source.text, sites.get(port.name) ?? instance.start) },
                details: { instance: instance.name, port: port.name, expected: expectedPort, actual: actualPort } });
        }
    }
}

function syntheticModel(parsed) {
    const substitutions = new Map();
    function replace(source, start, end, text) {
        if (!substitutions.has(source.path)) substitutions.set(source.path, []);
        substitutions.get(source.path).push({ start, end, text });
    }
    for (const unit of parsed.units.values()) {
        if (unit.scope.kind !== 'module') continue;
        checkInterfaceConnections(unit, parsed);
        for (const port of unit.ports) {
            const [name, modport] = port.type.split('.');
            const intf = parsed.units.get(name);
            if (intf?.scope.kind !== 'interface') continue;
            const model = unitInterface(intf), diagnostic = { path: unit.source.local, ...position(unit.source.text, port.start) };
            if (modport && !model.modports.some(item => item.name === modport)) parsed.diagnostics.push({ code: 'ARCH_MODPORT', severity: 'error', message: '未知 modport：' + port.type, source: diagnostic });
            if (!model.width || model.width > MAX_WIDTH) parsed.diagnostics.push({ code: 'ARCH_INTERFACE_WIDTH', severity: 'warning', message: '接口总线宽度待解析：' + port.type, source: diagnostic });
            const index = unit.source.tokens.findIndex(token => token.start === port.start);
            const start = unit.source.tokens[index - (modport ? 3 : 1)];
            if (start?.value === name) replace(unit.source, start.start, port.start, 'inout wire [' + ((model.width || 1) - 1) + ':0] ');
        }
        for (const instance of unit.instances) {
            const intf = parsed.units.get(instance.type);
            if (intf?.scope.kind !== 'interface') continue;
            const overrides = interfaceOverrides(unit, instance, intf);
            const { width } = unitInterface(intf, overrides);
            const length = width && width <= MAX_WIDTH ? width : 1;
            const original = unit.source.normalized.slice(instance.start, instance.end);
            replace(unit.source, instance.start, instance.end, 'wire [' + (length - 1) + ':0] ' + instance.name + '\n'.repeat(original.split('\n').length - 1));
        }
    }
    return parsed.sources.map(source => {
        let text = source.normalized;
        for (const edit of (substitutions.get(source.path) || []).sort((a, b) => b.start - a.start)) {
            text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
        }
        return { path: source.path, text };
    });
}

function usesProfile(files) {
    return files.some(file => (file.text.includes('...') && normalize(file.text) !== file.text) ||
        (/(?:^|\n)\s*interface\s+[A-Za-z_$]/u.test(file.text) &&
            tokenize(file.text).some(token => token.kind === 'identifier' && token.value === 'interface')));
}

function analyzeStructure(options) {
    const { workspace, files, top, defines = [] } = options;
    const parsed = parseFiles(workspace, files, options.native);
    const main = parsed.units.get(top);
    if (main?.scope.kind !== 'module') fail('MODULE_NOT_FOUND', '结构输入缺少顶层模块：' + top);
    let basis;
    try { basis = buildRTLDesign(syntheticModel(parsed), { top, defines }); }
    catch (error) { fail('DESIGN_FAILED', error.message, { diagnostics: parsed.diagnostics }); }
    for (const source of parsed.sources) source.conditional = protectedRanges(source.tokens, defines);
    for (const module of basis.design.modules) {
        const original = parsed.units.get(module.name);
        if (!original) continue;
        const source = offset => ({ path: original.source.path, ...position(original.source.text, offset) });
        module.source = source(original.scope.start);
        for (const port of module.ports) {
            const declared = original.ports.find(item => item.name === port.name);
            if (declared) port.source = source(declared.start);
        }
        for (const cell of module.cells) {
            const declared = original.instances.find(item => item.name === cell.name);
            if (declared) cell.source = source(declared.start);
        }
        if (!original.empty) module.processes = { structuralBody: true };
    }
    return { ...basis, parsed, main };
}

/**
 * 为结构投影里的接口连接收集方向证据。
 * 结构投影只认位级连线，接口两端在它那里都是"成员方向未知"，报告表格于是全写成 bus。
 * 这里按实例端口和 modport 声明重算一次，供 attachInterfaceEvidence 回填。
 * @param {{units:Map<string,object>}} parsed parseFiles 的结果。
 * @returns {Array<{key:string, flowEvidence:string|null, handshake:boolean, routes:boolean}>}
 */
function interfaceEvidence(parsed) {
    // 先把"接口实例 → 各实例端口的 modport"聚合起来：同一模块里接在同一接口实例上的实例共有这条束，
    // 必须两两配对判定，单看一端拿不到对端 modport（接口实例本身不声明 modport）。
    const endpoints = new Map();
    const remember = (key, endpoint, intf) => {
        if (!endpoints.has(key)) endpoints.set(key, { intf, list: [] });
        const entry = endpoints.get(key);
        if (!entry.list.some(item => item.modport === endpoint.modport && item.boundary === endpoint.boundary)) entry.list.push(endpoint);
    };
    for (const unit of parsed.units.values()) {
        if (unit.scope.kind !== 'module') continue;
        const targets = unit.instances.filter(instance => instance.scope === unit.scope.id);
        for (const instance of targets) {
            const child = parsed.units.get(instance.type);
            if (!child?.ports?.length) continue;
            let connections;
            try { connections = bindings(unit.source, instance.ports, child.ports.map(port => port.name), new Map()); }
            catch { continue; }
            for (const port of child.ports) {
                const [type, modport] = port.type.split('.');
                const intf = parsed.units.get(type);
                if (intf?.scope.kind !== 'interface') continue;
                const tokens = connections.get(port.name);
                const actual = tokens === undefined && connections.has('*') ? port.name : tokens?.length === 1 ? tokens[0].value : undefined;
                if (!actual) continue;
                const parent = [...unit.ports, ...targets].find(symbol => symbol.name === actual);
                if (!parent) continue;
                // 对端是模块边界端口：两侧 modport 都能拿到，直接登记。
                if (parent.kind === 'port') {
                    const [, parentModport] = parent.type.split('.');
                    if (parent.type.split('.')[0] !== type) continue;
                    remember(actual, { modport: parentModport, boundary: true }, intf);
                    remember(actual, { modport, boundary: false }, intf);
                    continue;
                }
                // 对端是接口实例：只登记本端 modport，配对在下面统一完成。
                remember(actual, { modport, boundary: false }, intf);
            }
        }
    }
    const evidence = [];
    for (const [key, bundle] of endpoints) {
        // 两端束按第一对配对判定；多端束逐对比较，任一对给出方向即视为可判定。
        let best = null;
        for (let left = 0; left < bundle.list.length; left++) for (let right = left + 1; right < bundle.list.length; right++) {
            const model = unitInterface(bundle.intf);
            const result = require('./interface-evidence').connectionEvidence([bundle.list[left], bundle.list[right]], model);
            if (result.routes.length && (!best || result.routes.length > best.routes.length)) best = result;
        }
        if (!best) continue;
        evidence.push({ key, flowEvidence: best.flowEvidence, handshake: best.handshake, routes: true });
    }
    return evidence;
}

/**
 * 把接口束级的方向证据回填到结构投影的连接记录上。
 * @param {object} output projectArchitecture 的结果（就地修改）。
 * @param {Array<{key:string, flowEvidence:string|null, handshake:boolean, routes:boolean}>} evidence 由 interfaceEvidence 产生的证据。
 */
function attachInterfaceEvidence(output, evidence) {
    if (!evidence.length) return;
    // 同一接口名会在多个模块里出现（父子模块共用一条束），证据可能互相覆盖：
    // 优先保留能给出方向的结论，避免后遍历到的"未知"把已知方向冲掉。
    const byKey = new Map();
    for (const item of evidence) {
        const previous = byKey.get(item.key);
        if (!previous || (!previous.routes && item.routes)) byKey.set(item.key, item);
    }
    for (const item of output.interfaces || []) {
        if (item.direction !== 'connection') continue;
        const found = byKey.get(item.label);
        if (!found) continue;
        item.flowEvidence = found.flowEvidence;
        item.handshake = found.handshake;
        if (found.routes) item.direction = found.handshake ? 'bidirectional' : 'forward';
    }
}

async function build(options) {
    const { workspace, files, top, contextRevision } = options;
    const { design, parsed, main, issues } = analyzeStructure(options);
    const { projectArchitecture, archHash } = require('./arch');
    const output = projectArchitecture(design, options);
    output.engine = 'struct';
    attachInterfaceEvidence(output, interfaceEvidence(parsed));
    output.structuralUnits = [...parsed.units.values()].map(unit => publicUnit(unit, parsed.units));
    output.checks = [...parsed.diagnostics, ...output.checks];
    for (const diagnostic of output.checks) {
        if (!['UNCONNECTED_PORT', 'UNDRIVEN_INPUT'].includes(diagnostic.code) || !diagnostic.details?.port) continue;
        const instance = main.instances.find(item => item.name === diagnostic.details.instance);
        const target = instance && parsed.units.get(instance.type);
        if (!target) continue;
        const sites = new Map();
        try { bindings(main.source, instance.ports, target.ports.map(port => port.name), sites); }
        catch { /* Prefer the instance location when the expression cannot be parsed. */ }
        diagnostic.source = { file: main.source.local, ...position(main.source.text, sites.get(diagnostic.details.port) ?? instance.start) };
    }
    output.sourceFiles = files.map(file => ({ path: nameOf(workspace, file.path), sha256: digest(file.text) })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    output.designId = 'design:' + digest(JSON.stringify([top, output.sourceFiles])).slice(0, 16);
    output.contextRevision = contextRevision || null;
    output.limitations = ['源级结构投影。接口在图中作为一条共享连接，modport 成员方向和位宽在 structuralUnits 中列出。',
        '未执行全量 elaboration、编译或时序分析。复杂 generate、宏和表达式中的不确定连接需要结合诊断阅读。', ...issues];
    output.archSha256 = archHash(output);
    output.modelSha256 = output.archSha256;
    return output;
}

async function command(action, input, { native } = {}) {
    const located = await resolveContext(input);
    const { options: { workspace }, contents } = located;
    let files = [...contents].map(([path, item]) => ({ path, text: item.text }));
    if (input.file) {
        const name = relative(input.file, '结构源码');
        files = files.filter(item => nameOf(workspace, item.path) === name);
        if (!files.length) fail('SOURCE_NOT_FOUND', '结构源码未进入当前工程快照：' + name);
    }
    const parsed = parseFiles(workspace, files, native);
    const data = { schemaVersion: 1, engine: 'svtools-struct', units: [...parsed.units.values()].map(unit => publicUnit(unit, parsed.units)), checks: parsed.diagnostics };
    if (!data.units.length) fail('DESIGN_FAILED', '结构输入没有可识别的声明');
    await assertCurrent(located);
    if (action === 'lower') {
        if (parsed.diagnostics.some(item => item.severity === 'error')) return { ...result('design.lower', data, null, parsed.diagnostics), status: 'failed' };
        const directory = relative(input.out || '.svtools/struct/lower', '实现桩目录');
        const fs = require('node:fs/promises');
        const targets = files.map(item => ({ path: directory + '/' + nameOf(workspace, item.path), text: normalize(item.text, '/* TODO: RTL implementation */') }));
        const created = [];
        try {
            for (const item of targets) { created.push(await create(workspace, item.path, item.text)); }
        } catch (error) {
            for (const file of created) await fs.unlink(file).catch(() => {});
            throw error;
        }
        data.files = targets.map(item => item.path);
    }
    const response = result(action === 'lower' ? 'design.lower' : 'struct.parse', data, null, parsed.diagnostics);
    return parsed.diagnostics.some(item => item.severity === 'error') ? { ...response, status: 'failed' } : response;
}

module.exports = { usesProfile, build, command, normalize, analyzeStructure, unitInterface, interfaceOverrides, position };
