'use strict';
const { keyPath, instanceContexts } = require('../circuit/trace-source');
/** @param {object} project 活动工程快照。 @param {string} file 所选文件。 @returns {object} 相应文件集与候选顶层，不修改工程配置。 */
function traceContext(project, file) {
    const contains = set => set.files.some(member => keyPath(member) === keyPath(file));
    const simulation = project.sets.filter(set => set.type === 'SimulationSrcs' && contains(set));
    const sets = project.sets.filter(set => set.type === 'DesignSrcs' || simulation.includes(set));
    const tops = [...new Set((simulation.length ? simulation.map(set => set.top) : [project.top]).filter(Boolean))];
    return { kind: simulation.length ? 'simulation' : 'design', tops,
        files: [...new Set(sets.flatMap(set => set.files).filter(member => /\.(sv|v|svh|vh)$/i.test(member)))] };
}
/** @param {object} design 静态模型。 @param {object} target 源码模块身份。 @returns {boolean} 精确声明所在模块是否属于当前实例树。 */
function containsTarget(design, target) {
    return design.modules.some(module => module.source && keyPath(module.source.path) === keyPath(target.path)
        && module.source.line === target.moduleLine && module.name === target.moduleName
        && instanceContexts(design, module.id).contexts.length > 0);
}
/** @param {object} index 只解析一次的RTL索引。 @param {string[]} tops 配置顶层。 @param {object} target 所选模块身份。 @returns {object} 包含所选模块的模型与实际追踪根；未解析的信号不触发换根。 */
function buildTraceContext(index, tops, target) {
    const candidates = [...new Set([...tops, target.moduleName])];
    for (const top of candidates) {
        let built;
        try {
            built = index.build(top);
        }
        catch (error) {
            if (top === target.moduleName) {
                throw error;
            }
            continue;
        }
        if (containsTarget(built.design, target)) {
            return { ...built, top, fallback: !tops.includes(top) };
        }
    }
    throw new Error('静态模型无法定位所选模块，请检查文件集、重复声明或条件宏');
}
module.exports = { traceContext, containsTarget, buildTraceContext };
