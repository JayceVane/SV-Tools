'use strict';

const { LABEL_H, CLOCK_ROW, FONT, MONO, textWidth, round } = require('./architecture-metrics');
const { diagramTopology } = require('./architecture-topology');
const { measureCards } = require('./architecture-measure');
const { attachPeers, initialAssignment, deriveAssignment } = require('./architecture-assign');
const { anchorFor, runLayout } = require('./architecture-elk');
const { signalKind } = require('./architecture-details');
/* ---------- 标签避让 ---------- */

const overlaps = (a, b, gap = 0) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x
    && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

function placeLabels(edges, cards, width) {
    const obstacles = cards.map(card => ({ x: card.x - 2, y: card.y - 2, w: card.width + 4, h: card.height + 4 }));
    // 其它连线也是障碍：名字虽然带白边，压在别的线上仍然读不清。只取正交段的外接矩形（2px 宽）。
    const wires = [];
    for (const edge of edges) for (const section of edge.sections || []) {
        const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
        for (let step = 1; step < points.length; step++) {
            const from = points[step - 1], to = points[step];
            wires.push({ edge: edge.id, x: Math.min(from.x, to.x) - 1, y: Math.min(from.y, to.y) - 1,
                w: Math.abs(to.x - from.x) + 2, h: Math.abs(to.y - from.y) + 2 });
        }
    }
    const placed = [];
    for (const edge of edges) {
        edge.at = undefined;
        if (!edge.label) continue;
        const labelWidth = Math.ceil(textWidth(edge.label, FONT.label, MONO)) + 8;
        const candidates = [];
        for (const [index, section] of (edge.sections || []).entries()) {
            const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
            for (let step = 1; step < points.length; step++) {
                const from = points[step - 1], to = points[step];
                if (Math.abs(from.y - to.y) > 0.5) continue;
                const length = Math.abs(to.x - from.x);
                if (length < labelWidth + 16) continue;
                candidates.push({ start: Math.min(from.x, to.x), end: Math.max(from.x, to.x), y: from.y, length, index });
            }
        }
        candidates.sort((a, b) => b.length - a.length || a.index - b.index);
        for (const candidate of candidates) {
            const offsets = [(candidate.length - labelWidth) / 2, 8, candidate.length - labelWidth - 8];
            let spot;
            for (const offset of offsets) {
                const x = candidate.start + offset;
                if (x < 8 || x + labelWidth > width - 8) continue;
                const rect = { x, y: candidate.y - LABEL_H / 2, w: labelWidth, h: LABEL_H };
                if (obstacles.some(item => overlaps(rect, item, 2))) continue;
                if (wires.some(item => item.edge !== edge.id && overlaps(rect, item, 1))) continue;
                if (placed.some(item => overlaps(rect, item, 2))) continue;
                spot = rect;
                break;
            }
            if (!spot) continue;
            placed.push(spot);
            edge.at = { x: spot.x, y: spot.y, width: labelWidth, height: LABEL_H };
            break;
        }
    }
}

/* ---------- 主布局 ---------- */

async function layoutDiagram(page, mode) {
    if (!page.hasStructure) return { width: 0, height: 0, cards: [], edges: [] };
    const detailed = mode === 'detailed';
    const { cards, edges } = diagramTopology(page, mode);
    if (!cards.length) return { width: 0, height: 0, cards, edges };
    attachPeers(cards, edges);
    const incident = new Map(cards.map(card => [card.id, []]));
    for (const edge of edges) {
        // 分组卡片按连线名排端口。接口束必须逐条列出真实名字——合并成"N 条连接"
        // 后读者无从知道这一束接的是什么，也就失去了 BD 式端口的意义。
        for (const [side, peer] of [[edge.from, edge.to], [edge.to, edge.from]]) {
            if (!incident.has(side) || side === peer) continue;
            for (const id of edge.links) {
                const link = page.links.find(item => item.id === id);
                if (!link) continue;
                incident.get(side).push({ id: edge.id, peer, port: side === edge.from ? edge.fromPort : edge.toPort,
                    outgoing: side === edge.from ? edge.forward : edge.reverse,
                    clock: edge.clockOnly, link: link.id, name: link.name, bus: link.kind === 'interface' });
            }
            // 只有一个关联连线时补一条汇总，避免非接口信号组丢掉"N 条"的规模感。
            if (!edge.links.length) incident.get(side).push({ id: edge.id, peer, name: '', bus: false });
        }
    }
    let assignment = initialAssignment(cards, detailed, incident);
    let layout, stable = false, wrapped = false;
    for (let pass = 0; pass < 3 && !stable; pass++) {
        measureCards(cards, detailed, assignment, incident);
        layout = await runLayout(cards, edges, detailed, wrapped);
        wrapped = layout.wrapped;
        const derived = deriveAssignment(cards, layout, assignment, detailed, incident);
        stable = !derived.changed;
        assignment = derived.assignment;
    }
    if (!stable) {
        measureCards(cards, detailed, assignment, incident);
        layout = await runLayout(cards, edges, detailed, wrapped);
    }
    const placed = new Map(layout.children.map(child => [child.id, child]));
    const routed = new Map((layout.edges || []).map(edge => [edge.id, edge]));
    for (const card of cards) {
        const info = placed.get(card.id);
        card.x = Math.round(info?.x || 0);
        card.y = Math.round(info?.y || 0);
    }
    const width = Math.ceil(layout.width), height = Math.ceil(layout.height);
    for (const edge of edges) {
        edge.sections = routed.get(edge.id)?.sections || [];
        if (!edge.clockOnly) continue;
        // 时钟/复位收进卡底脚注后，同名标签仍要在两端各留一小段接线：
        // 接点放在对应行（CLK / RST）的竖直中点，保证可点、可悬浮。
        for (const [id, port] of [[edge.from, edge.fromPort], [edge.to, edge.toPort]]) {
            const card = cards.find(item => item.id === id);
            if (!card) continue;
            const side = id === edge.from ? 'EAST' : 'WEST';
            let anchor;
            if (card.clockRows?.length) {
                const row = signalKind(edge.names?.[0]) === 'RST' && card.clockRows.length > 1 ? 1 : 0;
                anchor = { side, x: side === 'EAST' ? card.width : 0, y: card.clockTop + row * CLOCK_ROW + CLOCK_ROW / 2 };
            } else {
                const key = anchorFor(card, port, edge.id);
                anchor = [...card.bodyAnchors || [], ...card.rows || [], card.terminalPort].filter(Boolean)
                    .find(item => item.id === key);
            }
            if (!anchor) anchor = { side, x: side === 'EAST' ? card.width : 0, y: card.height / 2 };
            const point = { x: card.x + anchor.x, y: card.y + anchor.y };
            const end = { x: point.x + (anchor.side === 'EAST' ? 10 : -10), y: point.y };
            edge.sections.push(id === edge.from ? { startPoint: point, endPoint: end } : { startPoint: end, endPoint: point });
        }
    }
    placeLabels(edges, cards, width);
    return { width, height, cards, edges, clockRegion: layout.clockRegion, wrapped: layout.wrapped };
}

module.exports = { overlaps, placeLabels, layoutDiagram };
