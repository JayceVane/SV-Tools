'use strict';

const { HEAD_LINE, FOOT, PAD_SYM, PAD_SYM_H, CORNER, ARROW, ENTRY_ROW, CLOCK_ROW, CLOCK_LABEL, FONT, MONO, CLOCK_BAND_TITLE, round, clipText, textWidth } = require('./architecture-metrics');
const { escape, portDescription, signalKind } = require('./architecture-details');
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

// 组内连接面板：折叠卡里放不下的组内连接，点脚注后就地展开成成员行 + 同名同色标签。
// 面板是覆盖层，不参与布局，卡片高度和整图尺寸都不变；PDF/PNG 保持折叠。
function expandPanel(card, diagram) {
    const rows = (card.nodes || []).map(node => {
        const seen = new Set();
        const chips = [];
        for (const item of card.internal) {
            if (!item.ends?.includes(node.id) || seen.has(item.name)) continue;
            seen.add(item.name);
            chips.push(item);
        }
        return { name: node.name, chips };
    }).filter(row => row.chips.length);
    if (!rows.length) return '';
    const chipWidth = item => textWidth(item.name, FONT.chip, MONO) + 16;
    const nameWidth = Math.max(...rows.map(row => textWidth(row.name, FONT.foot, MONO)));
    const chipX = 12 + nameWidth + 12;
    const natural = Math.max(...rows.map(row => row.chips.reduce((total, item) => total + chipWidth(item), 0)
        + (row.chips.length - 1) * 4));
    const width = Math.max(280, Math.min(420, diagram.width - 16, chipX + natural + 12));
    // 芯片按面板宽度换行，行高随之变化，避免把面板撑满整张图。
    const lineWidth = width - 12 - chipX;
    const lines = rows.map(row => {
        const out = [];
        let line = [], used = 0;
        for (const item of row.chips) {
            const chip = chipWidth(item);
            if (line.length && used + chip > lineWidth) { out.push(line); line = []; used = 0; }
            line.push({ item, chip });
            used += chip + 4;
        }
        if (line.length) out.push(line);
        return out;
    });
    const head = 30, footHeight = 22, lineHeight = 18;
    const heights = lines.map(linesOf => linesOf.length * lineHeight + 3);
    const height = head + heights.reduce((total, value) => total + value, 0) + footHeight;
    const gap = 12;
    let x = card.x, y = card.y + card.height + gap;
    if (y + height > diagram.height - 8) y = card.y - height - gap;
    if (y < 8) {
        x = card.x + card.width + gap;
        y = Math.max(8, Math.min(card.y, diagram.height - height - 8));
    }
    x = Math.max(8, Math.min(x, diagram.width - width - 8));
    let top = head;
    const body = rows.map((row, index) => {
        const rowTop = top;
        top += heights[index];
        const chips = lines[index].map((line, lineIndex) => {
            let cursor = chipX;
            return line.map(({ item, chip }) => {
                const chipTop = rowTop + 3 + lineIndex * lineHeight;
                const markup = '<g class="expand-chip ' + (item.kind === 'interface' ? 'bundle' : 'signal') + '">'
                    + '<rect x="' + round(cursor) + '" y="' + round(chipTop) + '" width="' + round(chip) + '" height="15" rx="3"/>'
                    + '<text x="' + round(cursor + 8) + '" y="' + round(chipTop + 11) + '">' + escape(item.name) + '</text></g>';
                cursor += chip + 4;
                return markup;
            }).join('');
        }).join('');
        return '<text class="expand-member" x="12" y="' + round(rowTop + 15) + '">' + escape(row.name) + '</text>' + chips;
    }).join('');
    return '<g class="expand-panel" data-panel="' + escape(card.id) + '" transform="translate(' + round(x) + ','
        + round(y) + ')" role="dialog" aria-label="' + escape(card.title + ' 组内连接') + '">'
        + '<rect class="expand-bg" width="' + round(width) + '" height="' + round(height) + '" rx="6"/>'
        + '<text class="expand-title" x="12" y="19">' + escape(card.title) + '</text>'
        + '<text class="expand-count" x="' + round(width - 12) + '" y="19" text-anchor="end">' + card.nodes.length
        + ' 个实例 · ' + card.internal.length + ' 条连接</text>'
        + '<line class="expand-rule" x1="0" y1="' + head + '" x2="' + round(width) + '" y2="' + head + '"/>'
        + body
        + '<text class="expand-hint" x="12" y="' + round(height - 8) + '">同名同色表示同一条连接：蓝＝接口束，灰＝信号</text>'
        + '</g>';
}

// 分组卡成员面板：副标题「N 个实例」点开，逐行列出成员并链到各自章节。
// 与组内连接面板一样是覆盖层，不参与布局。
function memberPanel(card, diagram, interactive) {
    const nodes = card.nodes || [];
    if (nodes.length < 2) return '';
    const nameWidth = Math.max(...nodes.map(node => textWidth(node.name, FONT.foot, MONO)));
    const typeWidth = Math.max(...nodes.map(node => textWidth(node.type || '', FONT.chip, MONO)));
    const width = Math.max(280, Math.min(460, 24 + nameWidth + 16 + typeWidth + 16));
    const head = 30, rowHeight = 20, tail = 8;
    const height = head + nodes.length * rowHeight + tail;
    const gap = 12;
    let x = card.x, y = card.y + card.height + gap;
    if (y + height > diagram.height - 8) y = card.y - height - gap;
    if (y < 8) {
        x = card.x + card.width + gap;
        y = Math.max(8, Math.min(card.y, diagram.height - height - 8));
    }
    x = Math.max(8, Math.min(x, diagram.width - width - 8));
    const rows = nodes.map((node, index) => {
        const top = head + index * rowHeight;
        const body = '<rect class="row-bg" x="0" y="' + top + '" width="' + round(width) + '" height="' + rowHeight + '"/>'
            + '<text class="member-name" x="12" y="' + (top + 14) + '">' + escape(node.name) + '</text>'
            + '<text class="member-type" x="' + round(width - 12) + '" y="' + (top + 14) + '" text-anchor="end">'
            + escape(node.type || '') + '</text>';
        const inner = '<g class="member-row">' + '<title>' + escape([node.name, node.type].filter(Boolean).join(' · ')) + '</title>'
            + body + '</g>';
        if (interactive) return '<g class="member-row" data-node="' + escape(node.id) + '" role="button" tabindex="0">'
            + '<title>' + escape([node.name, node.type].filter(Boolean).join(' · ')) + '</title>' + body + '</g>';
        return node.chapter ? '<a href="#' + escape(node.chapter) + '">' + inner + '</a>' : inner;
    }).join('');
    return '<g class="expand-panel member-panel" data-panel="' + escape(card.id + '-members') + '" transform="translate('
        + round(x) + ',' + round(y) + ')" role="dialog" aria-label="' + escape(card.title + ' 成员') + '">'
        + '<rect class="expand-bg" width="' + round(width) + '" height="' + round(height) + '" rx="6"/>'
        + '<text class="expand-title" x="12" y="19">' + escape(card.title) + '</text>'
        + '<text class="expand-count" x="' + round(width - 12) + '" y="19" text-anchor="end">' + nodes.length + ' 个实例</text>'
        + '<line class="expand-rule" x1="0" y1="' + head + '" x2="' + round(width) + '" y2="' + head + '"/>'
        + rows + '</g>';
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
        // 汇聚节点不是方向终点：箭头只画在真正的模块端口上，避免三条束线"扎"进方框。
        const kindOf = id => diagram.cards.find(item => item.id === id)?.kind;
        if (edge.forward && kindOf(edge.to) !== 'junction') {
            const from = last[last.length - 2], to = last[last.length - 1];
            arrows += '<path class="edge-arrow" d="' + arrowPath(to, to.x - from.x, to.y - from.y) + '"/>';
        }
        if (edge.reverse && kindOf(edge.from) !== 'junction') {
            const from = first[1], to = first[0];
            arrows += '<path class="edge-arrow" d="' + arrowPath(to, to.x - from.x, to.y - from.y) + '"/>';
        }
        const label = edge.at
            ? '<g class="wire-label" transform="translate(' + round(edge.at.x) + ',' + round(edge.at.y) + ')"><rect width="'
                + edge.at.width + '" height="' + edge.at.height + '" rx="2"/><text x="4" y="11"'
                + (edge.clock && edge.names.length === 1 ? ' data-clock="' + escape(edge.names[0]) + '"' : '')
                + '>' + escape(edge.label) + '</text></g>'
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
                const rowLink = portLink(row.node.id, row.name);
                return '<g class="pad-row' + (row.direction === 'interface' ? ' bus' : '') + '"' + (rowLink ? ' data-link="' + escape(rowLink) + '"' : '')
                    + attrs + preview(rowLink, row.node.id, row.name) + '><title>'
                    + escape(row.name + ' · ' + (row.port ? portDescription(row.port) : '边界端口')) + '</title>'
                    + '<rect class="pad-row-bg" x="0" y="' + row.top + '" width="' + card.width + '" height="' + card.rowH + '"/>'
                    + '<polygon class="pad-pin-shape" points="' + row.terminal.points + '" transform="translate('
                    + symbolX + ',' + (row.y - PAD_SYM_H / 2) + ')"/>'
                    + '<text class="pad-name" x="' + (east ? 12 : PAD_SYM + 8) + '" y="' + baseline + '"'
                    + (row.direction !== 'interface' && signalKind(row.name) ? ' data-clock="' + escape(row.name) + '"' : '')
                    + '>' + escape(row.name) + '</text>'
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
            // 三条以上的束线汇到同一张卡时，沿入线一侧画一根总线竖条把它们收成一个节点，
            // 读者能看出这是"一条束的多个端点"，而不是三根线扎进一个方框。
            const entries = [];
            for (const edge of diagram.edges) {
                const sections = edge.sections || [];
                if (!sections.length) continue;
                if (edge.from === card.id) entries.push(sections[0].startPoint);
                if (edge.to === card.id) entries.push(sections[sections.length - 1].endPoint);
            }
            const local = entries.map(point => ({ x: point.x - card.x, y: point.y - card.y }));
            const west = local.length ? local.reduce((sum, point) => sum + point.x, 0) / local.length <= card.width / 2 : true;
            const busBar = local.length ? '<line class="junction-bus" x1="' + (west ? 0 : card.width) + '" y1="'
                + round(Math.max(0, Math.min(...local.map(point => point.y)) - 2)) + '" x2="' + (west ? 0 : card.width)
                + '" y2="' + round(Math.min(card.height, Math.max(...local.map(point => point.y)) + 2)) + '"/>' : '';
            return open + '<g class="diagram-card junction" ' + translate + attrs + '><title>' + escape(card.title)
                + '（' + (card.chip || '汇聚') + '）</title><rect class="card-bg" width="' + card.width + '" height="' + card.height + '" rx="5"/>'
                + '<rect class="card-frame" width="' + card.width + '" height="' + card.height + '" rx="5"/>' + busBar
                + '<text class="junction-title" x="12" y="20">' + escape(card.titleLines[0]) + '</text>' + chip + '</g>' + close;
        }
        const node = card.nodes[0];
        const single = card.nodes.length === 1;
        const status = single && node.implementation === 'stub' ? ' stub' : single && node.implementation === 'unresolved' ? ' unresolved' : '';
        const attrs = single ? action('node', node.id, [node.name, node.type].filter(Boolean).join(' ')) : '';
        // 分组卡不再跳「组内第一个成员的章节」：那里只有该成员的实例，端口和数量都对不上。
        // 成员清单改由副标题「N 个实例」点开（memberPanel）。
        const chapterOf = single ? node.chapter : undefined;
        const [open, close] = chapterOf ? link(chapterOf) : ['', ''];
        const titles = card.titleLines.map((line, index) => '<text class="card-title" x="12" y="' + (22 + index * HEAD_LINE)
            + '">' + escape(line) + '</text>').join('');
        const subtitle = card.subtitleName
            ? (single
                ? '<text class="card-subtitle" x="12" y="' + (card.headH + 16) + '">' + escape(card.subtitleName) + '</text>'
                : '<g class="card-members" data-members="' + escape(card.id + '-members') + '" role="button" tabindex="0" aria-expanded="false">'
                    + '<title>展开成员清单（' + card.nodes.length + ' 个实例）</title>'
                    + '<text class="card-subtitle" x="12" y="' + (card.headH + 16) + '">' + escape(card.subtitleName) + '</text>'
                    + '<text class="expand-caret" x="' + round(12 + textWidth(card.subtitleName, FONT.foot, MONO) + 5) + '" y="'
                    + (card.headH + 16) + '">▸</text></g>')
            : '';
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
            const portLinkId = port.links?.length === 1 ? port.links[0] : null;
            return '<g class="group-port' + (port.bus ? ' bus' : '') + (port.clock ? ' clock' : '') + '"'
                + (portLinkId ? ' data-link="' + escape(portLinkId) + '"' : '')
                + preview(portLinkId, single ? node.id : null, single ? port.port : null)
                + '><title>' + escape(port.caption) + '</title>'
                + '<line class="group-port-stem" x1="' + edge + '" y1="' + port.y + '" x2="' + inner + '" y2="' + port.y + '"/>'
                + tip
                + '<text class="group-port-label" x="' + (west ? edge + 12 : edge - 12) + '" y="' + (port.y + 4)
                + '" text-anchor="' + (west ? 'start' : 'end') + '">'
                + escape(clipText(port.caption, card.width - 24, FONT.pin, MONO)) + '</text></g>';
        }).join('');
        // 卡底 CLK / RST 脚注：每个网络一个 tspan，悬浮可查源端与接收端。
        // 时钟/复位网络是卡边端口：一行一个网络，贴边实心圆点 + 名称，可直接接线。
        // 时钟/复位端口分左右两列：进的排左列、出的排右列，名字各自贴着自己那一侧，中间不留空档。
        const clockColumn = (pins, east) => (pins || []).map((pin, index) => {
            const top = card.clockTop + index * CLOCK_ROW;
            const baseline = round(top + 10.5);
            const groupStart = index === 0 || pins[index - 1].kind !== pin.kind;
            const tag = groupStart ? '<tspan class="clock-tag">' + pin.kind + '</tspan>' : '';
            const attrs = ' class="clock-net" data-clock="' + escape(pin.name) + '"' + (pin.link ? preview(pin.link) : '');
            const net = '<tspan' + attrs + (east && tag ? ' dx="8"' : '') + '>' + escape(pin.name) + '</tspan>';
            const dot = '<circle class="clock-pin" cx="' + (east ? card.width : 0) + '" cy="'
                + round(top + CLOCK_ROW / 2) + '" r="2.7"/>';
            if (east) {
                return '<text class="clock-foot" x="' + round(card.width - 12) + '" y="' + baseline
                    + '" text-anchor="end">' + tag + net + '</text>' + dot;
            }
            return '<text class="clock-foot" x="12" y="' + baseline + '">' + tag
                + '<tspan class="clock-start" x="' + (12 + CLOCK_LABEL) + '">' + net + '</tspan></text>' + dot;
        }).join('');
        const clockFoot = clockColumn(card.clockWest, false) + clockColumn(card.clockEast, true);
        const split = card.pinSplit
            ? '<line class="pin-split" x1="12" y1="' + card.pinSplit + '" x2="' + (card.width - 12) + '" y2="' + card.pinSplit + '"/>' : '';
        const pins = card.pins.map(pin => {
            const west = pin.side === 'WEST';
            const stub = west ? 'x1="0" y1="' + pin.y + '" x2="-6" y2="' + pin.y + '"'
                : 'x1="' + card.width + '" y1="' + pin.y + '" x2="' + (card.width + 6) + '" y2="' + pin.y + '"';
            // 与 group-port / 端口图同一套端头：接口束是贴边实心方块 + 粗总线，信号是实心圆点。
            const marker = pin.bus
                ? '<rect class="pin-bus" x="' + round(west ? -3.25 : card.width - 3.25) + '" y="' + round(pin.y - 3.25)
                    + '" width="6.5" height="6.5" rx="1"/>'
                : '<circle class="pin-dot" cx="' + round(west ? 0 : card.width) + '" cy="' + round(pin.y) + '" r="2.7"/>';
            const pinLink = portLink(node.id, pin.port.name);
            return '<g class="schematic-pin"' + (pinLink ? ' data-link="' + escape(pinLink) + '"' : '')
                + preview(pinLink, node.id, pin.port.name) + '><title>' + escape(pin.port.name + ' · ' + portDescription(pin.port)) + '</title>'
                + '<line class="pin-stub' + (pin.bus ? ' bus' : '') + '" ' + stub + '/>' + marker + '<text class="pin-label' + (pin.bus ? ' bus' : '') + '" x="'
                + (west ? 12 : card.width - 12) + '" y="' + (pin.y + 4) + '" text-anchor="' + (west ? 'start' : 'end') + '">'
                + escape(pin.caption) + '</text></g>';
        }).join('');
        const footLines = [];
        if (card.internalText) {
            const caret = 12 + textWidth(card.internalText, FONT.foot, MONO) + 5;
            footLines.push(y => '<g class="card-foot internal" data-expand="' + escape(card.id) + '" role="button" tabindex="0" aria-expanded="false">'
                + '<title>展开组内连接清单</title>'
                + '<text class="card-foot internal" x="12" y="' + y + '">' + escape(card.internalText) + '</text>'
                + '<text class="expand-caret" x="' + caret + '" y="' + y + '">▸</text></g>');
        }
        if (card.footnote) footLines.push(y => '<text class="card-foot" x="12" y="' + y + '">' + escape(card.footnote) + '</text>');
        const footTop = card.height - footLines.length * FOOT;
        const foot = footLines.length
            ? '<line class="card-rule" x1="0" y1="' + footTop + '" x2="' + card.width + '" y2="' + footTop + '"/>'
                + footLines.map((line, index) => line(footTop + 14 + index * FOOT)).join('') : '';
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
    const expandMarkup = diagram.cards.filter(card => card.kind === 'instance' && card.internal?.length)
        .map(card => expandPanel(card, diagram)).join('');
    return '<svg class="architecture-svg" xmlns="http://www.w3.org/2000/svg" width="' + diagram.width + '" height="'
        + diagram.height + '" viewBox="0 0 ' + diagram.width + ' ' + diagram.height + '" role="'
        + (interactive ? 'group' : 'img') + '" aria-label="' + escape(page.name) + ' 架构图">'
        + clockRegion + edgeMarkup + cardMarkup + expandMarkup
        + diagram.cards.filter(card => card.kind === 'instance' && card.nodes.length > 1)
            .map(card => memberPanel(card, diagram, interactive)).join('') + '</svg>';
}

module.exports = { orthogonalPath, arrowPath, headPath, renderDiagram };
