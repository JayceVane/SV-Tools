(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CircuitRoutes = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const EPSILON = 1e-6, CORNER_RADIUS = 3;
    const near = (a, b) => Math.abs(a - b) < EPSILON;
    const pointKey = point => `${Math.round(point.x / EPSILON)},${Math.round(point.y / EPSILON)}`;
    const networkKey = edge => JSON.stringify([edge.netId, edge.source, edge.bits]);

    /** @param {object} section 正交折线段。 @returns {object[]} 去重及同向共线合并后的独立点列表。 */
    function routePoints(section) {
        const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint], result = [];
        if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) return result;
        for (const point of points) {
            const b = result.at(-1), a = result.at(-2);
            if (b && near(b.x, point.x) && near(b.y, point.y)) continue;
            if (a && ((near(a.x, b.x) && near(b.x, point.x) && (b.y - a.y) * (point.y - b.y) >= 0)
                || (near(a.y, b.y) && near(b.y, point.y) && (b.x - a.x) * (point.x - b.x) >= 0))) result.pop();
            result.push({ x: point.x, y: point.y });
        }
        return result;
    }

    /** @param {object[]} sections 路由。 @param {object[]} [junctions] 不可倒角的真实接点。 @returns {string} 有限M/L/Q路径，不修改路由或端点。 */
    function edgePath(sections, junctions = []) {
        const protectedPoints = new Set(junctions.map(pointKey));
        return (sections || []).map(section => {
            const points = routePoints(section); if (!points.length) return '';
            let d = `M ${points[0].x} ${points[0].y}`;
            for (let i = 1; i < points.length; i++) {
                const a = points[i - 1], b = points[i], c = points[i + 1];
                const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = c ? Math.hypot(c.x - b.x, c.y - b.y) : 0;
                const orthogonal = c && ((near(a.x, b.x) && near(b.y, c.y)) || (near(a.y, b.y) && near(b.x, c.x)));
                if (!orthogonal || !ab || !bc || protectedPoints.has(pointKey(b))) { d += ` L ${b.x} ${b.y}`; continue; }
                const radius = Math.min(CORNER_RADIUS, ab / 2, bc / 2);
                d += ` L ${b.x + (a.x - b.x) * radius / ab} ${b.y + (a.y - b.y) * radius / ab} Q ${b.x} ${b.y} ${b.x + (c.x - b.x) * radius / bc} ${b.y + (c.y - b.y) * radius / bc}`;
            }
            return d;
        }).filter(Boolean).join(' ');
    }

    function addInterval(lines, fixed, a, b) {
        const key = Math.round(fixed / EPSILON);
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push([Math.min(a, b), Math.max(a, b)]);
    }
    function mergeLines(lines) {
        for (const [key, intervals] of lines) {
            intervals.sort((a, b) => a[0] - b[0]); const merged = [];
            for (const interval of intervals) {
                const last = merged.at(-1);
                if (last && interval[0] <= last[1] + EPSILON) last[1] = Math.max(last[1], interval[1]);
                else merged.push([...interval]);
            }
            lines.set(key, merged);
        }
    }
    function directions(lines, fixed, position) {
        const intervals = lines.get(Math.round(fixed / EPSILON)) || [];
        let left = 0, right = intervals.length;
        while (left < right) { const mid = (left + right) >>> 1; if (intervals[mid][1] < position - EPSILON) left = mid + 1; else right = mid; }
        const interval = intervals[left];
        return !interval || interval[0] > position + EPSILON ? 0 : Number(interval[0] < position - EPSILON) + Number(interval[1] > position + EPSILON);
    }

    /**
     * 只合并同源、同网络和有序位集合的正交分支；绝不按坐标或常量值跨网连接。
     * @param {object[]} edges 带实际路由的连线。 @returns {Map<string,object>} 唯一T/十字接点及其所属边。
     */
    function createJunctions(edges) {
        const groups = new Map(), result = new Map();
        for (const edge of edges) {
            const identity = networkKey(edge);
            if (!edge.netId || !edge.source) continue;
            if (!groups.has(identity)) groups.set(identity, []);
            groups.get(identity).push(edge);
        }
        for (const [identity, group] of groups) {
            if (group.length < 2) continue;
            const horizontal = new Map(), vertical = new Map(), candidates = new Map();
            for (const edge of group) for (const section of edge.sections || []) {
                const points = routePoints(section);
                for (let i = 1; i < points.length; i++) {
                    const a = points[i - 1], b = points[i];
                    candidates.set(pointKey(a), { ...a, edgeId: edge.id }); candidates.set(pointKey(b), { ...b, edgeId: edge.id });
                    if (near(a.y, b.y)) addInterval(horizontal, a.y, a.x, b.x);
                    else if (near(a.x, b.x)) addInterval(vertical, a.x, a.y, b.y);
                }
            }
            mergeLines(horizontal); mergeLines(vertical);
            for (const [key, point] of candidates) if (directions(horizontal, point.y, point.x) + directions(vertical, point.x, point.y) >= 3) result.set(identity + key, { ...point, networkKey: identity });
        }
        return result;
    }
    return { routePoints, edgePath, createJunctions, networkKey };
});
