'use strict';

const { LABEL_H, CLOCK_ROW, FONT, MONO, textWidth, round } = require('./architecture-metrics');
const { diagramTopology } = require('./architecture-topology');
const { measureCards } = require('./architecture-measure');
const { attachPeers, initialAssignment, deriveAssignment } = require('./architecture-assign');
const { anchorFor, runLayout } = require('./architecture-elk');
/* ---------- 折行布局的边界端口 ---------- */
// 折行后边界端口常被折到行首/行尾，连线只能绕整张图。
// 这里把边界端口放到整块图左右外缘，并把它的连线改走「行间隙 → 外缘通道」的直角路线。
function padAnchor(card, port) {
    if (card.rows?.length) {
        const row = card.rows.find(item => item.port?.name === port || item.node.id === port || item.node.name === port) || card.rows[0];
        return { x: card.x + row.x, y: card.y + row.y };
    }
    if (card.terminalPort) return { x: card.x + card.terminalPort.x, y: card.y + card.terminalPort.y };
    return { x: card.x, y: card.y + card.height / 2 };
}

function rowGaps(cards) {
    const bands = [];
    for (const card of [...cards].sort((left, right) => left.y - right.y)) {
        const last = bands[bands.length - 1];
        if (last && card.y <= last.bottom + 8) last.bottom = Math.max(last.bottom, card.y + card.height);
        else bands.push({ top: card.y, bottom: card.y + card.height });
    }
    const gaps = [];
    for (let index = 1; index < bands.length; index++) gaps.push((bands[index - 1].bottom + bands[index].top) / 2);
    return gaps;
}

function nearestGap(gaps, y, fallback) {
    if (!gaps.length) return fallback;
    return gaps.reduce((best, gap) => Math.abs(gap - y) < Math.abs(best - y) ? gap : best, gaps[0]);
}

// 边界端口的连线改走「贴卡边 → 最近的行间隙 → 外缘通道 → 端口行」。
function routeBoundaryEdges(cards, edges) {
    const byId = new Map(cards.map(card => [card.id, card]));
    const body = cards.filter(card => card.kind !== 'pad' && card.kind !== 'boundary');
    const gaps = rowGaps(body);
    const fallback = body.length ? Math.min(...body.map(card => card.y)) - 12 : 0;
    for (const edge of edges) {
        if (edge.clockOnly) continue;
        const fromPad = ['pad', 'boundary'].includes(byId.get(edge.from)?.kind);
        const toPad = ['pad', 'boundary'].includes(byId.get(edge.to)?.kind);
        if (!fromPad && !toPad) continue;
        const pad = byId.get(fromPad ? edge.from : edge.to);
        const padPoint = padAnchor(pad, fromPad ? edge.fromPort : edge.toPort);
        const flat = (edge.sections || []).flatMap(section => [section.startPoint, ...(section.bendPoints || []), section.endPoint])
            .filter(Boolean);
        if (!flat.length) continue;
        const other = fromPad ? flat[flat.length - 1] : flat[0];
        const gapY = nearestGap(gaps, other.y, fallback);
        const channel = pad.edgeSide === 'right' ? pad.x - 8 : pad.x + pad.width + 8;
        const points = fromPad
            ? [padPoint, { x: channel, y: padPoint.y }, { x: channel, y: gapY }, { x: other.x, y: gapY }, other]
            : [other, { x: other.x, y: gapY }, { x: channel, y: gapY }, { x: channel, y: padPoint.y }, padPoint];
        edge.sections = [{ startPoint: points[0], bendPoints: points.slice(1, -1), endPoint: points[points.length - 1] }];
    }
}

// 折行布局里跨行的普通连线也会被 ELK 绕整张图外圈。
// 这里把「明显绕远」的线改走最近的行间隙：起点竖直上/下到间隙 → 横穿 → 竖直进目标。
// 任何一段会穿过其他卡片就保留原走线。
function segmentHits(card, from, to) {
    const pad = 2;
    if (Math.abs(from.x - to.x) < 0.5) {
        const x = from.x, low = Math.min(from.y, to.y), high = Math.max(from.y, to.y);
        return card.x - pad < x && x < card.x + card.width + pad && low < card.y + card.height && high > card.y;
    }
    const y = from.y, low = Math.min(from.x, to.x), high = Math.max(from.x, to.x);
    return card.y - pad < y && y < card.y + card.height + pad && low < card.x + card.width && high > card.x;
}

function routeLongEdges(cards, edges) {
    const body = cards.filter(card => card.kind !== 'pad' && card.kind !== 'boundary');
    const pads = new Set(cards.filter(card => card.kind === 'pad' || card.kind === 'boundary').map(card => card.id));
    const gaps = rowGaps(body);
    if (!gaps.length) return;
    for (const edge of edges) {
        if (edge.clockOnly || pads.has(edge.from) || pads.has(edge.to)) continue;
        const flat = (edge.sections || []).flatMap(section => [section.startPoint, ...(section.bendPoints || []), section.endPoint])
            .filter(Boolean);
        if (flat.length < 2) continue;
        let length = 0;
        for (let index = 1; index < flat.length; index++) {
            length += Math.abs(flat[index].x - flat[index - 1].x) + Math.abs(flat[index].y - flat[index - 1].y);
        }
        const start = flat[0], end = flat[flat.length - 1];
        const direct = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
        if (length < direct * 1.6 + 80) continue;
        const gapY = nearestGap(gaps, (start.y + end.y) / 2, start.y);
        const points = [start, { x: start.x, y: gapY }, { x: end.x, y: gapY }, end];
        const blocked = body.some(card => card.id !== edge.from && card.id !== edge.to
            && points.slice(1).some((point, index) => segmentHits(card, points[index], point)));
        if (blocked) continue;
        edge.sections = [{ startPoint: points[0], bendPoints: points.slice(1, -1), endPoint: points[points.length - 1] }];
    }
}

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
            if (card.clockPins?.length) {
                // 时钟/复位按列排：行号取所在列的序号，贴边点跟着端口自己的一侧。
                const name = edge.names?.[0] || '';
                const pin = card.clockPins.find(item => item.name === name) || card.clockPins[0];
                const column = pin.side === 'EAST' ? card.clockEast : card.clockWest;
                anchor = { side: pin.side, x: pin.side === 'EAST' ? card.width : 0,
                    y: card.clockTop + Math.max(0, column.indexOf(pin)) * CLOCK_ROW + CLOCK_ROW / 2 };
            } else {
                const key = anchorFor(card, port, edge.id);
                anchor = [...card.bodyAnchors || [], ...card.rows || [], card.terminalPort].filter(Boolean)
                    .find(item => item.id === key);
            }
            if (!anchor) anchor = { side, x: side === 'EAST' ? card.width : 0, y: card.height / 2 };
            const point = { x: card.x + anchor.x, y: card.y + anchor.y };
            // 引线拉长到 24px：同名标签的联动靠这条短线指回端口，太短看不出「这一行接出去了」。
            const end = { x: point.x + (anchor.side === 'EAST' ? 24 : -24), y: point.y };
            edge.sections.push(id === edge.from ? { startPoint: point, endPoint: end } : { startPoint: end, endPoint: point });
        }
    }
    // 折行页的边界端口固定在外缘，连线走「行间隙 → 外缘通道」；左端口的落点也随之更新。
    if (layout.wrapped) { routeBoundaryEdges(cards, edges); routeLongEdges(cards, edges); }
    placeLabels(edges, cards, width);
    return { width, height, cards, edges, clockRegion: layout.clockRegion, wrapped: layout.wrapped };
}

module.exports = { overlaps, placeLabels, layoutDiagram };
