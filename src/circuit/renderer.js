(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./graph-index'), require('./viewport'), require('./symbol-library'), require('./route-geometry'));
    else root.CircuitRenderer = factory(root.CircuitGraphIndex, root.CircuitViewport, root.CircuitSymbols, root.CircuitRoutes);
})(typeof globalThis === 'object' ? globalThis : this, function (graphIndex, viewport, symbols, routes) {
    'use strict';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const POLARITY_RADIUS = 4;
    const PORT_KINDS = new Set(['input', 'output', 'inout']);
    const KINDS = new Set(['input', 'output', 'inout', 'constant', 'register', 'mux', 'arithmetic', 'logic', 'memory', 'instance', 'unknown', 'junction', 'bus']);
    const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

    function element(document, name, attributes = {}, text) {
        const node = document.createElementNS(SVG_NS, name);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        if (text !== undefined) node.textContent = String(text);
        return node;
    }

    function shorten(text, width) {
        const value = String(text ?? '');
        const count = Math.max(4, Math.floor(width / 7.3));
        return value.length > count ? value.slice(0, count - 1) + '…' : value;
    }

    /**
     * 把工具给出的正交折点转换为 SVG 路径，不推断电路方向或重新布线。
     * @param {object[]} sections 全局坐标折线段。
     * @returns {string} 仅由有限数字和 M/L 指令组成的路径。
     */
    const edgePath = routes.edgePath;

    function nodeBody(document, node, width, height) {
        const geometry = symbols.geometry(node), outline = symbols.gateOutline(node), body = geometry.body;
        if (outline) {
            const group = element(document, 'g');
            group.appendChild(element(document, 'path', { d: outline.d, class: 'cellBody gateBody' }));
            if (['xor', 'xnor'].includes(geometry.kind)) group.appendChild(element(document, 'path', {
                d: `M ${body.x - 8} ${body.y} Q ${body.x + body.width * .3 - 8} ${body.y + body.height / 2} ${body.x - 8} ${body.y + body.height}`, class: 'gateCurve' }));
            if (outline.inverted) group.appendChild(element(document, 'circle', { cx: outline.x, cy: outline.y, r: outline.radius, class: 'polarityBubble' }));
            return group;
        }
        if (node.kind === 'bus') {
            const body = element(document, 'g');
            // 总线节点没有可见盒体：命中区收窄到主干，避免点击空白区域选中总线。
            body.appendChild(element(document, 'rect', { x: width / 2 - 10, width: 20, height, class: 'busHit' }));
            body.appendChild(element(document, 'path', { d: `M ${width / 2} 10 L ${width / 2} ${height - 10}`, class: 'cellBody busSpine' }));
            return body;
        }
        const shape = symbols.bodyShape(node, width, height);
        return element(document, shape.type, { ...shape.attrs, ...(shape.type === 'rect' ? { rx: 0 } : {}), class: 'cellBody' });
    }

    /** @returns {SVGElement|SVGPathElement|SVGPolygonElement} 与主体同形的选中轮廓；矩形向外扩3px。 */
    function outlineElement(document, shape, className) {
        if (shape.type !== 'rect') return element(document, shape.type, { ...shape.attrs, class: className });
        const { x, y, width, height } = shape.attrs;
        return element(document, 'rect', { x: x - 3, y: y - 3, width: width + 6, height: height + 6, rx: 3, class: className });
    }

    function appendPin(document, group, port, node) {
        const { width, height } = node, geometry = symbols.geometry(node), isBundle = node.kind === 'bus';
        const x = finite(port.x) + finite(port.width) / 2, y = finite(port.y) + finite(port.height) / 2;
        const left = x < width / 2, inward = left ? 1 : -1;
        let boundary = left ? geometry.body.x : geometry.body.x + geometry.body.width;
        if (geometry.isGate && left && ['or', 'nor', 'xor', 'xnor'].includes(geometry.kind)) {
            const fraction = (y - geometry.body.y) / geometry.body.height;
            boundary += geometry.body.width * .6 * fraction * (1 - fraction);
        }
        const endpoint = finite(port.x) + (left ? 0 : finite(port.width));
        const declared = port.declaredDirection || port.direction || 'unknown';
        const isLow = port.polarity === 0, isClock = port.role === 'clock' && [0, 1].includes(port.polarity);
        const note = [port.label || port.id, declared, `${(port.bits || []).length} bit`, port.description].filter(Boolean).join(' · ');
        const pin = element(document, 'g', { class: `pin${(port.bits || []).length > 1 ? ' bus' : ''}`, 'data-bit-width': (port.bits || []).length, 'data-port-id': port.id, role: 'button', tabindex: '-1', 'aria-label': note });
        pin.appendChild(element(document, 'title', {}, note));
        pin.appendChild(element(document, 'circle', { cx: x, cy: y, r: 2 * POLARITY_RADIUS, class: 'pinHit' }));
        // ELK 连线终止于端口外边缘，命中中心与接线端点不能混用。
        const stem = port.side === 'SOUTH' ? `M ${x} ${y} L ${x} ${height - 24}`
            : `M ${endpoint} ${y} L ${boundary - (isLow ? 2 * POLARITY_RADIUS * inward : 0)} ${y}`;
        pin.appendChild(element(document, 'path', { d: stem, class: isLow ? 'pinStem' : 'pinDot' }));
        if (isLow) pin.appendChild(element(document, 'circle', { cx: boundary - POLARITY_RADIUS * inward, cy: y, r: POLARITY_RADIUS, class: 'polarityBubble' }));
        if (isClock) pin.appendChild(element(document, 'path', { d: `M ${boundary} ${y - 5} L ${boundary + 7 * inward} ${y} L ${boundary} ${y + 5}`, class: 'clockMark' }));
        if (isBundle) {
            pin.appendChild(element(document, 'path', { d: `M ${boundary} ${y} L ${width / 2} ${y}`, class: `busTap${port.bits.length > 1 ? ' bus' : ''}` }));
        }
        if (port.label && height >= 70 && width >= 110 && !geometry.isGate && (!isBundle || port.bitPositions)) {
            const unknownPolarity = ['clock', 'control'].includes(port.role) && ![0, 1].includes(port.polarity);
            const label = isBundle ? port.bits.length === 1 && port.bitPositions.every(positions => positions.length === 1) ? port.label : port.wireLabel || port.label
                : port.label + (unknownPolarity ? '?' : '');
            const start = port.side === 'SOUTH' ? x + 10 : isBundle ? width / 2 + (left ? -10 : 10) : boundary + (isClock ? 14 : 10) * inward;
            const anchor = port.side === 'SOUTH' ? 'start' : isBundle ? (left ? 'end' : 'start') : left ? 'start' : 'end';
            pin.appendChild(element(document, 'text', { x: start, y: port.side === 'SOUTH' ? y - 4 : y + (isBundle ? -6 : 4), 'text-anchor': anchor, class: isBundle ? 'pinLabel mappingLabel' : 'pinLabel' }, shorten(label, Math.max(24, isBundle ? width / 2 - 16 : (width - 65) / 2))));
        }
        group.appendChild(pin); return pin;
    }

    function appendNode(document, layer, node, nodes, ports, traceDirection) {
        const kind = KINDS.has(node.kind) ? node.kind : 'unknown';
        const width = Math.max(2, finite(node.width, 120)), height = Math.max(2, finite(node.height, 56));
        const bitCount = PORT_KINDS.has(kind) ? node.ports?.[0]?.bits?.length || 0 : 0;
        const group = element(document, 'g', { class: `cell kind-${kind}${bitCount > 1 ? ' busPort' : ''}`, transform: `translate(${finite(node.x)} ${finite(node.y)})`, 'data-node-id': node.id, role: 'button', tabindex: '0', 'aria-label': `${node.label || node.id}${node.moduleId ? '，模块实例，可进入' : ''}` });
        if (node.traceNew) group.classList.add('traceNew');
        if (kind === 'bus' && (traceDirection === 'drivers' || traceDirection === 'loads')) group.classList.add(traceDirection === 'drivers' ? 'isDriver' : 'isLoad');
        group.appendChild(element(document, 'title', {}, [node.label || node.id, node.toolName, node.detail, node.description].filter(Boolean).join('\n')));
        group.appendChild(nodeBody(document, node, width, height));
        const geometry = symbols.geometry(node);
        // 总线无可见盒体，选中/搜索态由主干和分支着色表达，不画矩形外框。
        if (kind !== 'bus') {
            group.appendChild(outlineElement(document, symbols.bodyShape(node, width, height), 'selectionOutline'));
            group.appendChild(element(document, 'path', { d: `M 0 8 L 0 0 L 8 0 M ${width - 8} 0 L ${width} 0 L ${width} 8 M 0 ${height - 8} L 0 ${height} L 8 ${height} M ${width - 8} ${height} L ${width} ${height} L ${width} ${height - 8}`, class: 'searchCorners' }));
        }
        if (kind === 'bus') {
            group.appendChild(element(document, 'text', { x: width / 2, y: -10, 'text-anchor': 'middle', class: 'cellLabel' }, shorten(node.label, width)));
        } else if (geometry.isGate) {
            group.appendChild(element(document, 'text', { x: width / 2, y: height - 3, 'text-anchor': 'middle', class: 'cellLabel' }, shorten(node.label, width + 20)));
        } else if (geometry.kind === 'block' || geometry.kind === 'mux') {
            group.appendChild(element(document, 'text', { x: width / 2, y: height / 2 + 12, 'text-anchor': 'middle', class: 'cellSymbol' }, symbols.functionLabel(node)));
            group.appendChild(element(document, 'text', { x: width / 2, y: 21, 'text-anchor': 'middle', class: 'cellLabel' }, shorten(node.label, width - 44)));
            if (node.modeLabel) group.appendChild(element(document, 'text', { x: width / 2, y: 38, 'text-anchor': 'middle', class: 'cellMode' }, node.modeLabel));
        } else if (width >= 35) {
            const label = kind === 'constant' && node.ports?.[0]?.bits?.length === 1 && /^c:[01xz]$/i.test(node.ports[0].originalBits?.[0] || node.ports[0].bits[0])
                ? `1'b${(node.ports[0].originalBits?.[0] || node.ports[0].bits[0]).slice(2)}` : node.label;
            group.appendChild(element(document, 'text', { x: 10, y: height / 2 + (bitCount > 1 ? -3 : 4), class: 'cellLabel' }, shorten(label, width - 20)));
            if (bitCount > 1) group.appendChild(element(document, 'text', { x: 10, y: height / 2 + 12, class: 'portWidth' }, `${bitCount} bit`));
        }
        for (const port of node.ports || []) {
            const portGroup = appendPin(document, group, port, node);
            ports.set(String(port.id), { element: portGroup, port, node });
        }
        layer.appendChild(group); nodes.set(String(node.id), { element: group, node });
    }

    function appendWire(document, layer, edge, edges, marker, junctions, direction) {
        const d = edgePath(edge.sections, junctions);
        if (!d) return;
        const bitCount = (edge.bits || []).length;
        const group = element(document, 'g', { class: `wire${bitCount > 1 ? ' bus' : ''}${direction === 'drivers' ? ' isDriver' : direction === 'loads' ? ' isLoad' : ''}`, 'data-bit-width': bitCount, 'data-edge-id': edge.id });
        group.appendChild(element(document, 'title', {}, `${edge.label || edge.netId || edge.id} · ${bitCount} bit`));
        group.appendChild(element(document, 'path', { d, class: 'wireHit' }));
        group.appendChild(element(document, 'path', { d, class: 'wireLine' }));
        for (const point of junctions.filter(point => point.edgeId === edge.id)) group.appendChild(element(document, 'circle', { cx: point.x, cy: point.y, r: 2.7, class: 'junctionDot' }));
        // 箭头只出现在已有方向查询的局部图，双向／未知方向不凭几何猜测。
        if (['drivers', 'loads'].includes(direction)) {
            const points = routes.routePoints(edge.sections.at(-1)), end = points.at(-1), previous = points.at(-2);
            const span = end && previous ? Math.hypot(end.x - previous.x, end.y - previous.y) : 0;
            if (span >= 24) {
                const dx = (end.x - previous.x) / span, dy = (end.y - previous.y) / span, x = end.x - dx * 12, y = end.y - dy * 12;
                group.appendChild(element(document, 'path', { d: `M ${x} ${y} L ${x - dx * 7 - dy * 3.5} ${y - dy * 7 + dx * 3.5} L ${x - dx * 7 + dy * 3.5} ${y - dy * 7 - dx * 3.5} Z`, class: 'directionArrow' }));
            }
        }
        if (marker) {
            const { x, y, vertical } = marker;
            const mark = element(document, 'g', { class: 'busMark' });
            mark.appendChild(element(document, 'path', { d: `M ${x - 5} ${y + 6} L ${x + 5} ${y - 6}`, class: 'busSlash' }));
            mark.appendChild(element(document, 'text', { x: x + (vertical ? 11 : 9), y: y + (vertical ? 4 : -8), class: 'busWidth' }, bitCount));
            group.appendChild(mark);
        }
        layer.appendChild(group); edges.set(String(edge.id), { element: group, edge });
    }

    /**
     * 渲染一个已布局的模块。所有设计文本使用 textContent；对象 ID 仅作属性值。
     * @param {SVGSVGElement} svg 页面画布。
     * @param {object} graph 包含 nodes/edges 的布局结果。
     * @returns {object} DOM 索引和纯展示操作；不修改传入网表。
     */
    function renderGraph(svg, graph) {
        const markers = viewport.createBusMarkers(graph.edges || [], graph.nodes || []);
        const junctions = new Map();
        for (const point of routes.createJunctions(graph.edges || []).values()) {
            if (!junctions.has(point.networkKey)) junctions.set(point.networkKey, []);
            junctions.get(point.networkKey).push(point);
        }
        const index = graphIndex.createGraphIndex(graph), scene = viewport.createViewportIndex(graph, markers);
        const document = svg.ownerDocument, nodes = new Map(), ports = new Map(), edges = new Map();
        const layer = element(document, 'g', { class: 'graphLayer' });
        const wireLayer = element(document, 'g', { class: 'wireLayer' }), nodeLayer = element(document, 'g', { class: 'nodeLayer' });
        layer.appendChild(wireLayer); layer.appendChild(nodeLayer);
        for (const edge of graph.edges || []) {
            const source = index.ports.get(String(edge.source)), target = index.ports.get(String(edge.target));
            const directed = source?.port.direction === 'output' && target?.port.direction === 'input'
                && ![source.node, target.node].some(node => node.kind === 'unknown' && /Bidirectional/.test(node.detail));
            appendWire(document, wireLayer, edge, edges, markers.get(String(edge.id)), junctions.get(routes.networkKey(edge)) || [], directed ? graph.trace?.direction : undefined);
        }
        const traceDirection = ['drivers', 'loads'].includes(graph.trace?.direction) ? graph.trace.direction : undefined;
        for (const node of graph.nodes || []) appendNode(document, nodeLayer, node, nodes, ports, traceDirection);
        svg.replaceChildren(layer);
        let order = 0;
        for (const entry of [...nodes.values(), ...edges.values()]) entry.order = order++;

        let selected = index.selection(null), searched = { nodes: new Set(), edges: new Set() };
        let focusedNodes = new Set(), fadedNodes = new Set(), fadedEdges = new Set();
        let visible = new Set([...nodes.keys()].map(id => 'node:' + id).concat([...edges.keys()].map(id => 'edge:' + id))), detail = '';
        function updateClasses(entries, name, before, after) {
            for (const id of before) if (!after.has(id)) entries.get(id)?.element.classList.remove(name);
            for (const id of after) if (!before.has(id)) entries.get(id)?.element.classList.add(name);
        }
        function setSelection(value) {
            const next = index.selection(value);
            updateClasses(edges, 'selected', selected.edges, next.edges);
            updateClasses(ports, 'selected', selected.ports, next.ports);
            updateClasses(nodes, 'selected', selected.nodes, next.nodes);
            updateClasses(nodes, 'connected', selected.connected, next.connected);
            selected = next;
        }
        function setSearch(term) {
            const next = index.search(term);
            updateClasses(nodes, 'searchMatch', searched.nodes, next.nodes);
            updateClasses(edges, 'searchMatch', searched.edges, next.edges);
            searched = next; return next.matches;
        }
        function setFocus(objectIds) {
            const focused = new Set(objectIds);
            const next = new Set(), related = new Set(), wires = new Set();
            for (const [id, { node }] of nodes) for (const port of node.ports || []) {
                if (!focused.has(port.traceOrigin?.objectId)) continue;
                next.add(id); related.add(id);
                for (const edge of index.portEdges.get(String(port.id)) || []) {
                    if (wires.has(String(edge.id))) continue;
                    for (const wire of index.networkEdges(edge)) {
                        wires.add(String(wire.id));
                        for (const endpoint of [wire.source, wire.target]) {
                            const entry = index.ports.get(String(endpoint)); if (entry) related.add(String(entry.node.id));
                        }
                    }
                }
            }
            const dimNodes = next.size ? new Set([...nodes.keys()].filter(id => !related.has(id))) : new Set();
            const dimEdges = next.size ? new Set([...edges.keys()].filter(id => !wires.has(id))) : new Set();
            updateClasses(nodes, 'traceFocused', focusedNodes, next);
            updateClasses(nodes, 'contextFaded', fadedNodes, dimNodes); updateClasses(edges, 'contextFaded', fadedEdges, dimEdges);
            focusedNodes = next; fadedNodes = dimNodes; fadedEdges = dimEdges;
        }
        function setViewport(camera, width, height) {
            const next = scene.query(camera, width, height);
            function reconcile(entries, parent, prefix) {
                for (const id of visible) if (id.startsWith(prefix) && !next.has(id)) {
                    const group = entries.get(id.slice(prefix.length))?.element;
                    if (group?.parentNode === parent) parent.removeChild(group);
                }
                // 只挂载新进入视口的对象，保留既有 DOM 身份、焦点和原始绘制次序。
                const ordered = [...next].filter(id => id.startsWith(prefix)).map(id => entries.get(id.slice(prefix.length))).filter(Boolean).sort((a, b) => a.order - b.order);
                let anchor = null;
                for (let i = ordered.length - 1; i >= 0; i--) {
                    const group = ordered[i].element;
                    if (group.parentNode !== parent) parent.insertBefore(group, anchor);
                    anchor = group;
                }
            }
            if (next.size !== visible.size || [...next].some(id => !visible.has(id))) {
                reconcile(edges, wireLayer, 'edge:'); reconcile(nodes, nodeLayer, 'node:'); visible = next;
            }
            const nextDetail = camera.scale < .35 ? 'overview' : camera.scale < .65 ? 'compact' : 'full';
            if (detail !== nextDetail) { detail = nextDetail; layer.setAttribute('data-detail', detail); }
        }

        function hitTarget(target) {
            let current = target;
            while (current && current !== svg) {
                for (const [attribute, type] of [['data-port-id', 'port'], ['data-node-id', 'node'], ['data-edge-id', 'edge']]) {
                    const id = current.getAttribute?.(attribute);
                    if (id !== null && id !== undefined) return { type, id };
                }
                current = current.parentNode;
            }
            return null;
        }

        return { layer, nodes, ports, edges, index, bounds: scene.bounds, setSelection, setSearch, setFocus, setViewport, hitTarget };
    }

    return { edgePath, busMarker: viewport.busMarker, renderGraph };
});
