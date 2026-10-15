(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CircuitRenderer = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const KINDS = new Set(['input', 'output', 'inout', 'constant', 'register', 'mux', 'arithmetic', 'logic', 'memory', 'instance', 'unknown', 'junction']);
    const SYMBOLS = { register: 'D  Q', mux: 'MUX', arithmetic: 'ƒ', logic: 'LOGIC', memory: 'MEM', instance: '↗', constant: '#', unknown: '?' };
    const OPERATORS = { $add: '+', $sub: '−', $mul: '×', $mult: '×', $div: '÷', $mod: '%', $neg: '−',
        $and: '&', $or: 'OR', $xor: 'XOR', $xnor: 'XNOR', $not: 'NOT', $logic_not: '!', $logic_and: '&&', $logic_or: '||',
        $eq: '=', $ne: '≠', $lt: '<', $le: '≤', $gt: '>', $ge: '≥', $shl: '≪', $shr: '≫', $sshl: '≪', $sshr: '≫', gnd: '0', vcc: '1' };
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
    function edgePath(sections) {
        return (Array.isArray(sections) ? sections : []).map(section => {
            const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
            if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) return '';
            return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
        }).filter(Boolean).join(' ');
    }

    function nodeBody(document, node, width, height) {
        if (node.kind === 'mux') return element(document, 'polygon', { points: `0,0 ${width},12 ${width},${Math.max(12, height - 12)} 0,${height}`, class: 'cellBody' });
        if (node.kind === 'input' || node.kind === 'output' || node.kind === 'inout') {
            const tip = Math.min(12, width / 5);
            return element(document, 'polygon', { points: `0,0 ${width - tip},0 ${width},${height / 2} ${width - tip},${height} 0,${height}`, class: 'cellBody' });
        }
        return element(document, 'rect', { width, height, rx: node.kind === 'junction' ? Math.min(width, height) / 2 : 6, class: 'cellBody' });
    }

    function appendNode(document, layer, node, nodes, ports) {
        const kind = KINDS.has(node.kind) ? node.kind : 'unknown';
        const width = Math.max(2, finite(node.width, 120)), height = Math.max(2, finite(node.height, 56));
        const group = element(document, 'g', { class: `cell kind-${kind}`, transform: `translate(${finite(node.x)} ${finite(node.y)})`, 'data-node-id': node.id, role: 'button', tabindex: '0', 'aria-label': `${node.label || node.id}${node.moduleId ? '，模块实例，可进入' : ''}` });
        group.appendChild(element(document, 'title', {}, [node.label || node.id, node.toolName, node.detail].filter(Boolean).join('\n')));
        group.appendChild(nodeBody(document, node, width, height));
        if (height >= 50 && width >= 85 && SYMBOLS[kind]) {
            const operator = String(node.detail || '').replace(/^RTL_/, '$').toLowerCase();
            const symbol = ['logic', 'arithmetic'].includes(kind) && Object.hasOwn(OPERATORS, operator) ? OPERATORS[operator] : SYMBOLS[kind];
            group.appendChild(element(document, 'text', { x: width / 2, y: height / 2 + 4, 'text-anchor': 'middle', class: 'cellSymbol' }, symbol));
            group.appendChild(element(document, 'text', { x: 0, y: -10, class: 'cellLabel' }, shorten(node.label, width)));
        } else if (width >= 35) group.appendChild(element(document, 'text', { x: 10, y: height / 2 + 4, class: 'cellLabel' }, shorten(node.label, width - 20)));
        if (kind === 'register' && height >= 40) group.appendChild(element(document, 'path', { d: `M 0 ${height - 20} L 7 ${height - 15} L 0 ${height - 10}`, class: 'clockMark' }));
        for (const port of node.ports || []) {
            const x = finite(port.x) + finite(port.width) / 2, y = finite(port.y) + finite(port.height) / 2;
            const declared = port.declaredDirection || port.direction || 'unknown';
            const portGroup = element(document, 'g', { class: 'pin', 'data-port-id': port.id, role: 'button', tabindex: '-1', 'aria-label': `${port.label || port.id}，${declared}` });
            portGroup.appendChild(element(document, 'circle', { cx: x, cy: y, r: 7, class: 'pinHit' }));
            portGroup.appendChild(element(document, 'circle', { cx: x, cy: y, r: 3, class: 'pinDot' }));
            portGroup.appendChild(element(document, 'title', {}, `${port.label || port.id} · ${declared} · ${(port.bits || []).length} bit`));
            if (port.label && height >= 70 && width >= 110) {
                const left = x < width / 2;
                portGroup.appendChild(element(document, 'text', { x: x + (left ? 9 : -9), y: y + 4, 'text-anchor': left ? 'start' : 'end', class: 'pinLabel' }, shorten(port.label, Math.max(24, (width - 65) / 2))));
            }
            group.appendChild(portGroup); ports.set(String(port.id), { element: portGroup, port, node });
        }
        layer.appendChild(group); nodes.set(String(node.id), { element: group, node });
    }

    /**
     * 渲染一个已布局的模块。所有设计文本使用 textContent；对象 ID 仅作属性值。
     * @param {SVGSVGElement} svg 页面画布。
     * @param {object} graph 包含 nodes/edges 的布局结果。
     * @returns {object} DOM 索引和纯展示操作；不修改传入网表。
     */
    function renderGraph(svg, graph) {
        const document = svg.ownerDocument, nodes = new Map(), ports = new Map(), edges = new Map();
        const layer = element(document, 'g', { class: 'graphLayer' });
        const wireLayer = element(document, 'g', { class: 'wireLayer' }), nodeLayer = element(document, 'g', { class: 'nodeLayer' });
        layer.appendChild(wireLayer); layer.appendChild(nodeLayer);
        for (const edge of graph.edges || []) {
            const d = edgePath(edge.sections);
            if (!d) continue;
            const group = element(document, 'g', { class: `wire${(edge.bits || []).length > 1 ? ' bus' : ''}`, 'data-edge-id': edge.id });
            group.appendChild(element(document, 'title', {}, `${edge.label || edge.netId || edge.id} · ${(edge.bits || []).length} bit`));
            group.appendChild(element(document, 'path', { d, class: 'wireHit' }));
            group.appendChild(element(document, 'path', { d, class: 'wireLine' }));
            wireLayer.appendChild(group); edges.set(String(edge.id), { element: group, edge });
        }
        for (const node of graph.nodes || []) appendNode(document, nodeLayer, node, nodes, ports);
        svg.replaceChildren(layer);

        function setSelection(selection) {
            const selectedNode = selection?.type === 'node' ? nodes.get(String(selection.id)) : null;
            const selectedPort = selection?.type === 'port' ? ports.get(String(selection.id)) : null;
            const selectedEdge = selection?.type === 'edge' ? edges.get(String(selection.id))?.edge : null;
            const netId = selectedEdge?.netId, relatedPorts = new Set(), relatedNodes = new Set();
            for (const { element: group, edge } of edges.values()) {
                const active = selectedEdge ? edge.netId === netId : selectedPort ? edge.source === selectedPort.port.id || edge.target === selectedPort.port.id : false;
                group.classList.toggle('selected', active);
                if (active) { relatedPorts.add(String(edge.source)); relatedPorts.add(String(edge.target)); }
            }
            for (const [id, entry] of ports) {
                const active = relatedPorts.has(id) || entry === selectedPort;
                entry.element.classList.toggle('selected', active);
                if (active) relatedNodes.add(String(entry.node.id));
            }
            for (const [id, entry] of nodes) {
                entry.element.classList.toggle('selected', entry === selectedNode || entry.node === selectedPort?.node);
                entry.element.classList.toggle('connected', relatedNodes.has(id));
            }
        }

        function setSearch(term) {
            const needle = String(term || '').trim().toLocaleLowerCase();
            for (const { element: group, node } of nodes.values()) group.classList.toggle('searchMatch', !!needle && [node.label, node.toolName, node.detail, ...(node.ports || []).map(port => port.label)].some(value => String(value || '').toLocaleLowerCase().includes(needle)));
            for (const { element: group, edge } of edges.values()) group.classList.toggle('searchMatch', !!needle && [edge.label, edge.netId].some(value => String(value || '').toLocaleLowerCase().includes(needle)));
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

        return { layer, nodes, ports, edges, setSelection, setSearch, hitTarget };
    }

    return { edgePath, renderGraph };
});
