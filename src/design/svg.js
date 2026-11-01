'use strict';

// M3 交付3：纯 Node 字符串 SVG 架构图。复用 ELK 布局与电路视图的符号几何/配色，
// 不依赖 DOM；同一输入两次渲染的节点坐标与 SVG 必须完全一致。
const { createHash } = require('node:crypto');
const { prepareNode } = require('../circuit/symbol-library');
const { layoutProjection } = require('../circuit/layout');
const { elkNode } = require('../circuit/projection');
const { svgDocument } = require('../graphics/image-export');
const { escape } = require('../graphics/svg-canvas');
const { fail } = require('../agent/protocol');

const DEFAULT_RENDER_BUDGET = Object.freeze({ nodes: 2000, edges: 6000, ports: 16384 });
const LAYOUT_OPTIONS = Object.freeze({
    'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
    'elk.spacing.nodeNode': '36', 'elk.layered.spacing.nodeNodeBetweenLayers': '72',
    'elk.spacing.edgeNode': '18', 'elk.spacing.edgeEdge': '14',
    'elk.layered.spacing.edgeNodeBetweenLayers': '18', 'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
    'elk.padding': '[top=32,left=32,bottom=32,right=32]'
});
const PALETTE = Object.freeze({
    background: '#111923', panel: '#17222e', cellBg: '#1f252c', border: '#2c3a49', fg: '#d7e1ec', muted: '#9aaabc',
    wire: '#aebbc6', accent: '#63b8ff', blackbox: '#d3b57e', collapsed: '#7ccabf', input: '#eebc79', output: '#70d3c3',
    error: '#f29595', grid: '#23313f'
});
const FONT_MONO = "Consolas, 'SFMono-Regular', 'Courier New', monospace";
const FONT_UI = "-apple-system, 'Segoe UI', Roboto, sans-serif";
const PADDING = 40, HEADER = 64, FOOTER = 52, PORT_PITCH = 22, HEADER_BAND = 58, GRID = 8;

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
    return { inputs: ports.filter(port => port.direction !== 'output'), outputs: ports.filter(port => port.direction === 'output') };
}

/** @param {object} node 架构图实例节点。 @returns {object} 已分配尺寸/锚点的布局节点。 */
function prepareInstanceNode(node) {
    const base = prepareNode({
        id: node.id, kind: 'instance', label: node.label, detail: node.module,
        moduleId: node.moduleId || 'unresolved:' + node.name,
        implementation: node.implementation, status: node.status,
        ports: node.ports.map(port => ({ id: node.id + '/' + port.name, label: port.name, direction: port.direction,
            width: port.width, bits: new Array(Math.max(1, Math.min(port.width, 64))).fill('n:0') }))
    });
    const { inputs, outputs } = splitPorts(base.ports);
    const badge = node.status === 'unresolved' ? 'unresolved' : node.implementation;
    const badgeWidth = textWidth(badge, 9) + 12;
    const titleWidth = Math.max(textWidth(base.label, 13), textWidth(base.detail || '', 11)) + badgeWidth + 36;
    const portWidth = Math.max(0, ...base.ports.map(port => textWidth(port.label, 11) + (port.width > 1 ? textWidth('[' + port.width + ']', 11) : 0)));
    const width = Math.ceil(Math.max(base.width || 0, titleWidth, portWidth * 2 + 96) / GRID) * GRID;
    const height = Math.ceil((HEADER_BAND + PORT_PITCH * Math.max(inputs.length, outputs.length, 1) + 16) / GRID) * GRID;
    for (const [list, side] of [[inputs, 'WEST'], [outputs, 'EAST']]) {
        list.forEach((port, index) => {
            port.side = side;
            port.x = side === 'WEST' ? 0 : width;
            port.y = HEADER_BAND + index * PORT_PITCH;
            port.width = 0;
            port.height = 0;
        });
    }
    return { ...base, width, height, badge, badgeWidth, paintBounds: { left: -10, top: -10, right: width + 10, bottom: height + 10 },
        implementation: node.implementation, status: node.status };
}

/** @param {object} node 架构图边界节点。 @returns {object} 边界条节点。 */
function prepareBoundaryNode(node) {
    const label = node.name + (node.ports[0] && node.ports[0].width > 1 ? ' [' + node.ports[0].width + ']' : '');
    const width = Math.ceil(Math.max(92, textWidth(label, 12) + 44) / GRID) * GRID;
    const height = 36;
    const side = node.direction === 'output' ? 'WEST' : 'EAST';
    const port = { id: node.id + '/' + node.ports[0].name, label: node.name, direction: node.ports[0].direction,
        width: node.ports[0].width, bits: [], side, x: side === 'WEST' ? 0 : width, y: height / 2, width: 0, height: 0 };
    return { id: node.id, kind: 'boundary', label, name: node.name, direction: node.direction, boundary: true,
        width, height, paintBounds: { left: -10, top: -10, right: width + 10, bottom: height + 10 }, ports: [port] };
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

/** @param {object} node @param {string} hint 'input'|'output'|null @returns {object|null} 代表端口。 */
function representativePort(node, hint) {
    if (!node || !node.ports.length) {
        return null;
    }
    if (node.kind === 'boundary') {
        return node.ports[0];
    }
    const match = node.ports.find(port => port.direction === hint);
    return match || node.ports[0];
}

/** @param {string} name 端点名称（多端用 + 分隔）。 @param {'boundary'|'instance'} kind @returns {string[]} 节点 id。 */
function endpointNodes(name, kind) {
    return String(name).split('+').filter(Boolean).map(value => kind + ':' + value);
}

/**
 * 构造 ELK 投影：节点为实例/边界，接口束为边；多端接口引入总线汇合节点。
 * @param {object} arch design arch 数据。 @param {{budget?:object}} [options]
 * @returns {object} 可交给 layoutProjection 的投影。
 */
function buildRenderProjection(arch, { budget = {} } = {}) {
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
    const portTotal = graphNodes.reduce((total, node) => total + (node.ports ? node.ports.length : 0), 0);
    if (graphNodes.length > limits.nodes) {
        fail('DESIGN_LIMIT', '架构图节点数量超出渲染预算', { kind: 'nodes', used: graphNodes.length, limit: limits.nodes });
    }
    if (portTotal > limits.ports) {
        fail('DESIGN_LIMIT', '架构图端口数量超出渲染预算', { kind: 'ports', used: portTotal, limit: limits.ports });
    }
    const interfaces = interfacesOf(arch);
    if (interfaces.length > limits.edges) {
        fail('DESIGN_LIMIT', '架构图接口数量超出渲染预算', { kind: 'edges', used: interfaces.length, limit: limits.edges });
    }
    const nodes = graphNodes.map(node => node.kind === 'boundary' ? prepareBoundaryNode(node) : prepareInstanceNode(node));
    const byId = new Map(nodes.map(node => [node.id, node]));
    const edges = [];
    for (const item of interfaces) {
        const sourceIds = endpointNodes(item.from.name, item.from.kind);
        const targetIds = endpointNodes(item.to.name, item.to.kind);
        const sources = sourceIds.map(id => byId.get(id)).filter(Boolean);
        const targets = targetIds.map(id => byId.get(id)).filter(Boolean);
        if (!sources.length || !targets.length) {
            continue;
        }
        const bidirectional = item.direction === 'bidirectional';
        if (sources.length === 1 && targets.length === 1) {
            const sourcePort = representativePort(sources[0], 'output');
            const targetPort = representativePort(targets[0], 'input');
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
        const width = Math.ceil(Math.max(120, textWidth(label, 11) + 26) / GRID) * GRID;
        const height = Math.ceil((Math.max(junctionInputs.length, junctionOutputs.length) * 10 + 22) / GRID) * GRID;
        const junction = { id: junctionId, kind: 'junction', label, width: width + 20, height, x: 0, y: 0,
            ports: [...junctionInputs, ...junctionOutputs], implementation: null, status: 'resolved',
            paintBounds: { left: -6, top: -6, right: width + 26, bottom: height + 6 } };
        for (const port of junctionInputs) {
            port.x = 0;
        }
        for (const port of junctionOutputs) {
            port.x = width + 20;
        }
        nodes.push(junction);
        byId.set(junctionId, junction);
        sources.forEach((source, index) => {
            const sourcePort = representativePort(source, 'output');
            if (sourcePort) {
                edges.push({ id: item.id + ':in:' + index, sources: [sourcePort.id], targets: [junctionInputs[index].id],
                    interface: item, bidirectional, junction: true });
            }
        });
        targets.forEach((target, index) => {
            const targetPort = representativePort(target, 'input');
            if (targetPort) {
                edges.push({ id: item.id + ':out:' + index, sources: [junctionOutputs[index].id],
                    targets: [targetPort.id], interface: item, bidirectional, junction: true });
            }
        });
    }
    if (edges.length > limits.edges) {
        fail('DESIGN_LIMIT', '架构图渲染连边数量超出预算', { kind: 'edges', used: edges.length, limit: limits.edges });
    }
    const input = {
        id: 'graph:arch', layoutOptions: LAYOUT_OPTIONS,
        children: nodes.map(elkNode),
        edges: edges.map(edge => ({ id: edge.id, sources: edge.sources, targets: edge.targets }))
    };
    return { id: 'graph:arch', moduleId: arch.top ? arch.top.moduleId : null, name: arch.top ? arch.top.name : 'architecture',
        input, nodes, edges, signals: [], parameters: null,
        stats: { nodes: nodes.length, edges: edges.length, ports: portTotal, interfaces: interfaces.length } };
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

/** @param {object} node 布局节点。 @param {object[]} parts SVG片段。 @returns {void} 追加实例盒。 */
function drawInstance(node, parts) {
    const accent = node.status === 'unresolved' ? PALETTE.error : node.implementation === 'blackbox' ? PALETTE.blackbox : PALETTE.collapsed;
    const dash = node.status === 'unresolved' || node.implementation === 'blackbox' ? ' stroke-dasharray="4 3"' : '';
    parts.push('<g data-model-id="' + escape(node.id) + '" data-kind="instance" data-implementation="' + escape(node.implementation || 'collapsed') + '">');
    parts.push('<rect x="' + number(node.x) + '" y="' + number(node.y) + '" width="' + number(node.width) + '" height="' + number(node.height)
        + '" rx="3" fill="' + PALETTE.cellBg + '" stroke="' + accent + '" stroke-width="1.5"' + dash + '/>');
    parts.push('<text x="' + number(node.x + 12) + '" y="' + number(node.y + 21) + '" fill="' + PALETTE.fg + '" font-family="' + FONT_MONO + '" font-size="13" font-weight="600">'
        + escape(shorten(node.label, node.width - node.badgeWidth - 24, 13)) + '</text>');
    parts.push('<text x="' + number(node.x + 12) + '" y="' + number(node.y + 38) + '" fill="' + PALETTE.muted + '" font-family="' + FONT_MONO + '" font-size="11">'
        + escape(shorten(node.detail || '', node.width - node.badgeWidth - 24, 11)) + '</text>');
    const badge = node.badge, badgeWidth = node.badgeWidth;
    parts.push('<rect x="' + number(node.x + node.width - badgeWidth - 8) + '" y="' + number(node.y + 9) + '" width="' + number(badgeWidth)
        + '" height="16" rx="8" fill="' + PALETTE.panel + '" stroke="' + accent + '" stroke-width="1"/>');
    parts.push('<text x="' + number(node.x + node.width - badgeWidth / 2 - 8) + '" y="' + number(node.y + 20.5) + '" fill="' + accent
        + '" font-family="' + FONT_UI + '" font-size="9" text-anchor="middle">' + escape(badge) + '</text>');
    for (const port of node.ports) {
        const side = port.x <= node.width / 2 ? 'WEST' : 'EAST';
        const px = node.x + port.x, py = node.y + port.y;
        const label = port.label + (port.width > 1 ? '[' + port.width + ']' : '');
        parts.push('<g data-model-id="' + escape(port.id) + '" data-kind="port" data-direction="' + escape(port.direction) + '">');
        parts.push('<title>' + escape(port.label + ' · ' + port.direction + ' · ' + port.width + ' bit' + (port.width === 1 ? '' : 's')) + '</title>');
        parts.push('<line x1="' + number(side === 'WEST' ? px - 8 : px) + '" y1="' + number(py) + '" x2="' + number(side === 'WEST' ? px : px + 8)
            + '" y2="' + number(py) + '" stroke="' + PALETTE.wire + '" stroke-width="1.25"/>');
        parts.push('<circle cx="' + number(px) + '" cy="' + number(py) + '" r="2" fill="' + PALETTE.cellBg + '" stroke="' + PALETTE.wire + '" stroke-width="1.25"/>');
        if (side === 'WEST') {
            parts.push('<text x="' + number(node.x + 10) + '" y="' + number(py + 4) + '" fill="' + PALETTE.muted + '" font-family="' + FONT_MONO
                + '" font-size="11" text-anchor="start">' + escape(shorten(label, node.width / 2 - 18, 11)) + '</text>');
        } else {
            parts.push('<text x="' + number(node.x + node.width - 10) + '" y="' + number(py + 4) + '" fill="' + PALETTE.muted + '" font-family="' + FONT_MONO
                + '" font-size="11" text-anchor="end">' + escape(shorten(label, node.width / 2 - 18, 11)) + '</text>');
        }
        parts.push('</g>');
    }
    parts.push('</g>');
}

/** @param {object} node 布局节点。 @param {object[]} parts SVG片段。 @returns {void} 追加边界条。 */
function drawBoundary(node, parts) {
    const accent = node.direction === 'output' ? PALETTE.output : PALETTE.input;
    parts.push('<g data-model-id="' + escape(node.id) + '" data-kind="boundary" data-direction="' + escape(node.direction) + '">');
    parts.push('<rect x="' + number(node.x) + '" y="' + number(node.y) + '" width="' + number(node.width) + '" height="' + number(node.height)
        + '" rx="3" fill="' + PALETTE.panel + '" stroke="' + PALETTE.border + '" stroke-width="1"/>');
    parts.push('<rect x="' + number(node.direction === 'output' ? node.x + node.width - 4 : node.x) + '" y="' + number(node.y) + '" width="4" height="'
        + number(node.height) + '" fill="' + accent + '"/>');
    parts.push('<text x="' + number(node.x + node.width / 2) + '" y="' + number(node.y + node.height / 2 + 4) + '" fill="' + PALETTE.fg
        + '" font-family="' + FONT_MONO + '" font-size="12" text-anchor="middle">' + escape(node.label) + '</text>');
    for (const port of node.ports) {
        const px = node.x + port.x, py = node.y + port.y;
        parts.push('<g data-model-id="' + escape(port.id) + '" data-kind="port" data-direction="' + escape(port.direction) + '">');
        parts.push('<title>' + escape(port.label + ' · ' + node.direction + ' · ' + port.width + ' bit' + (port.width === 1 ? '' : 's')) + '</title>');
        parts.push('<line x1="' + number(port.side === 'WEST' ? px - 10 : px) + '" y1="' + number(py) + '" x2="' + number(port.side === 'WEST' ? px : px + 10)
            + '" y2="' + number(py) + '" stroke="' + accent + '" stroke-width="1.5"/>');
        parts.push('</g>');
    }
    parts.push('</g>');
}

/** @param {object} node 布局节点。 @param {object[]} parts SVG片段。 @returns {void} 追加接口汇合节点。 */
function drawJunction(node, parts) {
    parts.push('<g data-model-id="' + escape(node.id) + '" data-kind="junction">');
    parts.push('<rect x="' + number(node.x) + '" y="' + number(node.y) + '" width="' + number(node.width) + '" height="' + number(node.height)
        + '" rx="11" fill="' + PALETTE.panel + '" stroke="' + PALETTE.wire + '" stroke-width="1.5"/>');
    parts.push('<text x="' + number(node.x + node.width / 2) + '" y="' + number(node.y + node.height / 2 + 4) + '" fill="' + PALETTE.fg
        + '" font-family="' + FONT_MONO + '" font-size="11" text-anchor="middle">' + escape(shorten(node.label, node.width - 18, 11)) + '</text>');
    for (const port of node.ports) {
        parts.push('<g data-model-id="' + escape(port.id) + '" data-kind="port">');
        parts.push('<line x1="' + number(node.x + (port.side === 'WEST' ? 0 : node.width)) + '" y1="' + number(node.y + port.y)
            + '" x2="' + number(node.x + (port.side === 'WEST' ? -4 : node.width + 4)) + '" y2="' + number(node.y + port.y)
            + '" stroke="' + PALETTE.wire + '" stroke-width="1.5"/>');
        parts.push('</g>');
    }
    parts.push('</g>');
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

/** @param {number} width 位宽。 @returns {{stroke:string,width:number}} 边样式。 */
function edgeStyle(width) {
    return { stroke: PALETTE.wire, width: width > 1 ? 2.4 : 1.25 };
}

/** @param {object} edge 布局连边。 @returns {string} 端点标记属性：双向边双箭头，正向边仅终点箭头。 */
function markerAttributes(edge) {
    return ' marker-end="url(#arrow)"' + (edge.bidirectional ? ' marker-start="url(#arrow)"' : '');
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
 * @param {{title?:string}} [options]
 * @returns {{svg:string,sha256:string,bytes:number,width:number,height:number,evidence:object,stats:object}} 图像与证据。
 */
function renderArchitectureSvg(arch, layoutResult, { title } = {}) {
    const { layout, projection } = layoutResult;
    const width = Math.ceil(layout.width + PADDING * 2);
    const height = Math.ceil(HEADER + layout.height + FOOTER);
    const heading = title || (((arch.top && arch.top.name) ? arch.top.name : 'architecture') + ' 架构图');
    const revision = arch.contextRevision ? String(arch.contextRevision).slice(0, 12) : 'unknown';
    const subtitle = 'top ' + (arch.top ? arch.top.name : '?') + ' · context ' + revision + ' · nodes ' + projection.stats.nodes
        + ' · interfaces ' + projection.stats.interfaces + ' · source-level';
    const parts = [];
    const evidence = {
        archSha256: arch.archSha256 || null, contextRevision: arch.contextRevision || null,
        top: arch.top ? { name: arch.top.name, moduleId: arch.top.moduleId } : null,
        layout: { engine: 'elk', engineVersion: 'bundled' },
        export: { format: 'svg', style: 'ui', width, height, title: heading,
            nodeCount: projection.stats.nodes, portCount: projection.stats.ports, edgeCount: projection.stats.edges, interfaceCount: projection.stats.interfaces }
    };
    parts.push('<metadata id="svtools-evidence">' + escape(JSON.stringify(evidence)) + '</metadata>');
    parts.push('<defs>');
    parts.push('<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
        + '<path d="M 0 0 L 8 4 L 0 8 z" fill="' + PALETTE.wire + '"/></marker>');
    parts.push('<pattern id="arch-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" fill="' + PALETTE.grid + '"/></pattern>');
    parts.push('</defs>');
    parts.push('<rect width="100%" height="100%" fill="url(#arch-grid)"/>');
    parts.push('<text x="' + PADDING + '" y="28" fill="' + PALETTE.fg + '" font-family="' + FONT_UI + '" font-size="17" font-weight="600">'
        + escape(shorten(heading, width - PADDING * 2, 17)) + '</text>');
    parts.push('<text x="' + PADDING + '" y="48" fill="' + PALETTE.muted + '" font-family="' + FONT_UI + '" font-size="12">' + escape(subtitle) + '</text>');
    parts.push('<g transform="translate(' + PADDING + ' ' + HEADER + ')">');
    for (const edge of layout.edges) {
        const item = edge.interface;
        const points = edge.sections.flatMap(section => sectionPoints(section));
        if (!points.length) {
            continue;
        }
        let d = 'M ' + number(points[0][0]) + ' ' + number(points[0][1]);
        for (const point of points.slice(1)) {
            d += ' L ' + number(point[0]) + ' ' + number(point[1]);
        }
        const style = edgeStyle(item.bits);
        parts.push('<g data-interface-id="' + escape(item.id) + '" data-kind="interface">');
        parts.push('<title>' + escape(item.label + ' (' + item.bits + ' bits) · ' + item.from.kind + ':' + item.from.name + ' → '
            + item.to.kind + ':' + item.to.name + ' · signals: ' + item.signals.map(signal => signal.name + '[' + signal.width + ']').join(', ')) + '</title>');
        parts.push('<path d="' + d + '" fill="none" stroke="' + style.stroke + '" stroke-width="' + style.width
            + '" stroke-linejoin="round"' + markerAttributes(edge) + '/>');
        const anchor = labelAnchor(points);
        if (anchor && !edge.junction) {
            const label = item.label + ' (' + item.bits + ' bits)';
            const transform = anchor.angle ? ' transform="rotate(-90 ' + number(anchor.x) + ' ' + number(anchor.y - 6) + ')"' : '';
            parts.push('<text x="' + number(anchor.x) + '" y="' + number(anchor.y - 6) + '"' + transform + ' fill="' + PALETTE.wire
                + '" font-family="' + FONT_MONO + '" font-size="10" text-anchor="middle" paint-order="stroke" stroke="' + PALETTE.background
                + '" stroke-width="3.5" stroke-linejoin="round">' + escape(label) + '</text>');
        }
        parts.push('</g>');
    }
    for (const node of layout.nodes) {
        if (node.kind === 'boundary') {
            drawBoundary(node, parts);
        } else if (node.kind === 'junction') {
            drawJunction(node, parts);
        } else {
            drawInstance(node, parts);
        }
    }
    parts.push('</g>');
    const legendY = HEADER + layout.height + 26;
    const legends = [
        ['blackbox', PALETTE.blackbox, 'dash'], ['collapsed', PALETTE.collapsed, 'solid'],
        ['bus', PALETTE.wire, 'bus'], ['boundary', PALETTE.input, 'boundary']
    ];
    let legendX = PADDING;
    for (const [label, color, kind] of legends) {
        if (kind === 'bus') {
            parts.push('<line x1="' + legendX + '" y1="' + legendY + '" x2="' + (legendX + 26) + '" y2="' + legendY + '" stroke="' + color + '" stroke-width="2.4"/>');
            parts.push('<line x1="' + (legendX + 13) + '" y1="' + (legendY - 4) + '" x2="' + (legendX + 17) + '" y2="' + (legendY + 4) + '" stroke="' + color + '" stroke-width="1.5"/>');
        } else if (kind === 'boundary') {
            parts.push('<rect x="' + legendX + '" y="' + (legendY - 7) + '" width="26" height="14" rx="2" fill="' + PALETTE.panel + '" stroke="' + PALETTE.border + '"/>');
            parts.push('<rect x="' + legendX + '" y="' + (legendY - 7) + '" width="3" height="14" fill="' + color + '"/>');
        } else {
            parts.push('<rect x="' + legendX + '" y="' + (legendY - 7) + '" width="26" height="14" rx="2" fill="' + PALETTE.cellBg + '" stroke="' + color
                + '" stroke-width="1.5"' + (kind === 'dash' ? ' stroke-dasharray="4 3"' : '') + '/>');
        }
        parts.push('<text x="' + (legendX + 33) + '" y="' + (legendY + 4) + '" fill="' + PALETTE.muted + '" font-family="' + FONT_UI
            + '" font-size="11">' + label + '</text>');
        legendX += 108;
    }
    const body = parts.join('');
    const svg = svgDocument({ width, height, title: heading, detail: subtitle, body, background: PALETTE.background });
    return { svg, sha256: sha256(svg), bytes: Buffer.byteLength(svg, 'utf8'), width, height, evidence,
        stats: { ...projection.stats } };
}

/** @param {string} title @param {object} arch @returns {string} 默认输出文件名。 */
function defaultFileName(arch) {
    return safeName((arch.top && arch.top.name) || 'architecture') + '-' + String(arch.archSha256 || '0').slice(0, 8) + '.svg';
}

module.exports = { buildRenderProjection, layoutArchitecture, renderArchitectureSvg, defaultFileName, DEFAULT_RENDER_BUDGET, netLabel };
