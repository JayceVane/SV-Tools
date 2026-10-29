'use strict';
const { createHash } = require('node:crypto');
const { mergeTraces, projectTrace, REASONS, MAX_VIEW_REQUESTS } = require('./trace-projection');
const { layoutProjection } = require('./layout');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

function frontiers(result) {
    const values = new Map();
    for (const boundary of result.boundaries) {
        const kind = boundary.reason === 'depth' || boundary.reason === 'sequential' && !boundary.crossed ? 'expand'
            : boundary.reason === 'instance' && boundary.next ? 'enter' : 'boundary';
        const key = hash([boundary.reason, boundary.objectId, boundary.positions, boundary.next]);
        if (values.has(key)) continue;
        const selected = result.selections.find(selection => selection.objectId === boundary.objectId);
        const cell = result.cells.find(cell => cell.id === boundary.cellId);
        const name = [cell?.name, selected?.name].filter(Boolean).join('.') || selected?.name || boundary.objectId;
        values.set(key, { id: key, ownerId: boundary.ownerId || 'root', kind, reason: boundary.reason,
            label: name + ' · ' + (REASONS[boundary.reason] || boundary.reason), name,
            origin: { objectId: boundary.objectId, positions: boundary.positions },
            crossSequential: boundary.reason === 'sequential', next: boundary.next, controls: boundary.controls });
    }
    return [...values.values()];
}

function anchor(graph, origin) {
    const node = graph.nodes.find(node => node.ports.some(port => port.traceOrigin?.objectId === origin.objectId));
    return node ? { x: node.x + node.width / 2, y: node.y + node.height / 2 } : null;
}

function contextLabel(design, context) {
    let module = design.modules.find(module => module.id === design.top);
    if (context.kind !== 'instance') return '模块定义';
    const names = [module.name];
    for (const id of context.instancePath) {
        const cell = module.cells.find(cell => cell.id === id); names.push(cell.name);
        module = design.modules.find(module => module.id === cell.moduleId);
    }
    return names.join('/');
}

/**
 * 局部视图的查询、展开重放和ELK编排；每次只缓存最后一个图。
 * @param {{design:object,tracer:object,sourceLocator?:object,layout?:Function}} options 会话资源。
 * @returns {{render:Function,dispose:Function}} 旧布局和关闭后响应不会成为新图。
 */
function createTraceViews({ design, tracer, sourceLocator, layout = layoutProjection }) {
    let sequence = 0, closed = false, previous, previousRoot;
    function current(ticket) { if (closed || ticket !== sequence) throw new Error('局部电路请求已被新的操作取代'); }
    function query(request, origin, crossSequential, ownerId, endpointSeed = false) {
        const result = tracer.trace({ moduleId: request.moduleId, direction: request.direction, instancePath: request.instancePath,
            origin, depth: 1, crossSequential: crossSequential === true, endpointSeed });
        return { ...result, boundaries: result.boundaries.map(boundary => ({ ...boundary, ownerId })) };
    }
    async function render(request) {
        if (closed) throw new Error('局部电路会话已关闭');
        if (!Array.isArray(request.branches || []) || (request.branches || []).length >= MAX_VIEW_REQUESTS) throw new RangeError('局部展开超过15个分支');
        const ticket = ++sequence, results = [query(request, request.origin, false, 'root')], branches = [];
        let merged = mergeTraces(results), available = frontiers(merged);
        for (const branch of request.branches || []) {
            if (branches.some(entry => entry.id === branch.id)) throw new Error('展开分支重复');
            const frontier = available.find(frontier => frontier.id === branch.id && frontier.kind === 'expand');
            if (!frontier) throw new Error('展开边界已过期，请重新选择分支');
            branches.push({ id: branch.id, parentId: frontier.ownerId, label: frontier.name });
            // 边界展开从引脚继续，避免连带展开同网络的兄弟负载分支。
            results.push(query(request, frontier.origin, frontier.crossSequential, branch.id, true));
            merged = mergeTraces(results); available = frontiers(merged);
        }
        const rootKey = hash([request.moduleId, request.direction, request.instancePath, merged.origin.objectId, merged.origin.bits]);
        const viewId = hash([rootKey, branches.map(branch => branch.id)]), projection = projectTrace(design, merged, viewId);
        const old = previousRoot === rootKey ? previous : null;
        if (old) {
            const order = new Map(old.nodes.map((node, index) => [node.id, index]));
            projection.input.children.sort((a, b) => (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size));
        }
        const graph = await layout(projection); current(ticket);
        const oldIds = new Set(old?.nodes.map(node => node.id));
        for (const node of graph.nodes) {
            node.traceNew = !!old && !oldIds.has(node.id);
            if (sourceLocator && (node.cellId || node.traceOrigin)) {
                node.source = await sourceLocator.locate(graph.moduleId, { cellId: node.cellId, objectId: node.traceOrigin?.objectId });
                current(ticket);
            }
        }
        graph.trace = { viewId, rootKey, origin: merged.origin, direction: request.direction, context: merged.context, contextLabel: contextLabel(design, merged.context),
            branches, frontiers: available, precision: merged.precision, truncated: merged.truncated,
            truncationReasons: merged.truncationReasons, truncationLabels: merged.truncationReasons.map(reason => REASONS[reason] || reason), root: { moduleId: request.moduleId, direction: request.direction,
                origin: request.origin, instancePath: request.instancePath },
            anchor: old ? { previous: anchor(old, merged.origin), current: anchor(graph, merged.origin) } : null };
        previous = graph; previousRoot = rootKey;
        return graph;
    }
    return { render, cancel() { sequence++; }, dispose() { closed = true; sequence++; previous = null; design = null; } };
}

module.exports = { createTraceViews, frontiers };
