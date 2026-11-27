'use strict';

const { round } = require('./architecture-metrics');
const { edgeSide } = require('./architecture-topology');
const { roleKey } = require('./architecture-measure');
const { roleScore } = require('./interface-evidence');
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
    if (!peers.length && port.direction === 'interface') return roleScore({ modport: port.type?.split('.')[1] }) > 0 ? 'EAST' : 'WEST';
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

module.exports = { cardsById, attachPeers, guessSide, initialAssignment, peerAverage, nodeAverage, deriveAssignment, sameOrder, sameSides, sameList };
