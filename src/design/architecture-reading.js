'use strict';

const { code, escape, signalKind } = require('./architecture-details');

/** 讲解文字由作者提供，引用仅在当前章节中解析，不从结构连接推断运行行为。 */
function walkthroughFor(page, config) {
    if (!Array.isArray(config?.steps)) return;
    const connections = new Map();
    for (const link of page.links.filter(link => link.kind === 'interface')) {
        connections.set(link.name, connections.has(link.name) ? null : link.id);
    }
    const steps = config.steps.slice(0, 12).flatMap(step => {
        if (typeof step?.title !== 'string' || !step.title.trim() || typeof step.description !== 'string' || !step.description.trim()) return [];
        const names = Array.isArray(step.links) ? [...new Set(step.links.filter(name => typeof name === 'string').slice(0, 12))] : [];
        return [{ title: step.title.trim().slice(0, 60), description: step.description.trim().slice(0, 420),
            connections: names.map(name => ({ name, id: connections.get(name) || null })) }];
    });
    if (!steps.length) return;
    const names = new Set(page.links.filter(link => link.labeled).flatMap(link => link.names));
    const resets = Object.entries(config.clockResets || {}).filter(([clock, reset]) =>
        names.has(clock) && signalKind(clock) === 'CLK' && names.has(reset) && signalKind(reset) === 'RST');
    return { steps, clockResets: Object.fromEntries(resets) };
}

function walkthrough(page, print) {
    const steps = page.walkthrough?.steps;
    if (!steps?.length) return '';
    const sources = links => links.map(({ id, name }) => id ? `<a href="#${escape(id)}">${code(name)}</a>` : `${code(name)} <span class="walkthrough-unresolved">未定位</span>`).join(' · ');
    const detail = step => `<p>${escape(step.description)}</p>${step.connections.length ? `<p class="walkthrough-links">${sources(step.connections)}</p>` : ''}`;
    const controls = steps.map((step, index) => `<button type="button" data-walkthrough-step="${index}" aria-pressed="${index === 0}" aria-controls="${page.id}-step-${index}" data-connections="${step.connections.map(link => link.id).filter(Boolean).join(' ')}">${index + 1}. ${escape(step.title)}</button>`).join('');
    return `<section class="walkthrough" aria-label="数据路径"><h3>数据路径</h3>
        <p class="walkthrough-origin">设计说明 · 连线来自结构快照</p>
        ${print ? `<ol>${steps.map(step => `<li><strong>${escape(step.title)}</strong>${detail(step)}</li>`).join('')}</ol>`
            : `<div class="walkthrough-controls">${controls}</div>${steps.map((step, index) =>
                `<div class="walkthrough-detail" id="${page.id}-step-${index}"${index ? ' hidden' : ''}>${detail(step)}</div>`).join('')}`}</section>`;
}

function clockNetworks(page, nodes, print) {
    const networks = new Map();
    for (const link of page.links.filter(link => link.labeled)) {
        for (const name of link.names) {
            const kind = signalKind(name);
            if (!kind) continue;
            if (!networks.has(name)) networks.set(name, { kind, ends: new Map() });
            const { ends } = networks.get(name);
            for (const [index, endpoint] of link.endpoints.entries()) {
                const node = nodes.get(endpoint.node);
                const label = node?.kind === 'boundary' ? `${node.name}（本章边界）` : `${node?.name || endpoint.node}.${endpoint.port}`;
                const roles = ends.get(label) || { source: false, target: false };
                roles.source ||= link.routes.some(route => route.source === index);
                roles.target ||= link.routes.some(route => route.target === index);
                ends.set(label, roles);
            }
        }
    }
    if (!networks.size) return '';
    const pairs = new Map(Object.entries(page.walkthrough?.clockResets || {}));
    const rows = [...networks].sort(([, a], [, b]) => a.kind.localeCompare(b.kind)).map(([name, { kind, ends }]) => {
        const roles = predicate => [...ends].filter(([, value]) => predicate(value)).map(([end]) => code(end)).join(' · ');
        const source = roles(end => end.source);
        const target = roles(end => end.target);
        const unknown = roles(end => !end.source && !end.target);
        return `<tr><th scope="row">${kind} ${code(name)}</th><td>${source || '待确认'}</td><td>${target || '待确认'}${unknown ? `<br>方向待确认：${unknown}` : ''}</td>
            ${pairs.size ? `<td>${pairs.has(name) ? code(pairs.get(name)) : '—'}</td>` : ''}</tr>`;
    }).join('');
    return `<details class="book-detail chapter-reference" id="${page.id}-clocks" data-print-open${print ? ' open' : ''}>
        <summary>时钟与复位 · ${networks.size}</summary>
        ${pairs.size ? '<p class="subtle">关联复位由讲解配置指定。源端和接收端按本章连接方向显示。</p>' : ''}
        <div class="table-scroll"><table><thead><tr><th scope="col">网络</th><th scope="col">源端</th><th scope="col">接收端</th>${pairs.size ? '<th scope="col">关联复位</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

module.exports = { walkthroughFor, walkthrough, clockNetworks };
