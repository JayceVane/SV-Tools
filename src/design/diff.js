'use strict';

// design diff：比较基线架构快照与当前架构，报告实例/模块/顶层端口/接口/源文件的结构差异。
// 身份约定：实例按名称、模块与接口按归一化 id、顶层端口按名称；实现状态从 blackbox 变为
// collapsed 单独列为 implemented（补实现场景的核心信号）。diff 只报告差异，不判断好坏。

/** @param {object[]} ports 端口列表。 @returns {string} 可比较的端口签名。 */
function portsSignature(ports) {
    return (ports || []).map(port => [port.name, port.direction, port.width ?? port.bits?.length ?? null].join(':')).join(',');
}

/** @param {object[]} signals 信号列表。 @returns {string} 可比较的信号签名。 */
function signalsSignature(signals) {
    return (signals || []).map(signal => [signal.name, signal.width].join(':')).join(',');
}

/**
 * 通用三态差集：added/removed/changed（changed 用 fieldEquals 判等，变化记录 {field:{baseline,current}}）。
 * @param {object[]} baselineItems 基线项。 @param {object[]} currentItems 当前项。 @param {string} key 身份字段。
 * @param {string[]} fields 参与比较的字段。
 * @param {Function} [fieldValue] 字段取值函数（默认按字段取，端口类字段取签名）。
 * @returns {{added:object[], removed:object[], changed:object[]}}
 */
function diffByKey(baselineItems, currentItems, key, fields, fieldValue) {
    const baseline = new Map((baselineItems || []).map(item => [item[key], item]));
    const current = new Map((currentItems || []).map(item => [item[key], item]));
    const value = (item, field) => fieldValue ? fieldValue(item, field) : item[field];
    const added = [], removed = [], changed = [];
    for (const [name, item] of current) {
        const before = baseline.get(name);
        if (!before) {
            added.push(item);
            continue;
        }
        const changes = {};
        for (const field of fields) {
            const left = value(before, field), right = value(item, field);
            if (JSON.stringify(left) !== JSON.stringify(right)) {
                changes[field] = { baseline: left, current: right };
            }
        }
        if (Object.keys(changes).length) {
            changed.push({ [key]: name, changes });
        }
    }
    for (const [name, item] of baseline) {
        if (!current.has(name)) {
            removed.push(item);
        }
    }
    return { added, removed, changed };
}

/** @param {object[]} nodes graph.nodes。 @returns {object[]} 顶层端口事实（boundary 节点）。 */
function topPortsOf(data) {
    return ((data.graph && data.graph.nodes) || []).filter(node => node.kind === 'boundary')
        .map(node => ({ name: node.name, direction: node.direction, width: node.ports[0] ? node.ports[0].width : null }));
}

/**
 * 比较两份架构数据（schemaVersion=1 快照与当前 arch 输出）。
 * @param {object} baseline 基线快照数据。 @param {object} current 当前架构数据。
 * @returns {{instances:object, modules:object, topPorts:object, interfaces:object, sourceFiles:object,
 *   implemented:string[], summary:object}} 结构差异。
 */
function diffArchitectures(baseline, current) {
    const instances = diffByKey(baseline.instances, current.instances, 'name',
        ['module', 'implementation', 'empty', 'status', 'ports'],
        (item, field) => field === 'ports' ? portsSignature(item.ports) : item[field]);
    const modules = diffByKey(baseline.modules, current.modules, 'id',
        ['name', 'file', 'blackbox', 'empty', 'parameters', 'ports'],
        (item, field) => field === 'ports' ? portsSignature(item.ports) : item[field]);
    const topPorts = diffByKey(topPortsOf(baseline), topPortsOf(current), 'name', ['direction', 'width']);
    const interfaces = diffByKey(baseline.interfaces, current.interfaces, 'id',
        ['direction', 'bits', 'label', 'signals'],
        (item, field) => field === 'signals' ? signalsSignature(item.signals) : item[field]);
    const sourceFiles = diffByKey(baseline.sourceFiles, current.sourceFiles, 'path', ['sha256']);
    // 补实现信号：基线为空骨架（blackbox），当前已含实现（collapsed）。
    const beforeInstances = new Map((baseline.instances || []).map(item => [item.name, item]));
    const implemented = (current.instances || [])
        .filter(item => beforeInstances.get(item.name) && beforeInstances.get(item.name).implementation === 'blackbox'
            && item.implementation !== 'blackbox')
        .map(item => item.name);
    const summary = {
        addedInstances: instances.added.length, removedInstances: instances.removed.length, changedInstances: instances.changed.length,
        addedModules: modules.added.length, removedModules: modules.removed.length, changedModules: modules.changed.length,
        addedTopPorts: topPorts.added.length, removedTopPorts: topPorts.removed.length, changedTopPorts: topPorts.changed.length,
        addedInterfaces: interfaces.added.length, removedInterfaces: interfaces.removed.length, changedInterfaces: interfaces.changed.length,
        changedSourceFiles: sourceFiles.changed.length + sourceFiles.added.length + sourceFiles.removed.length,
        implementedInstances: implemented.length
    };
    return { instances, modules, topPorts, interfaces, sourceFiles, implemented, summary };
}

module.exports = { diffArchitectures };
