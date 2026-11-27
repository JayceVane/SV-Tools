'use strict';

// M3 交付3：纯 Node 字符串 SVG 架构图。复用 ELK 布局与电路视图的符号几何/配色，
// 不依赖 DOM；同一输入两次渲染的节点坐标与 SVG 必须完全一致。
const { createHash } = require('node:crypto');
const { prepareNode } = require('../circuit/symbol-library');
const { layoutProjection } = require('../circuit/layout');
const { elkNode, placeBoundaryColumns } = require('../circuit/projection');
const { svgDocument } = require('../graphics/image-export');
const { escape } = require('../graphics/svg-canvas');
const { fail } = require('../agent/protocol');
const { bundlePorts } = require('./bundles');
const { renderConnections } = require('./render-connections');
const { boundaryPeerGroups, aggregatePeerPorts } = require('./interface-ports');

const DEFAULT_RENDER_BUDGET = Object.freeze({ nodes: 2000, edges: 6000, ports: 16384 });
const LAYOUT_OPTIONS = Object.freeze({
    'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
    'elk.aspectRatio': '1.5',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.favorStraightEdges': 'true',
    'elk.layered.thoroughness': '7',
    'elk.spacing.nodeNode': '44', 'elk.layered.spacing.nodeNodeBetweenLayers': '72',
    'elk.spacing.edgeNode': '20', 'elk.spacing.edgeEdge': '16',
    'elk.layered.spacing.edgeNodeBetweenLayers': '20', 'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
    'elk.padding': '[top=32,left=32,bottom=32,right=32]'
});
const FONT_MONO = "Consolas, 'SFMono-Regular', 'Courier New', monospace";
const FONT_UI = "-apple-system, 'Segoe UI', Roboto, sans-serif";
const PADDING = 40, HEADER = 64, FOOTER = 52, PORT_PITCH = 17, HEADER_BAND = 54, GRID = 8;
// 独立 SVG 的视觉节奏：44px 标题带、4px 圆角/拐角、6~10px 引脚外伸、10.5px 端口标签。
const TITLE_BAND = 44, CARD_RADIUS = 4, PIN_REACH = 6, BUS_REACH = 10, LABEL_SIZE = 10.5;
/** 基础图例项：[标签, 渲染类别]。颜色由主题在渲染时提供。 */
const LEGEND_ITEMS = Object.freeze([['blackbox', 'dash'], ['collapsed', 'solid'], ['bus', 'bus'], ['boundary', 'boundary']]);
const LEGEND_ROW_HEIGHT = 18;
const THEMES = Object.freeze({
    document: Object.freeze({
        background: '#ffffff', panel: '#ffffff', cellBg: '#ffffff', border: '#111111', fg: '#111111', muted: '#333333',
        wire: '#111111', accent: '#111111', blackbox: '#111111', collapsed: '#111111', input: '#111111', output: '#111111',
        inout: '#111111', error: '#111111', grid: null, titleStrip: '#f5f5f5', font: FONT_UI, labelFont: FONT_UI, mono: FONT_MONO, badgeFill: '#ffffff',
        strokeWidth: 1.2, blackboxDash: '6 4', unresolvedDash: '2 3', gridBackground: false, busWidth: 1.8, wireWidth: 1
    }),
    presentation: Object.freeze({
        background: '#111923', panel: '#17222e', cellBg: '#1f252c', border: '#2c3a49', fg: '#d7e1ec', muted: '#9aaabc',
        wire: '#aebbc6', accent: '#63b8ff', blackbox: '#d3b57e', collapsed: '#7ccabf', input: '#eebc79', output: '#70d3c3',
        inout: '#63b8ff', error: '#f29595', grid: '#23313f', titleStrip: null, font: FONT_MONO, labelFont: FONT_MONO, mono: FONT_MONO, badgeFill: '#17222e',
        strokeWidth: 1.5, blackboxDash: '4 3', unresolvedDash: '4 3', gridBackground: true, busWidth: 2.4, wireWidth: 1.25
    })
});
const STYLES = Object.freeze(Object.keys(THEMES));

/** @param {string} [style] 风格名。 @returns {'document'|'presentation'} 归一后的风格；ui 是 presentation 的别名。 */
function normalizeStyle(style) {
    if (style === undefined || style === null || style === '') {
        return 'document';
    }
    const value = String(style).toLowerCase();
    if (value === 'ui') {
        return 'presentation';
    }
    if (!Object.hasOwn(THEMES, value)) {
        fail('INVALID_ARGUMENT', '不支持的--style：' + style + '（可选 document|presentation）');
    }
    return value;
}

/** @param {string} svg SVG 文本。 @returns {string} SHA-256。 */
function sha256(svg) {
    return createHash('sha256').update(svg, 'utf8').digest('hex');
}

/** @param {number} value @returns {number} 保留3位小数。 */
function number(value) {
    if (!Number.isFinite(value)) {
        throw new TypeError('架构图坐标不是有限数值');
    }
    return Math.round(value * 1000) / 1000;
}

/** @param {string} text @param {number} size 字号。 @returns {number} 估算文本宽度（中文字符按1em）。 */
function textWidth(text, size = 12) {
    return [...String(text)].reduce((total, char) => total + (/[^\x00-\x7f]/.test(char) ? size : size * 0.62), 0);
}

/** @param {string} text @param {number} width @param {number} size @returns {string} 按估算宽度截断的文本。 */
function shorten(text, width, size = 12) {
    const value = String(text);
    if (textWidth(value, size) <= width) {
        return value;
    }
    let result = '';
    for (const char of value) {
        if (textWidth(result + char + '…', size) > width) {
            break;
        }
        result += char;
    }
    return result + '…';
}

/** @param {string} value @returns {string} 安全文件名片段。 */
function safeName(value) {
    return String(value || 'architecture').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'architecture';
}

/** @param {string[]} names @param {number} width @returns {string} 图边回退标签（无 interfaces 时使用）。 */
function netLabel(names, width) {
    const candidates = names.map(name => {
        const index = name.lastIndexOf('_');
        return index >= 0 ? name.slice(0, index + 1) : name;
    }).filter(name => name.length >= 3);
    let common = candidates[0] || '';
    for (const candidate of candidates.slice(1)) {
        while (common && !candidate.startsWith(common)) {
            common = common.slice(0, -1);
        }
    }
    if (common.length >= 3 && common.includes('_')) {
        return `${common}* (${width} bits)`;
    }
    return `${names.slice(0, 2).join(', ')}${names.length > 1 ? '…' : ''} (${width} bits)`;
}

/** @param {object[]} ports 节点端口。 @returns {{inputs:object[], outputs:object[]}} 按方向分组。 */
function splitPorts(ports) {
    // m_/s_ 是架构接口的布局提示：请求与响应放在面对同一模块的一侧；direction 始终保留真实方向。
    const west = port => port.layoutSide ? port.layoutSide === 'WEST' : /^s\d*_/.test(port.label) || (!/^m\d*_/.test(port.label) && port.direction !== 'output');
    return { inputs: ports.filter(west), outputs: ports.filter(port => !west(port)) };
}

/** @param {object} node 架构图实例节点。 @param {{bundle:boolean,bundleNames:object}} options @returns {object[]} 显示端口（折叠端口或原始端口）。 */
function displayPorts(node, { bundle, bundleNames, sideHints = new Map() }) {
    if (!bundle) {
        return node.ports.map(port => ({
            id: node.id + '/' + port.name, label: port.name, displayLabel: port.name + (port.width > 1 ? '[' + port.width + ']' : ''),
            direction: port.direction, width: port.width, bitWidth: port.width,
            bits: new Array(Math.max(1, Math.min(port.width, 64))).fill('n:0'),
            members: null, prefix: null, collapsed: false, layoutSide: sideHints.get(node.id + '/' + port.name)
        }));
    }
    return bundlePorts(node.ports, { names: bundleNames }).map(item => {
        const collapsed = Boolean(item.prefix && item.members.length > 1);
        const displayLabel = collapsed ? item.name + '* (' + item.bits + ')' : item.members[0].name + (item.bits > 1 ? '[' + item.bits + ']' : '');
        const sides = new Set(item.members.map(member => sideHints.get(node.id + '/' + member.name)).filter(Boolean));
        return {
            id: node.id + '/' + (item.prefix ? 'bundle:' + item.prefix : item.name),
            label: item.name, displayLabel, direction: item.direction, width: item.bits, bitWidth: item.bits,
            bits: new Array(Math.max(1, Math.min(item.bits, 64))).fill('n:0'),
            members: item.members, prefix: item.prefix, collapsed, layoutSide: sides.size === 1 ? [...sides][0] : undefined
        };
    });
}

/** @param {object} node 架构图实例节点。 @param {{bundle:boolean,bundleNames:object}} options @returns {object} 已分配尺寸/锚点的布局节点。 */
function prepareInstanceNode(node, options) {
    const base = prepareNode({
        id: node.id, kind: 'instance', label: node.name || node.label, detail: node.module,
        moduleId: node.moduleId || 'unresolved:' + node.name,
        implementation: node.implementation, status: node.status,
        ports: aggregatePeerPorts(node, displayPorts(node, options), options.interfaceGroups)
    });
    const { inputs, outputs } = splitPorts(base.ports);
    const badge = node.status === 'unresolved' ? 'unresolved' : node.implementation;
    const badgeWidth = textWidth(badge, 9) + 12;
    const titleWidth = Math.max(textWidth(base.label, 13), textWidth(base.detail || '', 11)) + badgeWidth + 36;
    const sideWidth = list => Math.max(0, ...list.map(port => textWidth(port.displayLabel, 11)));
    const width = Math.ceil(Math.max(titleWidth, sideWidth(inputs) + sideWidth(outputs) + 48) / GRID) * GRID;
    // 无端口实例只保留标题带与副标题，不再为不存在的端口行预留空白。
    const rows = Math.max(inputs.length, outputs.length);
    const height = rows
        ? Math.ceil((HEADER_BAND + PORT_PITCH * rows + 16) / GRID) * GRID
        : Math.ceil((TITLE_BAND + 12) / GRID) * GRID;
    for (const [list, side] of [[inputs, 'WEST'], [outputs, 'EAST']]) {
        list.forEach((port, index) => {
            port.side = side;
            port.x = side === 'WEST' ? 0 : width;
            port.y = HEADER_BAND + index * PORT_PITCH;
            port.width = 0;
            port.height = 0;
        });
    }
    return { ...base, width, height, badge, badgeWidth, labelColumns: { WEST: sideWidth(inputs), EAST: sideWidth(outputs) },
        paintBounds: { left: -10, top: -10, right: width + 10, bottom: height + 10 },
        implementation: node.implementation, status: node.status };
}

/** @param {object} node 架构图边界节点。 @returns {object} 边界条节点。 */
function prepareBoundaryNode(node, boundaryLayout) {
    const label = node.name + (node.ports[0] && node.ports[0].width > 1 ? ' [' + node.ports[0].width + ']' : '');
    const width = Math.ceil(Math.max(92, textWidth(label, 12) + 44) / GRID) * GRID;
    const height = 36;
    const side = node.direction === 'output' || (boundaryLayout === 'ends' && node.direction === 'inout') ? 'WEST' : 'EAST';
    const port = { id: node.id + '/' + node.ports[0].name, label: node.name, direction: node.ports[0].direction,
        bitWidth: node.ports[0].width, bits: [], side, x: side === 'WEST' ? 0 : width, y: height / 2, width: 0, height: 0 };
    return { id: node.id, kind: 'boundary', label, name: node.name, direction: node.direction, boundary: true,
        width, height, paintBounds: { left: -10, top: -10, right: width + 10, bottom: height + 10 }, ports: [port] };
}

/** 同前缀边界排成接口表；默认共用一个逻辑锚点，信号级视图保留逐行锚点。 */
function prepareBoundaryTables(boundaries, detail, boundaryLayout) {
    const byName = new Map(boundaries.map(node => [node.name, node]));
    return bundlePorts(boundaries.map(node => ({ name: node.name, direction: node.direction, width: node.ports[0].width }))).map(group => {
        if (!group.prefix || group.members.length < 2) return prepareBoundaryNode(byName.get(group.members[0].name), boundaryLayout);
        const rowHeight = 22, headerHeight = 50;
        const nameWidth = Math.max(100, ...group.members.map(port => textWidth(port.name, 11) + 24));
        const width = Math.ceil(Math.max(nameWidth + 104, textWidth(group.name, 12) + textWidth(group.members.length + ' ports · ' + group.bits + ' bits', 10) + 40) / GRID) * GRID;
        const height = headerHeight + rowHeight * group.members.length;
        const inputCount = group.members.filter(port => port.direction === 'input').length;
        const side = inputCount > group.members.length / 2 ? 'EAST' : 'WEST';
        const ports = group.members.map((member, at) => {
            const node = byName.get(member.name), port = node.ports[0];
            return { id: node.id + '/' + port.name, sourceNodeId: node.id, label: member.name, boundaryDirection: node.direction,
                direction: port.direction, bitWidth: port.width, bits: [], side, x: side === 'WEST' ? 0 : width,
                y: headerHeight + rowHeight * (at + 0.5), width: 0, height: 0 };
        });
        const id = 'boundary-table:' + group.prefix;
        const summary = {id:id+'/interface',label:group.name,displayLabel:group.name,direction:group.direction,
            bitWidth:group.bits,bits:[],side,x:side==='WEST'?0:width,y:headerHeight+(height-headerHeight)/2,width:0,height:0,
            members:ports.map(port=>({name:port.label,width:port.bitWidth,direction:port.direction,sourceNodeId:port.sourceNodeId})),
            interfaceLevel:true,interfaceName:group.name};
        return { id, kind: 'boundary', boundary: true, boundaryTable: true,
            name: group.name, label: group.name, direction: group.direction, bitWidth: group.bits,
            width, height, nameWidth, rowHeight, headerHeight, ports: detail==='signals'?ports:[summary], rows:ports, detail,
            paintBounds: { left: -10, top: -10, right: width + 10, bottom: height + 10 } };
    });
}

/** 由真实连接给表格对端端口确定朝向；方向冲突时保留常规布局，不改变RTL方向。 */
function boundarySideHints(arch, boundaries, boundaryLayout) {
    const sides = new Map();
    for (const node of boundaries) {
        if (node.boundaryTable) {
            for (const port of node.rows) sides.set(port.sourceNodeId, port.side);
        } else if (boundaryLayout === 'ends') sides.set(node.id, node.ports[0].side);
    }
    const candidates = new Map();
    for (const edge of [...(arch.graph.edges || []), ...(arch.interfaces || []).flatMap(item => item.bindings || [])]) {
        for (const [boundary, peer, peerPort] of [[edge.sourceNode,edge.targetNode,edge.targetPort],[edge.targetNode,edge.sourceNode,edge.sourcePort]]) {
            if (!sides.has(boundary) || typeof peer !== 'string' || !peer.startsWith('instance:')) continue;
            const key = peer + '/' + peerPort;
            if (!candidates.has(key)) candidates.set(key, new Set());
            candidates.get(key).add(sides.get(boundary) === 'WEST' ? 'EAST' : 'WEST');
        }
    }
    return new Map([...candidates].filter(([,values]) => values.size === 1).map(([key,values]) => [key,[...values][0]]));
}

/** @param {object} arch 架构数据。 @returns {object[]} 接口列表；旧数据回退到 graph.edges。 */
function interfacesOf(arch) {
    if (Array.isArray(arch.interfaces) && arch.interfaces.length) {
        return arch.interfaces;
    }
    return (arch.graph.edges || []).map((edge, index) => ({
        id: 'edge-' + index,
        from: { kind: edge.sourceNode.startsWith('boundary:') ? 'boundary' : 'instance', name: edge.sourceNode.replace(/^(?:boundary|instance):/, '') },
        to: { kind: edge.targetNode.startsWith('boundary:') ? 'boundary' : 'instance', name: edge.targetNode.replace(/^(?:boundary|instance):/, '') },
        direction: 'forward', bits: edge.width, label: netLabel(edge.netNames || [], edge.width),
        signals: (edge.netNames || []).map(name => ({ name, width: edge.width, direction: 'forward' }))
    }));
}

/** @param {object} node @param {string} hint 'input'|'output'|'inout'|null @param {string[]} [portNames] 接口实际端口名。 @returns {object|null} 代表端口。 */
function representativePort(node, hint, portNames = []) {
    if (!node || !node.ports.length) {
        return null;
    }
    if (node.kind === 'boundary') {
        return node.ports[0];
    }
    const names = new Set(portNames);
    const named = node.ports.find(port => (port.members && port.members.some(member => names.has(member.name)))
        || names.has(port.label));
    if (named) {
        return named;
    }
    const exact = node.ports.find(port => port.direction === hint);
    if (exact) {
        return exact;
    }
    const inout = node.ports.find(port => port.direction === 'inout');
    return inout || node.ports[0];
}

/** @param {string} name 端点名称（多端用 + 分隔）。 @param {'boundary'|'instance'} kind @returns {string[]} 节点 id。 */
function endpointNodes(name, kind) {
    return String(name).split('+').filter(Boolean).map(value => kind + ':' + value);
}

/**
 * 构造 ELK 投影：节点为实例/边界，接口束为边；多端接口引入总线汇合节点。
 * @param {object} arch design arch 数据。 @param {{budget?:object, bundle?:boolean, bundleNames?:object, detail?:'interfaces'|'signals', boundaryLayout?:'auto'|'ends'}} [options]
 *   bundle 默认 false；启用后只合并落在同一显示端口上的成员连接。
 * @returns {object} 可交给 layoutProjection 的投影。
 */
function buildRenderProjection(arch, { budget = {}, bundle = false, bundleNames = {}, detail = 'interfaces', boundaryLayout = 'auto' } = {}) {
    if (!['auto', 'ends'].includes(boundaryLayout)) fail('INVALID_ARGUMENT', '--boundary-layout 需要 auto|ends');
    if (!['interfaces','signals'].includes(detail)) fail('INVALID_ARGUMENT','--detail需要 interfaces|signals');
    const limits = { ...DEFAULT_RENDER_BUDGET, ...budget };
    for (const [name, limit] of Object.entries(limits)) {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            fail('INVALID_ARGUMENT', '无效渲染预算项：' + name);
        }
    }
    const graphNodes = arch.graph && arch.graph.nodes ? arch.graph.nodes : [];
    if (!graphNodes.length) {
        fail('DESIGN_LIMIT', '架构图没有可渲染的节点', { kind: 'nodes', used: 0, limit: limits.nodes });
    }
    const fullPorts = graphNodes.reduce((total, node) => total + (node.ports ? node.ports.length : 0), 0);
    if (graphNodes.length > limits.nodes) {
        fail('DESIGN_LIMIT', '架构图节点数量超出渲染预算', { kind: 'nodes', used: graphNodes.length, limit: limits.nodes });
    }
    const legacyInout = arch.interfaces?.some(item => !item.bindings?.length && item.signals?.some(signal => signal.direction === 'inout'));
    const hasBindingFacts = !legacyInout && (!arch.interfaces?.length || arch.graph.edges?.length || arch.interfaces.some(item => item.bindings?.length));
    const boundaries = graphNodes.filter(node => node.kind === 'boundary');
    const boundaryNodes = hasBindingFacts ? prepareBoundaryTables(boundaries, detail, boundaryLayout)
        : boundaries.map(node => prepareBoundaryNode(node, boundaryLayout));
    const sideHints = boundarySideHints(arch, boundaryNodes, boundaryLayout);
    const peerGroups = detail==='interfaces' ? boundaryPeerGroups(arch,boundaryNodes) : new Map();
    const nodes = [...boundaryNodes,
        ...graphNodes.filter(node => node.kind !== 'boundary').map(node => prepareInstanceNode(node, { bundle, bundleNames, sideHints,interfaceGroups:peerGroups.get(node.id) }))];
    const byId = new Map(nodes.map(node => [node.id, node]));
    const interfaces = renderConnections(arch, nodes, interfacesOf(arch));
    if (interfaces.length > limits.edges) {
        fail('DESIGN_LIMIT', '架构图接口数量超出渲染预算', { kind: 'edges', used: interfaces.length, limit: limits.edges });
    }
    const endpointPort = (item, node, side, hint, names) => {
        const reference = item[side]?.find(value => value.nodeId === node.id);
        return reference ? node.ports.find(port => port.id === reference.portId) : representativePort(node, hint, names);
    };
    const edges = [];
    for (const item of interfaces) {
        const sourceIds = item.renderSources?.map(value => value.nodeId) || endpointNodes(item.from.name, item.from.kind);
        const targetIds = item.renderTargets?.map(value => value.nodeId) || endpointNodes(item.to.name, item.to.kind);
        const sources = sourceIds.map(id => byId.get(id)).filter(Boolean);
        const targets = targetIds.map(id => byId.get(id)).filter(Boolean);
        if (!sources.length || !targets.length) {
            continue;
        }
        const bidirectional = item.direction === 'bidirectional';
        if (sources.length === 1 && targets.length === 1) {
            const sourcePort = endpointPort(item, sources[0], 'renderSources', 'output', item.fromPorts);
            const targetPort = endpointPort(item, targets[0], 'renderTargets', 'input', item.toPorts);
            if (sourcePort && targetPort) {
                edges.push({ id: item.id, sources: [sourcePort.id], targets: [targetPort.id], interface: item, bidirectional });
            }
            continue;
        }
        // 多端接口引入汇合节点：总线从各端汇入，再从汇合点扇出。
        const junctionId = item.id;
        const junctionInputs = sources.map((source, index) => ({
            id: junctionId + ':in:' + index, label: '', direction: 'input', width: 0, height: 0, side: 'WEST',
            x: 0, y: 14 + index * 10, bits: []
        }));
        const junctionOutputs = targets.map((target, index) => ({
            id: junctionId + ':out:' + index, label: '', direction: 'output', width: 0, height: 0, side: 'EAST',
            x: 0, y: 14 + index * 10, bits: []
        }));
        const label = item.label + ' (' + item.bits + ' bits)';
        const width = Math.ceil(Math.max(48, textWidth(label, 11) + 16) / GRID) * GRID;
        const height = Math.ceil((Math.max(junctionInputs.length, junctionOutputs.length) * 10 + 22) / GRID) * GRID;
        const junction = { id: junctionId, kind: 'junction', label, bitWidth: item.bits, width: width + 20, height: height + 18, x: 0, y: 0,
            ports: [...junctionInputs, ...junctionOutputs], implementation: null, status: 'resolved',
            paintBounds: { left: -6, top: -6, right: width + 26, bottom: height + 24 } };
        for (const port of junctionInputs) {
            port.x = 0; port.y += 18;
        }
        for (const port of junctionOutputs) {
            port.x = width + 20; port.y += 18;
        }
        nodes.push(junction);
        byId.set(junctionId, junction);
        sources.forEach((source, index) => {
            const sourcePort = endpointPort(item, source, 'renderSources', 'output', item.fromPorts);
            if (sourcePort) {
                edges.push({ id: item.id + ':in:' + index, sources: [sourcePort.id], targets: [junctionInputs[index].id],
                    interface: item, bidirectional, junction: true });
            }
        });
        targets.forEach((target, index) => {
            const reference = item.renderTargets?.[index];
            const targetPort = reference ? target.ports.find(port => port.id === reference.portId) : representativePort(target, 'input', item.toPorts);
            if (targetPort) {
                edges.push({ id: item.id + ':out:' + index, sources: [junctionOutputs[index].id],
                    targets: [targetPort.id], interface: item, bidirectional, junction: true });
            }
        });
    }
    if (edges.length > limits.edges) {
        fail('DESIGN_LIMIT', '架构图渲染连边数量超出预算', { kind: 'edges', used: edges.length, limit: limits.edges });
    }
    // 汇合节点与其端口也计入渲染预算。
    if (nodes.length > limits.nodes) {
        fail('DESIGN_LIMIT', '架构图渲染节点数量超出预算', { kind: 'nodes', used: nodes.length, limit: limits.nodes });
    }
    const renderPorts = nodes.reduce((total, node) => total + node.ports.length, 0);
    if (renderPorts > limits.ports) {
        fail('DESIGN_LIMIT', '架构图渲染端口数量超出预算', { kind: 'ports', used: renderPorts, limit: limits.ports });
    }
    const portSides = new Map(nodes.flatMap(node => node.ports.map(port => [port.id, port.side])));
    const input = {
        id: 'graph:arch', layoutOptions: LAYOUT_OPTIONS,
        children: nodes.map(elkNode),
        edges: edges.map(edge => ({ id: edge.id, sources: edge.sources, targets: edge.targets,
            layoutOptions: { 'elk.layered.priority.direction': portSides.get(edge.sources[0]) === 'EAST' ? '10' : '0' },
            ...(!edge.junction ? { labels: [{ id: edge.id + ':label', text: edge.interface.label + ' (' + edge.interface.bits + ' bits)',
                width: textWidth(edge.interface.label + ' (' + edge.interface.bits + ' bits)', 10) + 12, height: 18,
                layoutOptions: { 'elk.edgeLabels.placement': 'CENTER', 'elk.edgeLabels.inline': 'false' } }] } : {}) }))
    };
    if (boundaryLayout === 'ends') placeBoundaryColumns(input, nodes);
    return { id: 'graph:arch', moduleId: arch.top ? arch.top.moduleId : null, name: arch.top ? arch.top.name : 'architecture',
        input, nodes, edges, signals: [], parameters: null,
        stats: { nodes: nodes.length, edges: edges.length, ports: renderPorts, fullPorts,
            bundles: nodes.reduce((total, node) => total + node.ports.filter(port => port.collapsed).length, 0),
            interfaces: interfaces.length, junctions: nodes.filter(node => node.kind === 'junction').length, bundled: bundle,
            boundaryTables: nodes.filter(node => node.boundaryTable).length, detail,
            ...(boundaryLayout === 'ends' ? { boundaryLayout } : {}) } };
}

/**
 * 用 ELK 布局架构投影。
 * @param {object} arch design arch 数据。 @param {{elk?:object, budget?:object}} [options]
 * @returns {Promise<{projection:object, layout:object}>} 投影与带坐标布局。
 */
async function layoutArchitecture(arch, options = {}) {
    const projection = buildRenderProjection(arch, options);
    const layout = await layoutProjection(projection, { elk: options.elk });
    return { projection, layout };
}

/** @param {number} x @param {number} y @param {number} width @param {number} height @param {number} radius @returns {string} 顶部圆角、底边平直的标题带路径。 */
function titleBandPath(x, y, width, height, radius = CARD_RADIUS) {
    const r = Math.max(0, Math.min(radius, width / 2, height));
    return 'M ' + number(x) + ' ' + number(y + r)
        + ' Q ' + number(x) + ' ' + number(y) + ' ' + number(x + r) + ' ' + number(y)
        + ' H ' + number(x + width - r)
        + ' Q ' + number(x + width) + ' ' + number(y) + ' ' + number(x + width) + ' ' + number(y + r)
        + ' V ' + number(y + height) + ' H ' + number(x) + ' Z';
}

/**
 * 画一个引脚符号：标量用外伸短线 + 圆点，inout 用实心菱形端头，
 * 接口束用两条横线 + 内侧竖线的总线端头；方向由所在边表达，不再重复三角。
 */
function drawPortPin(side, px, py, bus, inout, theme, parts, color = theme.wire) {
    const reach = bus ? BUS_REACH : PIN_REACH;
    parts.push('<line x1="' + number(side === 'WEST' ? px - reach : px) + '" y1="' + number(py) + '" x2="'
        + number(side === 'WEST' ? px : px + reach) + '" y2="' + number(py) + '" stroke="' + color
        + '" stroke-width="' + (bus ? theme.busWidth : theme.wireWidth) + '" stroke-linecap="round"/>');
    if (bus) {
        const bar = side === 'WEST' ? px - 2 : px + 2, edge = side === 'WEST' ? px - 8 : px + 8;
        parts.push('<path d="M ' + number(bar) + ' ' + number(py - 3) + ' V ' + number(py + 3)
            + ' M ' + number(edge) + ' ' + number(py - 2) + ' H ' + number(bar)
            + ' M ' + number(edge) + ' ' + number(py + 2) + ' H ' + number(bar)
            + '" fill="none" stroke="' + color + '" stroke-width="' + theme.strokeWidth + '" stroke-linecap="round"/>');
        return;
    }
    if (inout) {
        parts.push('<path d="M ' + number(px) + ' ' + number(py - 3) + ' L ' + number(px + 3) + ' ' + number(py)
            + ' L ' + number(px) + ' ' + number(py + 3) + ' L ' + number(px - 3) + ' ' + number(py)
            + ' Z" fill="' + theme.cellBg + '" stroke="' + color + '" stroke-width="' + theme.strokeWidth + '"/>');
        return;
    }
    parts.push('<circle cx="' + number(px) + '" cy="' + number(py) + '" r="2" fill="' + theme.cellBg
        + '" stroke="' + color + '" stroke-width="' + theme.strokeWidth + '"/>');
}

/** @param {object} node 布局节点。 @param {object[]} parts SVG片段。 @param {object} theme 风格。 @returns {void} 追加实例盒。 */
function drawInstance(node, parts, theme) {
    const accent = node.status === 'unresolved' ? theme.error : node.implementation === 'blackbox' ? theme.blackbox : theme.collapsed;
    const dash = node.status === 'unresolved' ? ' stroke-dasharray="' + theme.unresolvedDash + '"'
        : node.implementation === 'blackbox' ? ' stroke-dasharray="' + theme.blackboxDash + '"' : '';
    parts.push('<g data-model-id="' + escape(node.id) + '" data-kind="instance" data-implementation="' + escape(node.implementation || 'collapsed') + '">');
    parts.push('<rect x="' + number(node.x) + '" y="' + number(node.y) + '" width="' + number(node.width) + '" height="' + number(node.height)
        + '" rx="' + CARD_RADIUS + '" fill="' + theme.cellBg + '" stroke="' + accent + '" stroke-width="' + theme.strokeWidth + '"' + dash + '/>');
    if (theme.titleStrip) {
        // 标题带内缩 1px，保留虚线实现状态的完整上边框。
        parts.push('<path d="' + titleBandPath(node.x + 1, node.y + 1, node.width - 2, TITLE_BAND - 1) + '" fill="' + theme.titleStrip + '"/>');
        parts.push('<line x1="' + number(node.x) + '" y1="' + number(node.y + TITLE_BAND) + '" x2="' + number(node.x + node.width) + '" y2="'
            + number(node.y + TITLE_BAND) + '" stroke="' + theme.border + '" stroke-width="0.6"/>');
    }
    parts.push('<text x="' + number(node.x + 12) + '" y="' + number(node.y + 21) + '" fill="' + theme.fg + '" font-family="' + theme.mono + '" font-size="13" font-weight="600">'
        + escape(shorten(node.label, node.width - node.badgeWidth - 24, 13)) + '</text>');
    parts.push('<text x="' + number(node.x + 12) + '" y="' + number(node.y + 38) + '" fill="' + theme.muted + '" font-family="' + theme.mono + '" font-size="11">'
        + escape(shorten(node.detail || '', node.width - node.badgeWidth - 24, 11)) + '</text>');
    // 右上角只标注值得注意的实现状态；默认 collapsed 由实线卡片和图例表达，避免每张卡片重复同一枚 chip。
    const badge = node.badge, badgeWidth = node.badgeWidth;
    if (badge && badge !== 'collapsed') {
        const chipX = node.x + node.width - badgeWidth - 10;
        parts.push('<rect x="' + number(chipX) + '" y="' + number(node.y + 8) + '" width="' + number(badgeWidth)
            + '" height="16" rx="3" fill="' + theme.badgeFill + '" stroke="' + accent + '" stroke-width="0.8"/>');
        parts.push('<text x="' + number(chipX + badgeWidth / 2) + '" y="' + number(node.y + 19) + '" fill="' + accent
            + '" font-family="' + theme.mono + '" font-size="9" text-anchor="middle">' + escape(badge) + '</text>');
    }
    for (const port of node.ports) {
        const side = port.x <= node.width / 2 ? 'WEST' : 'EAST';
        const px = node.x + port.x, py = node.y + port.y;
        const label = port.displayLabel;
        const bus = (port.bitWidth || 1) > 1;
        const labelWidth = node.width - (node.labelColumns?.[side === 'WEST' ? 'EAST' : 'WEST'] || 0) - 32;
        const title = port.members
            ? '虚拟接口端口 ' + port.label + (port.collapsed ? '*' : '') + ' (' + port.bitWidth + ' bits) · ' + port.direction
                + ' · 成员: ' + port.members.map(member => member.name + '[' + member.width + ']').join(', ')
            : port.label + ' · ' + port.direction + ' · ' + port.bitWidth + ' bit' + (port.bitWidth === 1 ? '' : 's');
        parts.push('<g data-model-id="' + escape(port.id) + '" data-kind="port" data-direction="' + escape(port.direction) + '">');
        parts.push('<title>' + escape(title) + '</title>');
        drawPortPin(side, px, py, bus, port.direction === 'inout', theme, parts);
        parts.push('<text x="' + number(side === 'WEST' ? node.x + 12 : node.x + node.width - 12) + '" y="' + number(py + 3.5) + '" fill="' + theme.fg
            + '" font-family="' + theme.mono + '" font-size="' + LABEL_SIZE + '"' + (bus ? ' font-weight="600"' : '')
            + ' text-anchor="' + (side === 'WEST' ? 'start' : 'end') + '">' + escape(shorten(label, labelWidth, LABEL_SIZE)) + '</text>');
        parts.push('</g>');
    }
    parts.push('</g>');
}

/** @param {object} node 布局节点。 @param {object[]} parts SVG片段。 @param {object} theme 风格。 @returns {void} 追加边界条。 */
function drawBoundary(node, parts, theme) {
    if (node.boundaryTable) { drawBoundaryTable(node, parts, theme); return; }
    const accent = node.direction === 'output' ? theme.output : node.direction === 'inout' ? theme.inout : theme.input;
    parts.push('<g data-model-id="' + escape(node.id) + '" data-kind="boundary" data-direction="' + escape(node.direction) + '">');
    parts.push('<title>' + escape(node.label + ' · 边界' + node.direction + ' · ' + (node.ports[0] ? node.ports[0].bitWidth : 1) + ' bits') + '</title>');
    parts.push('<rect x="' + number(node.x) + '" y="' + number(node.y) + '" width="' + number(node.width) + '" height="' + number(node.height)
        + '" rx="3" fill="' + theme.panel + '" stroke="' + theme.border + '" stroke-width="' + theme.strokeWidth + '"/>');
    parts.push('<rect x="' + number(node.direction === 'output' ? node.x + node.width - 4 : node.x + 1) + '" y="' + number(node.y + 1)
        + '" width="3" height="' + number(node.height - 2) + '" rx="1.5" fill="' + accent + '"/>');
    parts.push('<text x="' + number(node.x + node.width / 2) + '" y="' + number(node.y + node.height / 2 + 4) + '" fill="' + theme.fg
        + '" font-family="' + theme.mono + '" font-size="11.5" text-anchor="middle">' + escape(node.label) + '</text>');
    for (const port of node.ports) {
        const px = node.x + port.x, py = node.y + port.y;
        parts.push('<g data-model-id="' + escape(port.id) + '" data-kind="port" data-direction="' + escape(port.direction) + '">');
        parts.push('<title>' + escape(port.label + ' · ' + node.direction + ' · ' + port.bitWidth + ' bit' + (port.bitWidth === 1 ? '' : 's')) + '</title>');
        drawPortPin(port.side, px, py, (port.bitWidth || 1) > 1, port.direction === 'inout', theme, parts, accent);
        parts.push('</g>');
    }
    parts.push('</g>');
}

/** 边界接口表：方向是相对于 RTL 顶层，位宽列表示位数，各行锚点保持原端口身份。 */
function drawBoundaryTable(node, parts, theme) {
    const left = node.x, top = node.y, pad = 10;
    // 三列：名称左对齐；方向、位宽右对齐，列宽按最长值（四位数位宽）预留。
    const dirRight = left + node.width - 70, bitsRight = left + node.width - pad;
    const dirLine = dirRight - 34, bitsLine = bitsRight - 30;
    parts.push('<g data-model-id="' + escape(node.id) + '" data-kind="boundary-table">');
    parts.push('<title>' + escape(node.name + '：按名称前缀分组；方向相对于RTL顶层，未推断协议') + '</title>');
    parts.push('<rect x="' + number(left) + '" y="' + number(top) + '" width="' + node.width + '" height="' + node.height
        + '" rx="3" fill="' + theme.panel + '" stroke="' + theme.border + '" stroke-width="' + theme.strokeWidth + '"/>');
    if (theme.titleStrip) {
        parts.push('<path d="' + titleBandPath(left + 1, top + 1, node.width - 2, node.headerHeight - 1, 3) + '" fill="' + theme.titleStrip + '"/>');
    }
    // 标题行与列标题之间的分隔线：两种主题共用，深色主题没有标题带底色时仍能读出表头层级。
    parts.push('<line x1="' + number(left + 1) + '" y1="' + number(top + 30) + '" x2="' + number(left + node.width - 1) + '" y2="'
        + number(top + 30) + '" stroke="' + theme.border + '" stroke-width="0.5" opacity="0.5"/>');
    parts.push('<text x="' + number(left + pad) + '" y="' + number(top + 18) + '" fill="' + theme.fg + '" font-family="' + theme.mono
        + '" font-size="12" font-weight="600">' + escape(node.name) + '</text>');
    parts.push('<text x="' + number(left + node.width - pad) + '" y="' + number(top + 18) + '" fill="' + theme.muted + '" font-family="' + theme.mono
        + '" font-size="10" text-anchor="end">' + node.rows.length + ' ports · ' + node.bitWidth + ' bits</text>');
    for (const [label, x, anchor] of [['SIGNAL', left + pad, 'start'], ['DIR', dirRight, 'end'], ['BITS', bitsRight, 'end']]) {
        parts.push('<text x="' + number(x) + '" y="' + number(top + 43) + '" fill="' + theme.muted + '" font-family="' + theme.mono
            + '" font-size="10" letter-spacing="0.7" text-anchor="' + anchor + '">' + label + '</text>');
    }
    for (let row = 0; row <= node.rows.length; row++) {
        const y = top + node.headerHeight + row * node.rowHeight;
        parts.push('<line x1="' + number(left) + '" y1="' + number(y) + '" x2="' + number(left + node.width) + '" y2="' + number(y)
            + '" stroke="' + theme.border + '" stroke-width="0.5" opacity="0.55"/>');
    }
    for (const x of [dirLine, bitsLine]) parts.push('<line x1="' + number(x) + '" y1="' + number(top + 30) + '" x2="' + number(x) + '" y2="'
        + number(top + node.height) + '" stroke="' + theme.border + '" stroke-width="0.5" opacity="0.35"/>');
    for (const port of node.rows) {
        // 方向用 i/o/io 缩写而非箭头：箭头在左右两侧表中含义相反（→ 在左表为流入设计、右表为流出），
        // 缩写直接对应 RTL 端口方向且无视角歧义；全词保留在 <title>。
        const y = top + port.y, x = left + port.x, direction = { input: 'i', output: 'o', inout: 'io' }[port.boundaryDirection] || port.boundaryDirection;
        parts.push('<g data-model-id="' + escape(port.id) + '" data-kind="port" data-boundary-id="' + escape(port.sourceNodeId) + '" data-direction="' + port.boundaryDirection + '">');
        parts.push('<title>' + escape(port.label + ' · ' + port.boundaryDirection + ' · ' + port.bitWidth + ' bits') + '</title>');
        parts.push('<text x="' + number(left + pad) + '" y="' + number(y + 3.5) + '" fill="' + theme.fg + '" font-family="' + theme.mono
            + '" font-size="10.5">' + escape(port.label) + '</text>');
        parts.push('<text x="' + number(dirRight) + '" y="' + number(y + 3.5) + '" fill="' + theme.fg + '" font-family="' + theme.mono
            + '" font-size="9.5" text-anchor="end">' + direction + '</text>');
        parts.push('<text x="' + number(bitsRight) + '" y="' + number(y + 3.5) + '" fill="' + theme.muted + '" font-family="' + theme.mono
            + '" font-size="9.5" text-anchor="end">' + port.bitWidth + '</text>');
        if (node.detail === 'signals') drawPortPin(port.side, x, y, (port.bitWidth || 1) > 1, port.boundaryDirection === 'inout', theme, parts);
        parts.push('</g>');
    }
    if (node.detail !== 'signals') {
        const port = node.ports[0], x = left + port.x, y = top + port.y;
        parts.push('<g data-model-id="' + escape(port.id) + '" data-kind="interface-port">');
        drawPortPin(port.side, x, y, true, false, theme, parts);
        parts.push('</g>');
    }
    parts.push('</g>');
}

/** @param {object} node 布局节点。 @param {object[]} parts SVG片段。 @param {object} theme 风格。 @returns {void} 追加接口汇合节点。 */
function drawJunction(node, parts, theme) {
    parts.push('<g data-model-id="' + escape(node.id) + '" data-kind="junction">');
    const center = node.x + node.width / 2, ys = node.ports.map(port => node.y + port.y), bus = node.bitWidth > 1;
    const trunk = bus ? theme.busWidth : theme.wireWidth;
    parts.push('<line x1="' + number(center) + '" y1="' + number(Math.min(...ys)) + '" x2="' + number(center) + '" y2="'
        + number(Math.max(...ys)) + '" stroke="' + theme.wire + '" stroke-width="' + trunk + '" stroke-linecap="round"/>');
    parts.push('<text x="' + number(center) + '" y="' + number(node.y + 15) + '" fill="' + theme.fg
        + '" font-family="' + theme.mono + '" font-size="10.5" text-anchor="middle">' + escape(shorten(node.label, node.width - 18, 10.5)) + '</text>');
    for (const port of node.ports) {
        parts.push('<g data-model-id="' + escape(port.id) + '" data-kind="port">');
        parts.push('<line x1="' + number(node.x + port.x) + '" y1="' + number(node.y + port.y)
            + '" x2="' + number(center) + '" y2="' + number(node.y + port.y)
            + '" stroke="' + theme.wire + '" stroke-width="' + trunk + '"/>');
        parts.push('<circle cx="' + number(center) + '" cy="' + number(node.y + port.y) + '" r="2.2" fill="' + theme.wire + '"/>');
        parts.push('</g>');
    }
    parts.push('</g>');
}

/** @param {number[][]} points 折线点。 @param {number} [radius] 拐角半径。 @returns {string} 正交折线路径；拐角用二次曲线收圆，端点不变。 */
function roundedPolyline(points, radius = CARD_RADIUS) {
    if (!Array.isArray(points) || points.length < 2) {
        return '';
    }
    let path = 'M ' + number(points[0][0]) + ' ' + number(points[0][1]);
    for (let index = 1; index < points.length - 1; index++) {
        const [ax, ay] = points[index - 1], [bx, by] = points[index], [cx, cy] = points[index + 1];
        const inLength = Math.abs(bx - ax) + Math.abs(by - ay);
        const outLength = Math.abs(cx - bx) + Math.abs(cy - by);
        const r = Math.min(radius, inLength / 2, outLength / 2);
        if (!(r > 0)) {
            path += ' L ' + number(bx) + ' ' + number(by);
            continue;
        }
        const sx = bx + (ax - bx) * r / inLength, sy = by + (ay - by) * r / inLength;
        const ex = bx + (cx - bx) * r / outLength, ey = by + (cy - by) * r / outLength;
        path += ' L ' + number(sx) + ' ' + number(sy) + ' Q ' + number(bx) + ' ' + number(by) + ' ' + number(ex) + ' ' + number(ey);
    }
    const last = points[points.length - 1];
    return path + ' L ' + number(last[0]) + ' ' + number(last[1]);
}

/** @param {object} section 布局段。 @returns {string[]} 路径点。 */
function sectionPoints(section) {
    const points = [[section.startPoint.x, section.startPoint.y]];
    for (const bend of section.bendPoints || []) {
        points.push([bend.x, bend.y]);
    }
    points.push([section.endPoint.x, section.endPoint.y]);
    return points;
}

/** @param {number} width 位宽。 @param {object} theme 风格。 @returns {{stroke:string,width:number}} 边样式。 */
function edgeStyle(width, theme) {
    return { stroke: theme.wire, width: width > 1 ? theme.busWidth : theme.wireWidth };
}

/** @param {object} edge 布局连边。 @returns {string} 端点标记属性：双向边双箭头，正向边仅终点箭头。 */
function markerAttributes(edge) {
    if (edge.interface.interfaceLevel || edge.interface.direction==='connection') return '';
    return ' marker-end="url(#arrow)"' + (edge.bidirectional ? ' marker-start="url(#arrow)"' : '');
}

/** @param {string} label 图例标签。 @returns {number} 单项占宽（图形 26 + 文字偏移 33 + 标签 + 间距 32）。 */
function legendItemSpan(label) {
    return 26 + 33 + textWidth(label, 11) + 32;
}

/**
 * 图例项与说明文字按画布宽度排布：放不下时换行（行高 18），全部定位先于渲染完成以保证确定性。
 * @param {[string,string][]} items [标签, 渲染类别] 列表。 @param {string|null} note 尾注；null 表示无。
 * @param {number} width 画布宽度。 @returns {{placements:{label:string,kind:string,x:number,y:number}[], rows:number}}
 */
function layoutLegend(items, note, width) {
    const placements = [];
    let row = 0, x = PADDING;
    const place = (label, kind, span) => {
        if (x > PADDING && x + span - 32 > width - PADDING) {
            row += 1;
            x = PADDING;
        }
        placements.push({ label, kind, x, y: row });
        x += span;
    };
    for (const [label, kind] of items) {
        place(label, kind, legendItemSpan(label));
    }
    if (note) {
        place(note, 'note', textWidth(note, 10) + 32);
    }
    return { placements, rows: row + 1 };
}

/** @param {object[]} points 折线点。 @returns {{x:number,y:number,angle:number}|null} 标签锚点。 */
function labelAnchor(points) {
    let best = null;
    for (let index = 1; index < points.length; index++) {
        const [x1, y1] = points[index - 1], [x2, y2] = points[index];
        const length = Math.abs(x2 - x1) + Math.abs(y2 - y1);
        if (!best || length > best.length) {
            best = { length, x: (x1 + x2) / 2, y: (y1 + y2) / 2, angle: y1 === y2 ? 0 : 90 };
        }
    }
    return best && best.length > 24 ? best : null;
}

/**
 * 渲染架构 SVG（纯 Node 字符串）。
 * @param {object} arch design arch 数据。 @param {object} layoutResult layoutArchitecture 结果。
 * @param {{title?:string, style?:string}} [options] style 默认 document；presentation（ui 别名）保持深色展示主题。
 * @returns {{svg:string,sha256:string,bytes:number,width:number,height:number,evidence:object,stats:object}} 图像与证据。
 */
function renderArchitectureSvg(arch, layoutResult, { title, style } = {}) {
    const styleName = normalizeStyle(style), theme = THEMES[styleName];
    const { layout, projection } = layoutResult;
    const width = Math.ceil(layout.width + PADDING * 2);
    // 图例按画布宽度先布局再渲染：窄图换行、高度按行数扩展，避免固定间距把图例推出 viewBox 被裁剪。
    const legendPlacements = layoutLegend(projection.stats.bundles ? LEGEND_ITEMS.concat([['virtual bundle', 'bundle']]) : LEGEND_ITEMS,
        projection.stats.bundles ? '虚拟接口端口为前缀折叠展示，未改变 RTL 端口事实；inout 仅为架构示意' : null, width);
    const height = Math.ceil(HEADER + layout.height + FOOTER + (legendPlacements.rows - 1) * 18);
    const heading = title || (((arch.top && arch.top.name) ? arch.top.name : 'architecture') + ' 架构图');
    const revision = arch.contextRevision ? String(arch.contextRevision).slice(0, 12) : 'unknown';
    const subtitle = 'top ' + (arch.top ? arch.top.name : '?') + ' · context ' + revision + ' · nodes ' + projection.stats.nodes
        + ' · interfaces ' + projection.stats.interfaces + (projection.stats.bundles ? ' · virtual bundles ' + projection.stats.bundles : '') + ' · source-level';
    const parts = [];
    const evidence = {
        designId: arch.designId || (arch.archSha256 ? 'design:' + String(arch.archSha256).slice(0, 16) : null),
        modelSha256: arch.modelSha256 || arch.archSha256 || null,
        archSha256: arch.archSha256 || null, contextRevision: arch.contextRevision || null,
        top: arch.top ? { name: arch.top.name, moduleId: arch.top.moduleId } : null,
        sourceFiles: Array.isArray(arch.sourceFiles) ? arch.sourceFiles.map(file => ({ path: file.path, sha256: file.sha256 })) : [],
        layout: { engine: 'elk', engineVersion: 'bundled',
            ...(projection.stats.boundaryLayout ? { boundaryLayout: projection.stats.boundaryLayout } : {}) },
        export: { format: 'svg', style: styleName, width, height, title: heading,
            nodeCount: projection.stats.nodes, portCount: projection.stats.ports, edgeCount: projection.stats.edges,
            interfaceCount: projection.stats.interfaces, junctionCount: projection.stats.junctions,
            bundled: projection.stats.bundled, bundleCount: projection.stats.bundles, boundaryTableCount: projection.stats.boundaryTables, detail:projection.stats.detail }
    };
    parts.push('<metadata id="svtools-evidence">' + escape(JSON.stringify(evidence)) + '</metadata>');
    parts.push('<defs>');
    parts.push('<marker id="arrow" viewBox="0 0 8 8" refX="8" refY="4" markerUnits="userSpaceOnUse" markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
        + '<path d="M 0 0.6 L 7.4 4 L 0 7.4 z" fill="' + theme.wire + '"/></marker>');
    if (theme.gridBackground) {
        parts.push('<pattern id="arch-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" fill="' + theme.grid + '"/></pattern>');
    }
    parts.push('</defs>');
    if (theme.gridBackground) {
        parts.push('<rect width="100%" height="100%" fill="url(#arch-grid)"/>');
    }
    parts.push('<text x="' + PADDING + '" y="28" fill="' + theme.fg + '" font-family="' + FONT_UI + '" font-size="17" font-weight="600">'
        + escape(shorten(heading, width - PADDING * 2, 17)) + '</text>');
    parts.push('<text x="' + PADDING + '" y="48" fill="' + theme.muted + '" font-family="' + FONT_UI + '" font-size="12"><title>' + escape(subtitle)
        + '</title>' + escape(shorten(subtitle, width - PADDING * 2, 12)) + '</text>');
    parts.push('<line x1="' + PADDING + '" y1="' + (HEADER - 10) + '" x2="' + (width - PADDING) + '" y2="' + (HEADER - 10)
        + '" stroke="' + theme.border + '" stroke-width="0.5" opacity="0.3"/>');
    parts.push('<g transform="translate(' + PADDING + ' ' + HEADER + ')">');
    for (const edge of layout.edges) {
        const item = edge.interface;
        const points = edge.sections.flatMap(section => sectionPoints(section));
        if (!points.length) {
            continue;
        }
        const d = edge.sections.map(section => roundedPolyline(sectionPoints(section))).filter(Boolean).join(' ');
        const styleNameForEdge = edgeStyle(item.bits, theme);
        parts.push('<g data-interface-id="' + escape(item.id) + '" data-kind="interface">');
        parts.push('<title>' + escape(item.label + ' (' + item.bits + ' bits) · ' + item.from.kind + ':' + item.from.name + ' → '
            + item.to.kind + ':' + item.to.name + ' · signals: ' + item.signals.map(signal => signal.name + '[' + signal.width + ']').join(', ')) + '</title>');
        parts.push('<path d="' + d + '" fill="none" stroke="' + styleNameForEdge.stroke + '" stroke-width="' + styleNameForEdge.width
            + '" stroke-linejoin="round"' + markerAttributes(edge) + '/>');
        const placed = edge.labels?.[0];
        const anchor = placed ? { x: placed.x + placed.width / 2, y: placed.y + placed.height / 2 + 9, angle: 0 }
            : edge.sections.map(section => labelAnchor(sectionPoints(section))).filter(Boolean)[0];
        if (anchor && !edge.junction) {
            const label = item.label + ' (' + item.bits + ' bits)';
            const transform = anchor.angle ? ' transform="rotate(-90 ' + number(anchor.x) + ' ' + number(anchor.y - 6) + ')"' : '';
            parts.push('<text x="' + number(anchor.x) + '" y="' + number(anchor.y - 6) + '"' + transform + ' fill="' + theme.fg
                + '" font-family="' + theme.mono + '" font-size="10" text-anchor="middle" paint-order="stroke" stroke="' + theme.background
                + '" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' + escape(label) + '</text>');
        }
        parts.push('</g>');
    }
    for (const node of layout.nodes) {
        if (node.kind === 'boundary') {
            drawBoundary(node, parts, theme);
        } else if (node.kind === 'junction') {
            drawJunction(node, parts, theme);
        } else {
            drawInstance(node, parts, theme);
        }
    }
    parts.push('</g>');
    // 图例渲染：坐标来自 layoutLegend（行号 × 18 偏移），窄图自动换行不再裁剪。
    const legendY0 = HEADER + layout.height + 26;
    parts.push('<line x1="' + PADDING + '" y1="' + (legendY0 - 12) + '" x2="' + (width - PADDING) + '" y2="' + (legendY0 - 12)
        + '" stroke="' + theme.border + '" stroke-width="0.5" opacity="0.3"/>');
    const legendColors = { dash: theme.blackbox, solid: theme.collapsed, bus: theme.wire, boundary: theme.input, bundle: theme.wire, note: theme.muted };
    for (const item of legendPlacements.placements) {
        const legendX = item.x, legendY = legendY0 + item.y * LEGEND_ROW_HEIGHT, color = legendColors[item.kind];
        if (item.kind === 'note') {
            parts.push('<text x="' + legendX + '" y="' + (legendY + 4) + '" fill="' + theme.muted + '" font-family="' + FONT_UI
                + '" font-size="10">' + escape(item.label) + '</text>');
            continue;
        }
        if (item.kind === 'bus') {
            parts.push('<line x1="' + legendX + '" y1="' + legendY + '" x2="' + (legendX + 26) + '" y2="' + legendY + '" stroke="' + color + '" stroke-width="' + theme.busWidth + '"/>');
            parts.push('<line x1="' + (legendX + 13) + '" y1="' + (legendY - 4) + '" x2="' + (legendX + 17) + '" y2="' + (legendY + 4) + '" stroke="' + color + '" stroke-width="1.5"/>');
        } else if (item.kind === 'boundary') {
            parts.push('<rect x="' + legendX + '" y="' + (legendY - 7) + '" width="26" height="14" rx="2" fill="' + theme.panel + '" stroke="' + theme.border + '"/>');
            parts.push('<rect x="' + (legendX + 1) + '" y="' + (legendY - 6) + '" width="2.5" height="12" rx="1.2" fill="' + color + '"/>');
        } else if (item.kind === 'bundle') {
            parts.push('<polygon points="' + (legendX + 13) + ',' + (legendY - 8) + ' ' + (legendX + 22) + ',' + legendY + ' '
                + (legendX + 13) + ',' + (legendY + 8) + ' ' + (legendX + 4) + ',' + legendY + '" fill="' + theme.cellBg + '" stroke="' + color
                + '" stroke-width="' + theme.strokeWidth + '"/>');
        } else {
            parts.push('<rect x="' + legendX + '" y="' + (legendY - 7) + '" width="26" height="14" rx="2" fill="' + theme.cellBg + '" stroke="' + color
                + '" stroke-width="' + theme.strokeWidth + '"' + (item.kind === 'dash' ? ' stroke-dasharray="' + theme.blackboxDash + '"' : '') + '/>');
        }
        parts.push('<text x="' + (legendX + 33) + '" y="' + (legendY + 4) + '" fill="' + theme.muted + '" font-family="' + FONT_UI
            + '" font-size="11">' + escape(item.label) + '</text>');
    }
    const body = parts.join('');
    const svg = svgDocument({ width, height, title: heading, detail: subtitle, body, background: theme.background });
    return { svg, sha256: sha256(svg), bytes: Buffer.byteLength(svg, 'utf8'), width, height, evidence,
        stats: { ...projection.stats } };
}

/** @param {object} arch @param {string} [style] @returns {string} 默认输出文件名（含风格后缀）。 */
function defaultFileName(arch, style = 'document', options = {}) {
    const suffix = normalizeStyle(style);
    const parameters = [options.bundle === true, Object.entries(options.bundleNames || {}).sort(), options.title || null, options.detail || 'interfaces'];
    if (options.boundaryLayout === 'ends') parameters.push(options.boundaryLayout);
    const identity = sha256(JSON.stringify(parameters)).slice(0, 8);
    return safeName((arch.top && arch.top.name) || 'architecture') + '-' + String(arch.archSha256 || '0').slice(0, 8) + '-' + identity + '-' + suffix + '.svg';
}

module.exports = { buildRenderProjection, layoutArchitecture, renderArchitectureSvg, defaultFileName, normalizeStyle,
    DEFAULT_RENDER_BUDGET, netLabel, STYLES };
