/* Webview 控制器：有界查询、虚拟列表、交互和会话布局。 */
(function () {
    'use strict';
    const api = acquireVsCodeApi(), M = window.WaveModel, I = window.WaveInteractions;
    const $ = id => document.getElementById(id);
    const canvas = $('waveCanvas'), tracks = $('tracks'), catalog = $('catalog');
    const ROW_HEIGHT = 38, CATALOG_HEIGHT = 34, MAX_TRACKS = 2000, QUERY_POINT_BUDGET = 240000;
    const state = { metadata: null, signals: new Map(), selected: [], rows: [], formats: Object.create(null), groups: Object.create(null), heights: Object.create(null),
        view: { start: 0, span: 1 }, cursorA: 0, cursorB: null, activeCursor: 'A', activeKey: null,
        multi: new Set(), selectionAnchor: null, fullName: false, snap: true, secondsPerTick: null,
        series: new Map(), seriesKey: '', windowKey: '', valuesA: Object.create(null), valuesB: Object.create(null) };
    const renderer = window.createWaveRenderer({ canvas, ruler: $('ruler'), tracks, state, model: M });
    const memory = window.createMemoryInspector({ request, addSignals: keys => {
        addSignals(keys); state.activeKey = keys[0]; state.selectionAnchor = keys[0]; state.multi = new Set(keys);
        const row = state.rows.find(item => M.signalKey(item.signal) === keys[0]);
        if (row) tracks.scrollTop = row.y;
        viewportChanged();
    }, onChange() { viewportChanged(); persist(); } });
    const pending = new Map();
    let requestId = 0, paintPending = false, filtered = [], windowBusy = false, windowWanted = null;
    let valuesBusy = false, valuesWanted = null, valuesKey = '', edgeVersion = 0, menu = null, groupDialog = null, drag = null;
    $('title').textContent = BOOT.fileName;

    function status(text) { $('status').textContent = text; }
    function request(type, params) {
        const id = ++requestId;
        return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); api.postMessage({ type, requestId: id, params }); });
    }
    function persist() {
        api.setState({ fileKey: BOOT.fileKey, selected: state.selected, start: state.view.start, span: state.view.span,
            cursorA: state.cursorA, cursorB: state.cursorB, formats: state.formats, groups: state.groups,
            heights: state.heights, fullName: state.fullName, snap: state.snap, memory: memory.snapshot() });
    }
    function paint() {
        if (paintPending) return;
        paintPending = true;
        requestAnimationFrame(() => { paintPending = false; renderer.draw(); updateReadout(); });
    }
    function updateReadout() {
        const format = time => M.formatTime(time, state.secondsPerTick);
        $('cursorA').textContent = 'A ' + format(state.cursorA);
        $('cursorB').textContent = 'B ' + format(state.cursorB);
        $('delta').textContent = state.cursorB === null ? 'Δt —' : 'Δt ' + format(state.cursorB - state.cursorA);
        $('viewRange').textContent = format(state.view.start) + ' → ' + format(state.view.start + state.view.span);
        $('rangeFit').disabled = state.cursorB === null || state.cursorB === state.cursorA;
        $('prevEdge').disabled = $('nextEdge').disabled = !state.activeKey;
        canvas.setAttribute('aria-label', `波形；已添加 ${state.selected.length} 条，选中 ${state.multi.size} 条。Ctrl 点击多选，Shift 点击范围选择，右键或 Shift+F10 管理所选信号。`);
    }
    function rebuildRows() {
        let y = 0;
        state.rows = state.selected.map(path => {
            const signal = state.signals.get(path), analog = state.formats[path] === 'analog' || (/real/i.test(signal.type) && !state.formats[path]);
            const height = analog ? state.heights[path] || 100 : ROW_HEIGHT;
            const row = { signal, y, height }; y += height; return row;
        });
        $('trackSpace').style.height = Math.max(y, tracks.clientHeight) + 'px';
        $('empty').hidden = !!state.rows.length;
        updateSelectionCount();
        viewportChanged(); renderCatalog(); persist();
    }
    function visibleIds() { return [...new Set(renderer.visibleRows().map(row => row.signal.id))].slice(0, 256).sort(); }
    function viewportChanged() {
        paint();
        if (!state.metadata) return;
        const ids = visibleIds();
        const params = { ids, start: state.view.start, end: Math.min(state.metadata.endTime, state.view.start + state.view.span),
            pixels: Math.max(1, Math.min(4096, Math.floor(renderer.geometry().plot), Math.floor(QUERY_POINT_BUDGET / Math.max(1, ids.length)))) };
        const key = JSON.stringify(params);
        if (key !== state.windowKey) { state.windowKey = key; windowWanted = { params, key }; pumpWindow(); }
        queueValues();
    }
    async function pumpWindow() {
        if (windowBusy || !windowWanted) return;
        const job = windowWanted; windowWanted = null; windowBusy = true;
        try {
            const result = await request('window', job.params);
            if (job.key === state.windowKey) {
                state.series = new Map(result.series.map(series => [series.id, series])); state.seriesKey = job.key;
                const dense = result.series.reduce((sum, series) => sum + series.dense.length, 0);
                status(dense ? '密集跳变区已标示 · 放大可分辨边沿；A/B 读值与边沿导航始终精确' : `${state.selected.length} 条波形 · 窗口数据就绪`);
                paint();
            }
        } catch (error) { status('窗口加载失败：' + error.message); }
        finally { windowBusy = false; pumpWindow(); }
    }
    function queueValues() {
        memory.refresh(state.cursorA, state.cursorB, state.secondsPerTick);
        const params = { ids: visibleIds(), a: state.cursorA, b: state.cursorB }, key = JSON.stringify(params);
        if (key === valuesKey) return;
        valuesKey = key; state.valuesA = Object.create(null); state.valuesB = Object.create(null); valuesWanted = { params, key }; pumpValues();
    }
    async function pumpValues() {
        if (valuesBusy || !valuesWanted) return;
        const job = valuesWanted; valuesWanted = null; valuesBusy = true;
        try {
            const queries = [request('values', { ids: job.params.ids, time: job.params.a })];
            if (job.params.b !== null) queries.push(request('values', { ids: job.params.ids, time: job.params.b }));
            const results = await Promise.all(queries);
            if (job.key === valuesKey) { state.valuesA = results[0].values; state.valuesB = results[1]?.values || Object.create(null); paint(); }
        } catch (error) { status('游标读值失败：' + error.message); }
        finally { valuesBusy = false; pumpValues(); }
    }
    function setView(view) { state.view = M.clampView(view.start, view.span, state.metadata.endTime); viewportChanged(); persist(); }
    function setCursor(time, cursor) {
        if (!state.metadata) return;
        state[cursor === 'B' ? 'cursorB' : 'cursorA'] = Math.min(state.metadata.endTime, Math.max(0, Math.round(time)));
        queueValues(); paint(); persist();
    }
    async function placeCursor(time, cursor, signal) {
        const version = ++edgeVersion;
        if (!state.snap || !signal) { setCursor(time, cursor); return; }
        try {
            const requests = [request('edge', { id: signal.id, time: Math.max(0, time - .25), direction: 'next' }),
                request('edge', { id: signal.id, time: Math.min(Number.MAX_SAFE_INTEGER, time + .25), direction: 'previous' })];
            const edges = (await Promise.all(requests)).filter(edge => edge.time !== null).sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time));
            if (version !== edgeVersion) return;
            const tolerance = state.view.span / renderer.geometry().plot * 8;
            setCursor(edges[0] && Math.abs(edges[0].time - time) <= tolerance ? edges[0].time : time, cursor);
        } catch (error) { status('吸附失败：' + error.message); if (version === edgeVersion) setCursor(time, cursor); }
    }
    async function navigateEdge(direction) {
        const signal = state.signals.get(state.activeKey);
        if (!signal) return;
        const version = ++edgeVersion, cursor = state.activeCursor, time = state[cursor === 'B' ? 'cursorB' : 'cursorA'] ?? state.cursorA;
        try {
            const edge = await request('edge', { id: signal.id, time, direction });
            if (version !== edgeVersion) return;
            if (edge.time === null) { status('该方向没有更多变更'); return; }
            setCursor(edge.time, cursor);
            if (edge.time < state.view.start || edge.time > state.view.start + state.view.span) setView({ start: edge.time - state.view.span / 2, span: state.view.span });
        } catch (error) { status('边沿查询失败：' + error.message); }
    }
    function renderCatalog() {
        const space = $('catalogSpace'); space.style.height = filtered.length * CATALOG_HEIGHT + 'px'; space.replaceChildren();
        const start = Math.max(0, Math.floor(catalog.scrollTop / CATALOG_HEIGHT) - 2);
        const end = Math.min(filtered.length, start + Math.ceil(catalog.clientHeight / CATALOG_HEIGHT) + 5);
        const selected = new Set(state.selected);
        for (let index = start; index < end; index++) {
            const signal = filtered[index], row = document.createElement('div'); row.className = 'signal' + (selected.has(M.signalKey(signal)) ? ' added' : '');
            row.style.top = index * CATALOG_HEIGHT + 'px'; row.title = `${signal.path}${signal.range || ''} · ${signal.type} · ${signal.changeCount || 0} 次变更`;
            row.tabIndex = 0; row.setAttribute('role', 'listitem');
            for (const [className, text] of [['plus', selected.has(M.signalKey(signal)) ? '✓' : '+'], ['name', signal.name + (signal.range || '')], ['width', /real/i.test(signal.type) ? 'real' : signal.width + 'b']]) {
                const span = document.createElement('span'); span.className = className; span.textContent = text; row.appendChild(span);
                if (className === 'name') { const scope = document.createElement('small'); scope.textContent = signal.scopePath; span.appendChild(scope); }
            }
            const add = () => addSignals([M.signalKey(signal)]); row.onclick = add;
            row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); add(); } };
            space.appendChild(row);
        }
    }
    function filterCatalog() {
        if (!state.metadata) return;
        filtered = M.filterSignals(state.metadata.vars, $('search').value, $('scope').value, $('constants').checked);
        catalog.scrollTop = 0; renderCatalog();
        updateSelectionCount();
    }
    function addSignals(paths) {
        const selected = new Set(state.selected);
        for (const path of paths) if (selected.size < MAX_TRACKS) selected.add(path);
        state.selected = [...selected]; rebuildRows();
        if (selected.size === MAX_TRACKS) status('已添加 2000 条信号；建议按层级或检索条件拆分分析');
    }
    function updateSelectionCount() {
        $('signalCount').textContent = `${filtered.length.toLocaleString()} 个可用 · ${state.selected.length} 个已添加 · ${state.multi.size} 个选中`;
    }
    function applySelection(selection) {
        state.multi = new Set(selection.keys); state.selectionAnchor = selection.anchor; state.activeKey = selection.activeKey;
        updateSelectionCount(); paint();
    }
    function selectRow(row, event) {
        applySelection(I.selectSignals(state.selected, state.multi, M.signalKey(row.signal), state.selectionAnchor, event));
    }
    function hideMenu(restore = true) { if (menu) menu.close(restore); }
    function assignGroup(targets, label) {
        const grouped = I.assignGroup(state.selected, state.groups, targets, label);
        state.selected = grouped.order; state.groups = grouped.groups;
        rebuildRows(); status(`已将 ${targets.length} 条信号加入分组“${I.groupName(label)}”`);
    }
    function showGroupDialog(targets) {
        hideMenu();
        const overlay = document.createElement('div'); overlay.className = 'waveDialogOverlay';
        const dialog = document.createElement('section'); dialog.className = 'waveGroupDialog';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'waveGroupTitle');
        const title = document.createElement('h2'); title.id = 'waveGroupTitle'; title.textContent = '新建信号分组';
        const hint = document.createElement('p'); hint.textContent = `分组作用于所选 ${targets.length} 条信号，保留原有行顺序。`;
        const label = document.createElement('label'); label.textContent = '分组名称'; label.htmlFor = 'waveGroupName';
        const input = document.createElement('input'); input.id = 'waveGroupName'; input.maxLength = 80; input.placeholder = '例如：AXI 写通道';
        const error = document.createElement('p'); error.id = 'waveGroupError'; error.className = 'dialogError'; error.setAttribute('role', 'alert');
        input.setAttribute('aria-describedby', error.id);
        const actions = document.createElement('div'); actions.className = 'dialogActions';
        const cancel = document.createElement('button'); cancel.textContent = '取消';
        const confirm = document.createElement('button'); confirm.textContent = '创建分组'; confirm.className = 'active';
        actions.append(cancel, confirm); dialog.append(title, hint, label, input, error, actions); overlay.appendChild(dialog);
        const close = () => { overlay.remove(); groupDialog = null; canvas.focus({ preventScroll: true }); };
        groupDialog = { close }; cancel.onclick = close;
        confirm.onclick = () => {
            let name;
            try { name = I.groupName(input.value); }
            catch (validation) { error.textContent = validation.message; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
            close(); assignGroup(targets, name);
        };
        input.oninput = () => { error.textContent = ''; input.removeAttribute('aria-invalid'); };
        overlay.onkeydown = event => {
            if (event.key === 'Escape') close();
            else if (event.key === 'Enter') confirm.click();
            else if (event.key === 'Tab') {
                const controls = [input, cancel, confirm], index = controls.indexOf(document.activeElement);
                controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
            } else return;
            event.preventDefault(); event.stopPropagation();
        };
        document.body.appendChild(overlay); input.focus();
    }
    function removeSignals(targets) {
        const removing = new Set(targets);
        state.selected = state.selected.filter(path => !removing.has(path));
        state.multi = new Set(I.orderedTargets(state.selected, state.multi));
        if (removing.has(state.activeKey)) state.activeKey = state.selected[0] || null;
        if (removing.has(state.selectionAnchor)) state.selectionAnchor = state.activeKey;
        rebuildRows(); status(`已移除 ${targets.length} 条信号`);
    }
    function showMenu(event, row) {
        hideMenu(false); if (!row || groupDialog) return;
        applySelection(I.selectContextTargets(state.selected, state.multi, M.signalKey(row.signal), state.selectionAnchor));
        const targets = Object.freeze(I.orderedTargets(state.selected, state.multi)), signals = targets.map(path => state.signals.get(path));
        const formats = targets.map(path => state.formats[path] || (/real/i.test(state.signals.get(path).type) ? 'analog' : 'hex'));
        const mixed = new Set(formats).size > 1;
        const action = (id, label, callback, extra = {}) => ({ id, label, ...extra, action: () => { callback(); } });
        const formatItems = [];
        let category = null;
        for (const option of M.FORMAT_OPTIONS) {
            if (category && category !== option.category) formatItems.push({ separator: true });
            category = option.category;
            formatItems.push(action('format-' + option.id, option.label, () => {
                for (const path of targets) state.formats[path] = option.id;
                rebuildRows(); status(`已为 ${targets.length} 条信号设置 ${option.label}`);
            }, { checked: !mixed && formats[0] === option.id, ...I.formatAvailability(option, signals, M.supportsFormat) }));
        }
        const groups = [...new Set(state.selected.map(path => state.groups[path]).filter(Boolean))];
        const items = [{ id: 'display-format', label: '显示格式' + (mixed ? ' · 混合' : ''), submenu: formatItems },
            action('analog-height', '增加模拟量行高', () => {
                for (const path of targets) { state.formats[path] = 'analog'; state.heights[path] = Math.min(280, (state.heights[path] || 100) + 40); }
                rebuildRows(); status(`已调整 ${targets.length} 条模拟量波形行高`);
            }, { disabled: signals.some(signal => !M.supportsFormat(signal, 'analog')) }),
            { separator: true }, action('new-group', '新建分组…', () => showGroupDialog(targets))];
        if (groups.length) items.push({ id: 'join-group', label: '加入已有分组', submenu: groups.map((name, index) =>
            action('join-group-' + index, name, () => assignGroup(targets, name))) });
        items.push(action('ungroup', '解除分组', () => {
            for (const path of targets) delete state.groups[path]; rebuildRows(); status(`已解除 ${targets.length} 条信号的分组`);
        }, { disabled: targets.every(path => !state.groups[path]) }),
        { separator: true }, action('remove-signals', '移除所选信号', () => removeSignals(targets)));
        menu = window.createWaveMenu({ items, x: event.clientX, y: event.clientY, title: `已选 ${targets.length} 条信号`, returnFocus: canvas,
            onClose: () => { menu = null; } });
    }
    function initialize(metadata) {
        metadata = { ...metadata, vars: M.prepareSignals(metadata.vars) };
        state.metadata = metadata; state.signals = new Map(metadata.vars.map(signal => [M.signalKey(signal), signal])); state.secondsPerTick = metadata.secondsPerTick || null;
        const saved = api.getState(), restored = M.restoreState(saved, metadata, BOOT.fileKey);
        Object.assign(state, { view: restored.view, cursorA: restored.cursorA, cursorB: restored.cursorB });
        if (saved?.fileKey === BOOT.fileKey) {
            state.formats = Object.assign(Object.create(null), saved.formats); state.groups = Object.assign(Object.create(null), saved.groups); state.heights = Object.assign(Object.create(null), saved.heights);
            state.fullName = !!saved.fullName; state.snap = saved.snap !== false;
        }
        const seen = new Set();
        state.selected = saved?.fileKey === BOOT.fileKey ? restored.selected.slice(0, MAX_TRACKS) : metadata.vars.filter(signal => {
            if (/parameter/i.test(signal.type) || !signal.changeCount || seen.has(signal.id)) return false;
            seen.add(signal.id); return true;
        }).slice(0, 16).map(M.signalKey);
        for (const path of Object.keys(state.formats)) {
            const signal = state.signals.get(path);
            if (!signal || !M.supportsFormat(signal, state.formats[path])) delete state.formats[path];
        }
        state.activeKey = state.selected[0] || null;
        state.selectionAnchor = state.activeKey;
        const scope = $('scope');
        for (const path of new Set(metadata.scopes.map(item => item.path))) {
            const option = document.createElement('option'); option.value = path; option.textContent = path; scope.appendChild(option);
        }
        $('metadata').textContent = `${metadata.vars.length.toLocaleString()} signals · ${(metadata.fileBytes / 1048576 || 0).toFixed(1)} MiB · ${metadata.timescale || 'timescale 未声明'} · ${M.formatTime(metadata.endTime, state.secondsPerTick)}`;
        $('loading').classList.add('hidden'); $('snap').classList.toggle('active', state.snap); $('fullName').classList.toggle('active', state.fullName);
        memory.refresh(state.cursorA, state.cursorB, state.secondsPerTick);
        memory.initialize(metadata.vars, saved?.fileKey === BOOT.fileKey ? saved.memory : null);
        filterCatalog(); rebuildRows();
    }
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'response') { const promise = pending.get(message.requestId); if (!promise) return; pending.delete(message.requestId);
            if (message.error) promise.reject(new Error(message.error)); else promise.resolve(message.result); }
        else if (message.type === 'init') initialize(message.metadata);
        else if (message.type === 'progress') {
            $('progress').max = Math.max(1, message.progress.fileBytes); $('progress').value = message.progress.bytesRead;
            $('loadDetail').textContent = `${(message.progress.bytesRead / 1048576).toFixed(1)} / ${(message.progress.fileBytes / 1048576).toFixed(1)} MiB · ${message.progress.eventCount.toLocaleString()} events`;
        } else if (message.type === 'error') {
            $('loadTitle').textContent = 'VCD 加载失败'; $('loadError').textContent = message.error; $('progress').hidden = true; $('cancel').textContent = '关闭面板';
            $('cancel').onclick = () => api.postMessage({ type: 'close' }); status(message.error);
        }
    });
    let filterTimer;
    $('search').oninput = () => { clearTimeout(filterTimer); filterTimer = setTimeout(filterCatalog, 100); };
    $('scope').onchange = $('constants').onchange = filterCatalog;
    catalog.onscroll = renderCatalog; tracks.onscroll = viewportChanged;
    $('addFiltered').onclick = () => addSignals(filtered.map(M.signalKey));
    $('clearSignals').onclick = () => { hideMenu(false); state.selected = []; state.activeKey = null; state.selectionAnchor = null; state.multi.clear(); rebuildRows(); };
    $('fit').onclick = () => state.metadata && setView({ start: 0, span: state.metadata.endTime });
    const zoom = factor => state.metadata && setView(M.zoomView(state.view, factor, .5, state.metadata.endTime));
    $('zoomIn').onclick = () => zoom(.5); $('zoomOut').onclick = () => zoom(2);
    $('rangeFit').onclick = () => { if (state.cursorB !== null) setView({ start: Math.min(state.cursorA, state.cursorB), span: Math.abs(state.cursorA - state.cursorB) }); };
    $('prevEdge').onclick = () => navigateEdge('previous'); $('nextEdge').onclick = () => navigateEdge('next');
    $('cursorMode').onclick = () => { state.activeCursor = state.activeCursor === 'A' ? 'B' : 'A'; $('cursorMode').textContent = '游标 ' + state.activeCursor; };
    $('snap').onclick = () => { state.snap = !state.snap; $('snap').classList.toggle('active', state.snap); persist(); };
    $('fullName').onclick = () => { state.fullName = !state.fullName; $('fullName').classList.toggle('active', state.fullName); viewportChanged(); persist(); };
    $('memoryToggle').onclick = () => memory.toggle();
    const jump = () => { if (!state.metadata) return; const time = M.parseTime($('jumpTime').value, state.secondsPerTick);
        if (time === null || time > state.metadata.endTime) { status('时间无效或超出文件范围；可输入 ticks 或带单位的时间'); return; }
        ++edgeVersion; setCursor(time, state.activeCursor); setView({ start: time - state.view.span / 2, span: state.view.span }); };
    $('jump').onclick = jump; $('jumpTime').onkeydown = event => { if (event.key === 'Enter') jump(); };
    $('cancel').onclick = () => api.postMessage({ type: 'cancel' });
    canvas.oncontextmenu = event => { event.preventDefault(); showMenu(event, renderer.rowAt(event.offsetY)); };
    document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) hideMenu(false); });
    window.addEventListener('blur', () => { hideMenu(false); drag = null; });
    window.addEventListener('resize', () => hideMenu(false));
    canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !state.metadata) return;
        const row = renderer.rowAt(event.offsetY), g = renderer.geometry(); canvas.focus();
        drag = { x: event.clientX, y: event.clientY, start: state.view.start, span: state.view.span,
            name: event.offsetX < g.names, row, moved: false }; canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
        if (!drag) return;
        const dx = event.clientX - drag.x;
        if (Math.abs(dx) + Math.abs(event.clientY - drag.y) > 4) drag.moved = true;
        if (drag.moved && drag.name && drag.row && !drag.targets) {
            const key = M.signalKey(drag.row.signal);
            if (!state.multi.has(key)) applySelection(I.selectSignals(state.selected, [], key, key));
            drag.targets = I.orderedTargets(state.selected, state.multi);
        }
        if (drag.moved && !drag.name) setView({ start: drag.start - dx / renderer.geometry().plot * drag.span, span: drag.span });
    });
    canvas.addEventListener('pointerup', event => {
        if (!drag) return; const current = drag; drag = null;
        if (current.name && current.row) {
            if (current.moved) { const target = renderer.rowAt(event.offsetY); if (target) {
                state.selected = I.moveSignals(state.selected, current.targets || [M.signalKey(current.row.signal)], M.signalKey(target.signal));
                rebuildRows(); status(`已整体移动 ${(current.targets || []).length || 1} 条信号`);
            } } else selectRow(current.row, event);
        } else if (!current.moved) {
            if (current.row) state.activeKey = M.signalKey(current.row.signal);
            const g = renderer.geometry(), time = state.view.start + Math.max(0, (event.offsetX - g.names) / g.plot) * state.view.span;
            placeCursor(time, event.shiftKey ? 'B' : state.activeCursor, current.row?.signal);
        }
    });
    canvas.addEventListener('pointercancel', () => { drag = null; });
    tracks.addEventListener('wheel', event => {
        if (!state.metadata) return;
        if (event.ctrlKey || event.metaKey) { event.preventDefault(); const left = tracks.getBoundingClientRect().left, g = renderer.geometry();
            setView(M.zoomView(state.view, event.deltaY > 0 ? 1.25 : .8, (event.clientX - left - g.names) / g.plot, state.metadata.endTime));
        } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) { event.preventDefault();
            setView({ start: state.view.start + (event.deltaX || event.deltaY) / renderer.geometry().plot * state.view.span, span: state.view.span }); }
    }, { passive: false });
    $('ruler').onclick = event => { if (!state.metadata) return; const g = renderer.geometry();
        if (event.offsetX >= g.names) placeCursor(state.view.start + (event.offsetX - g.names) / g.plot * state.view.span, event.shiftKey ? 'B' : state.activeCursor, state.signals.get(state.activeKey)); };
    document.addEventListener('keydown', event => {
        if (menu || groupDialog || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName) || event.target.isContentEditable) return;
        const waveFocused = event.target === canvas;
        if (waveFocused && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
            const row = state.rows.find(item => M.signalKey(item.signal) === state.activeKey) || state.rows[0];
            if (!row) return;
            const bounds = canvas.getBoundingClientRect();
            showMenu({ clientX: bounds.left + Math.min(150, renderer.geometry().names - 10),
                clientY: bounds.top + Math.max(0, Math.min(canvas.clientHeight - 10, row.y - tracks.scrollTop + row.height)) }, row);
            event.preventDefault(); return;
        }
        if (waveFocused && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            state.multi = new Set(state.selected); state.activeKey = state.activeKey || state.selected[0] || null;
            state.selectionAnchor = state.selectionAnchor || state.activeKey; updateSelectionCount(); paint();
            event.preventDefault(); return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Escape') { state.multi.clear(); state.selectionAnchor = null; updateSelectionCount(); paint(); }
        else if (event.key === 'f' || event.key === 'F') $('fit').click();
        else if (event.key === '+' || event.key === '=') zoom(.5);
        else if (event.key === '-') zoom(2);
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); navigateEdge(event.key === 'ArrowLeft' ? 'previous' : 'next'); }
        else if (waveFocused && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && state.rows.length) {
            const current = Math.max(0, state.selected.indexOf(state.activeKey));
            const next = Math.max(0, Math.min(state.rows.length - 1, current + (event.key === 'ArrowUp' ? -1 : 1)));
            const row = state.rows[next]; selectRow(row, event);
            if (row.y < tracks.scrollTop) tracks.scrollTop = row.y;
            else if (row.y + row.height > tracks.scrollTop + tracks.clientHeight) tracks.scrollTop = row.y + row.height - tracks.clientHeight;
            event.preventDefault();
        } else if (event.key === 'Delete' && waveFocused && state.multi.size) {
            removeSignals(I.orderedTargets(state.selected, state.multi)); event.preventDefault();
        }
    });
    new ResizeObserver(() => { $('trackSpace').style.height = Math.max(state.rows.reduce((sum, row) => sum + row.height, 0), tracks.clientHeight) + 'px'; viewportChanged(); renderCatalog(); }).observe(tracks);
    new MutationObserver(() => { renderer.colors(); paint(); }).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] });
    if (BOOT.metadata) initialize(BOOT.metadata);
    else api.postMessage({ type: 'ready' });
})();
