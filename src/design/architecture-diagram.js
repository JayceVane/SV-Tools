'use strict';

const { escape, groupPorts, portDescription } = require('./architecture-details');
const { terminalCaption, terminalWidth, terminalSymbol } = require('../circuit/symbol-library');
const textWidth = value => [...value].reduce((width, character) => width + (character.charCodeAt(0) > 255 ? 13 : 8), 0);
const shorten = (value, length = 34) => value.length > length ? value.slice(0, length - 1) + '…' : value;
const pinKey = ({ card, port }) => JSON.stringify([card, port]);
let elk;

function diagramTopology(page, mode) {
    const overview = mode === 'overview';
    const drawn = overview ? page.links.filter(link => !link.labeled) : page.links;
    const wired = new Set(drawn.flatMap(link => link.endpoints.map(endpoint => endpoint.node)));
    const labels = new Map();
    for (const link of page.links.filter(link => link.labeled)) for (const endpoint of link.endpoints) {
        if (!labels.has(endpoint.node)) labels.set(endpoint.node, new Set());
        for (const name of link.names) labels.get(endpoint.node).add(name);
    }
    const cards = [], groups = new Map(), locations = new Map();
    for (const node of page.nodes) {
        if (overview && node.kind === 'boundary' && labels.has(node.id) && !wired.has(node.id)) continue;
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
    if (overview) for (const card of cards) {
        card.labels = [...new Set(card.nodes.flatMap(node => [...labels.get(node.id) || []]))];
    }
    const pairs = new Map(), edges = [];
    function add(source, target, link, forward) {
        if (!source.card || !target.card || pinKey(source) === pinKey(target)) return;
        const key = [source.card, target.card].sort().join('/');
        let edge = overview && pairs.get(key);
        if (!edge) {
            edge = { id: 'edge-' + edges.length, from: source.card, to: target.card, fromPort: source.port, toPort: target.port,
                forward: false, reverse: false, links: [] };
            edges.push(edge);
            if (overview) pairs.set(key, edge);
        }
        if (forward) edge[edge.from === source.card ? 'forward' : 'reverse'] = true;
        if (!edge.links.includes(link.id)) edge.links.push(link.id);
    }
    for (const link of drawn) {
        const refs = link.endpoints.map(endpoint => ({ card: locations.get(endpoint.node), port: overview ? undefined : endpoint.port }));
        const endpoints = [...new Map(refs.filter(ref => ref.card).map(ref => [pinKey(ref), ref])).values()];
        if (endpoints.length < 2) continue;
        if (link.routes.length && endpoints.length === 2) {
            for (const route of link.routes) add(refs[route.source], refs[route.target], link, true);
        } else if (endpoints.length === 2) {
            add(endpoints[0], endpoints[1], link, false);
        } else {
            const boundary = link.endpoints.findIndex(endpoint => endpoint.boundary);
            if (boundary !== -1 && !link.routes.length) {
                for (const endpoint of endpoints) add(refs[boundary], endpoint, link, false);
                continue;
            }
            const hub = { id: 'card-' + cards.length, title: link.name, kind: 'junction', link: link.id, nodes: [] };
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
    for (const edge of edges) {
        // Store layout orientation independently of electrical direction for ambiguous edges.
        if (edge.reverse && !edge.forward) {
            [edge.from, edge.to] = [edge.to, edge.from];
            [edge.fromPort, edge.toPort] = [edge.toPort, edge.fromPort];
            [edge.forward, edge.reverse] = [true, false];
        }
        edge.names = edge.links.map(id => links.get(id).name);
        edge.label = mode === 'detailed' || edge.links.some(id => links.get(id).kind === 'interface')
            ? (edge.links.length === 1 ? shorten(edge.names[0], 26) : `${edge.links.length} 条连接`) : '';
    }
    return { cards, edges };
}

function placeLabel(label, sections) {
    const width = Math.ceil(textWidth(label) * .69) + 7;
    let best;
    for (const section of sections) {
        const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
        for (let index = 1; index < points.length; index++) {
            const from = points[index - 1], to = points[index], length = Math.abs(to.x - from.x);
            if (to.y !== from.y || length < width || best && length <= best.length) continue;
            best = { x: (from.x + to.x - width) / 2, y: from.y - 11, width, height: 15, length };
        }
    }
    return best;
}

function layoutModulePins(card) {
    const groups = groupPorts(card.nodes[0].ports);
    const caption = port => shorten(port.name + (port.width > 1 ? ` [${port.width}]` : ''), 30);
    const labelWidth = port => textWidth(caption(port));
    const sideWidth = ports => Math.max(0, ...ports.map(labelWidth));
    const bottomWidths = groups.shared.map(port => labelWidth(port) + 20);
    const bottomWidth = bottomWidths.reduce((sum, width) => sum + width, 0);
    card.width = Math.max(card.width, sideWidth(groups.input) + sideWidth(groups.output) + 36, bottomWidth + (bottomWidth ? 16 : 0));
    card.height = 51 + 20 * Math.max(groups.input.length, groups.output.length) + (bottomWidth ? 37 : 8);
    let bottomX = (card.width - bottomWidth) / 2;
    return [...groups.input.map((port, index) => ({ port, side: 'WEST', x: 0, y: 52 + index * 20 })),
        ...groups.output.map((port, index) => ({ port, side: 'EAST', x: card.width, y: 52 + index * 20 })),
        ...groups.shared.map((port, index) => {
            const x = bottomX + bottomWidths[index] / 2;
            bottomX += bottomWidths[index];
            return { port, side: 'SOUTH', x, y: card.height };
        })].map((pin, index) => ({ ...pin, id: `${card.id}-pin-${index}`, caption: caption(pin.port) }));
}

async function layoutDiagram(page, mode) {
    if (!page.hasStructure)
        return { width: 0, height: 0, cards: [], edges: [] };
    const { cards, edges } = diagramTopology(page, mode);
    if (!cards.length) return { width: 0, height: 0, cards, edges };
    const detailed = mode === 'detailed';
    const pinIds = new Map(), boundaryPins = new Map();
    const children = cards.map(card => {
        if (card.kind === 'boundary') {
            const node = card.nodes[0], direction = node.direction;
            const width = node.ports[0]?.width;
            const label = node.name + (width > 1 ? ` [${width}]` : '');
            const side = direction === 'output' ? 'WEST' : 'EAST';
            card.title = terminalCaption(label).text;
            card.width = terminalWidth(label);
            card.height = 26;
            card.terminal = terminalSymbol(card.width, card.height, side, direction);
            const port = { id: `${card.id}-terminal`, x: side === 'EAST' ? card.width : 0, y: card.height / 2,
                width: 0, height: 0, layoutOptions: { 'elk.port.side': side } };
            boundaryPins.set(card.id, port.id);
            const layoutOptions = { 'elk.portConstraints': 'FIXED_POS' };
            if (direction === 'input' || direction === 'output')
                layoutOptions['elk.layered.layering.layerConstraint'] = direction === 'input' ? 'FIRST' : 'LAST';
            return { id: card.id, width: card.width, height: card.height, ports: [port], layoutOptions };
        }
        card.title = shorten(card.title);
        const names = card.nodes.map(node => shorten(node.name));
        card.width = Math.max(card.kind === 'instance' ? 125 : 73, 24 + Math.max(textWidth(card.title), ...names.map(textWidth)));
        card.height = card.kind === 'instance' ? 39 + 25 * card.nodes.length + (card.labels?.length ? 17 : 0) : 33;
        if (detailed && card.kind === 'instance' && card.nodes[0].ports.length) {
            card.pins = layoutModulePins(card);
            const ports = card.pins.map(pin => {
                pinIds.set(pinKey({ card: card.id, port: pin.port.name }), pin.id);
                return { id: pin.id, x: pin.x, y: pin.y, width: 0, height: 0, layoutOptions: { 'elk.port.side': pin.side } };
            });
            return { id: card.id, width: card.width, height: card.height, ports, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' } };
        }
        return { id: card.id, width: card.width, height: card.height };
    });
    if (!elk) {
        let Elk;
        try { Elk = require('../../bin/vendor/elk.bundled.js'); }
        catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
            throw new Error('架构布局引擎尚未构建：请先运行 npm run build:circuit 生成 bin/vendor/elk.bundled.js。');
        }
        elk = new Elk();
    }
    const anchor = (card, port) => boundaryPins.get(card) || pinIds.get(pinKey({ card, port })) || card;
    const result = await elk.layout({ id: 'diagram', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL', 'elk.spacing.nodeNode': '23', 'elk.layered.spacing.nodeNodeBetweenLayers': detailed ? '53' : '68',
        'elk.layered.spacing.edgeNodeBetweenLayers': '12', 'elk.layered.cycleBreaking.strategy': 'GREEDY',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES', 'elk.padding': '[top=22,left=24,bottom=22,right=24]' }, children,
    edges: edges.map(edge => ({ id: edge.id, sources: [anchor(edge.from, edge.fromPort)], targets: [anchor(edge.to, edge.toPort)],
        labels: detailed && edge.label ? [{ id: edge.id + '-label', text: edge.label, width: textWidth(edge.label) + 8, height: 17 }] : [] })) });
    const placed = new Map(result.children.map(card => [card.id, card]));
    const routed = new Map((result.edges || []).map(edge => [edge.id, edge]));
    return { width: Math.ceil(result.width), height: Math.ceil(result.height), cards: cards.map(card => {
        const { x, y } = placed.get(card.id);
        return { ...card, x, y };
    }), edges: edges.map(edge => {
        const { sections = [], labels = [] } = routed.get(edge.id);
        return { ...edge, sections, at: labels[0] || (edge.label ? placeLabel(edge.label, sections) : undefined) };
    }) };
}

function renderDiagram(diagram, page, interactive) {
    if (!diagram.width) return '';
    const arrow = page.id + '-arrow';
    const action = (field, key, title) => interactive
        ? ` data-${field}="${escape(key)}" tabindex="0" role="button" aria-label="${escape(title)}"` : '';
    const edgeMarkup = diagram.edges.map(edge => {
        const link = edge.links.length === 1 ? edge.links[0] : null;
        const lines = edge.sections.map(section => {
            const [start, ...points] = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
            const d = `M${start.x},${start.y}` + points.map(point => `L${point.x},${point.y}`).join('');
            return `${interactive ? `<path class="edge-hit" d="${d}"/>` : ''}<path class="edge-line" d="${d}"${edge.forward ? ` marker-end="url(#${arrow})"` : ''}${edge.reverse ? ` marker-start="url(#${arrow})"` : ''}/>`;
        });
        const label = edge.at && `<g class="wire-label" transform="translate(${edge.at.x},${edge.at.y})"><rect width="${edge.at.width}" height="${edge.at.height}" rx="3"/><text x="4" y="12">${escape(edge.label)}</text></g>`;
        const group = `<g class="diagram-edge${edge.forward ? '' : ' neutral'}"${action('edge', edge.id, edge.names.join('、'))}><title>${escape(edge.names.join('、'))}</title>${lines.join('')}${label || ''}</g>`;
        return !interactive && link ? `<a href="#${link}">${group}</a>` : group;
    }).join('');
    const cardMarkup = diagram.cards.map(card => {
        const translate = `transform="translate(${card.x},${card.y})"`;
        if (card.terminal) {
            const node = card.nodes[0], { points, labelX, centerY, anchor } = card.terminal;
            return `<g class="diagram-card boundary" ${translate}${action('node', node.id, node.name)}><title>${escape(node.name)}</title><polygon class="boundary-symbol" points="${points}"/><text class="boundary-caption" x="${labelX}" y="${centerY + 4}" text-anchor="${anchor}">${escape(card.title)}</text></g>`;
        }
        const frame = `<rect class="card-frame" width="${card.width}" height="${card.height}" rx="7"/>`;
        if (card.kind !== 'instance') {
            const node = card.nodes[0];
            const markup = `<g class="diagram-card ${card.kind}" ${translate}${node ? action('node', node.id, node.name) : action('link', card.link, card.title)}>${frame}<text x="12" y="21">${escape(card.title)}</text></g>`;
            return !interactive && card.link ? `<a href="#${card.link}">${markup}</a>` : markup;
        }
        if (card.pins) {
            const node = card.nodes[0];
            const subtitle = node.name === card.title ? node.type : `${node.name} · ${node.type}`;
            const pins = card.pins.map(pin => {
                const anchor = pin.side === 'WEST' ? 'start' : pin.side === 'EAST' ? 'end' : 'middle';
                const x = pin.x + (pin.side === 'WEST' ? 9 : pin.side === 'EAST' ? -9 : 0);
                const y = pin.y + (pin.side === 'SOUTH' ? -10 : 4);
                return `<g class="schematic-pin"><title>${escape(pin.port.name + ' · ' + portDescription(pin.port))}</title><circle cx="${pin.x}" cy="${pin.y}" r="3"/><text x="${x}" y="${y}" text-anchor="${anchor}">${escape(pin.caption)}</text></g>`;
            }).join('');
            const label = `<text class="card-title" x="12" y="19">${escape(card.title)}</text><text class="net-label" x="12" y="34">${escape(shorten(subtitle, Math.floor((card.width - 24) / 7)))}</text>`;
            const markup = `<g class="diagram-card instance" ${translate}${action('node', node.id, node.name + ' ' + node.type)}>${frame}${label}${pins}</g>`;
            return !interactive && node.chapter ? `<a href="#${node.chapter}">${markup}</a>` : markup;
        }
        const entries = card.nodes.map((node, index) => {
            const y = 30 + 25 * index;
            const caption = (card.nodes.length === 1 && node.name === card.title ? node.type : node.name) + (node.implementation === 'stub' ? ' · 桩' : '');
            const entry = `<g class="node-entry"${card.nodes.length > 1 ? action('node', node.id, node.name + ' ' + node.type) : ''}><title>${escape(node.name + ' · ' + node.type)}</title><rect x="6" y="${y}" width="${card.width - 12}" height="23" rx="4"/><text x="12" y="${y + 16}">${escape(shorten(caption, Math.floor((card.width - 24) / 8)))}</text></g>`;
            return !interactive && node.chapter ? `<a href="#${node.chapter}">${entry}</a>` : entry;
        });
        const named = card.labels?.length ? `<text class="net-label" x="12" y="${card.height - 9}"><title>${escape(card.labels.join(' · '))}</title>${escape(shorten(card.labels.join(' · '), Math.floor((card.width - 24) / 8)))}</text>` : '';
        const only = card.nodes.length === 1 && card.nodes[0];
        return `<g class="diagram-card instance" ${translate}${only ? action('node', only.id, only.name + ' ' + only.type) : ''}>${frame}<text class="card-title" x="12" y="20">${escape(card.title)}</text>${entries.join('')}${named}</g>`;
    }).join('');
    return `<svg class="architecture-svg" xmlns="http://www.w3.org/2000/svg" width="${diagram.width}" height="${diagram.height}" viewBox="0 0 ${diagram.width} ${diagram.height}" role="${interactive ? 'group' : 'img'}" aria-label="${escape(page.name)} 架构图"><defs><marker id="${arrow}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="context-stroke"/></marker></defs>${edgeMarkup}${cardMarkup}</svg>`;
}

module.exports = { diagramTopology, layoutDiagram, renderDiagram, escape };
