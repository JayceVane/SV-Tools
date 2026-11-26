'use strict';

const { escape, portDescription } = require('./architecture-details');
const { terminalCaption, terminalWidth, terminalSymbol } = require('../circuit/symbol-library');
const { roleScore } = require('./interface-evidence');

/* ---------- 版式常量（px） ----------
   卡片：标题带 34（每多一行 +17）、副标题 24、引脚行距 18、共享网络脚注 20；
   端口排：标题带 28、行距 18；连线标签高 16；拐角半径 4。 */
const HEAD = 34;
const HEAD_LINE = 17;
const SUB = 24;
const PIN_PITCH = 18;
const BODY_PAD = 2;
const FOOT = 20;
const PAD_ROW = 18;
// 图2 边界端口符号：沿用 BD terminalSymbol 的尺寸（宽 20、高 12）。
const PAD_SYM = 20;
const PAD_SYM_H = 12;
const CORNER = 4;
const LABEL_H = 16;
const ARROW = 6;
const TITLE_MAX = 316;
const NOTE_MAX = 316;
const TITLE_NAMES = 3;
const ENTRY_ROW = 22;
// 分组卡片的对外端口行高：一行一个端口，名称 + 端点符号。
const GROUP_PORT_ROW = 22;

const FONT = {
    title: 12.5, subtitle: 10.5, chip: 9.5, pin: 10.5, foot: 10, label: 10,
    padTitle: 12, padName: 10.5, padMeta: 9.5, entryName: 11, entryType: 10, junction: 10.5,
};
const MONO = 0.6;
const UI = 0.55;

const PAD_TITLES = { input: '输入端口', output: '输出端口', inout: '双向端口', interface: '接口束', other: '待确认端口' };
const GLYPHS = { input: '→', output: '→', inout: '◆', interface: '≡', other: '·' };
const clockPort = /(?:^|_)(?:[a-z]*clk|clock|[a-z]*rstn?|[a-z]*resetn?)(?:_|$)/i;
let elk;

const isWide = character => character.codePointAt(0) > 255;
const textWidth = (value, size, ratio = MONO) => [...String(value ?? '')]
    .reduce((width, character) => width + (isWide(character) ? size : size * ratio), 0);
const round = value => Math.round(value * 10) / 10;

/** 按显示宽度裁剪并加省略号。 @param {unknown} value @param {number} maxWidth @param {number} size @param {number} ratio @returns {string} */
function clipText(value, maxWidth, size, ratio = MONO) {
    const text = String(value ?? '');
    if (textWidth(text, size, ratio) <= maxWidth) return text;
    const limit = maxWidth - textWidth('…', size, ratio);
    let clipped = '';
    for (const character of text) {
        if (textWidth(clipped + character, size, ratio) > limit) break;
        clipped += character;
    }
    return clipped + '…';
}

/** 标题按词换行，超长以省略号结束。 @param {unknown} value @param {number} maxWidth @param {number} maxLines @returns {string[]} */
function wrapTitle(value, maxWidth, maxLines = 2) {
    const units = [];
    let word = '';
    for (const character of String(value ?? '')) {
        if (isWide(character) || /\s/u.test(character)) {
            if (word) { units.push(word); word = ''; }
            units.push(character);
        } else word += character;
    }
    if (word) units.push(word);
    const lines = [''];
    let index = 0;
    while (index < units.length) {
        const unit = units[index], current = lines[lines.length - 1];
        if (!current.trim() && textWidth(unit, FONT.title, UI) > maxWidth) {
            lines[lines.length - 1] = clipText(unit, maxWidth, FONT.title, UI);
            index++;
            continue;
        }
        if (current.trim() && textWidth(current + unit, FONT.title, UI) > maxWidth) {
            if (lines.length >= maxLines) break;
            lines.push('');
            continue;
        }
        lines[lines.length - 1] = current + unit;
        index++;
    }
    if (index < units.length && lines.length) {
        const last = lines.length - 1;
        lines[last] = clipText(lines[last].trim() + '…', maxWidth, FONT.title, UI);
    }
    const visible = lines.map(line => line.trim()).filter(Boolean);
    return visible.length ? visible : ['（未命名）'];
}

function footnoteText(labels) {
    if (!labels?.length) return '';
    const shown = labels.slice(0, TITLE_NAMES);
    const rest = labels.length - shown.length;
    return '≡ ' + shown.join(' · ') + (rest > 0 ? ' +' + rest : '');
}

function internalText(bundles) {
    if (!bundles?.length) return '';
    const shown = bundles.slice(0, TITLE_NAMES).map(bundle => bundle.name);
    const rest = bundles.length - shown.length;
    return '组内束 ' + shown.join(' · ') + (rest > 0 ? ' +' + rest : '');
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
    // 简图按同名标签呈现时钟/复位，保留两端的连接与方向；详细图保留完整走线。
    const clockLinks = new Map(page.links.filter(link => link.labeled || link.kind === 'signal' &&
        [...link.names || [link.name], ...link.endpoints.map(endpoint => endpoint.port || '')].some(name => clockPort.test(name))).map(link => [link.id, true]));
    const drawn = page.links;
    const wired = new Set(drawn.filter(link => link.endpoints.length > 1).flatMap(link => link.endpoints.map(endpoint => endpoint.node)));
    const labels = new Map();
    for (const link of page.links.filter(link => link.labeled)) for (const endpoint of link.endpoints) {
        if (!labels.has(endpoint.node)) labels.set(endpoint.node, new Set());
        for (const name of link.names) labels.get(endpoint.node).add(name);
    }
    const neighbour = new Map();
    for (const link of drawn) for (const endpoint of link.endpoints) {
        if (!neighbour.has(endpoint.node)) neighbour.set(endpoint.node, new Set());
        for (const other of link.endpoints) if (other.node !== endpoint.node) neighbour.get(endpoint.node).add(other.node);
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
                nodePeers: new Map(nodes.map(node => [node.id, [...neighbour.get(node.id) || []]])) };
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
        if (!owner.internal.some(item => item.id === link.id)) owner.internal.push({ id: link.id, name: link.name, kind: link.kind });
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
                forward: false, reverse: false, clock, local: overview && clock, links: [] };
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
            ? clipText(edge.names.length === 1 ? edge.names[0] : edge.names.length + ' 个时钟/复位', 156, FONT.label, MONO)
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

/* ---------- 卡片度量 ---------- */

function pinCaption(port) {
    return (port.direction === 'interface' ? '≡ ' : '') + port.name;
}

function roleKey(port) {
    const [type, role] = String(port.type || '').split('.');
    return (role || '') + '\u0000' + (type || '') + '\u0000' + port.name;
}

function compareKey(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const left = String(a), right = String(b);
    return left < right ? -1 : left > right ? 1 : 0;
}

function buildPins(card, assignment) {
    const ports = card.nodes[0].ports || [];
    const planned = assignment?.get(card.id);
    const pins = ports.map((port, declaration) => {
        const plan = planned?.get(port.name);
        const side = port.direction === 'input' ? 'WEST' : port.direction === 'output' ? 'EAST'
            : plan?.side || 'WEST';
        const bus = port.direction === 'interface';
        return { port, declaration, side, bus, caption: pinCaption(port),
            key: bus ? roleKey(port) : plan?.key ?? declaration };
    });
    for (const side of ['WEST', 'EAST']) {
        // 标量引脚按对端高度排序，接口束引脚按 modport 角色与名称稳定排序，两组不混排。
        const sidePins = pins.filter(pin => pin.side === side);
        sidePins.sort((a, b) => (a.bus - b.bus) || compareKey(a.key, b.key) || (a.declaration - b.declaration));
        sidePins.forEach((pin, index) => { pin.order = index; });
    }
    return pins;
}

function measureInstance(card, detailed, assignment, incident) {
    const multi = card.nodes.length > 1;
    // 简图里的分组卡片按 BD 式画法：不列组内实例，只沿边缘排对外的接口端口。
    // 读者关心的是这一组对外提供/消费了什么，而不是组里装了哪些实例。
    const grouped = multi && !detailed;
    const node = card.nodes[0];
    const title = card.title || node?.name || '';
    card.subH = SUB;
    card.subtitleName = grouped ? '' : multi ? card.nodes.length + ' 个实例' : node?.name && node.name !== title ? node.name : '';
    card.chips = [];
    if (!multi && node) {
        if (node.type) card.chips.push({ kind: 'type', text: clipText(node.type, 160, FONT.chip, MONO) });
        if (node.implementation === 'stub') card.chips.push({ kind: 'status stub', text: '桩' });
        else if (node.implementation === 'unresolved') card.chips.push({ kind: 'status unresolved', text: '未解析' });
    }
    for (const chip of card.chips) chip.width = Math.ceil((textWidth(chip.text, FONT.chip, MONO) + 10) / 2) * 2;
    const subtitleWidth = card.subtitleName || card.chips.length
        ? 12 + textWidth(card.subtitleName, FONT.subtitle, MONO) + (card.subtitleName && card.chips.length ? 10 : 0)
            + card.chips.reduce((sum, chip) => sum + chip.width + 6, 0) : 0;
    card.entries = multi && !grouped ? card.nodes.map(entryNode => ({ node: entryNode, name: entryNode.name,
        type: entryNode.type || '未解析', y: 0 })) : [];
    // 简图在落点标明实际端口，分组卡片以对外网络名命名。
    card.groupPorts = detailed ? [] : groupEdgePorts((incident || []).map(item => ({ ...item,
        name: !multi && item.port ? item.port : item.name })));
    for (const port of card.groupPorts) {
        const matching = (incident || []).filter(item => port.edges.includes(item.id));
        port.clock = matching.every(item => item.clock);
        port.net = [...new Set(matching.filter(item => item.clock).map(item => item.name))].join(' / ');
        if (port.clock && port.net !== port.caption) port.caption += ' · ' + port.net;
    }
    const entryWidth = card.entries.length
        ? 12 + Math.max(...card.entries.map(entry => textWidth(entry.name, FONT.entryName, MONO))) + 24
            + Math.max(...card.entries.map(entry => textWidth(entry.type, FONT.entryType, MONO))) + 12 : 0;
    const sidePorts = { WEST: [], EAST: [] };
    for (const port of card.groupPorts) {
        port.side = assignment?.get(card.id)?.get(port.edges[0]) || 'WEST';
        sidePorts[port.side].push(port);
    }
    const columnWidth = ports => Math.max(0, ...ports.map(port => textWidth(port.caption, FONT.pin, MONO)));
    const portWidth = card.groupPorts.length ? 36 + columnWidth(sidePorts.WEST) + columnWidth(sidePorts.EAST) : 0;
    card.footnote = footnoteText(card.labels);
    // 组内束单独占一行，避免和标签网络混在一起（前者是组内实例之间的连接，后者是时钟复位这类同名网络）。
    card.internalText = internalText(card.internal);
    const footWidth = card.footnote || card.internalText
        ? 24 + Math.max(card.footnote ? Math.min(NOTE_MAX, textWidth(card.footnote, FONT.foot, MONO)) : 0,
            card.internalText ? Math.min(NOTE_MAX, textWidth(card.internalText, FONT.foot, MONO)) : 0) : 0;
    card.pins = detailed && card.nodes.length === 1 && (node?.ports || []).length ? buildPins(card, assignment) : [];
    let westMax = 0, eastMax = 0;
    for (const pin of card.pins) {
        const width = textWidth(pin.caption, FONT.pin, MONO);
        if (pin.side === 'WEST') westMax = Math.max(westMax, width);
        else eastMax = Math.max(eastMax, width);
    }
    const pinWidth = card.pins.length ? 12 + westMax + (eastMax ? 20 + eastMax : 0) + 12 : 0;
    // 单侧引脚时按引脚列宽收窄卡片，标题允许三行，避免标题把卡片撑出大片空白。
    const compact = card.pins.length > 0 && (westMax > 0) !== (eastMax > 0);
    const base = Math.max(152, subtitleWidth, entryWidth, portWidth, footWidth, pinWidth, compact ? 196 : 0);
    let titleMax = 232;
    if (detailed) titleMax = compact ? Math.max(160, Math.min(TITLE_MAX, base - 24)) : TITLE_MAX;
    card.titleLines = wrapTitle(title, titleMax, detailed && !compact ? 2 : 3);
    const titleWidth = Math.max(0, ...card.titleLines.map(line => textWidth(line, FONT.title, UI)));
    card.headH = HEAD + (card.titleLines.length - 1) * HEAD_LINE;
    card.width = Math.ceil(Math.max(base, titleWidth + 24) / 4) * 4;
    const bodyTop = card.headH + card.subH;
    const scalars = { WEST: [], EAST: [] }, buses = { WEST: [], EAST: [] };
    for (const pin of card.pins) (pin.bus ? buses : scalars)[pin.side].push(pin);
    const scalarRows = Math.max(scalars.WEST.length, scalars.EAST.length);
    const busRows = Math.max(buses.WEST.length, buses.EAST.length);
    const gap = scalarRows && busRows ? 12 : 0;
    card.pinSplit = gap ? bodyTop + BODY_PAD + scalarRows * PIN_PITCH + gap / 2 : undefined;
    for (const side of ['WEST', 'EAST']) {
        scalars[side].forEach((pin, index) => { pin.row = index; pin.offset = 0; });
        buses[side].forEach((pin, index) => { pin.row = index; pin.offset = scalarRows * PIN_PITCH + gap; });
    }
    card.bodyTop = bodyTop;
    card.pins.forEach(pin => {
        const west = pin.side === 'WEST';
        pin.x = west ? 0 : card.width;
        pin.y = bodyTop + BODY_PAD + pin.offset + pin.row * PIN_PITCH + PIN_PITCH / 2;
        pin.id = card.id + '-pin-' + pin.port.name;
    });
    card.entries.forEach((entry, index) => { entry.y = bodyTop + index * ENTRY_ROW; });
    const body = card.pins.length ? scalarRows * PIN_PITCH + gap + busRows * PIN_PITCH + BODY_PAD * 2 : 0;
    const portsHeight = card.groupPorts.length ? BODY_PAD * 2 + card.groupPorts.length * GROUP_PORT_ROW : 0;
    const content = card.entries.length ? card.entries.length * ENTRY_ROW : card.groupPorts.length ? portsHeight : body;
    const footLines = (card.footnote ? 1 : 0) + (card.internalText ? 1 : 0);
    card.height = bodyTop + content + footLines * FOOT;
    let x = card.width - 12;
    for (let index = card.chips.length - 1; index >= 0; index--) {
        const chip = card.chips[index];
        x -= chip.width;
        chip.x = x;
        chip.y = card.headH + Math.round((SUB - 15) / 2);
        x -= 6;
    }
    card.portIndex = new Map(card.nodes[0]?.ports?.map((port, index) => [port.name, index]) || []);
    // 简图的通路锚点与具名端口共用坐标。
    card.bodyAnchors = [];
    card.edgeAnchorIds = new Map();
    if (!detailed) {
        if (card.groupPorts.length) {
            // 分组卡片按端口定位：每个端口占一行，连线锚点就是端口本身，
            // 读者从连线落点就能看出这一组对外接的是哪条通道。
            card.groupLayout = [];
            let westRow = 0, eastRow = 0;
            for (const side of ['WEST', 'EAST']) {
                for (const port of sidePorts[side]) {
                    const row = side === 'WEST' ? westRow++ : eastRow++;
                    port.y = bodyTop + BODY_PAD + row * GROUP_PORT_ROW + GROUP_PORT_ROW / 2;
                    port.x = side === 'WEST' ? 0 : card.width;
                    port.id = card.id + '-group-' + side.toLowerCase() + '-' + row;
                    card.groupLayout.push(port);
                    card.bodyAnchors.push({ id: port.id, side, x: port.x, y: port.y });
                    for (const edgeId of port.edges) card.edgeAnchorIds.set(edgeId, port.id);
                }
            }
            card.height = bodyTop + BODY_PAD * 2 + Math.max(westRow, eastRow) * GROUP_PORT_ROW + footLines * FOOT;
            return;
        }
    }
}

function measurePad(card, assignment) {
    const byId = new Map(card.nodes.map(node => [node.id, node]));
    const order = assignment?.get(card.id) || card.nodes.map(node => node.id);
    const nodes = order.map(id => byId.get(id)).filter(Boolean);
    for (const node of card.nodes) if (!nodes.includes(node)) nodes.push(node);
    card.rows = nodes.map(node => {
        const port = node.ports?.[0];
        const direction = port?.direction && port.direction !== 'unknown' ? port.direction : node.direction;
        return { node, port, direction, glyph: GLYPHS[direction] || GLYPHS.other,
            name: port?.name || node.name, meta: portMeta(port) };
    });
    const nameMax = Math.max(0, ...card.rows.map(row => textWidth(row.name, FONT.padName, MONO)));
    const metaMax = Math.max(0, ...card.rows.map(row => textWidth(row.meta, FONT.padMeta, MONO)));
    // 图2 风格：没有表头与方框，宽度 = 端口符号 + 名称 + 类型小字。
    card.width = Math.ceil(Math.max(120, PAD_SYM + 8 + nameMax + 16 + metaMax + 8) / 4) * 4;
    card.eyebrow = '';
    card.rowH = card.rows.length > 10 ? 18 : PAD_ROW;
    card.height = card.rows.length * card.rowH;
    card.padSide = card.edgeSide === 'left' ? 'EAST' : 'WEST';
    card.rows.forEach((row, index) => {
        row.y = index * card.rowH + card.rowH / 2;
        row.side = card.padSide;
        row.x = card.padSide === 'EAST' ? card.width : 0;
        row.id = card.id + '-row-' + index;
        row.top = index * card.rowH;
        // 每行一个 20×12 的终端符号：尖端朝图面外侧（接线方向），平边贴名称一侧。
        row.terminal = terminalSymbol(PAD_SYM, PAD_SYM_H, row.side, row.direction);
    });
}

function measureFlag(card) {
    const node = card.nodes[0];
    const port = node.ports?.[0];
    const width = port?.width;
    const bus = port?.direction === 'interface';
    const label = (bus ? '≡ ' : '') + node.name + (width > 1 ? ' [' + width + ']' : '');
    const side = card.edgeSide === 'left' ? 'EAST' : 'WEST';
    card.width = terminalWidth(label);
    card.height = 26;
    card.title = terminalCaption(label).text;
    card.terminal = terminalSymbol(card.width, card.height, side, node.direction);
    card.terminalPort = { id: card.id + '-terminal', x: side === 'EAST' ? card.width : 0, y: card.height / 2, side };
}

function measureJunction(card) {
    card.titleLines = [clipText(card.title || '', 200, FONT.junction, MONO)];
    card.chip = card.count ? card.count + ' 端' : '';
    const chipWidth = card.chip ? Math.ceil((textWidth(card.chip, FONT.chip, MONO) + 10) / 2) * 2 : 0;
    card.chipWidth = chipWidth;
    card.width = Math.max(96, Math.ceil((24 + textWidth(card.titleLines[0], FONT.junction, MONO) + (chipWidth ? 12 + chipWidth : 0)) / 4) * 4);
    card.height = 30;
}

function measureCards(cards, detailed, assignment, incident) {
    for (const card of cards) {
        if (card.kind === 'pad') measurePad(card, assignment);
        else if (card.kind === 'boundary') measureFlag(card);
        else if (card.kind === 'junction') measureJunction(card);
        else measureInstance(card, detailed, assignment, incident.get(card.id));
    }
}

/* ---------- 两遍排布：先粗排，再按对端位置分配引脚东西侧与行序 ---------- */

function cardsById(cards) {
    return new Map(cards.map(card => [card.id, card]));
}

function attachPeers(cards, edges) {
    const byId = cardsById(cards);
    for (const card of cards) {
        card.peerPorts = new Map();
        if (!card.nodePeers) card.nodePeers = new Map();
    }
    for (const edge of edges) {
        const from = byId.get(edge.from), to = byId.get(edge.to);
        if (!from || !to) continue;
        if (edge.fromPort) {
            if (!from.peerPorts.has(edge.fromPort)) from.peerPorts.set(edge.fromPort, []);
            from.peerPorts.get(edge.fromPort).push({ card: to, outgoing: edge.forward });
        }
        if (edge.toPort) {
            if (!to.peerPorts.has(edge.toPort)) to.peerPorts.set(edge.toPort, []);
            to.peerPorts.get(edge.toPort).push({ card: from, outgoing: false });
        }
    }
    const nodeCard = new Map();
    for (const card of cards) for (const node of card.nodes) nodeCard.set(node.id, card);
    for (const card of cards) {
        if (card.kind !== 'pad') continue;
        card.nodePeerCards = new Map();
        for (const node of card.nodes) {
            const peers = new Set();
            for (const id of card.nodePeers.get(node.id) || []) {
                const peer = nodeCard.get(id);
                if (peer && peer.id !== card.id) peers.add(peer.id);
            }
            card.nodePeerCards.set(node.id, [...peers]);
        }
    }
}

function guessSide(card, port) {
    const peers = card.peerPorts?.get(port.name) || [];
    let score = 0;
    for (const peer of peers) {
        if (peer.card.kind === 'pad' || peer.card.kind === 'boundary') score += peer.card.edgeSide === 'left' ? -1 : 1;
        else score += peer.outgoing ? 1 : -1;
    }
    return score > 0 ? 'EAST' : 'WEST';
}

function initialAssignment(cards, detailed, incident) {
    const assignment = new Map();
    const byId = new Map(cards.map(card => [card.id, card]));
    for (const card of cards) {
        if (!detailed && card.kind === 'instance') {
            const sides = new Map();
            for (const item of incident.get(card.id) || []) {
                const peer = byId.get(item.peer);
                const left = peer && (peer.kind === 'pad' || peer.kind === 'boundary') ? peer.edgeSide === 'left' : true;
                const direction = card.nodes.length === 1 && card.nodes[0].ports.find(port => port.name === item.port)?.direction;
                let side = left ? 'WEST' : 'EAST';
                if (item.clock) {
                    if (direction === 'output' || !direction && item.outgoing) side = 'EAST';
                    else if (direction === 'input') side = 'WEST';
                }
                sides.set(item.id, side);
            }
            assignment.set(card.id, sides);
            continue;
        }
        if (card.kind === 'instance' && card.nodes.length === 1) {
            const order = new Map();
            const ports = card.nodes[0].ports || [];
            const sides = ports.map(port => port.direction === 'input' ? 'WEST' : port.direction === 'output' ? 'EAST' : guessSide(card, port));
            ports.forEach((port, declaration) => {
                order.set(port.name, { side: sides[declaration], index: declaration });
            });
            assignment.set(card.id, order);
        } else if (card.kind === 'pad') {
            assignment.set(card.id, card.nodes.map(node => node.id));
        }
    }
    return assignment;
}

function peerAverage(card, port, positions, field) {
    const peers = card.peerPorts?.get(port.name) || [];
    let sum = 0, count = 0;
    for (const peer of peers) {
        const info = positions.get(peer.card.id);
        if (!info) continue;
        sum += field === 'x' ? info.x + info.width / 2 : info.y + info.height / 2;
        count++;
    }
    return count ? sum / count : undefined;
}

function nodeAverage(card, node, positions, field) {
    let sum = 0, count = 0;
    for (const id of card.nodePeerCards?.get(node.id) || []) {
        const info = positions.get(id);
        if (!info) continue;
        sum += field === 'x' ? info.x + info.width / 2 : info.y + info.height / 2;
        count++;
    }
    return count ? sum / count : undefined;
}

function deriveAssignment(cards, layout, assignment, detailed, incident) {
    const positions = new Map(layout.children.map(child => [child.id, child]));
    const next = new Map();
    let changed = false;
    for (const card of cards) {
        const previous = assignment.get(card.id);
        if (!detailed && card.kind === 'instance') {
            const self = positions.get(card.id);
            const center = (self?.x || 0) + card.width / 2;
            const sides = new Map();
            for (const item of incident.get(card.id) || []) {
                const peer = positions.get(item.peer);
                const side = item.clock ? previous?.get(item.id) || 'WEST'
                    : peer ? peer.x + peer.width / 2 < center ? 'WEST' : 'EAST' : previous?.get(item.id) || 'WEST';
                sides.set(item.id, side);
            }
            next.set(card.id, sides);
            if (!sameSides(previous, sides)) changed = true;
            continue;
        }
        if (card.kind === 'instance' && card.nodes.length === 1 && card.pins?.length) {
            const self = positions.get(card.id);
            const center = (self?.x || 0) + card.width / 2;
            const sides = new Map(), keys = new Map();
            for (const pin of card.pins) {
                const port = pin.port;
                const fallback = previous?.get(port.name)?.side || 'WEST';
                let side;
                if (port.direction === 'input') side = 'WEST';
                else if (port.direction === 'output') side = 'EAST';
                else {
                    const average = peerAverage(card, port, positions, 'x');
                    side = average === undefined ? fallback : average < center ? 'WEST' : 'EAST';
                }
                sides.set(port.name, side);
                if (port.direction === 'interface') {
                    keys.set(port.name, roleKey(port));
                    continue;
                }
                const y = peerAverage(card, port, positions, 'y');
                keys.set(port.name, y === undefined ? card.portIndex.get(port.name) || 0 : Math.round(y));
            }
            const order = new Map();
            for (const [name, side] of sides) order.set(name, { side, index: keys.get(name) });
            next.set(card.id, order);
            if (!sameOrder(previous, order)) changed = true;
        } else if (card.kind === 'pad') {
            card.rows = card.rows || [];
            const sorted = card.nodes.map(node => ({ node, key: nodeAverage(card, node, positions, 'y') }))
                .sort((a, b) => (a.key ?? card.nodes.indexOf(a.node)) - (b.key ?? card.nodes.indexOf(b.node))
                    || card.nodes.indexOf(a.node) - card.nodes.indexOf(b.node))
                .map(item => item.node.id);
            next.set(card.id, sorted);
            if (!sameList(previous, sorted)) changed = true;
        }
    }
    return { assignment: next, changed };
}

function sameOrder(previous, next) {
    if (!previous || previous.size !== next.size) return false;
    for (const [key, value] of next) {
        const old = previous.get(key);
        if (!old || old.side !== value.side || old.index !== value.index) return false;
    }
    return true;
}

function sameSides(previous, next) {
    if (!previous || previous.size !== next.size) return false;
    for (const [key, value] of next) if (previous.get(key) !== value) return false;
    return true;
}

function sameList(previous, next) {
    if (!previous || previous.length !== next.length) return false;
    return next.every((value, index) => previous[index] === value);
}

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

async function runLayout(cards, edges, detailed) {
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
    const linked = new Set(edges.filter(edge => !edge.local).flatMap(edge => [edge.from, edge.to]));
    const local = new Set(edges.filter(edge => edge.local).flatMap(edge => [edge.from, edge.to]));
    // 只接时钟/复位的模块靠近同名边界标签放置，避免占据主数据通路的分层。
    const support = cards.filter(card => local.has(card.id) && !linked.has(card.id));
    const primary = cards.filter(card => !support.includes(card));
    const layout = await elk.layout({
        id: 'diagram',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.edgeRouting': 'ORTHOGONAL',
            'elk.spacing.nodeNode': detailed ? '24' : '16',
            'elk.layered.spacing.nodeNodeBetweenLayers': detailed ? '68' : '42',
            'elk.layered.spacing.edgeNodeBetweenLayers': detailed ? '12' : '6',
            'elk.layered.spacing.edgeEdgeBetweenLayers': detailed ? '12' : '6',
            'elk.layered.cycleBreaking.strategy': 'GREEDY',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            // 网络单纯形摆放把各层节点在竖直方向摊平，避免顶层长链被拉成斜向长条。
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            // 简图改用最长路径分层并收紧间距，保证 1100px 容器内不缩到不可读；详细图保持原参数。
            ...(detailed ? {} : { 'elk.layered.layering.strategy': 'LONGEST_PATH' }),
            'elk.padding': detailed ? '[top=24,left=24,bottom=24,right=24]' : '[top=16,left=12,bottom=16,right=12]',
        },
        children: elkChildren(primary),
        edges: edges.filter(edge => !edge.local).map(edge => ({
            id: edge.id,
            sources: [anchorFor(byId.get(edge.from), edge.fromPort, edge.id) || edge.from],
            targets: [anchorFor(byId.get(edge.to), edge.toPort, edge.id) || edge.to],
        })),
    });
    if (support.length) {
        const gap = 28, padding = 16, heading = 34;
        const top = layout.height + 20;
        const width = Math.max(layout.width, 700);
        let x = padding, y = top + heading, rowHeight = 0;
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
            x += card.width + gap;
            rowHeight = Math.max(rowHeight, card.height);
        }
        layout.width = Math.max(width, x - gap + padding);
        layout.height = y + rowHeight + padding;
        layout.clockRegion = { x: 0, y: top, width: layout.width, height: layout.height - top };
    }
    return layout;
}

/* ---------- 标签避让 ---------- */

const overlaps = (a, b, gap = 0) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x
    && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

function placeLabels(edges, cards, width, height) {
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
                    clock: edge.local, name: link.name, bus: link.kind === 'interface' });
            }
            // 只有一个关联连线时补一条汇总，避免非接口信号组丢掉"N 条"的规模感。
            if (!edge.links.length) incident.get(side).push({ id: edge.id, peer, name: '', bus: false });
        }
    }
    let assignment = initialAssignment(cards, detailed, incident);
    let layout, stable = false;
    for (let pass = 0; pass < 3 && !stable; pass++) {
        measureCards(cards, detailed, assignment, incident);
        layout = await runLayout(cards, edges, detailed);
        const derived = deriveAssignment(cards, layout, assignment, detailed, incident);
        stable = !derived.changed;
        assignment = derived.assignment;
    }
    if (!stable) {
        measureCards(cards, detailed, assignment, incident);
        layout = await runLayout(cards, edges, detailed);
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
        if (!edge.local) continue;
        for (const [id, port] of [[edge.from, edge.fromPort], [edge.to, edge.toPort]]) {
            const card = cards.find(card => card.id === id);
            const key = anchorFor(card, port, edge.id);
            const anchor = [...card.bodyAnchors || [], ...card.rows || [], card.terminalPort].filter(Boolean).find(item => item.id === key);
            if (!anchor) continue;
            const point = { x: card.x + anchor.x, y: card.y + anchor.y };
            const end = { x: point.x + (anchor.side === 'EAST' ? 10 : -10), y: point.y };
            edge.sections.push(id === edge.from ? { startPoint: point, endPoint: end } : { startPoint: end, endPoint: point });
        }
    }
    placeLabels(edges, cards, width, height);
    return { width, height, cards, edges, clockRegion: layout.clockRegion };
}

/* ---------- 渲染 ---------- */

function orthogonalPath(points, radius = CORNER) {
    const clean = [];
    for (const point of points) {
        const last = clean[clean.length - 1];
        if (!last || Math.abs(last.x - point.x) > 0.05 || Math.abs(last.y - point.y) > 0.05) clean.push(point);
    }
    if (clean.length < 2) return '';
    let path = 'M' + round(clean[0].x) + ',' + round(clean[0].y);
    for (let index = 1; index < clean.length - 1; index++) {
        const previous = clean[index - 1], point = clean[index], next = clean[index + 1];
        const inX = Math.sign(point.x - previous.x), inY = Math.sign(point.y - previous.y);
        const outX = Math.sign(next.x - point.x), outY = Math.sign(next.y - point.y);
        const lengthIn = Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
        const lengthOut = Math.abs(next.x - point.x) + Math.abs(next.y - point.y);
        const trim = Math.min(radius, lengthIn / 2, lengthOut / 2);
        const before = { x: point.x - inX * trim, y: point.y - inY * trim };
        const after = { x: point.x + outX * trim, y: point.y + outY * trim };
        path += ' L' + round(before.x) + ',' + round(before.y) + ' Q' + round(point.x) + ',' + round(point.y)
            + ' ' + round(after.x) + ',' + round(after.y);
    }
    const last = clean[clean.length - 1];
    return path + ' L' + round(last.x) + ',' + round(last.y);
}

function arrowPath(point, dx, dy, size = ARROW) {
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length, uy = dy / length;
    const base = { x: point.x - ux * size, y: point.y - uy * size };
    const nx = -uy * size / 2, ny = ux * size / 2;
    return 'M' + round(point.x) + ',' + round(point.y) + ' L' + round(base.x + nx) + ',' + round(base.y + ny)
        + ' L' + round(base.x - nx) + ',' + round(base.y - ny) + ' Z';
}

function headPath(width, height) {
    const radius = 5;
    return 'M0,' + height + ' L0,' + radius + ' Q0,0 ' + radius + ',0 L' + (width - radius) + ',0 Q' + width + ',0 '
        + width + ',' + radius + ' L' + width + ',' + height + ' Z';
}

function busGlyph(x, y) {
    const right = x + 8;
    return '<path class="pin-bus" d="M' + x + ',' + (y - 3) + 'H' + right + ' M' + x + ',' + (y + 3) + 'H' + right
        + ' M' + right + ',' + (y - 3) + 'V' + (y + 3) + '"/>';
}

function renderDiagram(diagram, page, interactive) {
    if (!diagram.width) return '';
    const kinds = new Map(page.links.map(item => [item.id, item.kind]));
    const action = (field, key, title) => interactive
        ? ' data-' + field + '="' + escape(key) + '" tabindex="0" role="button" aria-label="' + escape(title) + '"' : '';
    const link = href => !href ? ['', ''] : ['<a href="#' + escape(href) + '">', '</a>'];

    const edgeMarkup = diagram.edges.map(edge => {
        const sections = (edge.sections || []).map(section => [section.startPoint, ...(section.bendPoints || []), section.endPoint])
            .filter(points => points.length > 1);
        if (!sections.length) return '';
        const unknown = !edge.forward && !edge.reverse;
        const className = 'diagram-edge ' + (edge.clock ? 'clock'
            : edge.links.some(id => kinds.get(id) === 'interface') ? 'bus' : 'signal')
            + (unknown ? ' unknown' : '');
        const hits = interactive ? sections.map(points => '<path class="edge-hit" d="' + orthogonalPath(points) + '"/>').join('') : '';
        const lines = sections.map(points => '<path class="edge-line" d="' + orthogonalPath(points) + '"/>').join('');
        const first = sections[0], last = sections[sections.length - 1];
        let arrows = '';
        if (edge.forward) {
            const from = last[last.length - 2], to = last[last.length - 1];
            arrows += '<path class="edge-arrow" d="' + arrowPath(to, to.x - from.x, to.y - from.y) + '"/>';
        }
        if (edge.reverse) {
            const from = first[1], to = first[0];
            arrows += '<path class="edge-arrow" d="' + arrowPath(to, to.x - from.x, to.y - from.y) + '"/>';
        }
        const label = edge.at
            ? '<g class="wire-label" transform="translate(' + round(edge.at.x) + ',' + round(edge.at.y) + ')"><rect width="'
                + edge.at.width + '" height="' + edge.at.height + '" rx="2"/><text x="4" y="11">' + escape(edge.label) + '</text></g>'
            : '';
        const attrs = interactive ? action('edge', edge.id, edge.names.join('、')) : '';
        const body = '<g class="' + className + '"' + attrs + ' data-state="normal"><title>' + escape(edge.names.join('、'))
            + '</title>' + hits + lines + arrows + label + '</g>';
        if (!interactive && edge.links.length === 1) {
            const [open, close] = link(edge.links[0]);
            return open + body + close;
        }
        return body;
    }).join('');

    const cardMarkup = diagram.cards.map(card => {
        const translate = 'transform="translate(' + card.x + ',' + card.y + ')"';
        if (card.kind === 'boundary') {
            const node = card.nodes[0], terminal = card.terminal;
            return '<g class="diagram-card boundary" ' + translate + action('node', node.id, node.name) + '>'
                + '<title>' + escape(node.name) + '</title><polygon class="boundary-symbol" points="' + terminal.points + '"/>'
                + '<text class="boundary-caption" x="' + terminal.labelX + '" y="' + (terminal.centerY + 4)
                + '" text-anchor="' + terminal.anchor + '">' + escape(card.title) + '</text></g>';
        }
        if (card.kind === 'pad') {
            // 图2 风格：不画外框、表头和分隔线，每行就是「端口符号 + 名称 + 类型」。
            // 符号复用 terminalSymbol()：信号是外侧收尖的五边形，bus/interface 是纯矩形。
            // 读者看到的是端口，而不是一个装着端口清单的盒子。
            const east = card.padSide === 'EAST';
            const rows = card.rows.map(row => {
                const attrs = action('node', row.node.id, (row.name + ' ' + (row.port ? portDescription(row.port) : '')).trim());
                const baseline = Math.round(row.y + 4);
                const symbolX = east ? card.width - PAD_SYM : 0;
                return '<g class="pad-row' + (row.direction === 'interface' ? ' bus' : '') + '"' + attrs + '><title>'
                    + escape(row.name + ' · ' + (row.port ? portDescription(row.port) : '边界端口')) + '</title>'
                    + '<rect class="pad-row-bg" x="0" y="' + row.top + '" width="' + card.width + '" height="' + card.rowH + '"/>'
                    + '<polygon class="pad-pin-shape" points="' + row.terminal.points + '" transform="translate('
                    + symbolX + ',' + (row.y - PAD_SYM_H / 2) + ')"/>'
                    + '<text class="pad-name" x="' + (east ? 12 : PAD_SYM + 8) + '" y="' + baseline
                    + '">' + escape(row.name) + '</text>'
                    + '<text class="pad-meta" x="' + (east ? card.width - PAD_SYM - 8 : card.width - 4) + '" y="' + baseline
                    + '" text-anchor="' + (east ? 'end' : 'end') + '">' + escape(row.meta) + '</text></g>';
            }).join('');
            // 端口排属于当前章节的模块边界，悬停标题里写明所属模块，避免被读成独立子模块。
            const owner = page.name + ' 的模块边界 · ' + card.title + '（' + card.rows.length + ' 个端口）';
            return '<g class="diagram-card pad ' + card.edgeSide + '" ' + translate + '><title>' + escape(owner)
                + '</title>' + rows + '</g>';
        }
        if (card.kind === 'junction') {
            const [open, close] = link(card.link || null);
            const attrs = card.link && interactive ? action('link', card.link, card.title) : '';
            const chip = card.chip
                ? '<g class="junction-chip" transform="translate(' + (card.width - 12 - card.chipWidth) + ',8)"><rect width="'
                    + card.chipWidth + '" height="15" rx="3"/><text x="5" y="11">' + escape(card.chip) + '</text></g>' : '';
            return open + '<g class="diagram-card junction" ' + translate + attrs + '><title>' + escape(card.title)
                + '（' + (card.chip || '汇聚') + '）</title><rect class="card-bg" width="' + card.width + '" height="' + card.height + '" rx="5"/>'
                + '<rect class="card-frame" width="' + card.width + '" height="' + card.height + '" rx="5"/>'
                + '<text class="junction-title" x="12" y="20">' + escape(card.titleLines[0]) + '</text>' + chip + '</g>' + close;
        }
        const node = card.nodes[0];
        const single = card.nodes.length === 1;
        const status = single && node.implementation === 'stub' ? ' stub' : single && node.implementation === 'unresolved' ? ' unresolved' : '';
        const attrs = single ? action('node', node.id, [node.name, node.type].filter(Boolean).join(' ')) : '';
        // 分组卡也要能点进子模块章节：取组内第一个带章节的实例作为落点，
        // 否则读者看到一张能展开所有连接的卡片却点不动。
        const chapterOf = single ? node.chapter
            : card.nodes.map(item => item.chapter).find(Boolean);
        const [open, close] = chapterOf ? link(chapterOf) : ['', ''];
        const titles = card.titleLines.map((line, index) => '<text class="card-title" x="12" y="' + (22 + index * HEAD_LINE)
            + '">' + escape(line) + '</text>').join('');
        const subtitle = card.subtitleName ? '<text class="card-subtitle" x="12" y="' + (card.headH + 16) + '">'
            + escape(card.subtitleName) + '</text>' : '';
        const chips = card.chips.map(chip => '<g class="card-chip ' + chip.kind + '" transform="translate(' + chip.x + ','
            + chip.y + ')"><rect width="' + chip.width + '" height="15" rx="3"/><text x="5" y="11">' + escape(chip.text) + '</text></g>').join('');
        const entries = card.entries.map((entry, index) => {
            const rowAttrs = !single ? action('node', entry.node.id, (entry.node.name + ' ' + (entry.node.type || '')).trim()) : '';
            const [rowOpen, rowClose] = !single ? link(entry.node.chapter) : ['', ''];
            return rowOpen + '<g class="node-entry"' + rowAttrs + '><title>' + escape(entry.name + ' · ' + entry.type) + '</title>'
                + '<rect class="row-bg" x="0" y="' + entry.y + '" width="' + card.width + '" height="' + ENTRY_ROW + '"/>'
                + (index ? '<line class="entry-rule" x1="8" y1="' + entry.y + '" x2="' + (card.width - 8) + '" y2="' + entry.y + '"/>' : '')
                + '<text class="entry-name" x="12" y="' + (entry.y + 15) + '">' + escape(entry.name) + '</text>'
                + '<text class="entry-type" x="' + (card.width - 12) + '" y="' + (entry.y + 15) + '" text-anchor="end">'
                + escape(entry.type) + '</text></g>' + rowClose;
        }).join('');
        // 分组卡片的对外端口：一行一个通道名，端点用 BD 的实心 tip（信号圆点、束方块），
        // 名称朝卡内，读者从边缘就能看出这一组对外接了哪些通道。
        const groupPortMarkup = (card.groupLayout || []).map(port => {
            const west = port.side === 'WEST';
            const edge = west ? 0 : card.width;
            const inner = west ? edge + 7 : edge - 7;
            const tip = port.bus
                ? '<rect class="group-port-tip" x="' + (edge - 3.25) + '" y="' + (port.y - 3.25)
                    + '" width="6.5" height="6.5" rx="1"/>'
                : '<circle class="group-port-tip" cx="' + edge + '" cy="' + port.y + '" r="2.7"/>';
            return '<g class="group-port' + (port.bus ? ' bus' : '') + (port.clock ? ' clock' : '') + '"><title>' + escape(port.caption) + '</title>'
                + '<line class="group-port-stem" x1="' + edge + '" y1="' + port.y + '" x2="' + inner + '" y2="' + port.y + '"/>'
                + tip
                + '<text class="group-port-label" x="' + (west ? edge + 12 : edge - 12) + '" y="' + (port.y + 4)
                + '" text-anchor="' + (west ? 'start' : 'end') + '">'
                + escape(clipText(port.caption, card.width - 24, FONT.pin, MONO)) + '</text></g>';
        }).join('');
        // BD 式分组卡：无标题带、虚线层级框，标题浮在框内左上角，端口沿边框排。
        const grouped = !single && card.groupPorts.length > 0;
        const split = card.pinSplit
            ? '<line class="pin-split" x1="12" y1="' + card.pinSplit + '" x2="' + (card.width - 12) + '" y2="' + card.pinSplit + '"/>' : '';
        const pins = card.pins.map(pin => {
            const west = pin.side === 'WEST';
            const stub = west ? 'x1="0" y1="' + pin.y + '" x2="-6" y2="' + pin.y + '"'
                : 'x1="' + card.width + '" y1="' + pin.y + '" x2="' + (card.width + 6) + '" y2="' + pin.y + '"';
            const marker = pin.bus ? busGlyph(west ? -14 : card.width + 6, pin.y)
                : '<circle class="pin-dot" cx="' + (west ? -6 : card.width + 6) + '" cy="' + pin.y + '" r="3"/>';
            return '<g class="schematic-pin"><title>' + escape(pin.port.name + ' · ' + portDescription(pin.port)) + '</title>'
                + '<line class="pin-stub" ' + stub + '/>' + marker + '<text class="pin-label' + (pin.bus ? ' bus' : '') + '" x="'
                + (west ? 12 : card.width - 12) + '" y="' + (pin.y + 4) + '" text-anchor="' + (west ? 'start' : 'end') + '">'
                + escape(pin.caption) + '</text></g>';
        }).join('');
        const footLines = [
            card.internalText ? '<text class="card-foot internal" x="12" y="0">' + escape(card.internalText) + '</text>' : '',
            card.footnote ? '<text class="card-foot" x="12" y="0">' + escape(card.footnote) + '</text>' : '',
        ].filter(Boolean);
        const footTop = card.height - footLines.length * FOOT;
        const foot = footLines.length
            ? '<line class="card-rule" x1="0" y1="' + footTop + '" x2="' + card.width + '" y2="' + footTop + '"/>'
                + footLines.map((line, index) => line.replace('y="0"', 'y="' + (footTop + 14 + index * FOOT) + '"')).join('') : '';
        return open + '<g class="diagram-card instance' + status + (grouped ? ' bd-block' : '') + '" ' + translate + attrs + '><title>'
            + escape([card.title, node?.type].filter(Boolean).join(' · ')) + '</title>'
            + '<rect class="card-bg" width="' + card.width + '" height="' + card.height + '" rx="5"/>'
            + (grouped ? '' : '<path class="card-head" d="' + headPath(card.width, card.headH) + '"/>'
                + '<line class="card-rule" x1="0" y1="' + card.headH + '" x2="' + card.width + '" y2="' + card.headH + '"/>')
            + titles + subtitle + chips + entries + groupPortMarkup + split + pins + foot
            + '<rect class="card-frame" width="' + card.width + '" height="' + card.height + '" rx="5"/></g>' + close;
    }).join('');

    const region = diagram.clockRegion;
    const clockRegion = region ? '<g class="clock-region"><rect x="' + region.x + '" y="' + region.y + '" width="' + region.width
        + '" height="' + region.height + '" rx="5"/><text x="16" y="' + (region.y + 21) + '">时钟 / 复位 · 同名标签连接</text></g>' : '';
    return '<svg class="architecture-svg" xmlns="http://www.w3.org/2000/svg" width="' + diagram.width + '" height="'
        + diagram.height + '" viewBox="0 0 ' + diagram.width + ' ' + diagram.height + '" role="'
        + (interactive ? 'group' : 'img') + '" aria-label="' + escape(page.name) + ' 架构图">'
        + clockRegion + edgeMarkup + cardMarkup + '</svg>';
}

module.exports = { diagramTopology, layoutDiagram, renderDiagram, escape };
