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
        const heading = (label, english, total) => `<h4>${label}${english ? `<span class="module-pin-group-en">${english}</span>` : ''}<span class="module-pin-count">${total}</span></h4>`;
        const pin = port => {
            const bidirectional = port.direction === 'inout';
            const width = port.width == null ? '—' : `${port.width} 位`;
            const marker = bidirectional ? '<span class="module-pin-direction" role="img" aria-label="双向">↔</span>' : '';
            const content = `<span class="module-pin-lead" data-direction="${escape(['input', 'output', 'inout', 'ref'].includes(port.direction) ? port.direction : 'unknown')}" aria-hidden="true"></span>${code(port.name)}<small class="module-pin-width">${escape(width)}${marker}</small>`;
            return `<li${bidirectional ? ' class="bidirectional"' : ''}>${control(port, content)}</li>`;
        };
        const side = (kind, label, english) => groups[kind].length
            ? `<section class="module-pin-group ${kind}" aria-label="${label}">${heading(label, english, groups[kind].length)}<ul>${groups[kind].map(pin).join('')}</ul></section>`
            : '';
        const terminals = interfaces.map(port => {
            const [type, role] = (port.type || '').split('.', 2);
            const roleLabel = role === 'master' ? 'Master' : role === 'slave' ? 'Slave' : '';
            const badge = roleLabel ? `<span class="module-interface-role">${roleLabel}</span>` : '';
            const description = type || '类型待确认';
            const detail = `${description} · ${role || '未声明 modport'}`;
            const subtitle = roleLabel ? escape(description) : role ? escape(detail) : `${escape(description)} · <span class="module-interface-missing" aria-hidden="true">—</span>`;
            const hint = role ? '' : ` title="${escape(detail)}"`;
            const content = `<span class="module-bus-symbol" aria-hidden="true"></span><span class="module-interface-label"><strong>${code(port.name)}${badge}</strong><small${hint}>${subtitle}</small></span>`;
            return `<li>${control(port, content, 'module-pin module-interface-pin' + (roleLabel ? ` ${role}` : ''))}</li>`;
        }).join('');
        const buses = interfaces.length
            ? `<section class="module-pin-group interfaces" aria-label="接口束">${heading('接口束', 'INTERFACES', interfaces.length)}<ul>${terminals}</ul></section>`
            : '';
        const outputLabel = groups.output.some(port => port.direction === 'inout') ? '输出 / 双向' : '输出';
        const sharedLabel = [...new Set(groups.shared.map(port => port.direction === 'ref' ? '引用' : '方向待确认'))].join(' / ');
        const shared = groups.shared.length
            ? `<section class="module-pin-group shared" aria-label="${sharedLabel}">${heading(sharedLabel, '', groups.shared.length)}<ul>${groups.shared.map(pin).join('')}</ul></section>`
            : '';
        return `<div class="module-symbol-frame"><figure class="module-symbol" aria-label="${escape(name)} 端口图"><figcaption>${code(name)}</figcaption>
            <div class="module-pin-sides">${side('input', '输入', 'INPUT')}${buses}${side('output', outputLabel, 'OUTPUT')}</div>${shared}</figure></div>`;
    }

    function routeText(member, endpoints) {
        if (!member.proven) return '';
        const from = endpoints[member.drivers[0]];
        return `${code(from)} → ${member.receivers.map(index => code(endpoints[index])).join('、')}`;
    }

    // 束的流向来自哪级证据：向读者说明结论的可信度，也提示写法上还缺什么。
    const EVIDENCE = {
        valid: 'valid/ready 握手',
        single: '单一驱动端',
        role: 'modport 角色名',
        width: '驱动位宽',
        member: '逐成员方向',
    };

    function evidenceLine(link, endpoints) {
        if (!link.routes.length) return '';
        const single = link.routes.length === 1;
        const source = single ? endpoints[link.routes[0].source] : undefined;
        // 只有一条通路时才给出具体端点；逐成员通路已经在下表逐行列出，这里不重复。
        const detail = single ? `${code(source)} → ${link.routes.length} 条通路` : `逐成员 ${link.routes.length} 条通路`;
        return `<p class="subtle flow-evidence">流向依据：${EVIDENCE[link.flowEvidence] || '待确认'} · ${detail}</p>`;
    }

    function interfaceDetails(link, nodes, interactive) {
        const endpoints = link.endpoints.map(endpoint => endpointName(endpoint, nodes));
        const signals = [link.members.find(member => member.name === 'valid'), link.members.find(member => member.name === 'ready')];
        const summary = link.handshake ? `<div class="handshake">${signals.map((signal, index) =>
            `<div class="${signal.flow}"><strong>${index ? '反向回压' : '正向数据与有效信号'}</strong><span>${routeText(signal, endpoints)}</span><span>${link.members.filter(member => member.flow === signal.flow).map(member => code(member.name)).join(' · ')}</span></div>`).join('')}</div>` : '';
        const evidence = link.endpoints.map((endpoint, index) => `<tr><th scope="row">${code(endpoints[index])}</th><td>${code(endpoint.type)}</td><td>${endpoint.boundary ? '模块边界' : '子实例'}${endpoint.invalid ? ' · modport 不匹配' : ''}</td><td>${[sourceLink(endpoint.declaration, interactive, '端口声明'), sourceLink(endpoint.modportSource, interactive, 'modport'), sourceLink(endpoint.binding, interactive, '例化连接')].filter(Boolean).join(' · ')}</td></tr>`).join('');
        const members = link.members.map(member => `<tr><th scope="row">${member.declaration && interactive ? sourceLink(member.declaration, true, member.name) : code(member.name)}</th><td>${member.width ?? '待确认'}</td>${member.directions.map(value => `<td>${direction(value)}</td>`).join('')}<td class="${member.flow}">${flowNames[member.flow]}${member.proven ? `<br>${routeText(member, endpoints)}` : ''}</td></tr>`).join('');
        return `<p class="connection-type">${code(link.type)} · ${sourceLink(link.definition, interactive, '接口定义')} · ${sourceLink(link.declaration, interactive, '连接声明')}</p>${summary}
            ${evidenceLine(link, endpoints)}
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
