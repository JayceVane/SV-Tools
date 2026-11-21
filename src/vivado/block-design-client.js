/* global acquireVsCodeApi, SVToolsBlockDesignCanvas */
'use strict';
(() => {
    const vscode = acquireVsCodeApi(), $ = id => document.getElementById(id);
    const parentOf = id => id.slice(0, id.lastIndexOf('/'));
    const short = id => id.slice(id.lastIndexOf('/') + 1);
    const isInterface = item => item.kind.startsWith('interface_');
    const pinKey = (item, id = item.id) => (isInterface(item) ? 'interface:' : 'signal:') + id;
    const views = new Map();
    let model, revision, level = '', selected, scope, busy = false, preview = false, request = 0;
    let wireMode = false, wireStart, objectMode = 'net', hasLayout = false, expandedInterfaces = false, locateAfterLayout;

    function node(tag, text, className) {
        const item = document.createElement(tag);
        if (text !== undefined) item.textContent = text;
        if (className) item.className = className;
        return item;
    }
    const collection = kind => (kind === 'cell' ? model.cells : kind === 'net' ? model.nets : model.endpoints);
    const itemOf = item => item && collection(item.kind)[item.index];
    const sameItem = (a, b) => a && b && a.kind === b.kind && a.index === b.index;
    const levelIndex = () => level ? model.cells.findIndex(cell => cell.id === level) : undefined;
    const viewKey = () => level + '\0' + expandedInterfaces;
    const attached = index => scope.connections.get(index) || [];
    const report = message => { $('status').textContent = message || ''; };
    const canvas = SVToolsBlockDesignCanvas.create($('canvas'), $('drawing'), {
        onSelect: pick,
        onOpen(item) {
            const cell = itemOf(item);
            if (cell?.type === 'hier') changeLevel(cell.id);
            else if (cell && !wireMode) mutate('config', { cell: item.index });
        },
        onZoom: value => { $('zoom-reset').textContent = Math.round(value * 100) + '%'; }
    });

    function mutate(action, target = {}) {
        if (busy || action !== 'refresh' && (!model || preview)) return;
        report('');
        vscode.postMessage({ action, revision, ...target });
    }
    function button(label, action, target) {
        const item = node('button', label);
        item.type = 'button';
        item.disabled = busy || preview;
        item.onclick = () => mutate(action, target);
        return item;
    }
    function buildScope() {
        const cells = [], endpoints = [], nets = [], byName = new Map(), connections = new Map(), owners = new Map();
        model.cells.forEach((cell, index) => {
            if (parentOf(cell.id) === level) { cells.push(index); owners.set(cell.id, index); }
        });
        model.endpoints.forEach((port, index) => {
            if (port.cell === level || owners.has(port.cell)) { endpoints.push(index); byName.set(pinKey(port), index); }
        });
        model.nets.forEach((net, index) => {
            if (parentOf(net.id) !== level) return;
            const pins = net.endpoints.map(id => byName.get(pinKey(net, id))).filter(Number.isInteger);
            nets.push(index);
            for (const pin of pins) {
                if (!connections.has(pin)) connections.set(pin, []);
                connections.get(pin).push(index);
            }
        });
        return { cells, endpoints, nets, byName, connections, owners };
    }

    function showWireHint() {
        $('wire-mode').setAttribute('aria-pressed', String(wireMode));
        const origin = itemOf(wireStart);
        $('wire-hint').textContent = origin ? `从 ${origin.id} 选择另一端` : wireMode ? '选择起始端口' : '';
    }
    function setWiring(enabled) {
        wireMode = enabled;
        wireStart = undefined;
        showWireHint();
        mark();
    }
    function connectOnCanvas(destination) {
        if (busy) return;
        if (!wireStart || sameItem(wireStart, destination)) {
            wireStart = sameItem(wireStart, destination) ? undefined : destination;
            select(destination);
            showWireHint();
            return;
        }
        let origin = wireStart;
        let sourceLinks = attached(origin.index), targetLinks = attached(destination.index);
        if (isInterface(itemOf(origin)) !== isInterface(itemOf(destination))) {
            report('请选择同类端口。普通信号和接口需要分别连接。');
            return;
        }
        if (!sourceLinks.length && targetLinks.length) {
            [origin, destination] = [destination, origin];
            [sourceLinks, targetLinks] = [targetLinks, sourceLinks];
        }
        const link = model.nets[sourceLinks[0]];
        if (targetLinks.length || sourceLinks.length > 1 || link && isInterface(link) && link.endpoints.length > 1) {
            report('端口已有连接。可在检查器断开现有连接，或从一条信号网络接出分支。');
            return;
        }
        select(origin);
        setWiring(false);
        mutate('connect', { endpoint: origin.index, destination: destination.index, net: sourceLinks[0], level: levelIndex() });
    }
    function pick(item) {
        if (wireMode && item?.kind === 'endpoint') connectOnCanvas(item);
        else if (!wireMode) select(item);
    }
    function select(item) {
        selected = itemOf(item) ? item : undefined;
        mark();
        drawSelection();
        for (const button of $('objects').querySelectorAll('button[data-index]')) {
            const entry = { kind: button.dataset.kind, index: Number(button.dataset.index) };
            button.setAttribute('aria-pressed', String(Boolean(sameItem(entry, selected))));
        }
    }

    function mark() {
        const related = { cell: new Set(), net: new Set(), endpoint: new Set() };
        function markPin(index) {
            const endpoint = model.endpoints[index];
            related.endpoint.add(index);
            const interfacePin = endpoint.interfaceId && scope.byName.get('interface:' + endpoint.interfaceId);
            if (Number.isInteger(interfacePin)) related.endpoint.add(interfacePin);
            const owner = scope.owners.get(endpoint.cell);
            if (owner !== undefined) related.cell.add(owner);
        }
        function markNet(index) {
            related.net.add(index);
            const net = model.nets[index];
            for (const id of net.endpoints) {
                const pin = scope.byName.get(pinKey(net, id));
                if (pin !== undefined) markPin(pin);
            }
        }
        if (selected?.kind === 'cell') {
            related.cell.add(selected.index);
            for (const pin of scope.endpoints) {
                if (model.endpoints[pin].cell !== itemOf(selected).id) continue;
                markPin(pin);
                for (const net of attached(pin)) markNet(net);
            }
        } else if (selected?.kind === 'endpoint') {
            markPin(selected.index);
            for (const net of attached(selected.index)) markNet(net);
        } else if (selected?.kind === 'net') markNet(selected.index);
        canvas.highlight(selected, related, wireStart);
        $('canvas').classList.toggle('wiring', wireMode);
    }

    function portLabel(endpoint) {
        const bits = endpoint.left != null && endpoint.right != null && endpoint.left !== '' && endpoint.right !== '' && endpoint.left !== endpoint.right
            ? `[${endpoint.left}:${endpoint.right}]` : '';
        return [endpoint.direction, endpoint.type, bits].filter(Boolean).join(' · ');
    }
    function objectButton(kind, index, title, subtitle) {
        const control = node('button', undefined, 'selector');
        const item = { kind, index };
        control.type = 'button';
        control.dataset.kind = kind;
        control.dataset.index = index;
        control.append(node('span', title), node('small', subtitle));
        control.setAttribute('aria-pressed', String(Boolean(sameItem(selected, item))));
        control.onclick = () => {
            pick(item);
            if (kind === 'endpoint' && itemOf(item).interfaceId && !expandedInterfaces && !attached(index).length) {
                locateAfterLayout = item;
                showInterfaces(true);
            } else canvas.focus(item);
        };
        return control;
    }
    function drawSelection() {
        const container = $('selection');
        container.replaceChildren();
        const item = itemOf(selected);
        if (!item) {
            container.append(node('p', '选择图中的模块、端口或连接。', 'muted'));
            return;
        }
        const index = selected.index, target = { [selected.kind]: index };
        container.append(node('h2', item.id));
        const toolbar = node('div', undefined, 'tools selection-tools');
        if (selected.kind === 'cell') {
            if (item.type === 'hier') {
                const enter = node('button', '进入层级');
                enter.type = 'button';
                enter.onclick = () => changeLevel(item.id);
                toolbar.append(enter);
            } else toolbar.append(button('配置参数', 'config', target));
            toolbar.append(button('删除模块', 'remove', target));
            if (item.vlnv) container.append(node('p', item.vlnv, 'muted'));
            const pins = scope.endpoints.filter(pin => model.endpoints[pin].cell === item.id);
            if (pins.length) {
                const list = node('div', undefined, 'selection-endpoints');
                for (const pin of pins) {
                    const endpoint = model.endpoints[pin];
                    list.append(objectButton('endpoint', pin, short(endpoint.id), portLabel(endpoint)));
                }
                container.append(toolbar, list);
                return;
            }
        } else if (selected.kind === 'net') {
            container.append(node('p', isInterface(item) ? '接口连接' : '信号连接', 'muted'));
            toolbar.append(button('删除连接', 'remove', target));
            const endpoints = node('ul', undefined, 'list selection-endpoints');
            for (const id of item.endpoints) {
                const endpoint = scope.byName.get(pinKey(item, id));
                if (endpoint === undefined) continue;
                const line = node('li', undefined, 'connected-endpoint');
                line.append(objectButton('endpoint', endpoint, id, model.endpoints[endpoint].direction),
                    button('断开', 'disconnect', { net: index, endpoint }));
                endpoints.append(line);
            }
            container.append(toolbar, endpoints);
            return;
        } else {
            container.append(node('p', portLabel(item), 'muted'));
            if (!attached(index).length) {
                toolbar.append(button('连接至…', 'connect', { ...target, level: levelIndex() }));
                if (item.kind.endsWith('pin') && item.cell && !parentOf(item.cell))
                    toolbar.append(button('引出为外部端口', 'externalize', target));
            }
            for (const net of attached(index)) {
                const link = model.nets[net];
                const args = { endpoint: index, net };
                if (!isInterface(link)) toolbar.append(button('从 ' + short(link.id) + ' 分支…', 'connect', args));
                else if (link.endpoints.length === 1) toolbar.append(button('连接至…', 'connect', args));
                toolbar.append(button('断开 ' + short(link.id), 'disconnect', args));
            }
            if (item.kind.endsWith('port')) toolbar.append(button('配置端口', 'config-port', target), button('删除端口', 'remove', target));
            if (item.members?.length) {
                const pins = node('div', undefined, 'selection-endpoints');
                for (const member of item.members) {
                    const pin = scope.byName.get('signal:' + member);
                    if (pin !== undefined) pins.append(objectButton('endpoint', pin, short(member), portLabel(model.endpoints[pin])));
                }
                container.append(toolbar, pins);
                return;
            }
        }
        container.append(toolbar);
    }

    function drawObjects() {
        const query = $('filter').value.trim().toLowerCase();
        const provider = objectMode === 'net' ? [['net', scope.nets]] : [['cell', scope.cells], ['endpoint', scope.endpoints]];
        const rows = [];
        for (const [kind, indexes] of provider) {
            for (const index of indexes) {
                const item = collection(kind)[index];
                const secondary = kind === 'net' ? (isInterface(item) ? '接口' : '信号') + ' · ' + item.endpoints.join(' · ')
                    : kind === 'cell' ? item.vlnv || item.type : portLabel(item);
                if (`${item.id} ${secondary}`.toLowerCase().includes(query)) rows.push({ kind, index, item, secondary });
            }
        }
        const elements = rows.slice(0, 800).map(({ kind, index, item, secondary }) => {
            const row = node('li');
            row.append(objectButton(kind, index, kind === 'net' ? short(item.id) : item.id, secondary));
            return row;
        });
        if (rows.length > 800) elements.push(node('li', '仅显示前 800 项，可通过筛选定位其余对象。', 'muted'));
        else if (!rows.length) elements.push(node('li', query ? '没有匹配的对象。' : '此层级暂无该类对象。', 'muted'));
        $('objects').replaceChildren(...elements);
    }

    function drawControls() {
        for (const control of document.querySelectorAll('[data-action]')) control.disabled = busy || control.dataset.action !== 'refresh' && (!model || preview);
        for (const id of ['zoom-in', 'zoom-out', 'zoom-reset', 'zoom-fit']) $(id).disabled = !hasLayout;
        $('wire-mode').disabled = busy || preview || !scope?.endpoints.length;
        $('interface-members').disabled = !scope?.endpoints.some(index => model.endpoints[index].interfaceId);
        $('interface-members').setAttribute('aria-pressed', String(expandedInterfaces));
        $('level-up').disabled = !level;
    }
    function renderLayout(layout, error) {
        hasLayout = Boolean(layout?.width);
        $('canvas-message').hidden = hasLayout;
        if (hasLayout) {
            const view = views.get(viewKey());
            canvas.draw(layout, model, level, view);
            mark();
            if (locateAfterLayout) canvas.focus(locateAfterLayout);
            else if (selected && view?.autoFit !== false) canvas.focus(selected);
            locateAfterLayout = undefined;
        } else {
            canvas.clear();
            $('canvas-message').textContent = error || '此层级为空。可添加模块或外部端口。';
        }
        drawControls();
    }
    function requestLayout(saved) {
        ++request;
        if (saved) { renderLayout(saved); return; }
        canvas.clear();
        hasLayout = false;
        $('canvas-message').hidden = false;
        $('canvas-message').textContent = '正在布置原理图…';
        drawControls();
        vscode.postMessage({ action: 'layout', revision, level, request, expandedInterfaces });
    }
    function saveView() {
        const state = canvas.state();
        if (state) views.set(viewKey(), state);
    }
    function showInterfaces(expanded) {
        saveView();
        expandedInterfaces = expanded;
        requestLayout();
    }
    function drawLevel(saved) {
        scope = buildScope();
        $('level').value = level;
        $('counts').textContent = `${scope.cells.length} 个模块 · ${scope.nets.length} 条连接`;
        showWireHint();
        drawSelection();
        drawObjects();
        requestLayout(saved);
    }
    function changeLevel(next) {
        if (!model || next === level) return;
        saveView();
        level = next;
        selected = undefined;
        wireMode = false;
        wireStart = undefined;
        locateAfterLayout = undefined;
        $('filter').value = '';
        drawLevel();
    }
    $('level').onchange = () => changeLevel($('level').value);
    $('level-up').onclick = () => changeLevel(parentOf(level));
    $('zoom-in').onclick = () => canvas.zoomBy(1.25);
    $('zoom-out').onclick = () => canvas.zoomBy(0.8);
    $('zoom-reset').onclick = () => canvas.reset();
    $('zoom-fit').onclick = () => canvas.fit();
    $('wire-mode').onclick = () => setWiring(!wireMode);
    $('interface-members').onclick = () => showInterfaces(!expandedInterfaces);
    $('inspector-toggle').onclick = () => {
        $('inspector').hidden = !$('inspector').hidden;
        $('inspector-toggle').setAttribute('aria-expanded', String(!$('inspector').hidden));
        $('main').classList.toggle('wide-canvas', $('inspector').hidden);
    };
    for (const [id, mode] of [['show-nets', 'net'], ['show-objects', 'cell']]) {
        $(id).onclick = () => {
            objectMode = mode;
            $('show-nets').setAttribute('aria-pressed', String(mode === 'net'));
            $('show-objects').setAttribute('aria-pressed', String(mode === 'cell'));
            drawObjects();
        };
    }
    $('filter').oninput = drawObjects;
    for (const control of document.querySelectorAll('[data-action]')) {
        control.onclick = () => {
            control.closest('.more')?.removeAttribute('open');
            mutate(control.dataset.action, control.id === 'add-cell' ? { cell: levelIndex() } : {});
        };
    }
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (wireMode) setWiring(false);
        else if (selected) select(undefined);
    });
    window.addEventListener('message', ({ data }) => {
        if (data.type === 'snapshot') {
            saveView();
            const previous = itemOf(selected);
            model = data.model;
            preview = data.preview;
            revision = data.revision;
            if (previous) {
                const index = collection(selected.kind).findIndex(item => item.id === previous.id && item.kind === previous.kind);
                selected = index < 0 ? undefined : { ...selected, index };
            }
            wireStart = undefined;
            locateAfterLayout = undefined;
            const levels = [{ id: '', label: '顶层' }, ...model.cells.filter(cell => cell.type === 'hier').map(cell => ({ id: cell.id, label: cell.id }))];
            if (!levels.some(entry => entry.id === level)) { level = ''; selected = undefined; }
            $('level').replaceChildren(...levels.map(entry => {
                const option = node('option', entry.label);
                option.value = entry.id;
                return option;
            }));
            $('name').textContent = model.name;
            $('path').textContent = data.file;
            $('path').title = data.file;
            $('main').hidden = false;
            $('address-section').hidden = !model.addresses.length;
            $('addresses').replaceChildren(...model.addresses.map(address => {
                const row = node('tr');
                for (const value of [address.space, address.id, address.offset || '待分配', address.range]) row.append(node('td', value));
                return row;
            }));
            report(data.message);
            drawLevel(!level && !expandedInterfaces ? data.rootLayout : undefined);
        } else if (data.type === 'layout' && data.revision === revision && data.request === request && data.level === level) {
            renderLayout(data.layout, data.error);
        } else if (data.type === 'busy') {
            busy = data.busy;
            if (busy) report('Vivado 正在处理…');
            else if ($('status').textContent === 'Vivado 正在处理…') report('');
            drawControls();
            drawSelection();
        } else if (data.type === 'status') report(data.message);
    });
    drawControls();
    vscode.postMessage({ action: 'ready' });
})();
