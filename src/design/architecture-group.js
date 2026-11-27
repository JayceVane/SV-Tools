'use strict';

const { groupLinks } = require('./architecture-topology');
const { layoutDiagram, renderDiagram } = require('./architecture-diagram');

async function renderGroupDiagrams(diagram, page, interactive) {
    const groups = {};
    for (const card of diagram.cards.filter(card => card.kind === 'instance' && card.nodes.length > 1)) {
        // 从父章拿实例与连线。子章描述的是模块定义，无法表示这一层的实例间连接。
        const links = groupLinks(page.links, card.nodes);
        const nodes = card.nodes.map(node => ({ ...node, group: undefined }));
        const local = { ...page, name: card.title, nodes, links, groupDetail: true };
        const layout = await layoutDiagram(local, 'overview');
        groups[card.id] = { title: card.title, instances: nodes.length, connections: links.length,
            html: renderDiagram(layout, local, interactive) };
    }
    return groups;
}

module.exports = { renderGroupDiagrams };
