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
// 端口在卡片哪一侧，就从那一侧向外让 12px 再拐弯，避免竖线和卡片边框/引脚叠在一起。
function awayFromCard(card, point) {
    if (!card) return 0;
    if (point.x <= card.x + 0.5) return -1;
    if (point.x >= card.x + card.width - 0.5) return 1;
    return point.x < card.x + card.width / 2 ? -1 : 1;
}

// 同一条行间隙里并行多条线时按 12px 上下错开，避免几条线粘成一块。
function makeGapLanes() {
    const used = new Map();
    const offsets = [0, -20, 20, -40, 40];
    return gapY => {
        const key = Math.round(gapY);
        const count = used.get(key) || 0;
        used.set(key, count + 1);
        return gapY + offsets[count % offsets.length];
    };
}

function routeBoundaryEdges(cards, edges) {
    const byId = new Map(cards.map(card => [card.id, card]));
    const body = cards.filter(card => card.kind !== 'pad' && card.kind !== 'boundary');
    const gaps = rowGaps(body);
    const fallback = body.length ? Math.min(...body.map(card => card.y)) - 12 : 0;
    const laneAt = makeGapLanes();
    const lanes = new Map();
    // 同一张卡片同一侧的多个端口，离开卡片的距离也要错开，否则几根竖线会叠在同一条 x 上。
    const exits = new Map();
    const exitPoint = (card, point) => {
        const away = awayFromCard(card, point);
        const key = card.id + ':' + away;
        const count = exits.get(key) || 0;
        exits.set(key, count + 1);
        return { x: point.x + away * (12 + count * 14), y: point.y };
    };
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
        const card = byId.get(fromPad ? edge.to : edge.from);
        const gapY = nearestGap(gaps, other.y, fallback);
        // 同一端口的多条线分道，避免竖线叠成一条粗线。
        const lane = (lanes.get(pad.id) || 0) + 1;
        lanes.set(pad.id, lane);
        const channel = (pad.edgeSide === 'right' ? pad.x - 8 : pad.x + pad.width + 8) + (lane - 1) * 14;
        const exit = exitPoint(card, other);
        // 端口和端口行离得近时直接走「出一小段 → 竖直 → 进端口行」，不必绕到行间隙去。
        const direct = Math.abs(padPoint.y - other.y) <= 160;
        const directPoints = fromPad
            ? [padPoint, { x: channel, y: padPoint.y }, { x: channel, y: exit.y }, exit, other]
            : [other, exit, { x: exit.x, y: padPoint.y }, { x: channel, y: padPoint.y }, padPoint];
        const gapPoints = lane => fromPad
            ? [padPoint, { x: channel, y: padPoint.y }, { x: channel, y: lane }, { x: exit.x, y: lane }, exit, other]
            : [other, exit, { x: exit.x, y: lane }, { x: channel, y: lane }, { x: channel, y: padPoint.y }, padPoint];
        const clear = points => !body.some(item => item.id !== edge.from && item.id !== edge.to
            && points.slice(1).some((point, index) => segmentHits(item, points[index], point)));
        const pick = build => {
            for (const offset of [0, -20, 20, -40, 40]) {
                const candidate = build(gapY + offset);
                if (clear(candidate)) return candidate;
            }
            return build(gapY);
        };
        const points = direct && clear(directPoints) ? directPoints : pick(lane => gapPoints(lane));
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

// 在 [low, high] 这段高度里找一条没有卡片挡住的竖直通道（列间隙），尽量靠近 near。
function freeColumn(cards, low, high, near) {
    const spans = cards.filter(card => card.y < high - 4 && card.y + card.height > low + 4)
        .map(card => [card.x - 10, card.x + card.width + 10]).sort((left, right) => left[0] - right[0]);
    let cursor = -Infinity, best = null, bestGap = Infinity;
    const consider = value => {
        if (Math.abs(value - near) < bestGap) { bestGap = Math.abs(value - near); best = value; }
    };
    for (const [left, right] of spans) {
        if (left - cursor > 8) consider(cursor === -Infinity ? left - 12 : (cursor + left) / 2);
        cursor = Math.max(cursor, right);
    }
    if (cursor !== -Infinity) consider(cursor + 12);
    return best;
}

function routeLongEdges(cards, edges) {
    const byId = new Map(cards.map(card => [card.id, card]));
    const body = cards.filter(card => card.kind !== 'pad' && card.kind !== 'boundary');
    const pads = new Set(cards.filter(card => card.kind === 'pad' || card.kind === 'boundary').map(card => card.id));
    const gaps = rowGaps(body);
    if (!gaps.length) return;
    const laneAt = makeGapLanes();
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
        const startExit = { x: start.x + awayFromCard(byId.get(edge.from), start) * 12, y: start.y };
        const endExit = { x: end.x + awayFromCard(byId.get(edge.to), end) * 12, y: end.y };
        const base1 = nearestGap(gaps, start.y, start.y);
        const base2 = nearestGap(gaps, end.y, end.y);
        const build = (gap1, gap2) => {
            // 两个端口行靠得近时走同一条行间隙；否则在两条间隙之间找一条列间隙做竖直通道，
            // 让长竖线走在卡片之间，而不是贴着某张卡的边框。
            const channel = gap1 === gap2 ? null : freeColumn(body, Math.min(gap1, gap2), Math.max(gap1, gap2), (startExit.x + endExit.x) / 2);
            return channel === null
                ? [start, startExit, { x: startExit.x, y: gap1 }, { x: endExit.x, y: gap1 }, endExit, end]
                : [start, startExit, { x: startExit.x, y: gap1 }, { x: channel, y: gap1 }, { x: channel, y: gap2 },
                    { x: endExit.x, y: gap2 }, endExit, end];
        };
        const clear = points => !body.some(card => card.id !== edge.from && card.id !== edge.to
            && points.slice(1).some((point, index) => segmentHits(card, points[index], point)));
        const staggered = build(laneAt(base1), laneAt(base2));
        const points = clear(staggered) ? staggered : build(base1, base2);
        if (!clear(points)) continue;
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
