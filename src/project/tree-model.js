'use strict';
const path = require('node:path');
const { keyOf } = require('./manager');
const SYMBOLS = { internal: '●', output: '→', input: '←', inout: '↔', unknown: '?' };
const ROLES = ['internal', 'output', 'input', 'inout', 'unknown'];
const namesOf = node => node.names?.join('.') || node.moduleName;
/** @param {object[]} nodes 实际实例追踪结果。 @returns {object} 文件角色聚合，不把文件身份当作实例。 */
function fileRoles(nodes = []) {
    const files = new Map();
    for (const node of nodes) {
        if (!node.source?.path || !node.roles.length) {
            continue;
        }
        const key = keyOf(node.source.path), previous = files.get(key) || { roles: [], nodes: [], ambiguous: false };
        previous.nodes.push(node);
        previous.ambiguous ||= node.ambiguous;
        for (const role of node.roles)
            if (!previous.roles.includes(role)) {
                previous.roles.push(role);
            }
        files.set(key, previous);
    }
    return files;
}
function annotation(nodes, roles, ambiguous) {
    const flags = ROLES.filter(role => roles.includes(role)).map(role => ({ role, symbol: SYMBOLS[role] }));
    const lines = [];
    for (const node of nodes) {
        if (node.declaration) {
            lines.push(namesOf(node) + '.' + node.declaration.name + ' · 选中位 ' + node.declaration.indices.join(','));
        }
        for (const detail of node.details)
            lines.push(namesOf(node) + '.' + detail.port + ' · ' + detail.direction + ' · 位 ' + detail.indices.join(','));
        if (lines.length > 256) {
            lines.length = 256;
            lines.push('其余连接请切换到实例层级查看');
            break;
        }
    }
    if (ambiguous) {
        lines.push('存在双向、方向未知或多驱动连接；箭头仅表示端口声明方向');
    }
    return { flags, tooltip: lines.join('\n') };
}
/** @param {object} project 工程成员快照。 @param {{projection?:string,flow?:object}} options @returns {object[]} 仅文件/模块节点，信号名只放提示。 */
function projectTree(project, { projection = 'files', flow } = {}) {
    if (!project) {
        return [];
    }
    if (projection === 'instances' && flow?.nodes) {
        const nodes = new Map(flow.nodes.map(node => [node.id, { id: 'instance:' + node.id, label: node.label, kind: 'instance', module: node.moduleName,
                file: node.source?.path, source: node.declaration?.source || node.source, children: [], ...annotation([node], node.roles, node.ambiguous) }]));
        const roots = [];
        for (const node of flow.nodes) {
            const item = nodes.get(node.id);
            if (node.parentId === null) {
                roots.push(item);
            }
            else {
                nodes.get(node.parentId)?.children.push(item);
            }
        }
        return roots;
    }
    const roles = fileRoles(flow?.nodes), roots = [];
    for (const set of project.sets) {
        const group = { id: 'set:' + set.name, label: set.name + (set.top ? ' · top: ' + set.top : ''), kind: 'set', fileset: set.name, children: [], flags: [] };
        const folders = new Map([['', group]]);
        for (const file of [...set.files].sort()) {
            const relative = path.relative(project.root, file), directory = path.dirname(relative), segments = directory === '.' ? [] : directory.split(path.sep);
            let parent = group, trail = '';
            for (const segment of segments) {
                trail = trail ? trail + '/' + segment : segment;
                if (!folders.has(trail)) {
                    const folder = { id: group.id + '/dir:' + trail, label: segment, kind: 'folder', file: path.resolve(project.root, trail), children: [], flags: [] };
                    parent.children.push(folder);
                    folders.set(trail, folder);
                }
                parent = folders.get(trail);
            }
            const role = roles.get(keyOf(file));
            parent.children.push({ id: group.id + '/file:' + keyOf(file), label: path.basename(file), kind: 'file', file, fileset: set.name, children: [],
                ...(role ? annotation(role.nodes, role.roles, role.ambiguous) : { flags: [], tooltip: file }) });
        }
        roots.push(group);
    }
    return roots;
}
module.exports = { projectTree, fileRoles, SYMBOLS };
