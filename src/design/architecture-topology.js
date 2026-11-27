'use strict';

const { TITLE_NAMES, FONT, MONO, PAD_TITLES, clipText } = require('./architecture-metrics');
const { signalKind, isClockLike } = require('./architecture-details');
const { roleScore } = require('./interface-evidence');
function footnoteText(labels) {
    if (!labels?.length) return '';
    const shown = labels.slice(0, TITLE_NAMES);
    const rest = labels.length - shown.length;
    return '≡ ' + shown.join(' · ') + (rest > 0 ? ' +' + rest : '');
}

function internalText(bundles) {
    if (!bundles?.length) return '';
    // 折叠卡只显示条数，完整清单在同名同色面板里展开，避免把名字挤成一行 +N。
    return '组内连接 ' + bundles.length + ' 条';
}

/**
 * 分组卡片沿边缘排的对外端口清单。同名连线合成一个端口：一组对外的
 * 同名连接本来就是同一条逻辑通道，重复画只会让边缘堆满同一个名字。
 * @param {Array<{id:string, peer:string, name?:string, bus?:boolean}>} incident 该卡片的关联边。
 * @returns {Array<{caption:string, bus:boolean, edges:string[]}>}
 */
function groupEdgePorts(incident) {
    const ports = new Map();
    for (const item of incident || []) {
        const caption = item.name || item.caption;
        if (!caption) continue;
        if (!ports.has(caption)) ports.set(caption, { caption, bus: Boolean(item.bus), edges: [] });
        ports.get(caption).edges.push(item.id);
    }
    return [...ports.values()];
}

/**
 * 时钟/复位网络收成卡底两行：CLK / RST 各一行，按首次出现顺序去重。
 * 每个网络保留所属连线 id，渲染成独立 tspan 以便逐网悬浮查源端/接收端。
 * @param {Array<{net?:string, caption:string, links?:string[]}>} ports
 * @returns {Array<{label:'CLK'|'RST', items:Array<{name:string, link?:string}>}>}
 */
function clockRowItems(ports) {
    const groups = { CLK: [], RST: [] };
    const seen = { CLK: new Set(), RST: new Set() };
    for (const port of ports) {
        const names = String(port.net || port.caption || '').split(' / ').map(name => name.trim()).filter(Boolean);
        for (const name of names.length ? names : [port.caption || '']) {
            const label = signalKind(name) === 'RST' ? 'RST' : 'CLK';
            if (seen[label].has(name)) continue;
            seen[label].add(name);
            groups[label].push({ name, link: port.links?.[0] });
        }
    }
    return ['CLK', 'RST'].filter(label => groups[label].length).map(label => ({ label, items: groups[label] }));
}

function boundaryCategory(node) {
    const port = node.ports?.[0];
    const direction = port?.direction && port.direction !== 'unknown' ? port.direction : node.direction;
    if (direction === 'interface') return 'interface';
    if (direction === 'input' || direction === 'output' || direction === 'inout') return direction;
    return 'other';
}

function portMeta(port) {
    if (!port) return '';
    if (port.direction === 'interface') return clipText(port.type || '类型待确认', 132, FONT.padMeta, MONO);
    if (port.width == null) return '';
    return '[' + port.width + ']';
}

/* ---------- 拓扑 ---------- */

/** 把页面投影成卡片与连线；简图按功能分组折叠实例，边界端口合并为端口排。 */
function diagramTopology(page, mode) {
    const overview = mode === 'overview';
    // 简图把时钟/复位折到卡底两行，按同名标签连两端（只留 10px 接线）；详细图保留完整走线。
    const clockLinks = new Map(page.links.filter(link => link.labeled || link.kind === 'signal' &&
        [...link.names || [link.name], ...link.endpoints.map(endpoint => endpoint.port || '')].some(name => isClockLike(name))).map(link => [link.id, true]));
    const drawn = page.links;
    const wired = new Set(drawn.filter(link => link.endpoints.length > 1).flatMap(link => link.endpoints.map(endpoint => endpoint.node)));
    const labels = new Map();
    for (const link of page.links.filter(link => link.labeled)) for (const endpoint of link.endpoints) {
        if (!labels.has(endpoint.node)) labels.set(endpoint.node, new Set());
        for (const name of link.names) labels.get(endpoint.node).add(name);
    }
    const neighbor = new Map();
    for (const link of drawn) for (const endpoint of link.endpoints) {
        if (!neighbor.has(endpoint.node)) neighbor.set(endpoint.node, new Set());
        for (const other of link.endpoints) if (other.node !== endpoint.node) neighbor.get(endpoint.node).add(other.node);
    }
    const cards = [], groups = new Map(), locations = new Map(), boundary = [];
    for (const node of page.nodes) {
        if (node.kind === 'boundary') {
            if (!(overview && !wired.has(node.id))) boundary.push(node);
            continue;
        }
        const group = overview && node.group;
        let card = group && groups.get(group);
        if (!card) {
            card = { id: 'card-' + cards.length, title: group || node.title || node.name, kind: node.kind, nodes: [] };
            cards.push(card);
            if (group) groups.set(group, card);
        }
        card.nodes.push(node);
        locations.set(node.id, card.id);
    }
    const byCategory = new Map();
    for (const node of boundary) {
        const category = boundaryCategory(node);
        const role = category === 'interface' ? roleScore({ modport: node.ports?.[0]?.type?.split('.')[1] }) : 0;
        const side = category === 'output' || role > 0 ? 'right' : 'left';
        const key = side + ':' + category;
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key).push(node);
    }
    const padBoundary = boundary.length > 2;
    for (const [key, nodes] of byCategory) {
        const [edgeSide, category] = key.split(':');
        if (padBoundary) {
            const card = { id: 'pad-' + cards.length, kind: 'pad', title: PAD_TITLES[category], category, edgeSide, nodes,
                nodePeers: new Map(nodes.map(node => [node.id, [...neighbor.get(node.id) || []]])) };
            cards.push(card);
            for (const node of nodes) locations.set(node.id, card.id);
            continue;
        }
        for (const node of nodes) {
            const card = { id: 'card-' + cards.length, kind: 'boundary', title: node.title || node.name, category, edgeSide, nodes: [node] };
            cards.push(card);
            locations.set(node.id, card.id);
        }
    }
    const pairs = new Map(), edges = [];
    // 端口排的每一行都要独立成线，才能追出接口束属于哪条连线；涉及点名的边不进入合并表。
    const padIds = new Set(cards.filter(card => card.kind === 'pad').map(card => card.id));
    const cardOf = new Map(cards.map(card => [card.id, card]));
    // 简图把同一功能组的实例折成一张卡片后，组内连线无法再画成线。
    // 这些连线必须记到卡片的组内束清单里，否则读者会以为组内实例之间没有连接。
    function noteInternal(cardId, link) {
        const owner = cardOf.get(cardId);
        if (!owner || owner.kind !== 'instance') return;
        if (!owner.internal) owner.internal = [];
        if (!owner.internal.some(item => item.id === link.id)) {
            owner.internal.push({ id: link.id, name: link.name, kind: link.kind, ends: link.endpoints.map(endpoint => endpoint.node) });
        }
    }
    function add(source, target, link, forward) {
        if (!source.card || !target.card || pinKey(source) === pinKey(target)) return;
        if (overview && source.card === target.card) {
            noteInternal(source.card, link);
            return;
        }
        const clock = clockLinks.has(link.id);
        // 同名标签需要保留各网络身份，普通通路仍按模块对合并。
        const merged = overview && !clock && link.kind !== 'interface' && !padIds.has(source.card) && !padIds.has(target.card);
        const key = [source.card, target.card].sort().join('/') + '|' + (clock ? '\u0000clock' : link.kind);
        let edge = merged && pairs.get(key);
        if (!edge) {
            edge = { id: 'edge-' + edges.length, from: source.card, to: target.card, fromPort: source.port, toPort: target.port,
                forward: false, reverse: false, clock, clockOnly: overview && clock, links: [] };
            edges.push(edge);
            if (merged) pairs.set(key, edge);
        }
        if (forward) edge[edge.from === source.card ? 'forward' : 'reverse'] = true;
        if (!edge.links.includes(link.id)) edge.links.push(link.id);
    }
    for (const link of drawn) {
        const refs = link.endpoints.map(endpoint => ({ card: locations.get(endpoint.node), port: endpoint.port }));
        const endpoints = [...new Map(refs.filter(ref => ref.card).map(ref => [pinKey(ref), ref])).values()];
        if (endpoints.length < 2) {
            // 折进同一张卡片后两端合成一个锚点：把这条连线记成组内束，不能静默丢弃。
            if (overview && endpoints.length === 1) noteInternal(endpoints[0].card, link);
            continue;
        }
        if (link.routes.length && endpoints.length === 2) {
            for (const route of link.routes) add(refs[route.source], refs[route.target], link, true);
        } else if (endpoints.length === 2) {
            add(endpoints[0], endpoints[1], link, false);
        } else {
            const boundaryIndex = link.endpoints.findIndex(endpoint => endpoint.boundary);
            if (boundaryIndex !== -1 && !link.routes.length) {
                for (const endpoint of endpoints) add(refs[boundaryIndex], endpoint, link, false);
                continue;
            }
            const hub = { id: 'card-' + cards.length, title: link.name, kind: 'junction', link: link.id, count: link.endpoints.length, nodes: [] };
            cards.push(hub);
            const junction = { card: hub.id };
            const senders = new Set(link.routes.map(route => pinKey(refs[route.source])));
            const receivers = new Set(link.routes.map(route => pinKey(refs[route.target])));
            for (const endpoint of endpoints) {
                if (senders.has(pinKey(endpoint))) add(endpoint, junction, link, true);
                else add(junction, endpoint, link, receivers.has(pinKey(endpoint)));
            }
        }
    }
    const links = new Map(page.links.map(link => [link.id, link]));
    const byCard = new Map(cards.map(card => [card.id, card]));
    for (const edge of edges) {
        // 布局朝向按"左边界 → 内部 → 右边界"归一，电气方向只体现在箭头。
        const from = byCard.get(edge.from), to = byCard.get(edge.to);
        const fromSide = edgeSide(from), toSide = edgeSide(to);
        if (fromSide === 'right' && toSide !== 'right' || toSide === 'left' && fromSide !== 'left') {
            [edge.from, edge.to] = [edge.to, edge.from];
            [edge.fromPort, edge.toPort] = [edge.toPort, edge.fromPort];
            [edge.forward, edge.reverse] = [edge.reverse, edge.forward];
        }
        edge.names = edge.links.map(id => links.get(id).name);
        // 端口排行名与引脚名一致时不再重复标注，只保留名称不同或汇聚的连线标签。
        const sameEnds = edge.links.length === 1 && edge.fromPort && edge.fromPort === edge.toPort;
        // 简图里的时钟域通道必须自解释：读者要能看出这条虚线是时钟/复位，而不是普通数据。
        edge.label = edge.clock
            ? clipText(edge.names[0], 156, FONT.label, MONO)
            : mode === 'detailed' && !sameEnds
                ? edge.links.length === 1 ? clipText(edge.names[0], 156, FONT.label, MONO) : edge.links.length + ' 条连接'
                : '';
    }
    if (overview) {
        // 时钟域已画成可见虚线，卡片不再重复挂 ≡ 脚注；只有连时钟边都没落上的
        // 卡片（例如整组时钟都在组内）才保留脚注，避免信息丢失。
        const onClockEdge = new Set(edges.flatMap(edge => edge.clock ? [edge.from, edge.to] : []));
        for (const card of cards) {
            if (card.kind !== 'instance' || onClockEdge.has(card.id)) continue;
            card.labels = [...new Set(card.nodes.flatMap(node => [...labels.get(node.id) || []]))];
        }
    }
    return { cards, edges };
}

const pinKey = ({ card, port }) => JSON.stringify([card, port]);
const edgeSide = card => card && (card.kind === 'pad' || card.kind === 'boundary') ? card.edgeSide : undefined;

module.exports = { footnoteText, internalText, groupEdgePorts, clockRowItems, boundaryCategory, portMeta, diagramTopology, pinKey, edgeSide };
