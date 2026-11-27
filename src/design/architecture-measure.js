'use strict';

const { HEAD, HEAD_LINE, SUB, PIN_PITCH, BODY_PAD, FOOT, PAD_ROW, PAD_SYM, PAD_SYM_H, TITLE_MAX, NOTE_MAX, ENTRY_ROW, GROUP_PORT_ROW, CLOCK_ROW, CLOCK_LABEL, FONT, MONO, UI, textWidth, round, clipText, wrapTitle } = require('./architecture-metrics');
const { footnoteText, internalText, groupEdgePorts, clockRowItems, portMeta, edgeSide } = require('./architecture-topology');
const { signalKind } = require('./architecture-details');
const { terminalCaption, terminalWidth, terminalSymbol } = require('../circuit/symbol-library');
/* ---------- 卡片度量 ---------- */

// 接口引脚名称不再加 ≡ 前缀：端头已经用实心方块表示接口束（与 group-port / 端口图一致）。
function pinCaption(port) {
    return port.name;
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
    card.subtitleName = multi ? card.nodes.length + ' 个实例' : node?.name && node.name !== title ? node.name : '';
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
        port.port = matching[0]?.port;
        port.links = [...new Set(matching.map(item => item.link))];
        port.clock = matching.every(item => item.clock);
        port.net = [...new Set(matching.filter(item => item.clock).map(item => item.name))].join(' / ');
        if (port.clock && port.net !== port.caption) port.caption += ' · ' + port.net;
        if (port.clock) port.caption = (signalKind(port.net) || signalKind(port.port)) + ' ' + port.caption;
    }
    // 时钟/复位不占左右列：统一折到卡底两行（CLK / RST），每行 14px。
    // 它们不画跨模块长线（同名标签连接，只在两端留接点），按端口行排只会白占卡片高度。
    card.clockRows = [];
    if (!detailed) {
        const clockPorts = card.groupPorts.filter(port => port.clock);
        if (clockPorts.length) {
            card.groupPorts = card.groupPorts.filter(port => !port.clock);
            card.clockRows = clockRowItems(clockPorts);
        }
    }
    // 不再截断：卡片至少要能放下最长的单个网络名，其余按行折行。
    const clockIdeal = card.clockRows.length
        ? 12 + CLOCK_LABEL + Math.min(TITLE_MAX, Math.max(...card.clockRows
            .flatMap(row => row.items.map(item => textWidth(item.name, FONT.clock, MONO))))) + 12 : 0;
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
    const base = Math.max(152, subtitleWidth, entryWidth, portWidth, footWidth, pinWidth, clockIdeal, compact ? 196 : 0);
    let titleMax = 232;
    if (detailed) titleMax = compact ? Math.max(160, Math.min(TITLE_MAX, base - 24)) : TITLE_MAX;
    card.titleLines = wrapTitle(title, titleMax, detailed && !compact ? 2 : 3);
    const titleWidth = Math.max(0, ...card.titleLines.map(line => textWidth(line, FONT.title, UI)));
    card.headH = HEAD + (card.titleLines.length - 1) * HEAD_LINE;
    card.width = Math.ceil(Math.max(base, titleWidth + 24) / 4) * 4;
    // 每个时钟/复位网络单独一行，做成卡边端口（贴边圆点 + 名称），不再是折行的标签清单。
    card.clockPins = [];
    for (const row of card.clockRows) {
        for (const item of row.items) card.clockPins.push({ name: item.name, link: item.link, kind: row.label, side: 'WEST' });
    }
    card.clockHeight = card.clockPins.length * CLOCK_ROW;
    const bodyTop = card.headH + SUB;
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
    card.clockTop = bodyTop + content;
    card.height = card.clockTop + card.clockHeight + footLines * FOOT;
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
            card.clockTop = bodyTop + BODY_PAD * 2 + Math.max(westRow, eastRow) * GROUP_PORT_ROW;
            card.height = card.clockTop + card.clockHeight + footLines * FOOT;
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
        return { node, port, direction,
            name: port?.name || node.name, meta: [signalKind(node.name), portMeta(port)].filter(Boolean).join(' ') };
    });
    const nameMax = Math.max(0, ...card.rows.map(row => textWidth(row.name, FONT.padName, MONO)));
    const metaMax = Math.max(0, ...card.rows.map(row => textWidth(row.meta, FONT.padMeta, MONO)));
    // 图2 风格：没有表头与方框，宽度 = 端口符号 + 名称 + 类型小字。
    card.width = Math.ceil(Math.max(120, PAD_SYM + 8 + nameMax + 16 + metaMax + 8) / 4) * 4;
    card.rowH = PAD_ROW;
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

module.exports = { pinCaption, roleKey, compareKey, buildPins, measureInstance, measurePad, measureFlag, measureJunction, measureCards };
