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

    // ---- 地址编辑器：主地址空间、已映射段与未映射从设备段 ----
    const hexNumber = value => {
        const text = String(value === undefined || value === null ? '' : value).replace(/[\s_]/g, '');
        return /^0x[0-9a-f]{1,16}$/i.test(text) ? BigInt(text) : undefined;
    };
    function hexText(value, digits) {
        let text = value.toString(16).toUpperCase();
        if (digits) text = text.padStart(digits, '0');
        return '0x' + text.replace(/\B(?=(?:[0-9A-F]{4})+(?![0-9A-F]))/g, '_');
    }
    const sizeText = value => {
        const hit = [[1n << 30n, 'G'], [1n << 20n, 'M'], [1n << 10n, 'K']]
            .find(([unit]) => value >= unit && value % unit === 0n);
        return hit ? (value / hit[0]).toString() + hit[1] : value.toString();
    };
    const bitWidth = value => { let bits = 0; while ((1n << BigInt(bits)) < value) bits += 1; return bits; };
    const spaceParent = id => id.slice(0, id.lastIndexOf('/'));
    const spaceSlug = id => spaceParent(id).split('/').filter(Boolean).join('_');
    const segmentLabel = segment => segment.name || segment.id.slice(segment.id.lastIndexOf('/') + 1);
    const isExternal = space => space.owner.kind === 'port';
    // Vivado 偶尔解析不到空间宿主；已有偏移的段仍按主地址空间展示，避免地址被隐藏。
    const isMasterSpace = space => isExternal(space) || (space.owner.kind === 'pin' && space.owner.mode === 'Master')
        || (!space.owner.kind && space.segments.some(segment => hexNumber(segment.offset) !== undefined));
    const isSlaveSpace = space => space.owner.kind === 'pin' && space.owner.mode === 'Slave';
    function slaveOf(name, spaces) {
        for (const space of spaces) {
            if (!isSlaveSpace(space)) continue;
            const prefix = 'SEG_' + spaceSlug(space.id) + '_';
            for (const segment of space.segments) if (prefix + segmentLabel(segment) === name) return { space, segment };
        }
    }
    function addressInput(space, segment, field) {
        const input = node('input');
        input.type = 'text';
        input.value = (field === 'offset' ? segment.offset : segment.range) || '';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.dataset.field = field;
        input.disabled = busy || preview;
        input.setAttribute('aria-label', (field === 'offset' ? '偏移地址 ' : '范围 ') + segment.id);
        input.onchange = () => {
            const row = input.closest('tr');
            mutate('address-edit', { space: space.id, segment: segment.id,
                offset: row.querySelector('input[data-field=offset]').value,
                range: row.querySelector('input[data-field=range]').value });
        };
        const cell = node('td');
        cell.append(input);
        return cell;
    }
    function mappedRow(space, segment, spaces) {
        const row = node('tr');
        const slave = slaveOf(segmentLabel(segment), spaces);
        const offset = hexNumber(segment.offset), range = hexNumber(segment.range);
        row.append(node('td', slave ? slave.space.id : '—'));
        row.append(node('td', segmentLabel(segment)));
        row.append(addressInput(space, segment, 'offset'));
        row.append(addressInput(space, segment, 'range'));
        const width = String(segment.offset || '').replace(/^0x/i, '').length;
        row.append(node('td', offset !== undefined && range !== undefined && range > 0n ? hexText(offset + range - 1n, width) : '—', 'addr-number'));
        row.append(node('td', slave ? slave.segment.id : '', 'muted'));
        row.append(node('td'));
        return row;
    }
    function unmappedRow(space, segment) {
        const row = node('tr', undefined, 'addr-unmapped');
        row.append(node('td', '—'));
        row.append(node('td', space.id));
        row.append(node('td', segmentLabel(segment)));
        const range = hexNumber(segment.range);
        const hint = node('td', range ? sizeText(range) : '', 'muted');
        hint.colSpan = 3;
        row.append(hint);
        const action = node('button', '映射…');
        action.type = 'button';
        action.disabled = busy || preview;
        action.onclick = () => mutate('address-map', { segment: segment.id });
        const cell = node('td');
        cell.append(action);
        row.append(cell);
        return row;
    }
    function groupRow(title, detail) {
        const row = node('tr', undefined, 'addr-group');
        const cell = node('td');
        cell.colSpan = 7;
        cell.append(node('strong', title));
        if (detail) cell.append(node('span', ' ' + detail, 'muted'));
        row.append(cell);
        return row;
    }
    function drawAddresses() {
        const body = $('addresses');
        if (!model) { body.replaceChildren(); return; }
        const spaces = model.spaces || [];
        const masters = spaces.filter(isMasterSpace);
        const mapped = new Set(masters.flatMap(space => space.segments.map(segmentLabel)));
        const unmapped = spaces.filter(isSlaveSpace).flatMap(space => space.segments.map(segment => ({ space, segment })))
            .filter(({ space, segment }) => !mapped.has('SEG_' + spaceSlug(space.id) + '_' + segmentLabel(segment)));
        const rows = [];
        for (const space of masters) {
            const range = hexNumber(space.range);
            rows.push(groupRow(space.id, range ? bitWidth(range) + ' 位 · 0x0000_0000 [' + sizeText(range) + '] · ' + (isExternal(space) ? '外部主设备' : '内部主设备')
                : (isExternal(space) ? '外部主设备' : '内部主设备')));
            if (!space.segments.length) {
                const empty = node('tr');
                const cell = node('td', '尚未分配从设备段', 'muted');
                cell.colSpan = 7;
                empty.append(cell);
                rows.push(empty);
            }
            for (const segment of space.segments) rows.push(mappedRow(space, segment, spaces));
        }
        if (unmapped.length) {
            rows.push(groupRow('未映射的从设备段', unmapped.length + ' 个'));
            for (const { space, segment } of unmapped) rows.push(unmappedRow(space, segment));
        }
        body.replaceChildren(...rows);
        $('address-empty').hidden = rows.length > 0;
        const total = masters.reduce((sum, space) => sum + space.segments.length, 0);
        $('address-summary').textContent = rows.length ? masters.length + ' 个主地址空间 · ' + total + ' 个已映射段' : '';
    }
    let view = 'diagram';
    function showView(next) {
        view = next === 'address' ? 'address' : 'diagram';
        $('diagram-view').hidden = view !== 'diagram';
        $('address-view').hidden = view !== 'address';
        $('tab-diagram').setAttribute('aria-selected', String(view === 'diagram'));
        $('tab-address').setAttribute('aria-selected', String(view === 'address'));
        if (view === 'address') drawAddresses();
    }
    $('tab-diagram').onclick = () => showView('diagram');
    $('tab-address').onclick = () => showView('address');

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
        for (const control of document.querySelectorAll('#addresses input, #addresses button')) control.disabled = busy || preview;
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
            drawAddresses();
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
