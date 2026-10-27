'use strict';
const { createTopologyIndex, declaredIndex } = require('../circuit/topology');
const MAX_CONTEXTS = 3000, MAX_DEPTH = 64, MAX_REFERENCES = 500000, MAX_VISITS = 100000, MAX_DETAILS = 256;
const contextKey = instancePath => JSON.stringify(instancePath);
/**
 * 读取真实实例树，实例ID独立于同文件、同模块名；不接受循环层级。
 * @param {object} design 已验证领域模型。
 * @returns {object} 有界实例快照和索引，缺失层级明确标注。
 */
function projectHierarchy(design) {
    const modules = new Map(design.modules.map(module => [module.id, module])), contexts = new Map(), nodes = [], issues = [];
    const queue = [{ moduleId: design.top, instancePath: [], names: [], ancestors: [] }];
    let scannedCells = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const current = queue[cursor], module = modules.get(current.moduleId);
        if (!module) {
            issues.push('实例引用的模块缺失');
            continue;
        }
        const id = contextKey(current.instancePath), parentId = current.instancePath.length ? contextKey(current.instancePath.slice(0, -1)) : null;
        const node = { id, parentId, moduleId: module.id, moduleName: module.name, instancePath: current.instancePath,
            names: current.names, label: current.names.length ? current.names.at(-1) + ' : ' + module.name : module.name,
            source: module.source, instanceSource: current.instanceSource, roles: [], details: [] };
        nodes.push(node);
        contexts.set(id, { ...current, node, module });
        for (const cell of module.cells)
            if (cell.moduleId) {
                if (++scannedCells > MAX_VISITS || queue.length >= MAX_CONTEXTS) {
                    if (!issues.includes('实例层级达到扫描预算，剩余部分未展开')) {
                        issues.push('实例层级达到扫描预算，剩余部分未展开');
                    }
                    break;
                }
                if (queue.length >= MAX_CONTEXTS || current.instancePath.length >= MAX_DEPTH || [...current.ancestors, module.id].includes(cell.moduleId)) {
                    issues.push('实例层级达到预算或存在循环，剩余部分未展开');
                    continue;
                }
                queue.push({ moduleId: cell.moduleId, instancePath: [...current.instancePath, cell.id], names: [...current.names, cell.name],
                    ancestors: [...current.ancestors, module.id], instanceSource: cell.source });
            }
    }
    if (design.provenance?.hierarchy === 'flat') {
        issues.push('工具仅提供平坦网表，不能恢复原RTL层级');
    }
    return { nodes, contexts, modules, issues: [...new Set(issues)] };
}
/**
 * 沿同一网络及真实端口映射双向遍历层级；不穿越逻辑/寄存器，不合并常量。
 * @param {object} design 已验证模型。
 * @param {{moduleId:string,instancePath:string[],origin:object}} request 唯一实例和原始位选择。
 * @returns {object} 文件/实例角色、精确位段及边界提示；不输出布局。
 */
function traceProjectSignal(design, request) {
    const hierarchy = projectHierarchy(design), startKey = contextKey(request.instancePath || []), start = hierarchy.contexts.get(startKey);
    if (!start || start.moduleId !== request.moduleId) {
        throw new Error('工程追踪实例已不存在，请重新选择');
    }
    const indices = new Map();
    let indexedReferences = 0;
    function indexFor(module) {
        if (indices.has(module.id)) {
            return indices.get(module.id);
        }
        const index = createTopologyIndex(module);
        while (indices.size && (indexedReferences + index.referenceCount > MAX_REFERENCES || indices.size >= 8)) {
            const key = indices.keys().next().value;
            indexedReferences -= indices.get(key).referenceCount;
            indices.delete(key);
        }
        indices.set(module.id, index);
        indexedReferences += index.referenceCount;
        return index;
    }
    const origin = indexFor(start.module).resolveOrigin(request.origin), queue = [], seen = new Map(), edges = new Map();
    let visits = 0, truncated = false;
    function enqueue(key, bits) {
        if (!hierarchy.contexts.has(key)) {
            return;
        }
        const visited = seen.get(key) || new Set(), fresh = [];
        for (const bit of bits)
            if (bit.startsWith('n:') && !visited.has(bit)) {
                if (++visits > MAX_VISITS) {
                    truncated = true;
                    break;
                }
                visited.add(bit);
                fresh.push(bit);
            }
        seen.set(key, visited);
        if (fresh.length) {
            queue.push({ key, bits: fresh });
        }
    }
    enqueue(startKey, origin.bits.map(bit => bit.bit));
    const originObject = indexFor(start.module).object(request.origin.objectId);
    if (originObject.kind === 'module-port') {
        start.node.roles.push(originObject.object.direction);
    }
    if (originObject.kind === 'signal' && !start.module.ports.some(port => port.name === origin.name)) {
        start.node.roles.push('internal');
    }
    start.node.declaration = { name: origin.name, indices: origin.bits.map(bit => bit.index), source: originObject.object.source || start.module.source };
    for (let cursor = 0; cursor < queue.length && !truncated; cursor++) {
        const current = queue[cursor], context = hierarchy.contexts.get(current.key), index = indexFor(context.module), matches = new Map();
        for (const bit of current.bits) {
            const net = index.net(bit);
            if (!net) {
                continue;
            }
            if (net.drivers.length > 1) {
                context.node.ambiguous = true;
            }
            for (const occurrences of [net.drivers, net.loads, net.ambiguous])
                for (const occurrence of occurrences) {
                    if (++visits > MAX_VISITS) {
                        truncated = true;
                        break;
                    }
                    const endpoint = index.endpoint(occurrence), key = endpoint.portId;
                    if (!matches.has(key)) {
                        matches.set(key, []);
                    }
                    matches.get(key).push(endpoint);
                }
            if (truncated) {
                break;
            }
        }
        for (const endpoints of matches.values()) {
            const endpoint = endpoints[0], entry = index.object(endpoint.portId), port = entry.object;
            if (!endpoint.cellId) {
                if (!context.node.roles.includes(port.direction)) {
                    context.node.roles.push(port.direction);
                }
                if (context.node.details.length < MAX_DETAILS) {
                    context.node.details.push({ port: port.name, direction: port.direction, indices: endpoints.map(item => item.index) });
                }
                else {
                    truncated = true;
                }
                if (context.instancePath.length) {
                    const parentKey = contextKey(context.instancePath.slice(0, -1)), parent = hierarchy.contexts.get(parentKey);
                    const cell = parent.module.cells.find(cell => cell.id === context.instancePath.at(-1)), parentPort = cell?.ports.find(item => item.name === port.name);
                    if (!parentPort || parentPort.bits.length !== port.bits.length) {
                        hierarchy.issues.push('端口位宽或身份无法核对：' + context.node.label + '.' + port.name);
                        continue;
                    }
                    enqueue(parentKey, endpoints.map(item => parentPort.bits[item.position]));
                }
            }
            else {
                const cell = index.cell(endpoint.cellId);
                if (!cell.moduleId) {
                    continue;
                }
                const childKey = contextKey([...context.instancePath, cell.id]), child = hierarchy.contexts.get(childKey);
                const childPort = child?.module.ports.find(item => item.name === port.name);
                if (!childPort || childPort.bits.length !== port.bits.length) {
                    hierarchy.issues.push('子模块端口映射缺失：' + cell.name + '.' + port.name);
                    continue;
                }
                const edgeKey = JSON.stringify([current.key, cell.id, port.id]);
                if (!edges.has(edgeKey)) {
                    edges.set(edgeKey, { parentId: current.key, childId: childKey, port: port.name, direction: port.direction, positions: new Set() });
                }
                const edge = edges.get(edgeKey);
                for (const item of endpoints)
                    edge.positions.add(item.position);
                enqueue(childKey, endpoints.map(item => childPort.bits[item.position]));
            }
        }
    }
    for (const node of hierarchy.nodes)
        if (node.roles.includes('unknown') || node.roles.includes('inout')) {
            node.ambiguous = true;
        }
    const issues = [...new Set(hierarchy.issues)];
    if (origin.bits.some(item => item.bit.startsWith('c:'))) {
        issues.push('常量位只保留起点，不按相同常量值追踪其它信号');
    }
    if (truncated) {
        issues.push('信号追踪达到预算，未标记部分不能视为未连接');
    }
    issues.push('仅跟踪直接网络及端口透传；组合逻辑、寄存器和黑盒边界不自动跨越');
    return { nodes: hierarchy.nodes, edges: [...edges.values()].map(edge => ({ ...edge, positions: [...edge.positions] })), issues,
        truncated: truncated || hierarchy.issues.some(issue => /预算|循环/.test(issue)), origin: { ...request, name: origin.name }, visits };
}
module.exports = { projectHierarchy, traceProjectSignal };
