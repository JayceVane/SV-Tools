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

/** @param {object} module 顶层模块。 @param {object} design 已验证设计。 @param {object} limits 预算。 @returns {object[]} 顶层实例节点。 */
function buildInstanceNodes(module, design, limits) {
    if (module.cells.length > limits.instances) {
        fail('DESIGN_LIMIT', '顶层实例数量超出架构图预算', { kind: 'instances', used: module.cells.length, limit: limits.instances });
    }
    return module.cells.map(cell => {
        const target = cell.moduleId ? findModule(design, cell.moduleId) : null;
        const moduleType = target ? moduleLabel(target) : prettifyModuleType(cell.type).base;
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

/**
 * 把已验证的 Yosys 电路设计投影为顶层架构图与接口表。
 * @param {object} design fromYosys 结果。 @param {{workspace:string, depth?:number, budget?:object}} options
 * @returns {object} 架构模型（modules/instances/unresolved/graph/limitations）。
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
    const unresolved = instanceNodes.filter(node => node.status === 'unresolved').map(node => {
        const cell = module.cells.find(item => item.name === node.name);
        const source = relativeSource(cell && cell.source, workspace);
        return { kind: 'instance', name: node.name, module: cell ? cell.type : node.module, instance: node.id, ...(source ? { source } : {}) };
    });
    const moduleIds = [...new Set([module.id, ...instanceNodes.filter(node => node.moduleId).map(node => node.moduleId)])];
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
        '只投影顶层实例与顶层端口；子模块内部实现折叠为盒，内部网络不单独入图。',
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
        modules: interfaceModules, instances, unresolved,
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
 * 构造架构 Yosys 脚本：hierarchy 后只跑 proc，不跑 prep/opt。
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
    return [words.join(' '), 'hierarchy -top ' + top, 'proc', 'write_json ' + yosysQuote(outputPath), ''].join('\n');
}

/** @param {string} text Yosys 输出。 @returns {string} 错误摘要。 */
function errorSummary(text) {
    const value = String(text || '');
    const errors = value.split(/\r?\n/).map(line => line.trim()).filter(line => /ERROR/i.test(line));
    return (errors.length ? errors.join('\n') : value.trim().split(/\r?\n/).slice(-6).join('\n')).slice(-MAX_ERROR_CHARS);
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
        const summary = errorSummary(logs) || output.errorMessage || 'Yosys 未完成架构生成';
        // 失败时保留任务目录，日志作为artifact交由调用者读取。
        if (/Re-definition of module/i.test(logs)) {
            fail('AMBIGUOUS_MODULE', 'Yosys报告同名模块重复声明', { candidates: [], message: summary, logPath });
        }
        if (/Module `[^']*' not found|top module .* not found/i.test(logs)) {
            fail('MODULE_NOT_FOUND', '未找到指定顶层模块', { top, message: summary, logPath });
        }
        if (/资源缺失|无法加载内置 Yosys|资源校验失败|ENOENT|WASM/i.test(logs + (output.errorMessage || ''))) {
            fail('TOOL_NOT_FOUND', '内置 Yosys 不可用：' + summary, { runDirectory, logPath });
        }
        fail('DESIGN_FAILED', 'Yosys 架构生成失败：' + summary, { logPath, exitCode: output.code, artifacts: [{ kind: 'log', path: logPath }] });
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
    data.archSha256 = archHash(data);
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

module.exports = { buildArchitecture, projectArchitecture, DEFAULT_BUDGET, SCHEMA_VERSION, buildArchScript, duplicateCandidates };
