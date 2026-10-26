'use strict';
const { instanceContexts } = require('./trace-source');
const { MAX_LINK_BITS, cleanName, compatibleRange } = require('../debug/bit-ranges');
const MAX_CANDIDATES = 256;

/** @param {object} design 已验证领域模型。 @param {object} tracer 已有拓扑索引。 @returns {object} 关联请求只解析当前模型的真实声明和实例。 */
function createCircuitWaveSignals(design, tracer) {
    const modules = new Map(design.modules.map(module => [module.id,module]));
    const namedCache = new WeakMap();
    function context(moduleId, instancePath) {
        if (!Array.isArray(instancePath) || instancePath.length > 64) throw new Error('波形关联需要明确的实际实例路径');
        let module = modules.get(design.top); const names = [];
        for (const id of instancePath) {
            const cell = module.cells.find(cell => cell.id === id);
            if (!cell?.moduleId || !modules.has(cell.moduleId)) throw new Error('电路实例路径已失效');
            names.push(cleanName(cell.name)); module = modules.get(cell.moduleId);
        }
        if (module.id !== moduleId) throw new Error('实例路径与电路模块不匹配');
        return { instancePath: [...instancePath], instanceNames: names, label: names.join('/') || modules.get(design.top).name };
    }
    function nameParts(name) {
        const cleaned = cleanName(name);
        // Vivado适配器明确使用工具的层级限定名称；其他引擎保留原标识符，不按点号猜层级。
        return design.provenance.engine === 'vivado' && design.provenance.hierarchy === 'flat' && !name.includes('\\') ? cleaned.split('/') : [cleaned];
    }
    function declarations(module) {
        if(namedCache.has(module))return namedCache.get(module);
        const seen = new Set();
        const result = [...module.ports,...module.signals].filter(object => {
            const key = JSON.stringify([object.name,object.offset||0,!!object.upto,object.bits]);
            if (seen.has(key)) return false; seen.add(key); return true;
        });
        namedCache.set(module,result);return result;
    }
    function target(module, object, origin) {
        const resolved = tracer.resolveOrigin({ moduleId: module.id, origin });
        return { moduleId: module.id, objectId: object.id, name: cleanName(object.name), nameParts: nameParts(object.name),
            width: object.bits.length, offset: object.offset || 0, upto: object.upto || false,
            indices: resolved.bits.map(bit => bit.index), origin: { objectId: object.id, positions: resolved.bits.map(bit => bit.position) } };
    }
    function selection({ moduleId, origin, instancePath }) {
        const module = modules.get(moduleId); if (!module) throw new Error('电路模块已不存在');
        const resolved = tracer.resolveOrigin({ moduleId, origin }), named = declarations(module), direct = named.find(object => object.id === origin.objectId);
        const bits = new Set(resolved.bits.map(bit => bit.bit));
        if (!direct && [...bits].some(bit => bit.startsWith('c:'))) throw new Error('常量引脚不能按常量值反推信号，请选择已命名的网络');
        const candidates = [];
        for (const object of direct ? [direct] : named) {
            const positions = direct ? resolved.bits.map(bit => bit.position) : object.bits.flatMap((bit,i) => bits.has(bit) ? [i] : []);
            if (positions.length > MAX_LINK_BITS) continue;
            const covered = new Set(positions.map(position=>object.bits[position]));
            if (!positions.length || [...bits].some(bit => !covered.has(bit))) continue;
            candidates.push(target(module,object,{ objectId:object.id, positions }));
            if (candidates.length >= MAX_CANDIDATES) throw new Error('同一网络的命名候选过多，请选择具体命名端口');
        }
        if (!candidates.length) throw new Error('工具没有保留可关联的命名网络，请选择其他端口或信号');
        const contexts = instancePath !== undefined ? { contexts: [context(moduleId,instancePath)], truncated:false } : instanceContexts(design,moduleId);
        if (contexts.truncated) throw new Error('实际实例候选超出预算，请从顶层进入所需实例');
        if (!contexts.contexts.length) throw new Error('当前模块没有从设计顶层可到达的实例');
        return { candidates, contexts: contexts.contexts.map(item => context(moduleId,item.instancePath)) };
    }
    function find(request) {
        if (!Array.isArray(request.scopes) || request.scopes.length > 64 || request.scopes.some(name => typeof name !== 'string' || !name || name.length > 65536)
            || typeof request.name !== 'string' || !request.name || request.name.length > 65536 || !Number.isSafeInteger(request.width) || request.width < 1
            || ![request.left,request.right].every(Number.isSafeInteger) || Math.abs(request.left-request.right)+1 !== request.width
            || !Array.isArray(request.indices) || !request.indices.length || request.indices.length > MAX_LINK_BITS || request.indices.some(index => !Number.isSafeInteger(index)
                || index < Math.min(request.left,request.right) || index > Math.max(request.left,request.right))) throw new Error('VCD声明关联请求无效');
        let module = modules.get(design.top); const instancePath = [], scopes = [...request.scopes];
        const flat = design.provenance.engine === 'vivado' && design.provenance.hierarchy === 'flat';
        if (!flat) for (const name of scopes) {
            const cells = module.cells.filter(cell => cleanName(cell.name) === name && cell.moduleId);
            if (cells.length !== 1) throw new Error('VCD实例层级未在电路中保留或存在歧义：' + name);
            instancePath.push(cells[0].id); module = modules.get(cells[0].moduleId);
        }
        const qualified = flat ? [...scopes,request.name] : [request.name], result = [];
        for (const object of declarations(module)) {
            if (JSON.stringify(nameParts(object.name)) !== JSON.stringify(qualified) || !compatibleRange({width:object.bits.length,offset:object.offset,upto:object.upto},request)) continue;
            const candidate = target(module,object,{objectId:object.id,indices:request.indices});
            result.push({ ...candidate, ...context(module.id,instancePath) });
            if (result.length >= MAX_CANDIDATES) throw new Error('电路声明候选过多，无法可靠关联');
        }
        if (!result.length) throw new Error('没有名称、位宽和范围均匹配的实际电路信号；可能未保留、未dump或来自不同参数/源码');
        return result;
    }
    return { selection, find };
}
module.exports = { createCircuitWaveSignals };
