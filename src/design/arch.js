'use strict';

// M3 交付1：Yosys 链接空模块（blackbox）后投影顶层架构。Yosys 脚本固定为
// read_verilog -sv ...; hierarchy -top <top>; proc; write_json ...，不跑 prep/opt，
// 避免优化掉未连接实例。架构图是源级结构事实，不做综合、时序或功能验证。
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { prepareBundledYosys } = require('../circuit/yosys-bundled');
const { fromYosys } = require('../circuit/adapters/yosys');
const { findModule } = require('../circuit/model');
const { extractDesignUnits } = require('../workspace/sources');
const { runProcess } = require('../toolchains/process');
const { processSucceeded } = require('../toolchains/result');
const { yosysQuote } = require('../circuit/yosys-runner');
const { directory } = require('../agent/storage');
const { fail } = require('../agent/protocol');

const SCHEMA_VERSION = 1;
const STAGE = 'source';
const DEFAULT_BUDGET = Object.freeze({ modules: 4096, instances: 20000, edges: 50000 });
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_ERROR_CHARS = 4000;
const SOURCE_GLOB = /\.(?:sv|v)$/i;
const TOP_GLOB = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** @param {string} text @returns {string} SHA-256 十六进制摘要。 */
function hashText(text) {
    return createHash('sha256').update(text).digest('hex');
}

/** @param {*} value @returns {string} 键排序后的 JSON，供架构哈希使用。 */
function stableStringify(value) {
    if (Array.isArray(value)) {
        return '[' + value.map(item => stableStringify(item)).join(',') + ']';
    }
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}

/** @param {string} workspace @param {string} file @returns {string} 相对工作区的 POSIX 路径。 */
function relativePosix(workspace, file) {
    const relative = path.relative(workspace, file);
    return (relative || path.basename(file)).split(path.sep).join('/');
}

/** @param {*} value Yosys 属性值。 @returns {boolean} blackbox/whitebox 是否置位（兼容 32 位字符串/1/true）。 */
function flagSet(value) {
    return value === true || value === 1 || (typeof value === 'string' && /^0*1$/.test(value.trim()));
}

/** @param {*} value @returns {number|string|boolean|null} Yosys 32 位二进制参数值转十进制，其余原样保留。 */
function decodeParameter(value) {
    if (typeof value === 'string' && /^[01]+$/.test(value) && value.length <= 52) {
        return Number.parseInt(value, 2);
    }
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

/** @param {object} parameters @returns {object|null} 解码后的参数表。 */
function decodeParameters(parameters) {
    if (!parameters || typeof parameters !== 'object') {
        return null;
    }
    const entries = Object.entries(parameters);
    return entries.length ? Object.fromEntries(entries.map(([name, value]) => [name, decodeParameter(value)])) : null;
}

/** @param {string} type @returns {{base:string, summary:string|null}} $paramod 名称的可读形式。 */
function prettifyModuleType(type) {
    const match = /^\$paramod\\([^\\]+)\\(.+)$/.exec(type || '');
    if (!match) {
        return { base: type, summary: null };
    }
    const summary = match[2].split('\\').filter(Boolean).map(segment => {
        const equals = segment.indexOf('=');
        if (equals < 0) {
            return segment;
        }
        const name = segment.slice(0, equals), raw = segment.slice(equals + 1);
        const value = /^s?32'([01]+)$/.exec(raw);
        return name + '=' + (value ? Number.parseInt(value[1], 2) : raw);
    }).join(', ');
    return { base: match[1], summary: summary || null };
}

/** @param {object} module 已验证的电路模块。 @returns {string} 可读模块标签（含参数摘要）。 */
function moduleLabel(module) {
    const { base, summary } = prettifyModuleType(module.name);
    if (summary) {
        return base + ' #(' + summary + ')';
    }
    const parameters = decodeParameters(module.parameters);
    if (parameters) {
        return base + ' #(' + Object.entries(parameters).map(([name, value]) => name + '=' + value).join(', ') + ')';
    }
    return base;
}

/** @param {object|undefined} source Yosys 来源。 @param {{from:string,to:string}[]} sourceDirectories guest→宿主映射。 @returns {object|undefined} 宿主来源。 */
function remapSource(source, sourceDirectories) {
    if (!source || typeof source.path !== 'string') {
        return undefined;
    }
    let best = null;
    for (const mapping of sourceDirectories) {
        if (source.path === mapping.from || source.path.startsWith(mapping.from + '/')) {
            if (!best || mapping.from.length > best.from.length) {
                best = mapping;
            }
        }
    }
    return best ? { ...source, path: source.path.replace(best.from, best.to) } : source;
}

/** @param {object|undefined} source 已映射来源。 @param {string} workspace @returns {object|undefined} 相对工作区的来源。 */
function relativeSource(source, workspace) {
    if (!source || typeof source.path !== 'string') {
        return undefined;
    }
    const result = { file: relativePosix(workspace, source.path) };
    if (Number.isSafeInteger(source.line)) {
        result.line = source.line;
    }
    if (Number.isSafeInteger(source.column)) {
        result.column = source.column;
    }
    return result;
}

/** @param {object} design fromYosys 结果。 @param {{from:string,to:string}[]} sourceDirectories guest→宿主映射。 @returns {object} 来源已映射的设计副本。 */
function remapDesignSources(design, sourceDirectories) {
    const mapping = source => remapSource(source, sourceDirectories);
    return {
        ...design,
        modules: design.modules.map(module => ({
            ...module,
            ...(module.source ? { source: mapping(module.source) } : {}),
            ports: module.ports.map(port => ({ ...port, ...(port.source ? { source: mapping(port.source) } : {}) })),
            cells: module.cells.map(cell => ({ ...cell, ...(cell.source ? { source: mapping(cell.source) } : {}) })),
            signals: module.signals.map(signal => ({ ...signal, ...(signal.source ? { source: mapping(signal.source) } : {}) }))
        }))
    };
}

/**
 * 扫描工作区声明，找出同名模块候选。
 * @param {{path:string,text:string}[]} files 工作区源码。 @param {string} workspace 工作区绝对路径。
 * @returns {{names:string[], candidates:{name:string,file:string,line:number}[]}|null} 重复声明；无重复返回 null。
 */
function duplicateCandidates(files, workspace) {
    const declarations = new Map();
    for (const file of files) {
        let line = 1, cursor = 0;
        for (const unit of extractDesignUnits(file.text)) {
            line += (file.text.slice(cursor, unit.start).match(/\n/g) || []).length;
            cursor = unit.start;
            const list = declarations.get(unit.name) || [];
            list.push({ name: unit.name, file: relativePosix(workspace, file.path), line });
            declarations.set(unit.name, list);
        }
    }
    const duplicated = [...declarations.entries()].filter(([, list]) => list.length > 1);
    if (!duplicated.length) {
        return null;
    }
    duplicated.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const candidates = duplicated.flatMap(([, list]) => list)
        .sort((left, right) => left.file === right.file ? left.line - right.line : left.file < right.file ? -1 : 1);
    return { names: duplicated.map(([name]) => name), candidates };
}

/** @param {{path:string,text:string}[]} files @param {object} budget @returns {void} 模块预算预检，超限不产出部分模型。 */
function checkModuleBudget(files, budget) {
    const declarations = files.reduce((total, file) => total + extractDesignUnits(file.text).length, 0);
    if (declarations > budget.modules) {
        fail('DESIGN_LIMIT', '模块数量超出架构图预算', { kind: 'modules', used: declarations, limit: budget.modules });
    }
}

/** @param {object} cell 顶层单元。 @returns {boolean} 是否用户模块实例（工具生成的 $ 单元不进入架构图）。 */
function isUserInstance(cell) {
    return Boolean(cell.moduleId) || !String(cell.type || '').startsWith('$');
}

/** @param {object} cell 顶层单元。 @returns {string} 实例盒标签（参数覆盖优先于声明默认值）。 */
function instanceModuleLabel(cell) {
    const pretty = prettifyModuleType(cell.type);
    const overrides = decodeParameters(cell.parameters);
    if (pretty.summary) {
        return pretty.base + ' #(' + pretty.summary + ')';
    }
    if (overrides) {
        return pretty.base + ' #(' + Object.entries(overrides).map(([name, value]) => name + '=' + value).join(', ') + ')';
    }
    return pretty.base;
}

/** @param {object} module 顶层模块。 @param {object} design 已验证设计。 @param {object} limits 预算。 @returns {object[]} 顶层实例节点（只含用户模块实例）。 */
function buildInstanceNodes(module, design, limits) {
    const cells = module.cells.filter(isUserInstance);
    if (cells.length > limits.instances) {
        fail('DESIGN_LIMIT', '顶层实例数量超出架构图预算', { kind: 'instances', used: cells.length, limit: limits.instances });
    }
    return cells.map(cell => {
        const target = cell.moduleId ? findModule(design, cell.moduleId) : null;
        const moduleType = instanceModuleLabel(cell);
        const ports = (target ? target.ports : []).map(port => {
            const connection = cell.ports.find(item => item.name === port.name);
            const width = connection && connection.bits.length ? connection.bits.length : port.bits.length;
            return { name: port.name, direction: port.direction, width };
        });
        return {
            id: 'instance:' + cell.name, kind: 'instance', label: cell.name + ' (' + moduleType + ')',
            name: cell.name, module: moduleType, moduleId: target ? target.id : null,
            implementation: target && flagSet(target.attributes && target.attributes.blackbox) ? 'blackbox' : 'collapsed',
            status: target ? 'resolved' : 'unresolved', ports,
            width: Math.max(150, (cell.name + ' (' + moduleType + ')').length * 7 + 44),
            height: Math.max(62, ports.length * 22 + 32)
        };
    });
}

/** @param {object} module 顶层模块。 @returns {object[]} 顶层端口边界节点（输入在左、输出在右）。 */
function buildBoundaryNodes(module) {
    return module.ports.map(port => {
        const direction = port.direction === 'output' ? 'output' : port.direction === 'inout' ? 'inout' : 'input';
        return {
            id: 'boundary:' + port.name, kind: 'boundary', label: port.name, name: port.name,
            direction, implementation: null, status: 'resolved',
            ports: [{ name: port.name, direction: direction === 'input' ? 'output' : direction === 'output' ? 'input' : 'inout', width: port.bits.length }],
            width: Math.max(72, port.name.length * 8 + 32), height: 40
        };
    });
}

/** @param {string} bit Yosys bit。 @param {object[]} signals 顶层 netnames。 @returns {string[]} 覆盖该 bit 的可见网络名。 */
function namesOfBit(bit, signals) {
    const names = [];
    for (const signal of signals) {
        if (!signal.hidden && signal.bits.includes(bit)) {
            names.push(signal.name);
        }
    }
    return names;
}

/** @param {Map<string,object>} endpoints @param {string} bit @param {string} direction @param {string} endpoint 记录端口端点。 */
function track(endpoints, bit, direction, endpoint) {
    if (!endpoints.has(bit)) {
        endpoints.set(bit, { drivers: new Set(), sinks: new Set(), ambiguous: new Set() });
    }
    const entry = endpoints.get(bit);
    if (direction === 'output') {
        entry.drivers.add(endpoint);
    } else if (direction === 'input') {
        entry.sinks.add(endpoint);
    } else {
        entry.ambiguous.add(endpoint);
    }
}

/** @param {object} module 顶层模块。 @param {object} nodes 全部节点。 @param {object} limits 预算。 @returns {{edges:object[], stats:object}} 经 netnames 的端口连边。 */
function buildEdges(module, nodes, limits) {
    const endpoints = new Map();
    for (const node of nodes) {
        for (const port of node.ports) {
            const bitSource = node.kind === 'boundary'
                ? boundaryBits(module, node.name)
                : (module.cells.find(item => item.name === node.name)?.ports.find(item => item.name === port.name)?.bits || []);
            for (const bit of bitSource) {
                track(endpoints, bit, port.direction, node.id + '/' + port.name);
            }
        }
    }
    const groups = new Map();
    for (const [bit, entry] of endpoints) {
        const drivers = [...entry.drivers].sort(), sinks = [...entry.sinks].sort(), ambiguous = [...entry.ambiguous].sort();
        const key = JSON.stringify([drivers, sinks, ambiguous]);
        if (!groups.has(key)) {
            groups.set(key, { drivers, sinks, ambiguous, bits: [] });
        }
        groups.get(key).bits.push(bit);
    }
    const edges = [];
    let undrivenBits = 0, multiDriverBits = 0, ambiguousBits = 0;
    for (const group of groups.values()) {
        if (!group.drivers.length && (group.sinks.length || group.ambiguous.length)) {
            undrivenBits += group.bits.length;
        }
        if (group.drivers.length > 1) {
            multiDriverBits += group.bits.length;
        }
        if (group.ambiguous.length) {
            ambiguousBits += group.bits.length;
        }
        if (!group.drivers.length) {
            continue;
        }
        const netNames = [...new Set(group.bits.flatMap(bit => namesOfBit(bit, module.signals)))].sort();
        for (const driver of group.drivers) {
            for (const sink of group.sinks) {
                edges.push({ source: driver, target: sink, width: group.bits.length, netNames });
            }
        }
    }
    edges.sort((left, right) => (left.source + '>' + left.target + '>' + left.width) < (right.source + '>' + right.target + '>' + right.width) ? -1 : 1);
    if (edges.length > limits.edges) {
        fail('DESIGN_LIMIT', '架构图连边数量超出预算', { kind: 'edges', used: edges.length, limit: limits.edges });
    }
    return { edges, stats: { bits: endpoints.size, undrivenBits, multiDriverBits, ambiguousBits } };
}

/** @param {object} module 顶层模块。 @param {string} name 顶层端口名。 @returns {string[]} 端口 bit。 */
function boundaryBits(module, name) {
    const port = module.ports.find(item => item.name === name);
    return port ? port.bits : [];
}

/** @param {string} endpoint 端点 id（nodeId/portName）。 @returns {{nodeId:string, portName:string}} 拆分的节点与端口名。 */
function splitEndpoint(endpoint) {
    const index = endpoint.lastIndexOf('/');
    return { nodeId: endpoint.slice(0, index), portName: endpoint.slice(index + 1) };
}

/** @param {string} id 节点 id。 @returns {string} 实例或边界节点名。 */
function endpointName(id) {
    return id.startsWith('boundary:') ? id.slice('boundary:'.length) : id.slice('instance:'.length);
}

/** @param {string} name 顶层端口名。 @returns {string|null} 可聚合的边界前缀；clk/rst 等保留名与无下划线端口返回 null。 */
function boundaryPrefix(name) {
    const reserved = new Set(['clk', 'rst', 'reset', 'nrst', 'arst', 'srst', 'por']);
    const index = name.indexOf('_');
    if (index < 3) {
        return null;
    }
    const prefix = name.slice(0, index);
    if (!/^[A-Za-z][A-Za-z0-9]{2,}$/.test(prefix) || reserved.has(prefix.toLowerCase())) {
        return null;
    }
    return prefix;
}

/** @param {string[]} names 信号名。 @returns {string|null} 按最后一个 '_' 截断后的公共前缀（含下划线，长度≥3）。 */
function commonSignalPrefix(names) {
    const candidates = names.map(name => {
        const index = name.lastIndexOf('_');
        return index >= 0 ? name.slice(0, index + 1) : name;
    }).filter(name => name.length >= 3);
    if (!candidates.length) {
        return null;
    }
    let prefix = candidates[0];
    for (const candidate of candidates.slice(1)) {
        while (prefix && !candidate.startsWith(prefix)) {
            prefix = prefix.slice(0, -1);
        }
    }
    return prefix.length >= 3 && prefix.includes('_') ? prefix : null;
}

/** @param {string} label 已拼接标签。 @returns {string} 不超过48字符的接口标签（不含位宽后缀）。 */
function trimLabel(label) {
    return label.length > 48 ? label.slice(0, 47) + '…' : label;
}

/** @param {{kind:string,name:string}} from @param {{kind:string,name:string}} to @returns {string} 稳定接口 id。 */
function interfaceId(from, to) {
    return 'interface:' + hashText(JSON.stringify([from.kind, from.name, to.kind, to.name])).slice(0, 12);
}

/** @param {Map<string,object>} signals @returns {object[]} 排序后的成员信号。 */
function signalList(signals) {
    return [...signals.values()].map(signal => ({ name: signal.name, width: signal.width, direction: signal.direction }))
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

/** @param {Map<string,object>} map @param {string} name @param {number} width @param {string} direction @returns {void} 记录去重后的成员信号。 */
function addSignal(map, name, width, direction) {
    const existing = map.get(name);
    if (existing) {
        existing.width = Math.max(existing.width, width);
        if (existing.direction !== direction) {
            existing.direction = 'bidirectional';
        }
        return;
    }
    map.set(name, { name, width, direction });
}

/** @param {object[]} signals @returns {string|null} 时钟/复位类信号的语义标签（如 clk/rst）；混入其他信号返回 null。 */
function clockResetLabel(signals) {
    const kinds = new Set();
    for (const signal of signals) {
        if (/^(?:clk|clock)/i.test(signal.name)) {
            kinds.add('clk');
        } else if (/^(?:rst|reset|nrst|arst|srst)/i.test(signal.name)) {
            kinds.add('rst');
        } else {
            return null;
        }
    }
    return kinds.size ? ['clk', 'rst'].filter(kind => kinds.has(kind)).join('/') : null;
}

/** @param {object[]} signals @returns {string} 接口标签（不含位宽）：语义标签 > 信号公共前缀 > 最多两个信号名摘要。 */
function labelForSignals(signals) {
    const semantic = clockResetLabel(signals);
    if (semantic) {
        return semantic;
    }
    const names = signals.map(signal => signal.name);
    const prefix = commonSignalPrefix(names);
    if (prefix) {
        return prefix + '*';
    }
    const unique = [...new Set(names)];
    return unique.length > 2 ? unique.slice(0, 2).join(', ') + '…' : unique.join(', ');
}

/**
 * 把信号级端口连接抽象为架构接口束。
 * 实例↔实例先合并双向对；同源实例且源端口集合相同的多目标连接合并为扇出接口；实例↔边界按顶层端口前缀分组。
 * inout 端口按顶层连接补齐为双向。
 * @param {object} module 顶层模块。 @param {object[]} nodes 架构节点。 @param {object[]} edges 信号级连边。
 * @returns {object[]} 接口束列表；多端名称用 '+' 连接。
 */
function buildInterfaces(module, nodes, edges) {
    const kinds = new Map(nodes.filter(node => node.kind === 'instance' || node.kind === 'boundary').map(node => [node.id, node.kind]));
    const directed = new Map();
    const boundaryGroups = new Map();
    function directedGroup(source, target) {
        const key = source + '\u0000' + target;
        if (!directed.has(key)) {
            directed.set(key, { source, target, ports: new Map(), signals: new Map() });
        }
        return directed.get(key);
    }
    function boundaryGroup(portName) {
        const prefix = boundaryPrefix(portName);
        // 前缀束与精确端口分属不同命名空间，避免 gpio 与 gpio_a 被合并。
        const key = prefix ? 'prefix:' + prefix : 'port:' + portName;
        if (!boundaryGroups.has(key)) {
            boundaryGroups.set(key, { prefix, boundaryPorts: new Set(), instances: new Set(), signals: new Map() });
        }
        return boundaryGroups.get(key);
    }
    for (const edge of edges) {
        const sourceKind = kinds.get(edge.sourceNode), targetKind = kinds.get(edge.targetNode);
        if (!sourceKind || !targetKind) {
            continue;
        }
        const signalName = edge.netNames[0] || splitEndpoint(edge.source).portName;
        if (sourceKind === 'instance' && targetKind === 'instance') {
            const source = endpointName(edge.sourceNode), target = endpointName(edge.targetNode);
            if (source === target) {
                continue;
            }
            const group = directedGroup(source, target), sourcePort = splitEndpoint(edge.source).portName;
            group.ports.set(sourcePort, Math.max(group.ports.get(sourcePort) || 0, edge.width));
            addSignal(group.signals, signalName, edge.width, 'forward');
        } else if (sourceKind === 'boundary' && targetKind === 'instance') {
            const group = boundaryGroup(splitEndpoint(edge.source).portName);
            group.instances.add(endpointName(edge.targetNode));
            group.boundaryPorts.add(splitEndpoint(edge.source).portName);
            addSignal(group.signals, splitEndpoint(edge.source).portName, edge.width, 'input');
        } else if (sourceKind === 'instance' && targetKind === 'boundary') {
            const group = boundaryGroup(splitEndpoint(edge.target).portName);
            group.instances.add(endpointName(edge.sourceNode));
            group.boundaryPorts.add(splitEndpoint(edge.target).portName);
            addSignal(group.signals, splitEndpoint(edge.target).portName, edge.width, 'output');
        }
    }
    // inout 顶层端口在信号级连边中方向未知，仅按用户模块实例连接补齐为双向接口。
    for (const port of module.ports.filter(item => item.direction === 'inout')) {
        const matched = module.cells.filter(isUserInstance)
            .filter(cell => cell.ports.some(item => item.bits.some(bit => port.bits.includes(bit))));
        if (!matched.length) {
            continue;
        }
        const group = boundaryGroup(port.name);
        for (const cell of matched) {
            group.instances.add(cell.name);
            group.boundaryPorts.add(port.name);
            addSignal(group.signals, port.name, port.bits.length, 'inout');
        }
    }
    const interfaces = [];
    const consumed = new Set();
    // 双向实例对：A→B 与 B→A 的成员合并为一个双向接口。
    for (const [key, group] of directed) {
        if (consumed.has(key)) {
            continue;
        }
        const reverse = directed.get(group.target + '\u0000' + group.source);
        if (!reverse) {
            continue;
        }
        consumed.add(key);
        consumed.add(group.target + '\u0000' + group.source);
        const names = [group.source, group.target].sort();
        const from = { kind: 'instance', name: names[0] }, to = { kind: 'instance', name: names[1] };
        const combined = new Map();
        for (const item of [group, reverse]) {
            for (const signal of item.signals.values()) {
                addSignal(combined, signal.name, signal.width, item.source === from.name ? 'forward' : 'reverse');
            }
        }
        const signals = signalList(combined);
        const bits = signals.reduce((total, signal) => total + signal.width, 0);
        interfaces.push({ id: interfaceId(from, to), from, to, direction: 'bidirectional', bits,
            label: trimLabel(labelForSignals(signals)), signals });
    }
    // 单向连接：同源实例且源端口集合相同的多目标连接合并为一条扇出接口。
    const fanout = new Map();
    for (const [key, group] of directed) {
        if (consumed.has(key)) {
            continue;
        }
        const signature = [...group.ports.entries()].sort(([left], [right]) => left < right ? -1 : 1)
            .map(([port, width]) => port + ':' + width).join(',');
        const fanoutKey = group.source + '\u0000' + signature;
        if (!fanout.has(fanoutKey)) {
            fanout.set(fanoutKey, { source: group.source, ports: group.ports, targets: new Set(), signals: new Map() });
        }
        const entry = fanout.get(fanoutKey);
        entry.targets.add(group.target);
        for (const signal of group.signals.values()) {
            addSignal(entry.signals, signal.name, signal.width, 'forward');
        }
    }
    for (const group of fanout.values()) {
        const targets = [...group.targets].sort();
        const from = { kind: 'instance', name: group.source }, to = { kind: 'instance', name: targets.join('+') };
        const signals = signalList(group.signals);
        const bits = signals.reduce((total, signal) => total + signal.width, 0);
        interfaces.push({ id: interfaceId(from, to), from, to, direction: 'forward', bits,
            label: trimLabel(labelForSignals(signals)), signals });
    }
    for (const group of boundaryGroups.values()) {
        const signals = signalList(group.signals);
        if (!signals.length || !group.instances.size) {
            continue;
        }
        const directions = new Set(signals.map(signal => signal.direction));
        const bidirectional = directions.has('bidirectional') || directions.has('inout') || (directions.has('input') && directions.has('output'));
        const boundaryName = [...group.boundaryPorts].sort().join('+');
        const instanceName = [...group.instances].sort().join('+');
        const onlyOutput = !bidirectional && directions.has('output');
        const from = onlyOutput ? { kind: 'instance', name: instanceName } : { kind: 'boundary', name: boundaryName };
        const to = onlyOutput ? { kind: 'boundary', name: boundaryName } : { kind: 'instance', name: instanceName };
        const bits = signals.reduce((total, signal) => total + signal.width, 0);
        const label = group.prefix ? group.prefix + '*' : signals[0].name;
        interfaces.push({ id: interfaceId(from, to), from, to, direction: bidirectional ? 'bidirectional' : 'forward',
            bits, label: trimLabel(label), signals });
    }
    interfaces.sort((left, right) => {
        const leftKey = [left.from.kind, left.from.name, left.to.kind, left.to.name].join('\u0000');
        const rightKey = [right.from.kind, right.from.name, right.to.kind, right.to.name].join('\u0000');
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    return interfaces;
}


/** @param {object} design 已验证设计。 @param {string} id 实例目标模块 id。 @returns {object|null} 接口表引用（$paramod 归一到声明模块）。 */
function interfaceReference(design, id) {
    const reference = findModule(design, id);
    if (!reference) {
        return null;
    }
    const pretty = prettifyModuleType(reference.name);
    return pretty.summary ? (design.modules.find(module => module.name === pretty.base) || reference) : reference;
}

/**
 * 把已验证的 Yosys 电路设计投影为顶层架构图与接口表。
 * @param {object} design fromYosys 结果。 @param {{workspace:string, depth?:number, budget?:object}} options
 * @returns {object} 架构模型（modules/instances/unresolved/interfaces/graph/limitations）。
 */
function projectArchitecture(design, { workspace, depth = 1, budget = {} }) {
    const limits = { ...DEFAULT_BUDGET, ...budget };
    for (const [name, limit] of Object.entries(limits)) {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            fail('INVALID_ARGUMENT', '无效预算项：' + name);
        }
    }
    if (!Number.isSafeInteger(depth) || depth < 1) {
        fail('INVALID_ARGUMENT', '--depth要求正整数');
    }
    if (design.modules.length > limits.modules) {
        fail('DESIGN_LIMIT', '模块数量超出架构图预算', { kind: 'modules', used: design.modules.length, limit: limits.modules });
    }
    const module = findModule(design, design.top);
    if (!module) {
        fail('MODULE_NOT_FOUND', 'Yosys 结果缺少顶层模块', { top: design.title });
    }
    const instanceNodes = buildInstanceNodes(module, design, limits);
    const boundaryNodes = buildBoundaryNodes(module);
    const nodes = [...boundaryNodes, ...instanceNodes];
    const connected = buildEdges(module, nodes, limits);
    const edges = connected.edges.map(edge => {
        const source = splitEndpoint(edge.source), target = splitEndpoint(edge.target);
        return { source: edge.source, target: edge.target, sourceNode: source.nodeId, sourcePort: source.portName,
            targetNode: target.nodeId, targetPort: target.portName, width: edge.width, netNames: edge.netNames };
    });
    const interfaces = buildInterfaces(module, nodes, edges);
    const unresolved = instanceNodes.filter(node => node.status === 'unresolved').map(node => {
        const cell = module.cells.find(item => item.name === node.name);
        const source = relativeSource(cell && cell.source, workspace);
        return { kind: 'instance', name: node.name, module: cell ? cell.type : node.module, instance: node.id, ...(source ? { source } : {}) };
    });
    const moduleIds = [...new Set([module.id, ...instanceNodes.filter(node => node.moduleId)
        .map(node => interfaceReference(design, node.moduleId))
        .filter(Boolean)
        .map(reference => reference.id)])];
    const interfaceModules = moduleIds.map(id => findModule(design, id)).filter(Boolean).map(reference => ({
        id: reference.id, name: moduleLabel(reference),
        file: reference.source ? relativePosix(workspace, reference.source.path) : null,
        blackbox: flagSet(reference.attributes && reference.attributes.blackbox),
        parameters: decodeParameters(reference.parameters),
        ports: reference.ports.map(port => {
            const source = relativeSource(port.source, workspace);
            return { name: port.name, direction: port.direction, width: port.bits.length, ...(source ? { source } : {}) };
        })
    }));
    const instances = instanceNodes.map(node => {
        const cell = module.cells.find(item => item.name === node.name);
        const source = relativeSource(cell && cell.source, workspace);
        return { name: node.name, module: node.module, moduleId: node.moduleId, implementation: node.implementation,
            status: node.status, nodeId: node.id, ports: node.ports, ...(source ? { source } : {}) };
    });
    const limitations = [
        '架构图是源级结构事实：未综合、未做时序或功能验证，不得作为综合/时序证据。',
        '只投影顶层实例与顶层端口；子模块内部实现折叠为盒，内部网络、寄存器和存储不单独入图。',
        '仅保留用户模块实例；工具生成的 $ 单元（组合/时序/存储）不绘制为节点。',
        '参数覆盖以实例连接位宽为准，模块接口表为声明默认值；未连接端口按声明默认位宽。',
        '未连接/多驱动等结构问题在D2检查；本交付只呈现连接关系。',
        '缺失子模块按unresolved展示为无端口盒，不伪造端口表。',
        'IP/BD、动态XDC与宏include不在4.2范围。'
    ];
    if (depth > 1) {
        limitations.push('--depth大于1尚未展开子层，当前固定按顶层实例投影。');
    }
    return {
        schemaVersion: SCHEMA_VERSION, stage: STAGE,
        top: { name: module.name, moduleId: module.id, file: module.source ? relativePosix(workspace, module.source.path) : null },
        modules: interfaceModules, instances, unresolved, interfaces,
        graph: { nodes, edges, stats: { ...connected.stats, modules: interfaceModules.length, instances: instanceNodes.length,
            boundaries: boundaryNodes.length, nodes: nodes.length, edges: edges.length, depth } },
        limitations
    };
}

/** @param {object} data 架构数据。 @returns {string} 稳定架构哈希（不含 archSha256 自身）。 */
function archHash(data) {
    const hashable = { ...data };
    delete hashable.archSha256;
    return hashText(stableStringify(hashable));
}

/**
 * 构造架构 Yosys 脚本：hierarchy 后只跑 proc 与 memory_collect，不跑 prep/opt。
 * @param {string[]} sources guest 源文件。 @param {string[]} includeDirs guest include 目录。
 * @param {string[]} defines 宏定义。 @param {string} top 顶层模块。 @param {string} outputPath guest 输出路径。
 * @returns {string} 脚本内容。
 */
function buildArchScript(sources, includeDirs, defines, top, outputPath) {
    if (!TOP_GLOB.test(top || '')) {
        fail('INVALID_ARGUMENT', '--top需要普通HDL标识符');
    }
    const words = ['read_verilog', '-sv'];
    for (const define of defines) {
        if (typeof define !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*(?:=[^\s"'\\]*)?$/.test(define)) {
            fail('INVALID_ARGUMENT', '架构生成暂不支持含空白或引号的宏定义');
        }
        words.push('-D' + define);
    }
    for (const include of includeDirs) {
        words.push('-I' + include);
    }
    words.push(...sources.map(source => yosysQuote(source)));
    return [words.join(' '), 'hierarchy -top ' + top, 'proc', 'memory_collect', 'write_json ' + yosysQuote(outputPath), ''].join('\n');
}

/** @param {string} text Yosys 输出。 @returns {string} 错误摘要。 */
function errorSummary(text) {
    const value = String(text || '');
    const errors = value.split(/\r?\n/).map(line => line.trim()).filter(line => /ERROR/i.test(line));
    return (errors.length ? errors.join('\n') : value.trim().split(/\r?\n/).slice(-6).join('\n')).slice(-MAX_ERROR_CHARS);
}

/**
 * 把 Yosys 失败文本分类为稳定错误码，供调用层附加日志与上下文。
 * @param {string} logs Yosys stdout/stderr。 @param {{errorMessage?:string, code?:number}} [output] 进程结果。
 * @returns {{code:string, message:string, details:object}} 分类结果。
 */
function classifyYosysFailure(logs, output = {}) {
    const summary = errorSummary(logs) || output.errorMessage || 'Yosys 未完成架构生成';
    if (/Re-definition of module/i.test(logs)) {
        return { code: 'AMBIGUOUS_MODULE', message: 'Yosys报告同名模块重复声明', details: { candidates: [], message: summary } };
    }
    if (/Module `[^']*' not found|top module .* not found/i.test(logs)) {
        return { code: 'MODULE_NOT_FOUND', message: '未找到指定顶层模块', details: { message: summary } };
    }
    if (/资源缺失|无法加载内置 Yosys|资源校验失败|ENOENT|WASM/i.test(logs + (output.errorMessage || ''))) {
        return { code: 'TOOL_NOT_FOUND', message: '内置 Yosys 不可用：' + summary, details: {} };
    }
    return { code: 'DESIGN_FAILED', message: 'Yosys 架构生成失败：' + summary, details: { exitCode: output.code } };
}

/**
 * 运行内置 Yosys 并生成顶层架构模型。
 * @param {{workspace:string, files:{path:string,text:string}[], top:string, includeDirs?:string[], defines?:string[],
 *   depth?:number, timeoutMs?:number, budget?:object, contextRevision?:string|null}} options
 * @returns {Promise<object>} 架构数据（schemaVersion/stage/top/modules/instances/unresolved/graph/limitations）。
 */
async function buildArchitecture({ workspace, files, top, includeDirs = [], defines = [], depth = 1, timeoutMs = DEFAULT_TIMEOUT_MS,
    budget = {}, contextRevision = null }) {
    if (!TOP_GLOB.test(top || '')) {
        fail('INVALID_ARGUMENT', '--top需要普通HDL标识符');
    }
    const limits = { ...DEFAULT_BUDGET, ...budget };
    for (const [name, limit] of Object.entries(limits)) {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            fail('INVALID_ARGUMENT', '无效预算项：' + name);
        }
    }
    checkModuleBudget(files, limits);
    const duplicates = duplicateCandidates(files, workspace);
    if (duplicates) {
        fail('AMBIGUOUS_MODULE', '工作区存在同名模块声明，请先消除歧义', { names: duplicates.names, candidates: duplicates.candidates });
    }
    const hdl = files.filter(file => SOURCE_GLOB.test(file.path));
    if (!hdl.length) {
        fail('MODULE_NOT_FOUND', '工作区没有可用的Verilog/SystemVerilog源文件', { top });
    }
    const runDirectory = await createRunDirectory(workspace);
    let bundled;
    try {
        bundled = await prepareBundledYosys({ directory: runDirectory, sourceRoot: workspace,
            sources: hdl.map(file => file.path), includeDirs });
    } catch (error) {
        await fs.rm(runDirectory, { recursive: true, force: true }).catch(() => {});
        const message = '内置 Yosys 输入准备失败：' + error.message;
        if (/内置 Yosys|yosys\.wasm|bin\/vendor\/yosys/i.test(error.message)) {
            fail('TOOL_NOT_FOUND', message);
        }
        fail('DESIGN_FAILED', message);
    }
    const outputPath = bundled.outputPath;
    const script = buildArchScript(bundled.sources, bundled.includeDirs, defines, top, outputPath);
    await fs.writeFile(path.join(runDirectory, 'circuit.ys'), script, 'utf8');
    const logPath = path.join(runDirectory, 'yosys.log');
    const output = await runProcess(bundled.command, bundled.args, { cwd: workspace,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs, logPath });
    const logs = [output.stdout, output.stderr].filter(Boolean).join('\n');
    const failed = !processSucceeded(output);
    if (failed) {
        const classified = classifyYosysFailure(logs, output);
        // 失败时保留任务目录，日志作为artifact交由调用者读取。
        fail(classified.code, classified.message, { ...classified.details, ...(classified.code === 'MODULE_NOT_FOUND' ? { top } : {}),
            logPath, artifacts: [{ kind: 'log', path: logPath }] });
    }
    const jsonPath = path.join(runDirectory, path.basename(outputPath));
    let raw;
    try {
        raw = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    } catch (error) {
        fail('DESIGN_FAILED', 'Yosys 未生成可用的架构JSON：' + error.message, { logPath, artifacts: [{ kind: 'log', path: logPath }] });
    }
    let design;
    try {
        design = remapDesignSources(fromYosys(raw, { top, title: top, stage: STAGE }), bundled.sourceDirectories);
    } catch (error) {
        fail('DESIGN_FAILED', 'Yosys JSON 无法构成架构模型：' + error.message, { logPath, artifacts: [{ kind: 'log', path: logPath }] });
    }
    const data = projectArchitecture(design, { workspace, depth, budget: limits });
    data.contextRevision = contextRevision || null;
    data.sourceFiles = files.map(file => ({ path: relativePosix(workspace, file.path), sha256: hashText(file.text) }))
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    data.designId = 'design:' + hashText(stableStringify([design.top, data.sourceFiles])).slice(0, 16);
    data.archSha256 = archHash(data);
    data.modelSha256 = data.archSha256;
    await fs.rm(runDirectory, { recursive: true, force: true }).catch(() => {});
    return data;
}

/** @param {string} workspace @returns {Promise<string>} 本次运行的私有任务目录。 */
async function createRunDirectory(workspace) {
    const runsDirectory = await directory(workspace, 'design', 'runs');
    const runDirectory = path.join(runsDirectory, randomUUID());
    await fs.mkdir(runDirectory);
    return runDirectory;
}

module.exports = { buildArchitecture, projectArchitecture, DEFAULT_BUDGET, SCHEMA_VERSION, buildArchScript, duplicateCandidates,
    classifyYosysFailure, blackboxFlag: flagSet };
