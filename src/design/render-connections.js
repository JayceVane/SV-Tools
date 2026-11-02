'use strict';
const { createHash } = require('node:crypto');
const { fail } = require('../agent/protocol');
const { labelForSignals } = require('./arch');

/** 连线按实际显示端口分组。完整端口模式保留每根连接；只有落在同一虚拟端口的成员才可合并。 */
function renderConnections(arch, nodes, fallback) {
    const bindings = fallback.flatMap(item => item.bindings || []);
    const rawEdges = [...(arch.graph?.edges || []), ...bindings];
    if (!rawEdges.length) return fallback;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const portIndex = new Map();
    for (const node of nodes) for (const port of node.ports) {
        for (const member of port.members || [{name:port.label}]) {
            portIndex.set(JSON.stringify([member.sourceNodeId || port.sourceNodeId || node.id, member.name]),
                { nodeId: node.id, portId: port.id, width: port.bitWidth, interfaceLevel:port.interfaceLevel, interfaceName:port.interfaceName });
        }
    }
    const groups = new Map();
    for (const edge of rawEdges) {
        const source = portIndex.get(JSON.stringify([edge.sourceNode, edge.sourcePort]));
        const target = portIndex.get(JSON.stringify([edge.targetNode, edge.targetPort]));
        if (!source || !target) fail('DESIGN_FAILED', '架构连接缺少对应端口，不能用其它端口代替', { edge });
        const key = JSON.stringify([source.portId, target.portId]);
        if (!groups.has(key)) groups.set(key, { source, targets: [target], bits: 0, signals: [], fromPorts: [], toPorts: [] });
        const group = groups.get(key);
        if (edge.bidirectional) group.bidirectional = true;
        if (edge.connectionOnly) group.connectionOnly = true;
        group.interfaceLevel ||= Boolean(source.interfaceLevel || target.interfaceLevel || edge.connectionOnly);
        group.interfaceName ||= source.interfaceName || target.interfaceName;
        group.bits += edge.width;
        group.signals.push({ name: edge.netNames?.[0] || edge.sourcePort, width: edge.width, direction: edge.connectionOnly?'unknown':'forward' });
        group.fromPorts.push(edge.sourcePort); group.toPorts.push(edge.targetPort);
    }
    const combined = [], consumed = new Set();
    for (const [key, group] of groups) {
        if (consumed.has(key)) continue;
        const reverseKey = JSON.stringify([group.targets[0].portId, group.source.portId]);
        const reverse = groups.get(reverseKey);
        consumed.add(key);
        if (reverse && reverseKey !== key) {
            consumed.add(reverseKey);
            group.bits += reverse.bits;
            group.signals.push(...reverse.signals.map(signal => ({ ...signal, direction: signal.direction === 'unknown' ? 'unknown' : 'reverse' })));
            group.fromPorts.push(...reverse.toPorts); group.toPorts.push(...reverse.fromPorts);
            group.bidirectional = true;
            group.interfaceLevel ||= reverse.interfaceLevel; group.connectionOnly ||= reverse.connectionOnly;
        }
        combined.push(group);
    }
    const fanouts = new Map();
    for (const group of combined) {
        // 只有完整源端口的同一组信号才能共用扇出主干；不同切片不能伪装成同一根总线。
        const key = JSON.stringify([group.source.portId, group.bits, group.signals]);
        if (group.bidirectional || group.bits !== group.source.width) continue;
        if (fanouts.has(key)) {
            const previous = fanouts.get(key);
            previous.targets.push(...group.targets); previous.toPorts.push(...group.toPorts);
            group.merged = true;
        } else fanouts.set(key, group);
    }
    const endpoint = nodeId => {
        const node = byId.get(nodeId);
        return { kind: node.kind === 'boundary' ? 'boundary' : 'instance', name: node.name || node.label };
    };
    const result = combined.filter(group => !group.merged).map(group => {
        const identity = JSON.stringify([group.source.portId, group.targets.map(target => target.portId)]);
        const target = endpoint(group.targets[0].nodeId);
        return { id: 'connection:' + createHash('sha256').update(identity).digest('hex').slice(0, 24),
            from: endpoint(group.source.nodeId), to: { ...target, name: group.targets.map(item => endpoint(item.nodeId).name).join('+') },
            direction: group.connectionOnly ? 'connection' : group.bidirectional ? 'bidirectional' : 'forward', bits: group.bits, interfaceLevel:group.interfaceLevel,
            label: group.interfaceName || (group.signals.length === 1 ? group.signals[0].name : labelForSignals(group.signals)), signals: group.signals,
            fromPorts: [...new Set(group.fromPorts)], toPorts: [...new Set(group.toPorts)],
            renderSources: [group.source], renderTargets: group.targets };
    });
    // 顶层 inout 没有确定的驱动边，沿用明确标注为双向的边界展示。
    return result.concat(fallback.filter(item => !item.bindings?.length && item.signals?.some(signal => signal.direction === 'inout')));
}
module.exports = { renderConnections };
