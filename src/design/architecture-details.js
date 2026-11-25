/* global module */
(function (root) {
    'use strict';

    const escape = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const code = value => `<code>${escape(value)}</code>`;
    const direction = value => ({ input: 'input', output: 'output', inout: 'inout', ref: 'ref', interface: 'interface',
        unlisted: '未列入', unknown: '待确认' })[value] || '待确认';
    const parameterText = parameters => Object.entries(parameters || {}).map(([name, value]) => `${name}=${value}`).join(', ');
    const pageName = page => page.name + (parameterText(page.parameters) ? ` #(${parameterText(page.parameters)})` : '');
    const flowNames = { forward: '正向', reverse: '反向', directed: '已知方向', unknown: '待确认' };
    const endpointName = (endpoint, nodes) => {
        const node = nodes.get(endpoint.node);
        return endpoint.name || (node?.kind === 'boundary' ? node.name : `${node?.name || endpoint.node}.${endpoint.port}`);
    };

    function sourceLink(source, interactive, title) {
        if (!source) return '';
        const name = escape(title || `${source.file}:${source.line}`);
        const tooltip = escape(`${source.file}:${source.line}`);
        return interactive ? `<button class="text-action" type="button" data-source="${escape(source.id)}" title="${tooltip}">${name}</button>` : `<span class="source-label">${title ? `${name} (${tooltip})` : name}</span>`;
    }

    function portTable(ports, interactive) {
        if (!ports.length) return '<p class="subtle">没有已解析的端口。</p>';
        return `<div class="table-scroll"><table><thead><tr><th scope="col">端口</th><th scope="col">声明类型</th><th scope="col">方向</th><th scope="col">位宽</th><th scope="col">源码</th></tr></thead><tbody>${ports.map(port =>
            `<tr><th scope="row">${code(port.name)}</th><td>${port.type ? code(port.type) : '—'}</td><td>${direction(port.direction)}</td><td>${port.width ?? '—'}</td><td>${sourceLink(port.declaration, interactive)}</td></tr>`).join('')}</tbody></table></div>`;
    }

    function groupPorts(ports, inoutSide = 'shared') {
        const groups = { input: [], output: [], shared: [] };
        for (const port of ports) {
            if (port.direction === 'inout') groups[inoutSide].push(port);
            else if (port.direction === 'input' || port.direction === 'output') groups[port.direction].push(port);
            else groups.shared.push(port);
        }
        return groups;
    }

    function portDescription(port) {
        return [port.type, direction(port.direction), port.width == null ? '' : `${port.width} 位`].filter(Boolean).join(' · ');
    }

    function renderModuleSymbol(name, ports, { interactive = false, selected, targets } = {}) {
        if (!ports.length) return '<p class="subtle">没有已解析的端口。</p>';
        const groups = groupPorts(ports, 'output');
        const interfaces = groups.shared.filter(port => port.direction === 'interface');
        groups.shared = groups.shared.filter(port => port.direction !== 'interface');
        const control = (port, content, className = 'module-pin') => {
            const target = targets?.get(port.name);
            const tag = interactive ? 'button' : target ? 'a' : 'span';
            const attrs = interactive ? ` type="button" data-port="${escape(port.name)}" aria-pressed="${port.name === selected}"`
                : target ? ` href="#${escape(target)}"` : '';
            return `<${tag} class="${className}"${attrs} title="${escape(portDescription(port))}">${content}</${tag}>`;
        };
        const side = (kind, label) => {
            if (!groups[kind].length) return '';
            const pins = groups[kind].map(port => {
                const bidirectional = port.direction === 'inout';
                const width = port.width == null ? '' : `${port.width} 位`;
                const description = kind === 'shared' ? [port.type, direction(port.direction), width].filter(Boolean).join(' · ')
                    : width || '位宽待确认';
                const marker = bidirectional ? '<span class="module-pin-direction" role="img" aria-label="双向">↔</span>' : '';
                const content = `${code(port.name)}<small>${escape(description)}</small>${marker}`;
                return `<li${bidirectional ? ' class="bidirectional"' : ''}>${control(port, content)}</li>`;
            }).join('');
            return `<section class="module-pin-group ${kind}" aria-label="${label}"><h4>${label}</h4><ul>${pins}</ul></section>`;
        };
        const terminals = interfaces.map(port => {
            const [type, role] = (port.type || '').split('.', 2);
            const content = `<span class="module-bus-symbol" aria-hidden="true"></span><span class="module-interface-label">
                <strong>${code(port.name)}</strong><small>${escape(type || '类型待确认')} · ${escape(role || '未声明 modport')}</small></span>`;
            return `<li>${control(port, content, 'module-pin module-interface-pin')}</li>`;
        }).join('');
        const buses = terminals ? `<section class="module-pin-group interfaces" aria-label="接口束"><h4>接口束</h4><ul>${terminals}</ul></section>` : '';
        const outputLabel = groups.output.some(port => port.direction === 'inout') ? '输出 / 双向' : '输出';
        const sharedLabel = [...new Set(groups.shared.map(port => port.direction === 'ref' ? '引用' : '方向待确认'))].join(' / ');
        return `<figure class="module-symbol" aria-label="${escape(name)} 端口图"><figcaption>${code(name)}</figcaption>
            <div class="module-pin-sides">${side('input', '输入')}${buses}${side('output', outputLabel)}</div>${side('shared', sharedLabel)}</figure>`;
    }

    function routeText(member, endpoints) {
        if (!member.proven) return '';
        const from = endpoints[member.drivers[0]];
        return `${code(from)} → ${member.receivers.map(index => code(endpoints[index])).join('、')}`;
    }

    function interfaceDetails(link, nodes, interactive) {
        const endpoints = link.endpoints.map(endpoint => endpointName(endpoint, nodes));
        const signals = [link.members.find(member => member.name === 'valid'), link.members.find(member => member.name === 'ready')];
        const summary = link.handshake ? `<div class="handshake">${signals.map((signal, index) =>
            `<div class="${signal.flow}"><strong>${index ? '反向回压' : '正向数据与有效信号'}</strong><span>${routeText(signal, endpoints)}</span><span>${link.members.filter(member => member.flow === signal.flow).map(member => code(member.name)).join(' · ')}</span></div>`).join('')}</div>` : '';
        const evidence = link.endpoints.map((endpoint, index) => `<tr><th scope="row">${code(endpoints[index])}</th><td>${code(endpoint.type)}</td><td>${endpoint.boundary ? '模块边界' : '子实例'}${endpoint.invalid ? ' · modport 不匹配' : ''}</td><td>${[sourceLink(endpoint.declaration, interactive, '端口声明'), sourceLink(endpoint.modportSource, interactive, 'modport'), sourceLink(endpoint.binding, interactive, '例化连接')].filter(Boolean).join(' · ')}</td></tr>`).join('');
        const members = link.members.map(member => `<tr><th scope="row">${member.declaration && interactive ? sourceLink(member.declaration, true, member.name) : code(member.name)}</th><td>${member.width ?? '待确认'}</td>${member.directions.map(value => `<td>${direction(value)}</td>`).join('')}<td class="${member.flow}">${flowNames[member.flow]}${member.proven ? `<br>${routeText(member, endpoints)}` : ''}</td></tr>`).join('');
        return `<p class="connection-type">${code(link.type)} · ${sourceLink(link.definition, interactive, '接口定义')} · ${sourceLink(link.declaration, interactive, '连接声明')}</p>${summary}
            <h3>端点与声明</h3><div class="table-scroll"><table><thead><tr><th scope="col">端点</th><th scope="col">接口视图</th><th scope="col">位置</th><th scope="col">源码</th></tr></thead><tbody>${evidence}</tbody></table></div>
            <h3>成员方向</h3><p class="subtle">各端口列显示其 modport 声明。图内流向按当前模块观察，顶层边界的方向已按内侧换算。</p><div class="table-scroll"><table><thead><tr><th scope="col">信号</th><th scope="col">位宽</th>${endpoints.map(name => `<th scope="col">${code(name)}</th>`).join('')}<th scope="col">图内流向</th></tr></thead><tbody>${members}</tbody></table></div>`;
    }

    function signalEnds(link, nodes) {
        return link.endpoints.map(endpoint => code(endpointName(endpoint, nodes))).join(link.routes.length ? ' → ' : ' ↔ ');
    }

    function backgroundSignals(page, interactive) {
        const groups = new Map();
        for (const link of page.links.filter(link => link.labeled)) for (const name of link.names) {
            if (!groups.has(name)) groups.set(name, []);
            groups.get(name).push(link);
        }
        if (!groups.size) return '';
        const nodes = new Map(page.nodes.map(node => [node.id, node]));
        return `<details class="named-connections"${interactive ? '' : ' open'}><summary>标签网络 <span>${groups.size}</span></summary><dl>${[...groups].map(([name, links]) => {
            const targets = [...new Set(links.flatMap(link => link.endpoints.map(endpoint => endpointName(endpoint, nodes))))];
            return `<div><dt>${code(name)}</dt><dd>${targets.map(code).join(' · ')}</dd></div>`;
        }).join('')}</dl></details>`;
    }

    const details = { escape, code, pageName, parameterText, sourceLink, portTable, groupPorts, portDescription, renderModuleSymbol,
        interfaceDetails, signalEnds, backgroundSignals };
    if (typeof module === 'object' && module.exports) module.exports = details;
    else root.ArchitectureDetails = details;
})(globalThis);
