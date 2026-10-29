(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./symbol-library'), require('./route-geometry'));
    else root.CircuitViewport = factory(root.CircuitSymbols, root.CircuitRoutes);
})(typeof globalThis === 'object' ? globalThis : this, function (symbols, routes) {
    'use strict';
    const LEAF_SIZE = 8, OVERSCAN_PX = 100, GEOMETRY_EPSILON = 1e-6;
    const MIN_MARKER_SPAN = 64, MARKER_CELL_WIDTH = 64, MARKER_CELL_HEIGHT = 32;
    const near = (a, b) => Math.abs(a - b) < GEOMETRY_EPSILON;
    const intersects = (a, b) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
    function union(items) {
        return items.reduce((box, item) => ({ left: Math.min(box.left, item.left), top: Math.min(box.top, item.top), right: Math.max(box.right, item.right), bottom: Math.max(box.bottom, item.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    }
    function build(items) {
        if (!items.length) return null;
        const bounds = union(items);
        if (items.length <= LEAF_SIZE) return { bounds, items };
        const axis = bounds.right - bounds.left > bounds.bottom - bounds.top ? ['left', 'right'] : ['top', 'bottom'];
        items.sort((a, b) => a[axis[0]] + a[axis[1]] - b[axis[0]] - b[axis[1]]);
        const middle = Math.floor(items.length / 2);
        return { bounds, children: [build(items.slice(0, middle)), build(items.slice(middle))] };
    }

    const routePoints = routes.routePoints;

    function busCandidates(sections, bitCount) {
        if (!Number.isSafeInteger(bitCount) || bitCount <= 1) return [];
        const minSpan = Math.max(MIN_MARKER_SPAN, 2 * (String(bitCount).length * 8 + 16)), segments = [];
        for (const section of sections || []) {
            const points = routePoints(section);
            for (let i = 1; i < points.length; i++) {
                const a = points[i - 1], b = points[i], vertical = near(a.x, b.x);
                if (!vertical && !near(a.y, b.y)) continue;
                const span = Math.abs(vertical ? b.y - a.y : b.x - a.x);
                if (span >= minSpan) segments.push({ a, b, vertical, span });
            }
        }
        segments.sort((a, b) => Number(a.vertical) - Number(b.vertical) || b.span - a.span);
        return segments.flatMap(({ a, b, vertical, span }) => [.5, .25, .75]
            .filter(fraction => span * Math.min(fraction, 1 - fraction) >= minSpan / 2)
            .map(fraction => ({ x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction, vertical })));
    }

    /**
     * 选取正交长段，容许ELK浮点误差并优先水平段；不改变已有路由。
     * @param {object[]} sections 已有连线折点。 @param {number} bitCount 路由真实位数。
     * @returns {{x:number,y:number,vertical:boolean}|null} 有限坐标锚点。
     */
    function busMarker(sections, bitCount) { return busCandidates(sections, bitCount)[0] || null; }

    function markerBounds(marker, bitCount) {
        return { left: marker.x - 7, top: marker.y - 22,
            right: marker.x + 15 + String(bitCount).length * 8, bottom: marker.y + 9 };
    }
    function markerCells(box) {
        const keys = [], left = Math.floor(box.left / MARKER_CELL_WIDTH), right = Math.floor(box.right / MARKER_CELL_WIDTH);
        const top = Math.floor(box.top / MARKER_CELL_HEIGHT), bottom = Math.floor(box.bottom / MARKER_CELL_HEIGHT);
        if (![left, right, top, bottom].every(Number.isSafeInteger)) return keys;
        for (let x = left; x <= right; x++) {
            for (let y = top; y <= bottom; y++) keys.push(`${x}:${y}`);
        }
        return keys;
    }
    function reserveMarker(marker, bitCount, occupied) {
        const box = markerBounds(marker, bitCount), keys = markerCells(box);
        if (keys.some(key => (occupied.get(key) || []).some(other => intersects(box, other)))) return false;
        occupyBounds(box, occupied, keys); return true;
    }
    function occupyBounds(box, occupied, keys = markerCells(box)) {
        for (const key of keys) {
            if (!occupied.has(key)) occupied.set(key, []);
            occupied.get(key).push(box);
        }
    }

    /** @param {object[]} edges 模块连线。 @param {object[]} [nodes] 需避让的单元。 @returns {Map<string,object>} 稳定位宽标记；空间不足时只保留线型。 */
    function createBusMarkers(edges, nodes = []) {
        const markers = new Map(), occupied = new Map();
        for (const node of nodes) occupyBounds({ left: node.x - 10, top: node.y - 24,
            right: node.x + node.width + 10, bottom: node.y + node.height + 10 }, occupied);
        const markedNetworks = new Set();
        for (const edge of edges) {
            const bitCount = edge.bits?.length || 0;
            const network = edge.netId && JSON.stringify([edge.netId, edge.source, edge.bits]);
            if (network && markedNetworks.has(network)) continue;
            const marker = busCandidates(edge.sections, bitCount).find(candidate => reserveMarker(candidate, bitCount, occupied));
            if (marker) { markers.set(String(edge.id), marker); if (network) markedNetworks.add(network); }
        }
        return markers;
    }

    /** @param {object} graph 已布局模块。 @param {Map<string,object>} [markers] 与渲染共享的标记位置。 @returns {object} 静态包围盒树；保留穿过视口的连线和可见位宽。 */
    function createViewportIndex(graph, markers = createBusMarkers(graph.edges || [], graph.nodes || [])) {
        const items = [];
        for (const node of graph.nodes || []) {
            const bounds = symbols.geometry(node).paintBounds;
            items.push({ key: 'node:' + node.id, left: node.x + Math.min(-24, bounds.left), top: node.y + Math.min(-24, bounds.top),
                right: node.x + Math.max(node.width + 24, bounds.right), bottom: node.y + Math.max(node.height + 24, bounds.bottom) });
        }
        for (const edge of graph.edges || []) {
            const segments = [];
            for (const section of edge.sections || []) {
                const points = routePoints(section);
                for (let i = 1; i < points.length; i++) segments.push({ left: Math.min(points[i - 1].x, points[i].x), top: Math.min(points[i - 1].y, points[i].y), right: Math.max(points[i - 1].x, points[i].x), bottom: Math.max(points[i - 1].y, points[i].y) });
            }
            const bitCount = edge.bits?.length || 0, marker = markers.get(String(edge.id));
            // 装饰在连线外侧；高倍率下不能只按中心线裁剪，否则可见位宽会消失。
            if (marker) segments.push(markerBounds(marker, bitCount));
            if (segments.length) items.push({ ...union(segments), key: 'edge:' + edge.id, segments });
        }
        const tree = build(items);
        function query(camera, width, height) {
            const scale = camera.scale, margin = OVERSCAN_PX / scale;
            const view = { left: -camera.x / scale - margin, top: -camera.y / scale - margin, right: (width - camera.x) / scale + margin, bottom: (height - camera.y) / scale + margin }, visible = new Set();
            function visit(branch) {
                if (!branch || !intersects(branch.bounds, view)) return;
                if (branch.children) { branch.children.forEach(visit); return; }
                for (const item of branch.items) if (intersects(item, view) && (!item.segments || item.segments.some(segment => intersects(segment, view)))) visible.add(item.key);
            }
            visit(tree); return visible;
        }
        return { query, bounds: items.length ? union(items) : { left: 0, top: 0, right: 1, bottom: 1 } };
    }
    return { createViewportIndex, busMarker, createBusMarkers };
});
