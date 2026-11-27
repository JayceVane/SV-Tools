'use strict';

const { OVERVIEW_MAX_WIDTH, UI, CLOCK_BAND_TITLE, textWidth } = require('./architecture-metrics');
const { edgeSide } = require('./architecture-topology');
const { cardsById } = require('./architecture-assign');
// ELK 包体积大，按需懒加载并复用同一份实例。
let elk;

/* ---------- ELK 布局 ---------- */

function portForPin(pin) {
    return { id: pin.id, x: pin.x, y: pin.y, width: 0, height: 0, layoutOptions: { 'elk.port.side': pin.side } };
}

function elkChildren(cards) {
    return cards.map(card => {
        const child = { id: card.id, width: card.width, height: card.height };
        let ports = [];
        if (card.bodyAnchors?.length) ports = card.bodyAnchors.map(anchor => ({ id: anchor.id, x: anchor.x, y: anchor.y,
            width: 0, height: 0, layoutOptions: { 'elk.port.side': anchor.side } }));
        else if (card.pins?.length) ports = card.pins.map(portForPin);
        else if (card.rows?.length) ports = card.rows.map(row => ({ id: row.id, x: row.x, y: row.y, width: 0, height: 0,
            layoutOptions: { 'elk.port.side': row.side } }));
        else if (card.terminalPort) ports = [{ id: card.terminalPort.id, x: card.terminalPort.x, y: card.terminalPort.y,
            width: 0, height: 0, layoutOptions: { 'elk.port.side': card.terminalPort.side } }];
        const layoutOptions = {};
        if (ports.length) {
            child.ports = ports;
            layoutOptions['elk.portConstraints'] = 'FIXED_POS';
        }
        if (card.kind === 'pad' || card.kind === 'boundary') {
            layoutOptions['elk.layered.layering.layerConstraint'] = card.edgeSide === 'left' ? 'FIRST' : 'LAST';
        }
        if (Object.keys(layoutOptions).length) child.layoutOptions = layoutOptions;
        return child;
    });
}

function anchorFor(card, port, edge) {
    if (!card) return undefined;
    if (edge && card.edgeAnchorIds?.has(edge)) return card.edgeAnchorIds.get(edge);
    if (card.kind === 'pad') {
        const row = card.rows?.find(item => item.port?.name === port || item.node.id === port || item.node.name === port);
        return row?.id || card.id;
    }
    if (card.kind === 'boundary') return card.terminalPort?.id || card.id;
    if (card.pins?.length) {
        const pin = card.pins.find(item => item.port.name === port);
        return pin?.id || card.id;
    }
    return card.id;
}

// 折行后边界端口常被折到行首/行尾，连线只能绕整张图。
// 这里把边界端口钉到整块图的左右外缘：左端口 x=12，右端口 x=内容右侧+16，
// 竖位置对准与它相连的卡片，重叠时顺次下移。
function placeBoundaryColumns(cards, edges, layout) {
    const pads = cards.filter(card => card.kind === 'pad' || card.kind === 'boundary');
    if (!pads.length) return;
    const padIds = new Set(pads.map(card => card.id));
    const body = layout.children.filter(child => !padIds.has(child.id));
    if (!body.length) return;
    const left = pads.filter(card => card.edgeSide !== 'right');
    const right = pads.filter(card => card.edgeSide === 'right');
    const shift = left.length ? Math.max(...left.map(card => card.width)) + 16 : 0;
    if (shift) {
        for (const child of body) child.x += shift;
        // 卡片整体右移，ELK 已算好的连线路由也要跟着平移，否则线和卡片会错位。
        for (const edge of layout.edges || []) {
            for (const section of edge.sections || []) {
                for (const key of ['startPoint', 'endPoint']) if (section[key]) section[key].x += shift;
                for (const point of section.bendPoints || []) point.x += shift;
            }
        }
    }
    const byId = new Map(body.map(child => [child.id, child]));
    const minY = Math.min(...body.map(child => child.y));
    const maxBottom = Math.max(...body.map(child => child.y + child.height));
    const maxX = Math.max(...body.map(child => child.x + child.width));
    const place = (list, x) => {
        let cursor = minY;
        for (const card of list) {
            const peers = edges.filter(edge => edge.from === card.id || edge.to === card.id)
                .map(edge => byId.get(edge.from === card.id ? edge.to : edge.from)).filter(Boolean);
            const center = peers.length
                ? peers.reduce((sum, child) => sum + child.y + child.height / 2, 0) / peers.length
                : minY + card.height / 2;
            const y = Math.max(minY, Math.min(maxBottom - card.height, Math.round(center - card.height / 2)));
            card.x = x;
            card.y = Math.max(y, cursor);
            cursor = card.y + card.height + 12;
            // 端口卡本来就是 ELK 的 child：就地改坐标，避免 children 里同时留旧位置和新位置。
            const child = layout.children.find(item => item.id === card.id);
            if (child) { child.x = card.x; child.y = card.y; }
            else layout.children.push({ id: card.id, x: card.x, y: card.y, width: card.width, height: card.height });
        }
    };
    place(left, 12);
    place(right, maxX + 16);
    layout.width = Math.max(layout.width, ...pads.map(card => card.x + card.width + 12));
    // 端口排可能比主体更高（折行后主体变矮），高度 bbox 也要把它们算进来，否则会落到 viewBox 之外。
    layout.height = Math.max(layout.height, maxBottom + 16, ...pads.map(card => card.y + card.height + 16));
}

async function runLayout(cards, edges, detailed, wrapped = false) {
    if (!elk) {
        let Engine;
        try { Engine = require('../../bin/vendor/elk.bundled.js'); }
        catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
            throw new Error('架构布局引擎尚未构建：请先运行 npm run build:circuit 生成 bin/vendor/elk.bundled.js。');
        }
        elk = new Engine();
    }
    const byId = cardsById(cards);
    const linked = new Set(edges.filter(edge => !edge.clockOnly).flatMap(edge => [edge.from, edge.to]));
    const local = new Set(edges.filter(edge => edge.clockOnly).flatMap(edge => [edge.from, edge.to]));
    // 只接时钟/复位的模块靠近同名边界标签放置，避免占据主数据通路的分层。
    const support = cards.filter(card => local.has(card.id) && !linked.has(card.id));
    const primary = cards.filter(card => !support.includes(card));
    const layout = await elk.layout({
        id: 'diagram',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.edgeRouting': 'ORTHOGONAL',
            // 简图卡片边缘有 24px 时钟/复位引线，相邻两张卡对着的引线要留出 48px；
            // 节点间距 24、层间距 56，正好让两条引线之间还剩 8px。
            'elk.spacing.nodeNode': '24',
            'elk.layered.spacing.nodeNodeBetweenLayers': detailed ? '68' : '56',
            'elk.layered.spacing.edgeNodeBetweenLayers': detailed ? '12' : '10',
            'elk.layered.spacing.edgeEdgeBetweenLayers': detailed ? '12' : '6',
            'elk.layered.cycleBreaking.strategy': 'GREEDY',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            // 网络单纯形摆放把各层节点在竖直方向摊平，避免顶层长链被拉成斜向长条。
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            // 先排列主通路，超出内容列时改用多行布局。
            ...(detailed ? {} : { 'elk.layered.layering.strategy': 'LONGEST_PATH' }),
            ...(wrapped ? {
                'elk.layered.wrapping.strategy': 'MULTI_EDGE',
                'elk.layered.wrapping.multiEdge.improveCuts': 'true',
                // 当前 ELK 的跨行缩短阶段会在固定端口长链上抛错，保留原始正交路线。
                'elk.layered.wrapping.multiEdge.improveWrappedEdges': 'false',
                'elk.aspectRatio': '1.6',
            } : {}),
            'elk.padding': detailed ? '[top=24,left=24,bottom=24,right=24]' : '[top=16,left=12,bottom=16,right=12]',
        },
        children: elkChildren(primary),
        edges: edges.filter(edge => !edge.clockOnly).map(edge => ({
            id: edge.id,
            sources: [anchorFor(byId.get(edge.from), edge.fromPort, edge.id) || edge.from],
            targets: [anchorFor(byId.get(edge.to), edge.toPort, edge.id) || edge.to],
        })),
    });
    if (!detailed && !wrapped && layout.width > OVERVIEW_MAX_WIDTH) return runLayout(cards, edges, detailed, true);
    layout.wrapped = wrapped;
    // 折行页的边界端口不参与折叠，固定到左右外缘（连线在 layoutDiagram 改走外缘通道）。
    if (wrapped) placeBoundaryColumns(cards, edges, layout);
    if (support.length) {
        const gap = 28, padding = 16, heading = 34;
        const top = layout.height + 20;
        // 换行宽度仍以主图宽度为上限，带宽最后再按内容 bbox 收窄。
        const width = Math.max(layout.width, 700);
        let x = padding, y = top + heading, rowHeight = 0, contentRight = padding;
        const ordered = [...support].sort((left, right) => {
            const rank = card => edgeSide(card) === 'left' ? 0 : edgeSide(card) === 'right' ? 2 : 1;
            return rank(left) - rank(right);
        });
        for (const card of ordered) {
            if (x > padding && x + card.width > width - padding) {
                x = padding;
                y += rowHeight + gap;
                rowHeight = 0;
            }
            layout.children.push({ id: card.id, x, y, width: card.width, height: card.height });
            contentRight = Math.max(contentRight, x + card.width);
            x += card.width + gap;
            rowHeight = Math.max(rowHeight, card.height);
        }
        // 带宽按带内卡片/端子的实际 bbox 收窄，右侧不再铺满画布；底部与画布对齐。
        const contentBottom = y + rowHeight;
        const headingText = CLOCK_BAND_TITLE;
        const regionWidth = Math.max(contentRight + padding, 16 + textWidth(headingText, 11, UI) + padding, 320);
        layout.clockRegion = { x: 0, y: top, width: regionWidth, height: contentBottom + padding - top };
        layout.width = Math.max(layout.width, regionWidth);
        layout.height = contentBottom + padding;
    }
    return layout;
}

module.exports = { portForPin, elkChildren, anchorFor, runLayout };
