/* global acquireVsCodeApi */
(function () {
    'use strict';
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    let model, revision, busy = false, level = '', selected;
    const endpointsByCell = new Map();
    const parent = id => id.slice(0, id.lastIndexOf('/'));
    const short = id => id.slice(id.lastIndexOf('/') + 1);
    const isInterface = item => item.kind.startsWith('interface_');
    function node(tag, text, className) {
        const item = document.createElement(tag);
        if (text !== undefined) item.textContent = text;
        if (className) item.className = className;
        return item;
    }
    function mutate(action, target = {}) {
        if (busy) return;
        $('status').textContent = '';
        vscode.postMessage({ action, revision, ...target });
    }
    function button(label, action, target) {
        const item = node('button', label);
        item.type = 'button';
        item.disabled = busy;
        item.onclick = () => mutate(action, target);
        return item;
    }
    const attached = endpoint => model.nets.filter(net => parent(net.id) === level && isInterface(net) === isInterface(endpoint) &&
        net.endpoints.includes(endpoint.id));
    function selectedButton(label, description, kind, item) {
        const control = node('button', undefined, 'selector');
        const active = selected?.kind === kind && selected.id === item.id && selected.itemKind === item.kind;
        control.append(node('span', label), node('small', description));
        control.setAttribute('aria-pressed', String(active));
        control.onclick = () => {
            selected = active ? undefined : { kind, id: item.id, itemKind: item.kind };
            draw();
            $('selection').focus();
        };
        return control;
    }
    const endpointsFor = cell => endpointsByCell.get(cell) || [];
    function portLabel(endpoint) {
        const bits = endpoint.left && endpoint.right ? `[${endpoint.left}:${endpoint.right}]` : '';
        return [endpoint.direction, endpoint.type, bits].filter(Boolean).join(' · ');
    }
    function highlight(endpoint) {
        if (selected?.kind === 'net') {
            const link = model.nets.find(item => item.id === selected.id && item.kind === selected.itemKind);
            return link && isInterface(link) === isInterface(endpoint) && link.endpoints.includes(endpoint.id);
        }
        if (selected?.kind === 'endpoint') return selected.id === endpoint.id && selected.itemKind === endpoint.kind;
        return false;
    }
    function card(title, detail, endpoints, cell) {
        const result = node('article', undefined, 'block');
        if (endpoints.some(highlight)) result.classList.add('highlight');
        if (cell) {
            result.append(selectedButton(title, detail, 'cell', cell));
        } else {
            result.append(node('h3', title));
        }
        if (!endpoints.length) result.append(node('p', '无可见端口', 'muted'));
        for (const pin of endpoints) {
            const control = selectedButton(short(pin.id), portLabel(pin), 'endpoint', pin);
            control.classList.toggle('linked', Boolean(highlight(pin)));
            result.append(control);
        }
        return result;
    }
    function drawDetails() {
        const container = $('selection');
        container.replaceChildren();
        container.tabIndex = -1;
        if (!selected) return;
        const list = selected.kind === 'cell' ? model.cells : selected.kind === 'net' ? model.nets : model.endpoints;
        const index = list.findIndex(item => item.id === selected.id && item.kind === selected.itemKind);
        if (index < 0) return;
        const item = list[index], target = { [selected.kind]: index };
        container.append(node('h2', item.id));
        const toolbar = node('div', undefined, 'tools');
        if (selected.kind === 'cell') {
            if (item.type !== 'hier') toolbar.append(button('配置参数', 'config', target));
            toolbar.append(button('删除模块', 'remove', target));
        } else if (selected.kind === 'net') {
            toolbar.append(button('删除连接', 'remove', target));
            const endpoints = node('ul', undefined, 'list');
            for (const id of item.endpoints) {
                const endpoint = model.endpoints.findIndex(ep => ep.id === id && isInterface(ep) === isInterface(item));
                if (endpoint < 0) continue;
                const line = node('li', id);
                line.append(button('断开', 'disconnect', { net: index, endpoint }));
                endpoints.append(line);
            }
            container.append(endpoints);
        } else {
            const nets = attached(item);
            if (!nets.length) {
                toolbar.append(button('连接至…', 'connect', { ...target, level: level ? model.cells.findIndex(cell => cell.id === level) : undefined }));
                if (item.kind.endsWith('pin') && item.cell && !parent(item.cell)) {
                    toolbar.append(button('引出为外部端口', 'externalize', target));
                }
            }
            for (const net of nets) {
                const args = { endpoint: index, net: model.nets.indexOf(net) };
                if (!isInterface(net)) toolbar.append(button('从 ' + short(net.id) + ' 分支…', 'connect', args));
                else if (net.endpoints.length === 1) toolbar.append(button('连接至…', 'connect', args));
                toolbar.append(button('断开 ' + short(net.id), 'disconnect', args));
            }
            if (item.kind.endsWith('port')) toolbar.append(button('配置端口', 'config-port', target), button('删除端口', 'remove', target));
        }
        container.append(toolbar);
    }
    function draw() {
        if (!model) return;
        $('level').replaceChildren(...[{ id: '', label: '顶层' }, ...model.cells.filter(cell => cell.type === 'hier').map(cell => ({
            id: cell.id, label: cell.id
        }))].map(item => {
            const option = node('option', item.label);
            option.value = item.id;
            return option;
        }));
        if (level && !model.cells.some(cell => cell.id === level)) level = '';
        $('level').value = level;
        const blocks = model.cells.filter(cell => parent(cell.id) === level).map(cell =>
            card(short(cell.id), cell.vlnv || (cell.type === 'hier' ? '层级块' : cell.type), endpointsFor(cell.id), cell));
        const ports = endpointsFor(level);
        if (ports.length) blocks.unshift(card(level ? '层级边界' : '外部端口', '', ports));
        $('blocks').replaceChildren(...blocks, ...(!blocks.length ? [node('p', '此层级为空，可添加模块。', 'muted')] : []));
        const nets = model.nets.filter(net => parent(net.id) === level).map(net => {
            const item = node('li');
            item.append(selectedButton(short(net.id), isInterface(net) ? '接口' : '信号', 'net', net),
                node('small', net.endpoints.join(' · ')));
            return item;
        });
        $('nets').replaceChildren(...nets, ...(!nets.length ? [node('li', '此层级暂无连接', 'muted')] : []));
        $('address-section').hidden = !model.addresses.length;
        $('addresses').replaceChildren(...model.addresses.map(address => {
            const row = node('tr');
            for (const value of [address.space, address.id, address.offset || '待分配', address.range]) row.append(node('td', value));
            return row;
        }));
        for (const control of document.querySelectorAll('[data-action]')) control.disabled = busy;
        drawDetails();
    }
    $('level').onchange = () => { level = $('level').value; selected = undefined; draw(); };
    for (const control of document.querySelectorAll('[data-action]')) {
        control.onclick = () => control.id === 'add-cell' && level
            ? mutate('add-cell', { cell: model.cells.findIndex(cell => cell.id === level) })
            : mutate(control.dataset.action);
    }
    window.addEventListener('message', ({ data }) => {
        if (data.type === 'snapshot') {
            model = data.model;
            endpointsByCell.clear();
            for (const endpoint of model.endpoints) {
                if (!endpointsByCell.has(endpoint.cell)) endpointsByCell.set(endpoint.cell, []);
                endpointsByCell.get(endpoint.cell).push(endpoint);
            }
            revision = data.revision;
            $('name').textContent = model.name;
            $('path').textContent = data.file;
            $('status').textContent = data.message || '';
            $('main').hidden = false;
        } else if (data.type === 'busy') {
            busy = data.busy;
            if (busy) $('status').textContent = 'Vivado 正在处理…';
            else if ($('status').textContent === 'Vivado 正在处理…') $('status').textContent = '';
        } else if (data.type === 'status') {
            $('status').textContent = data.message;
        }
        draw();
    });
    vscode.postMessage({ action: 'ready' });
})();
