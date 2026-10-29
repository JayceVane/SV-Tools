'use strict';

const { createTopologyIndex, MAX_INDEX_REFERENCES, MAX_INDEX_OBJECTS } = require('./topology');
const { cellDependencies } = require('./trace-semantics');
const { registerSymbol } = require('./register-symbol');

const DEFAULT_LIMITS = Object.freeze({ depth: 1, maxCells: 128, maxVisitedBits: 8192,
    maxWireBits: 4096, maxTransitions: 8192, maxWork: 50000 });
const HARD_LIMITS = Object.freeze({ depth: 32, maxCells: 2000, maxVisitedBits: 16384,
    maxWireBits: 8192, maxTransitions: 16384, maxWork: 200000 });
const MAX_BOUNDARIES = 512;
const MAX_CACHED_MODULES = 4;

function limits(options) {
    const result = {};
    for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
        const value = options[name] ?? fallback;
        if (!Number.isSafeInteger(value) || value < (name === 'depth' ? 0 : 1) || value > HARD_LIMITS[name]) throw new RangeError('追踪预算无效：' + name);
        result[name] = value;
    }
    if (options.crossSequential !== undefined && typeof options.crossSequential !== 'boolean') throw new TypeError('crossSequential必须为布尔值');
    return { ...result, crossSequential: options.crossSequential === true };
}
function contextFor(design, module, instancePath) {
    if (instancePath === undefined) return { kind: 'module-definition', moduleId: module.id };
    if (!Array.isArray(instancePath) || instancePath.length > 64) throw new TypeError('追踪实例路径必须为最多64级的单元ID数组');
    let current = design.modules.find(item => item.id === design.top);
    for (const id of instancePath) {
        const cell = current.cells.find(item => item.id === id);
        current = cell?.moduleId && design.modules.find(item => item.id === cell.moduleId);
        if (!current) throw new TypeError('追踪实例路径不属于当前设计');
    }
    if (current.id !== module.id) throw new TypeError('追踪实例路径与模块不匹配');
    return { kind: 'instance', moduleId: module.id, instancePath: [...instancePath] };
}

/** 每次查询独占工作队列、预算和结果集合；索引只读且可跨查询复用。 */
class TraceQuery {
    constructor({ design, module, index, request }) {
        this.design = design; this.module = module; this.index = index;
        this.budget = limits(request); this.origin = index.resolveOrigin(request.origin);
        // 端点种子模式：从单元引脚本身继续追踪，不展开同网络的其它负载分支。
        this.endpointSeed = request.endpointSeed === true;
        if (this.endpointSeed && this.origin.kind !== 'cell-port') throw new TypeError('端点展开只支持单元引脚');
        this.context = contextFor(design, module, request.instancePath);
        this.direction = request.direction;
        if (!['drivers', 'loads'].includes(this.direction)) throw new TypeError('追踪方向必须为drivers或loads');
        this.queue = []; this.scheduled = new Set(); this.visited = new Set(); this.selected = new Map();
        this.nets = new Map(); this.cells = new Map(); this.boundaries = new Map(); this.transitions = [];
        this.truncationReasons = new Set();
        this.work = 0; this.reused = 0; this.truncated = false; this.halted = false; this.conservative = false;
    }

    stop(reason, anchor, details = {}, capacity = false) {
        this.truncated ||= capacity;
        if (capacity) this.truncationReasons.add(reason);
        const objectId = anchor.portId || anchor.objectId || this.origin.objectId;
        const key = JSON.stringify([reason, objectId, details.value, details.driverCount]);
        if (!this.boundaries.has(key)) {
            if (this.boundaries.size >= MAX_BOUNDARIES) {
                this.truncated = true; this.halted = true; this.truncationReasons.add('boundary-budget'); return;
            }
            this.boundaries.set(key, { reason, objectId, cellId: anchor.cellId, positions: new Set(), ...details });
        }
        if (Number.isSafeInteger(anchor.position)) this.boundaries.get(key).positions.add(anchor.position);
    }

    spend(anchor) {
        if (++this.work <= this.budget.maxWork) return true;
        this.stop('work-budget', anchor, {}, true); this.halted = true; return false;
    }

    select(point, precision = 'bit') {
        const objectId = point.portId || point.objectId;
        const entry = this.index.object(objectId);
        if (!this.selected.has(objectId)) this.selected.set(objectId, { objectId, name: entry.object.name, kind: entry.kind,
            cellId: entry.cellId, width: entry.object.bits.length, positions: new Set(), precision });
        const selection = this.selected.get(objectId);
        selection.positions.add(point.position);
        if (precision === 'cell') selection.precision = 'cell';
    }

    rememberNet(bit, point) {
        if (!this.nets.has(bit)) {
            if (this.nets.size >= this.budget.maxWireBits) { this.stop('wire-budget', point, {}, true); return null; }
            const actual = this.index.net(bit);
            this.nets.set(bit, { bit, driverCount: actual?.drivers.length || 0, loadCount: actual?.loads.length || 0,
                ambiguousCount: actual?.ambiguous.length || 0, endpoints: new Map() });
        }
        const net = this.nets.get(bit);
        if (point.portId) net.endpoints.set(point.id, point);
        return net;
    }

    enqueueEndpoint(id, state) {
        const point = this.index.endpoint(id);
        if (!this.scheduled.has(id) && this.scheduled.size >= this.budget.maxVisitedBits) { this.stop('endpoint-budget', point, {}, true); return false; }
        if (point.cellId && !this.recordCell(point, state.depth)) return false;
        this.select(point, state.precision);
        if (point.bit.startsWith('n:')) this.rememberNet(point.bit, point);
        if (state.path.includes(id)) { this.stop('loop', point); return true; }
        if (this.scheduled.has(id)) { this.reused++; return true; }
        this.scheduled.add(id);
        this.queue.push({ ...state, kind: 'endpoint', point });
        return true;
    }

    walkWire(state) {
        const { point, bit } = state, { index, direction } = this;
        this.select(point, state.precision);
        if (bit.startsWith('c:')) {
            this.stop('constant', point, { value: bit.slice(2) });
            // 常量输入引脚的负载只属于该具体单元，不连接其它同值常量。
            if (state.seed && this.origin.kind === 'cell-port' && direction === 'loads' && point.flow === 'loads') this.enqueueEndpoint(point.id, state);
            return;
        }
        const remembered = this.rememberNet(bit, point);
        if (!remembered) return;
        const net = index.net(bit);
        if ((net?.drivers.length || 0) > 1) this.stop('multiple-drivers', point, { driverCount: net.drivers.length });
        for (const id of net?.ambiguous || []) {
            if (!this.spend(point)) return;
            const unknown = index.endpoint(id);
            if (unknown.cellId && !this.recordCell(unknown, state.depth)) return;
            this.select(unknown, state.precision); remembered.endpoints.set(id, unknown);
            this.stop('unknown-direction', unknown);
        }
        const endpoints = net?.[direction] || [];
        if (!endpoints.length) this.stop(net?.ambiguous.length ? 'unknown-direction' : direction === 'drivers' ? 'undriven' : 'unloaded', point);
        for (const id of endpoints) {
            if (!this.spend(point) || this.halted || !this.enqueueEndpoint(id, state)) return;
        }
    }

    recordCell(point, depth) {
        const cell = this.index.cell(point.cellId);
        if (!this.cells.has(cell.id)) {
            if (this.cells.size >= this.budget.maxCells) { this.stop('cell-budget', point, {}, true); return null; }
            this.cells.set(cell.id, { id: cell.id, name: cell.name, type: cell.type, kind: cell.kind,
                moduleId: cell.moduleId, source: cell.source, depth, expanded: false });
        }
        return cell;
    }

    boundary(cell, state) {
        const point = state.point;
        if (cell.moduleId || cell.kind === 'instance') {
            const child = this.design.modules.find(item => item.id === cell.moduleId);
            const port = child?.ports.find(item => item.name === point.name);
            const parent = this.index.object(point.portId).object;
            const next = port && port.bits.length === parent.bits.length && port.direction === parent.direction
                ? { moduleId: child.id, cellId: cell.id, objectId: port.id, mapping: 'position' } : undefined;
            this.stop(cell.moduleId ? 'instance' : 'blackbox', point, { next,
                mappingStatus: next ? 'mapped' : port ? 'incompatible-port' : 'missing-port' }); return true;
        }
        if (cell.kind === 'unknown' || cell.kind === 'memory') { this.stop(cell.kind === 'memory' ? 'memory' : 'blackbox', point); return true; }
        if (cell.kind === 'register') {
            const symbol = registerSymbol(cell);
            const controls = cell.ports.filter(port => ['clock', 'control'].includes(symbol?.ports[port.name]?.role))
                .map(port => ({ portId: port.id, name: port.name, width: port.bits.length, ...symbol.ports[port.name] }));
            this.stop('sequential', point, { crossed: this.budget.crossSequential, controls });
            if (!this.budget.crossSequential) return true;
        }
        if (cell.ports.some(port => !['input', 'output'].includes(port.direction))) { this.stop('unknown-direction', point); return true; }
        if (state.depth >= this.budget.depth) { this.stop('depth', point); return true; }
        return false;
    }

    walkEndpoint(state) {
        const { point } = state;
        this.visited.add(point.id);
        if (!point.cellId) { this.stop('module-port', point); return; }
        const cell = this.recordCell(point, state.depth);
        if (!cell || this.boundary(cell, state)) return;
        const dependency = cellDependencies(cell, point, this.direction);
        this.conservative ||= dependency.precision === 'cell';
        const precision = state.precision === 'cell' ? 'cell' : dependency.precision;
        const roles = registerSymbol(cell)?.ports || {};
        this.cells.get(cell.id).expanded = true;
        let count = 0;
        for (const target of dependency.targets) {
            if (!this.spend(point) || this.halted) return;
            if (this.transitions.length >= this.budget.maxTransitions) { this.stop('transition-budget', point, {}, true); return; }
            const next = this.index.endpoint(this.index.occurrence(target.portId, target.position));
            this.select(next, precision);
            this.transitions.push({ cellId: cell.id, from: { portId: point.portId, position: point.position },
                to: { portId: next.portId, position: next.position }, precision: dependency.precision,
                relation: dependency.relation, role: roles[next.name]?.role || target.role });
            this.queue.push({ kind: 'wire', point: next, bit: next.bit, depth: state.depth + 1,
                path: [...state.path, point.id], precision });
            count++;
        }
        if (!count) this.stop('no-dependent-bits', point);
    }

    snapshot() {
        return { moduleId: this.module.id, context: this.context, origin: this.origin, direction: this.direction,
            limits: this.budget, precision: this.conservative ? 'cell' : 'bit', truncated: this.truncated,
            truncationReasons: [...this.truncationReasons], cells: [...this.cells.values()],
            selections: [...this.selected.values()].map(item => ({ ...item, positions: [...item.positions].sort((a, b) => a - b) })),
            nets: [...this.nets.values()].map(net => ({ ...net, endpoints: [...net.endpoints.values()] })), transitions: this.transitions,
            boundaries: [...this.boundaries.values()].map(item => ({ ...item, positions: [...item.positions].sort((a, b) => a - b) })),
            stats: { cells: this.cells.size, wires: this.nets.size, visitedBits: this.visited.size,
                transitions: this.transitions.length, work: this.work, reused: this.reused } };
    }

    run() {
        for (const item of this.origin.bits) {
            // 端点种子直接把该引脚交给 walkEndpoint：边界展开只沿所在分支继续，
            // 同网络其它兄弟分支的边界保留，交由用户按分支逐级展开。
            if (this.endpointSeed) {
                this.enqueueEndpoint(this.index.occurrence(this.origin.objectId, item.position),
                    { depth: 0, path: [], precision: 'bit', seed: true });
                continue;
            }
            const point = this.origin.kind === 'signal' ? { ...item, objectId: this.origin.objectId }
                : this.index.endpoint(this.index.occurrence(this.origin.objectId, item.position));
            this.queue.push({ kind: 'wire', point, bit: item.bit, depth: 0, path: [], precision: 'bit', seed: true });
        }
        for (let cursor = 0; cursor < this.queue.length && !this.halted; cursor++) {
            const state = this.queue[cursor];
            if (!this.spend(state.point)) break;
            if (state.kind === 'wire') this.walkWire(state); else this.walkEndpoint(state);
        }
        return this.snapshot();
    }
}

/**
 * 设计会话内的按需拓扑索引与纯查询；不运行工具、不布局、不按名称猜测连接。
 * @param {object} design 已验证且不可变的领域设计。
 * @returns {{trace:Function,listSignals:Function,stats:Function,dispose:Function}} dispose后旧请求明确失败。
 */
function createCircuitTracer(design) {
    const modules = new Map(design.modules.map(module => [module.id, module])), indices = new Map();
    let references = 0, objects = 0, builds = 0, closed = false;
    function moduleFor(id) {
        if (closed) throw new Error('电路追踪会话已关闭');
        const module = modules.get(id);
        if (!module) throw new TypeError('追踪模块在当前设计中不存在');
        return module;
    }
    function indexFor(module) {
        if (indices.has(module.id)) {
            const index = indices.get(module.id); indices.delete(module.id); indices.set(module.id, index); return index;
        }
        const required = module.ports.reduce((sum, port) => sum + port.bits.length, 0)
            + module.cells.reduce((sum, cell) => sum + cell.ports.reduce((count, port) => count + port.bits.length, 0), 0);
        const requiredObjects = module.ports.length + module.signals.length + module.cells.reduce((sum, cell) => sum + 1 + cell.ports.length, 0);
        if (required > MAX_INDEX_REFERENCES) throw new RangeError('当前模块超过500,000端口位追踪索引预算，请选择子模块');
        if (requiredObjects > MAX_INDEX_OBJECTS) throw new RangeError('当前模块超过100,000对象追踪索引预算，请选择子模块');
        while (indices.size && (indices.size >= MAX_CACHED_MODULES || references + required > MAX_INDEX_REFERENCES || objects + requiredObjects > MAX_INDEX_OBJECTS)) {
            const id = indices.keys().next().value;
            references -= indices.get(id).referenceCount; objects -= indices.get(id).objectCount; indices.delete(id);
        }
        const index = createTopologyIndex(module);
        indices.set(module.id, index); references += index.referenceCount; objects += index.objectCount; builds++;
        return index;
    }
    return {
        trace(request) {
            if (!request || typeof request !== 'object') throw new TypeError('追踪请求无效');
            const module = moduleFor(request.moduleId);
            return new TraceQuery({ design, module, index: indexFor(module), request }).run();
        },
        resolveOrigin({ moduleId, origin }) { return indexFor(moduleFor(moduleId)).resolveOrigin(origin); },
        listSignals({ moduleId, query = '', limit = 200 }) {
            if (typeof query !== 'string' || query.length > 1024 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('追踪信号检索参数无效');
            const module = moduleFor(moduleId), needle = query.toLowerCase(), items = []; let total = 0;
            for (const object of [...module.ports, ...module.signals]) if (object.name.toLowerCase().includes(needle)) {
                total++;
                if (items.length < limit) items.push({ objectId: object.id, name: object.name, width: object.bits.length,
                    direction: object.direction, offset: object.offset || 0, upto: object.upto || false });
            }
            return { moduleId, items, total, truncated: total > items.length };
        },
        stats: () => ({ cachedModules: indices.size, indexedReferences: references, indexedObjects: objects, builds }),
        dispose() { closed = true; indices.clear(); modules.clear(); references = 0; objects = 0; design = null; }
    };
}

module.exports = { DEFAULT_LIMITS, HARD_LIMITS, createCircuitTracer };
