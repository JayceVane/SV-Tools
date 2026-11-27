'use strict';

const path = require('node:path');
const { resolveContext, assertCurrent, hash } = require('../agent/context');
const { json, unchanged } = require('./workflow-files');
const { projectArchitecture } = require('./arch');
const { analyzeStructure, unitInterface, interfaceOverrides, interfaceEvidence, position } = require('./struct');
const { bindings } = require('../project/rtl-model');
const { connectionEvidence } = require('./interface-evidence');
const { isClockLike } = require('./architecture-details');
const { walkthroughFor } = require('./architecture-reading');
const { bindDesignDocs } = require('./architecture-design-doc');
const { fail } = require('../agent/protocol');

const CONFIG = 'svtools.architecture.json';
const instanceId = name => 'instance:' + name;
const boundaryId = name => 'boundary:' + name;
const portKey = (node, port) => JSON.stringify([node, port]);
const property = (object, key) => object && Object.hasOwn(object, key) ? object[key] : undefined;
const label = value => typeof value === 'string' ? value.trim().slice(0, 140) : '';
const flip = direction => ({ input: 'output', output: 'input' })[direction] || direction;

async function readPresentation(root) {
    return json(root, CONFIG, 256 * 1024).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
    });
}


// 接口方向证据只在 struct 侧算一次；页面链接复用同一结论，避免两处对同一束接口给出不同方向。
const sharedEvidence = new WeakMap();
function evidenceFor(parsed) {
    let value = sharedEvidence.get(parsed);
    if (!value) {
        value = new Map(interfaceEvidence(parsed).map(item => [item.key, item]));
        sharedEvidence.set(parsed, value);
    }
    return value;
}

function typedConnections(unit, module, parsed, values, source) {
    const groups = new Map(), connectedPorts = new Set(), unitPorts = [...unit.ports];
    const at = (definition, offset) => source({ path: definition.source.path, ...position(definition.source.text, offset) });
    const endpoint = (definition, port, node, options = {}) => {
        const [interfaceName, modport] = port.type.split('.');
        const intf = parsed.units.get(interfaceName);
        const view = intf.modports.find(item => item.name === modport);
        return { node, port: port.name, name: options.name ?? port.name, type: port.type, modport, ...options,
            declaration: at(definition, port.start), modportSource: view && at(intf, view.start) };
    };
    for (const symbol of [...unitPorts, ...unit.instances.filter(item => item.scope === unit.scope.id)]) {
        if (unit.source.conditional(symbol.start)) continue;
        const [type, modport] = symbol.type.split('.');
        const intf = parsed.units.get(type);
        if (intf?.scope.kind !== 'interface' || intf.source.conditional(intf.scope.start)) continue;
        const boundary = symbol.kind === 'port';
        // A boundary can be connected to a parameterized instance in its parent.
        const overrides = boundary ? new Map(intf.parameters.filter(parameter => parameter.kind === 'parameter').map(parameter => [parameter.name, undefined]))
            : interfaceOverrides(unit, symbol, intf, values);
        const model = unitInterface(intf, overrides);
        const members = model.members.map((member, index) => ({ ...member,
            declaration: at(intf, intf.members[index].start) }));
        const endpoints = boundary ? [endpoint(unit, symbol, boundaryId(symbol.name), { boundary })] : [];
        if (boundary) connectedPorts.add(portKey(boundaryId(symbol.name), symbol.name));
        groups.set(symbol.name, { type, modport, model: { ...model, members }, endpoints,
            declaration: at(unit, symbol.start), definition: at(intf, intf.scope.start) });
    }
    const declared = new Map(unit.instances.filter(instance => instance.scope === unit.scope.id).map(instance => [instance.name, instance]));
    for (const cell of module.cells) {
        const instance = declared.get(cell.name), child = parsed.units.get(cell.type);
        if (!instance || !cell.moduleId || !child || unit.source.conditional(instance.start)) continue;
        let connections;
        const sites = new Map();
        try { connections = bindings(unit.source, instance.ports, child.ports.map(port => port.name), sites); }
        catch (error) {
            // 语法限制已由结构投影报告为 issue；其余异常说明解析管线有缺陷，不能静默吞掉。
            if (!/不能静态确定|无法确定顺序/.test(error.message)) throw error;
            continue;
        }
        for (const port of child.ports) {
            const [type, view] = port.type.split('.');
            if (parsed.units.get(type)?.scope.kind !== 'interface') continue;
            const node = instanceId(cell.name);
            connectedPorts.add(portKey(node, port.name));
            const tokens = connections.get(port.name);
            const actual = !tokens && connections.has('*') ? port.name : tokens?.length === 1 ? tokens[0].value : undefined;
            const group = groups.get(actual);
            if (group?.type !== type || child.source.conditional(port.start)) continue;
            const invalid = Boolean(view && group.modport && group.modport !== view);
            group.endpoints.push(endpoint(child, port, node, { name: cell.name + '.' + port.name, invalid,
                binding: at(unit, sites.get(port.name) ?? instance.start) }));
        }
    }
    const links = [], canonical = evidenceFor(parsed);
    for (const [name, group] of groups) {
        if (!group.endpoints.length) continue;
        const shared = canonical.get(name);
        links.push({ name, kind: 'interface', type: group.type, endpoints: group.endpoints, declaration: group.declaration,
            definition: group.definition, ...connectionEvidence(group.endpoints, group.model),
            // struct 的束级配对结论优先；本地的 routes 数组只用于渲染端点方向。
            ...(shared ? { flowEvidence: shared.flowEvidence, handshake: shared.handshake } : {}) });
    }
    return { links, connectedPorts };
}

function ordinaryConnection(edge, undirected) {
    const names = edge.netNames?.length ? edge.netNames : [edge.sourcePort + ' → ' + edge.targetPort];
    return { name: names.join(' / '), kind: 'signal', width: edge.width, names,
        labeled: Boolean(edge.netNames?.length && edge.netNames.every(name => isClockLike(name))),
        endpoints: [{ node: edge.sourceNode, port: edge.sourcePort }, { node: edge.targetNode, port: edge.targetPort }],
        routes: undirected ? [] : [{ source: 0, target: 1 }] };
}

function modulePage(module, { design, parsed, parameterValues }, chapterIds, presentation, source, workspace) {
    const unit = parsed.units.get(module.name);
    const id = chapterIds.get(module.id);
    const projection = projectArchitecture({ ...design, top: module.id }, { workspace });
    const parameters = Object.fromEntries([...parameterValues.get(module.id) || []].filter(([, value]) => Number.isSafeInteger(value)));
    const instanceByName = new Map(module.cells.map(cell => [cell.name, cell]));
    const typed = typedConnections(unit, module, parsed, parameterValues.get(module.id), source);
    function ports(items, definition) {
        const symbols = new Map(definition?.ports.map(port => [port.name, port]));
        const analyzed = new Map(items.map(port => [port.name, port]));
        return [...new Set([...symbols.keys(), ...analyzed.keys()])].map(name => {
            const symbol = symbols.get(name), port = analyzed.get(name), type = symbol?.type;
            const isInterface = parsed.units.get(type?.split('.')[0])?.scope.kind === 'interface';
            return { name, type, direction: isInterface ? 'interface' : symbol?.direction || port?.direction || 'unknown',
                width: isInterface ? undefined : port?.width,
                declaration: symbol && source({ path: definition.source.path, ...position(definition.source.text, symbol.start) }) };
        });
    }
    const grouping = property(presentation?.groups, module.name);
    const boundaryPorts = ports(projection.modules[0].ports, unit);
    const byPortName = new Map(boundaryPorts.map(port => [port.name, port]));
    const nodes = projection.graph.nodes.map(node => {
        if (node.kind === 'boundary') return { id: node.id, name: node.name, kind: node.kind, direction: node.direction,
            ports: [byPortName.get(node.name)] };
        const cell = instanceByName.get(node.name), definition = parsed.units.get(cell.type);
        return { id: node.id, name: node.name, type: cell.type, kind: node.kind,
            title: label(property(presentation?.titles, cell.type)), group: label(property(grouping, node.name)),
            chapter: chapterIds.get(cell.moduleId), ports: ports(node.ports, definition), source: source(cell.source),
            parameters: Object.fromEntries([...parameterValues.get(cell.moduleId) || []].filter(([, value]) => Number.isSafeInteger(value))),
            implementation: node.empty ? 'stub' : node.status === 'unresolved' ? 'unresolved' : 'defined' };
    });
    const raw = [...projection.graph.edges.map(edge => [edge, false]), ...projection.interfaces.filter(link => link.direction === 'connection')
        .flatMap(link => link.bindings.map(binding => [binding, true]))];
    const typedPort = (node, port) => typed.connectedPorts.has(portKey(node, port));
    const ordinary = raw.filter(([edge]) => !typedPort(edge.sourceNode, edge.sourcePort) && !typedPort(edge.targetNode, edge.targetPort))
        .map(([edge, undirected]) => ordinaryConnection(edge, undirected));
    const links = [...typed.links, ...ordinary].map((link, index) => ({ ...link, id: `${id}-link-${index + 1}` }));
    const checks = projection.checks.filter(item => {
        const { instance, port } = item.details || {};
        // Synthetic widths are placeholders for the shared interface; use the real interface bindings above.
        return !instance || !port || !typedPort(instanceId(instance), port) || item.code === 'UNCONNECTED_PORT' &&
            !typed.links.some(link => link.endpoints.some(endpoint => endpoint.node === instanceId(instance) && endpoint.port === port));
    });
    for (const link of typed.links) {
        const conflicts = link.members.filter(member => member.drivers.length > 1).map(member => ({
            name: member.name, outputs: member.drivers.map(index => link.endpoints[index].name)
        }));
        if (conflicts.length) checks.push({
            code: 'ARCH_INTERFACE_MULTI_DRIVER', severity: 'warning',
            message: `接口 ${link.name} 的成员 ${conflicts.map(member => member.name).join('、')} 声明了多个输出端，请复核仲裁或汇聚约定。`,
            source: link.declaration && { file: link.declaration.file, line: link.declaration.line },
            details: { interface: link.name, members: conflicts }
        });
    }
    const instances = nodes.filter(node => node.kind === 'instance');
    const dense = instances.length > 6 || links.length > 18 || nodes.length > 14 || instances.some(node => node.ports.length > 14);
    const hasStructure = instances.length > 0;
    const walkthrough = walkthroughFor({ links }, property(presentation?.walkthroughs, module.name));
    return { id, name: module.name, title: label(property(presentation?.titles, module.name)), source: source(module.source), empty: unit.empty, walkthrough,
        nodes, links, checks, parameters, hasStructure, ports: boundaryPorts, auto: dense ? 'overview' : 'detailed' };
}

async function buildArchitectureBook(snapshot, native) {
    const { context, contents } = snapshot;
    const workspace = context.workspace;
    const presentation = await readPresentation(workspace);
    const presentationRevision = hash(JSON.stringify(presentation));
    const basis = analyzeStructure({ workspace, files: [...contents].map(([path, item]) => ({ path, text: item.text })),
        top: context.top, defines: context.defines, native });
    const { design } = basis;
    const byId = new Map(design.modules.map(module => [module.id, module]));
    const ids = new Map();
    const positions = new Map();
    function visit(id, parent = null, number = '1') {
        const module = byId.get(id);
        if (!module || ids.has(id)) return;
        ids.set(id, 'module-' + (ids.size + 1));
        positions.set(id, { parent: parent ? ids.get(parent) : null, number, depth: number.split('.').length - 1 });
        let child = 0;
        for (const cell of module.cells) {
            if (!byId.has(cell.moduleId) || ids.has(cell.moduleId)) continue;
            visit(cell.moduleId, id, number + '.' + ++child);
        }
    }
    visit(design.top);
    const sourceLocations = new Map();
    const sourceIds = new Map();
    function source(location) {
        if (!location || !contents.has(location.path)) return;
        const key = JSON.stringify(location);
        let id = sourceIds.get(key);
        if (!id) {
            id = 'source-' + (sourceIds.size + 1);
            sourceIds.set(key, id);
            sourceLocations.set(id, location);
        }
        return { id, file: path.relative(workspace, location.path).split(path.sep).join('/'), line: location.line };
    }
    const pages = [...ids.keys()].map(id => ({ ...modulePage(byId.get(id), basis, ids, presentation, source, workspace), ...positions.get(id) }));
    const { documents, bindings: designDocs } = await bindDesignDocs(workspace, presentation?.designDocs, pages, basis.parsed.units);
    const designDocFiles = [...documents.values()].map(({ path, sha256 }) => ({ path, sha256 }));
    const documentRevision = designDocFiles.length ? hash(JSON.stringify(designDocFiles)) : '';
    const loaded = { snapshot, presentationRevision, sourceLocations, designDocFiles, designDocs,
        book: { revision: hash(context.revision + presentationRevision + documentRevision),
        top: context.top, pages, diagnostics: basis.parsed.diagnostics, issues: basis.issues } };
    await assertBookCurrent(loaded);
    return loaded;
}

async function assertBookCurrent({ snapshot, presentationRevision, designDocFiles }) {
    await assertCurrent(snapshot);
    if (hash(JSON.stringify(await readPresentation(snapshot.context.workspace))) !== presentationRevision)
        throw new Error(CONFIG + ' 已修改，请重新读取架构。');
    if (designDocFiles?.length && !await unchanged(snapshot.context.workspace, designDocFiles))
        fail('CONTEXT_CHANGED', '绑定的模块设计文档已修改，请重新读取架构。', {}, 4);
}

function resolveReviewFocus(book, target) {
    if (book.top !== target.top) return;
    const chapters = new Map(book.pages.map(page => [page.id, page]));
    let page = book.pages[0];
    const ancestors = [];
    for (const instance of target.path) {
        ancestors.push(page.id);
        page = chapters.get(page.nodes.find(node => node.kind === 'instance' && node.name === instance)?.chapter);
        if (!page) return;
    }
    if (page.source?.file !== target.source.path) return;
    const nodes = [];
    for (const name of target.instances) {
        const node = page.nodes.find(node => node.kind === 'instance' && node.name === name);
        if (!node) return;
        nodes.push(node.id);
    }
    const links = new Set();
    for (const name of target.links) {
        const matches = page.links.filter(link => link.name === name || link.names?.includes(name));
        if (!matches.length) return;
        for (const link of matches) links.add(link.id);
    }
    return { page: page.id, ancestors, nodes, links: [...links] };
}

module.exports = { buildArchitectureBook, assertBookCurrent, resolveContext, resolveReviewFocus };
