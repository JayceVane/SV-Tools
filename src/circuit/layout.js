'use strict';

const { projectModule } = require('./projection');

function coordinate(value, where) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`ELK returned invalid ${where}`);
    return value;
}
function dimension(value, where) {
    coordinate(value, where);
    if (value < 0) throw new TypeError(`ELK returned negative ${where}`);
    return value;
}
function point(value, where) {
    if (!value || typeof value !== 'object') throw new TypeError(`ELK returned missing ${where}`);
    return { x: coordinate(value.x, `${where}.x`), y: coordinate(value.y, `${where}.y`) };
}
function geometry(value, where) {
    return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, (key === 'x' || key === 'y' ? coordinate : dimension)(value[key], `${where}.${key}`)]));
}

/**
 * @param {object} design 已验证的领域设计；不会写入坐标。
 * @param {string} moduleId 当前模块标识。
 * @param {{elk?:{layout:function}}} options 可注入 ELK 实例，默认按需加载打包依赖。
 * @returns {Promise<object>} 带有节点、端口和正交连线坐标的独立展示图。
 * @throws {Error} 模块/预算错误、依赖缺失或布局失败，不返回伪造布局。
 */
async function layoutModule(design, moduleId, { elk } = {}) {
    const projection = projectModule(design, moduleId);
    return layoutProjection(projection, { elk });
}

/** @param {object} projection 已验证的独立展示投影。 @param {{elk?:object}} options 布局引擎。 @returns {Promise<object>} 带几何的图，不修改领域模型。 */
async function layoutProjection(projection, { elk } = {}) {
    if (!elk) {
        const Elk = require('../../bin/vendor/elk.bundled.js');
        elk = new Elk();
    }
    if (typeof elk.layout !== 'function') throw new TypeError('Circuit layout requires an ELK layout instance');
    const result = await elk.layout(projection.input);
    if (!result || typeof result !== 'object') throw new TypeError('ELK returned no layout result');
    const positionedNodes = new Map((result.children || []).map(node => [node.id, node]));
    const routedEdges = new Map((result.edges || []).map(edge => [edge.id, edge]));
    const nodes = projection.nodes.map(node => {
        const positioned = positionedNodes.get(node.id);
        if (!positioned) throw new TypeError(`ELK omitted node ${node.id}`);
        const ports = new Map((positioned.ports || []).map(port => [port.id, port]));
        return { ...node, ...geometry(positioned, `node ${node.id}`), ports: node.ports.map(port => {
            const positionedPort = ports.get(port.id);
            if (!positionedPort) throw new TypeError(`ELK omitted port ${port.id}`);
            return { ...port, ...geometry(positionedPort, `port ${port.id}`) };
        }) };
    });
    const edges = projection.edges.map(edge => {
        const routed = routedEdges.get(edge.id);
        if (!routed || !Array.isArray(routed.sections) || !routed.sections.length) throw new TypeError(`ELK omitted edge route ${edge.id}`);
        return { ...edge, sections: routed.sections.map(section => ({
            startPoint: point(section.startPoint, 'edge startPoint'),
            ...(section.bendPoints ? { bendPoints: section.bendPoints.map(bend => point(bend, 'edge bendPoint')) } : {}),
            endPoint: point(section.endPoint, 'edge endPoint'),
        })) };
    });
    return { id: projection.id, moduleId: projection.moduleId, name: projection.name, width: dimension(result.width, 'graph width'), height: dimension(result.height, 'graph height'),
        nodes, edges, signals: projection.signals, parameters: projection.parameters, stats: projection.stats };
}

module.exports = { layoutModule, layoutProjection };
