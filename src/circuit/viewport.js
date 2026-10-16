(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CircuitViewport = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const LEAF_SIZE = 8, OVERSCAN_PX = 100;
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

    /** @param {object} graph 已布局模块。 @returns {object} 静态包围盒树；查询保留穿过视口且端点在屏外的网络。 */
    function createViewportIndex(graph) {
        const items = [];
        for (const node of graph.nodes || []) {
            // 名称位于节点上方；保留外侧引脚和文字的绘制边界。
            items.push({ key: 'node:' + node.id, left: node.x - 24, top: node.y - 24, right: node.x + node.width + 24, bottom: node.y + node.height + 24 });
        }
        for (const edge of graph.edges || []) {
            const segments = [];
            for (const section of edge.sections || []) {
                const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
                if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) continue;
                for (let i = 1; i < points.length; i++) segments.push({ left: Math.min(points[i - 1].x, points[i].x), top: Math.min(points[i - 1].y, points[i].y), right: Math.max(points[i - 1].x, points[i].x), bottom: Math.max(points[i - 1].y, points[i].y) });
            }
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
        return { query };
    }
    return { createViewportIndex };
});
