'use strict';

const { HEAD_LINE, FOOT, PAD_SYM, PAD_SYM_H, CORNER, ARROW, ENTRY_ROW, CLOCK_ROW, CLOCK_LABEL, FONT, MONO, CLOCK_BAND_TITLE, round, clipText } = require('./architecture-metrics');
const { escape, portDescription } = require('./architecture-details');
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
    const preview = (id, node, port) => id ? ' data-preview-link="' + escape(id) + '"'
        + (node ? ' data-preview-node="' + escape(node) + '"' : '') + (port ? ' data-preview-port="' + escape(port) + '"' : '') : '';
    const portLink = (node, port) => page.links.find(item => item.endpoints.some(endpoint => endpoint.node === node && endpoint.port === port))?.id;

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
        const body = '<g class="' + className + '"' + attrs + preview(edge.links.length === 1 ? edge.links[0] : null) + ' data-state="normal"><title>' + escape(edge.names.join('、'))
            + '</title>' + hits + lines + arrows + label + '</g>';
        // 同名标签网络（时钟/复位等）没有独立的连接详情章节，不能包成 <a>，
        // 否则导出文档里会出现指向不存在锚点的死链接；悬停预览仍然保留。
        if (!interactive && edge.links.length === 1 && !edge.clock) {
            const [open, close] = link(edge.links[0]);
            return open + body + close;
        }
        return body;
    }).join('');

    // 边界端子列的小标：写明这些端口属于当前章节模块，而不是独立子模块。
    // 只挂在每列最上面那一排，避免同一列重复出现。
    const padColumnLabel = new Map();
    const region = diagram.clockRegion;
    for (const side of ['left', 'right']) {
        // 时钟带里的端子排已经有带标题，不再重复挂归属小标（否则会压住带标题）。
        const pads = diagram.cards.filter(card => card.kind === 'pad' && card.edgeSide === side
            && !(region && card.y >= region.y - 2))
            .sort((a, b) => a.y - b.y || a.x - b.x);
        if (!pads.length) continue;
        padColumnLabel.set(pads[0].id, side === 'left' ? page.name + ' · 模块边界' : '模块边界');
    }

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
                return '<g class="pad-row' + (row.direction === 'interface' ? ' bus' : '') + '"' + attrs + preview(portLink(row.node.id, row.name), row.node.id, row.name) + '><title>'
                    + escape(row.name + ' · ' + (row.port ? portDescription(row.port) : '边界端口')) + '</title>'
                    + '<rect class="pad-row-bg" x="0" y="' + row.top + '" width="' + card.width + '" height="' + card.rowH + '"/>'
                    + '<polygon class="pad-pin-shape" points="' + row.terminal.points + '" transform="translate('
                    + symbolX + ',' + (row.y - PAD_SYM_H / 2) + ')"/>'
                    + '<text class="pad-name" x="' + (east ? 12 : PAD_SYM + 8) + '" y="' + baseline
                    + '">' + escape(row.name) + '</text>'
                    + '<text class="pad-meta" x="' + (east ? card.width - PAD_SYM - 8 : card.width - 4) + '" y="' + baseline
                    + '" text-anchor="' + 'end' + '">' + escape(row.meta) + '</text></g>';
            }).join('');
            // 端口排属于当前章节的模块边界，悬停标题里写明所属模块，避免被读成独立子模块。
            const owner = page.name + ' 的模块边界 · ' + card.title + '（' + card.rows.length + ' 个端口）';
            const column = padColumnLabel.get(card.id);
            const columnLabel = column
                ? '<text class="pad-column-label" x="' + (card.edgeSide === 'left' ? 0 : 12) + '" y="-8">' + escape(column) + '</text>'
                : '';
            return '<g class="diagram-card pad ' + card.edgeSide + '" ' + translate + '><title>' + escape(owner)
                + '</title>' + columnLabel + rows + '</g>';
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
            return '<g class="group-port' + (port.bus ? ' bus' : '') + (port.clock ? ' clock' : '') + '"'
                + preview(port.links?.length === 1 ? port.links[0] : null, single ? node.id : null, single ? port.port : null)
                + '><title>' + escape(port.caption) + '</title>'
                + '<line class="group-port-stem" x1="' + edge + '" y1="' + port.y + '" x2="' + inner + '" y2="' + port.y + '"/>'
                + tip
                + '<text class="group-port-label" x="' + (west ? edge + 12 : edge - 12) + '" y="' + (port.y + 4)
                + '" text-anchor="' + (west ? 'start' : 'end') + '">'
                + escape(clipText(port.caption, card.width - 24, FONT.pin, MONO)) + '</text></g>';
        }).join('');
        // 卡底 CLK / RST 脚注：每个网络一个 tspan，悬浮可查源端与接收端。
        const clockFoot = (card.clockRows || []).map((row, index) => {
            const baseline = round(card.clockTop + index * CLOCK_ROW + 10.5);
            const nets = row.shown.map((item, position) => (position ? '<tspan class="clock-sep"> · </tspan>' : '')
                + '<tspan class="clock-net"' + (item.link ? preview(item.link) : '') + '>' + escape(item.name) + '</tspan>').join('');
            const more = row.rest ? '<tspan class="clock-sep"> +' + row.rest + '</tspan>' : '';
            return '<text class="clock-foot" x="12" y="' + baseline + '"><tspan class="clock-tag">' + row.label + '</tspan>'
                + '<tspan class="clock-start" x="' + (12 + CLOCK_LABEL) + '">' + nets + more + '</tspan></text>';
        }).join('');
        const split = card.pinSplit
            ? '<line class="pin-split" x1="12" y1="' + card.pinSplit + '" x2="' + (card.width - 12) + '" y2="' + card.pinSplit + '"/>' : '';
        const pins = card.pins.map(pin => {
            const west = pin.side === 'WEST';
            const stub = west ? 'x1="0" y1="' + pin.y + '" x2="-6" y2="' + pin.y + '"'
                : 'x1="' + card.width + '" y1="' + pin.y + '" x2="' + (card.width + 6) + '" y2="' + pin.y + '"';
            const marker = pin.bus ? busGlyph(west ? -14 : card.width + 6, pin.y)
                : '<circle class="pin-dot" cx="' + (west ? -6 : card.width + 6) + '" cy="' + pin.y + '" r="3"/>';
            return '<g class="schematic-pin"' + preview(portLink(node.id, pin.port.name), node.id, pin.port.name) + '><title>' + escape(pin.port.name + ' · ' + portDescription(pin.port)) + '</title>'
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
        return open + '<g class="diagram-card instance' + status + '" ' + translate + attrs + '><title>'
            + escape([card.title, node?.type].filter(Boolean).join(' · ')) + '</title>'
            + '<rect class="card-bg" width="' + card.width + '" height="' + card.height + '" rx="5"/>'
            + '<path class="card-head" d="' + headPath(card.width, card.headH) + '"/>'
            + '<line class="card-rule" x1="0" y1="' + card.headH + '" x2="' + card.width + '" y2="' + card.headH + '"/>'
            + titles + subtitle + chips + entries + groupPortMarkup + clockFoot + split + pins + foot
            + '<rect class="card-frame" width="' + card.width + '" height="' + card.height + '" rx="5"/></g>' + close;
    }).join('');

    const clockRegion = region ? '<g class="clock-region"><rect x="' + region.x + '" y="' + region.y + '" width="' + region.width
        + '" height="' + region.height + '" rx="5"/><text x="16" y="' + (region.y + 21) + '">' + CLOCK_BAND_TITLE + '</text></g>' : '';
    return '<svg class="architecture-svg" xmlns="http://www.w3.org/2000/svg" width="' + diagram.width + '" height="'
        + diagram.height + '" viewBox="0 0 ' + diagram.width + ' ' + diagram.height + '" role="'
        + (interactive ? 'group' : 'img') + '" aria-label="' + escape(page.name) + ' 架构图">'
        + clockRegion + edgeMarkup + cardMarkup + '</svg>';
}

module.exports = { orthogonalPath, arrowPath, headPath, busGlyph, renderDiagram };
