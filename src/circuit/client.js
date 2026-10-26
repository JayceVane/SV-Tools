(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./graph-index'), require('./trace-client'), require('./trace-actions'), require('./wave-link-client'),require('./cursor-values-client'));
    else {
        root.CircuitClient = factory(root.CircuitGraphIndex, root.CircuitTraceClient, root.CircuitTraceActions, root.CircuitWaveLink,root.CircuitCursorValues);
        const bridge = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState() { return {}; }, setState() {} };
        root.CircuitClient.createClient(root.document, root, bridge, root.CircuitRenderer);
    }
})(typeof globalThis === 'object' ? globalThis : this, function (graphIndex, traceClient, traceActions, waveLinkClient,cursorValuesClient) {
    'use strict';
    const MIN_SCALE = .0001, MAX_SCALE = 8, PADDING = 40, MAX_SAVED_VIEWS = 32;
    const MAX_DETAIL_BITS = 256, MAX_PARAMETERS = 32, MAX_PARAMETER_CHARS = 256;
    const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
    const text = value => value === undefined || value === null ? '—' : String(value);
    const KINDS = { input: '输入端口', output: '输出端口', inout: '双向端口', constant: '常量', register: '寄存器', mux: '选择器', arithmetic: '算术单元', logic: '组合逻辑', memory: '存储器', instance: '模块实例', unknown: '连接节点', junction: '连接节点', bus: '总线连接' };

    /** @param {object} camera 用户保存的相机。 @returns {object} 有界有限相机。 */
    function cleanCamera(camera) {
        return { x: Math.max(-1e8, Math.min(1e8, finite(camera?.x, 0))), y: Math.max(-1e8, Math.min(1e8, finite(camera?.y, 0))), scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, finite(camera?.scale, 1))) };
    }

    /** @param {object} graph 已布局尺寸。 @param {number} width 视口宽。 @param {number} height 视口高。 @returns {object} 居中适配相机。 */
    function fitCamera(graph, width, height) {
        const graphWidth = Math.max(1, finite(graph?.width, 1)), graphHeight = Math.max(1, finite(graph?.height, 1));
        const scale = Math.max(MIN_SCALE, Math.min(1.5, Math.max(1, width - PADDING * 2) / graphWidth, Math.max(1, height - PADDING * 2) / graphHeight));
        return cleanCamera({ x: (width - graphWidth * scale) / 2, y: (height - graphHeight * scale) / 2, scale });
    }

    /** @param {object} camera 原相机。 @param {number} factor 缩放倍数。 @param {{x:number,y:number}} point 视口锚点。 @returns {object} 保持锚点图坐标不动的相机。 */
    function zoomCamera(camera, factor, point) {
        const old = cleanCamera(camera), scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, old.scale * finite(factor, 1))), ratio = scale / old.scale;
        return cleanCamera({ x: point.x + (old.x - point.x) * ratio, y: point.y + (old.y - point.y) * ratio, scale });
    }

    /** @param {object} design 设计身份。 @param {object} graph 模块身份。 @returns {string} 不复用其他输入设计的视图状态键。 */
    function graphStateKey(design, graph) {
        return JSON.stringify([design?.id || JSON.stringify([design?.title, design?.top, design?.provenance]), graph?.id]);
    }

    /** @param {object} graph 模块图。 @param {string} query 名称片段。 @returns {object[]} 稳定排序且去重的节点/网络匹配。 */
    function searchGraph(graph, query) {
        return graph ? graphIndex.createGraphIndex(graph).search(query).matches : [];
    }

    function parameterText(value) {
        const raw = String(value);
        return raw.length > MAX_PARAMETER_CHARS ? `${raw.slice(0, MAX_PARAMETER_CHARS)}…（共 ${raw.length} 字符）` : raw;
    }

    function bitsProperties(bits, index) {
        const values = Array.isArray(bits) ? bits : [];
        const shown = values.slice(0, MAX_DETAIL_BITS);
        const suffix = values.length > shown.length ? ` …（仅显示前 ${MAX_DETAIL_BITS} 位，完整连接保留在网表）` : '';
        const properties = [['位宽', String(values.length)], ['位 ID（LSB → MSB）', values.length ? shown.join(', ') + suffix : '无位信息']];
        const constants = shown.map((value, index) => /^(?:c:)?(0|1|x|z)$/i.test(String(value)) ? `${index}:${String(value).replace(/^c:/i, '').toUpperCase()}` : null).filter(Boolean);
        if (constants.length) properties.push(['常量位（位置:值）', constants.join(', ')]);
        const aliases = index.relatedSignals(values);
        if (aliases.length) properties.push(['关联信号', aliases.map(signal => {
            const hasRange = Number.isInteger(signal.offset) && signal.bits.length > 1;
            const start = signal.offset, end = start + signal.bits.length - 1;
            return hasRange ? `${signal.name} [${signal.upto ? start : end}:${signal.upto ? end : start}]` : signal.name;
        }).join('\n')]);
        return properties;
    }

    function mappingText(port) {
        let remaining = MAX_DETAIL_BITS;
        const rows = [];
        for (const [i, positions] of port.bitPositions.entries()) {
            if (!remaining) break;
            const shown = positions.slice(0, remaining); remaining -= shown.length;
            rows.push(`${port.bits[i]} → ${shown.join(', ')}${shown.length < positions.length ? ' …' : ''}`);
        }
        return rows.join('\n') + (port.bitPositions.reduce((sum, positions) => sum + positions.length, 0) > MAX_DETAIL_BITS ? `\n…（最多显示${MAX_DETAIL_BITS}个目标位置）` : '');
    }

    /** @param {object} graph 当前模块。 @param {{type:string,id:string}|null} selection 选择标识。 @param {object} [index] 当前模块共享索引。 @returns {object|null} 安全的文本详情和可执行宿主动作。 */
    function describeSelection(graph, selection, index) {
        if (!graph || !selection) return null;
        index ||= graphIndex.createGraphIndex(graph);
        if (selection.type === 'node') {
            const node = index.nodes.get(String(selection.id));
            if (!node) return null;
            const properties = [['类型', KINDS[node.kind] || node.kind]];
            if (node.detail) properties.push(['说明', node.detail]);
            if (node.description) properties.push(['时序语义', node.description]);
            if (node.parameters) {
                const entries = Object.entries(node.parameters);
                properties.push(['工具参数', entries.slice(0, MAX_PARAMETERS).map(([name, value]) => `${name}: ${parameterText(value)}`).join('\n') + (entries.length > MAX_PARAMETERS ? `\n…（仅显示前 ${MAX_PARAMETERS} 项，共 ${entries.length} 项）` : '')]);
            }
            if (node.toolName && node.toolName !== node.label) properties.push(['工具名称', node.toolName]);
            if (node.ports?.length) properties.push(['引脚', node.ports.map(port => `${port.label || port.id} · ${port.declaredDirection || port.direction || 'unknown'} · ${(port.bits || []).length} bit${port.description ? ' · ' + port.description : ''}`).join('\n')]);
            if (node.kind === 'constant') properties.push(...bitsProperties(node.ports?.[0]?.originalBits || node.ports?.[0]?.bits, index));
            if (node.source?.path) properties.push(['源码', `${node.source.path}:${node.source.line || 1}`]);
            return { name: node.label || node.id, kind: KINDS[node.kind] || node.kind, properties, cellId: node.cellId, moduleId: node.moduleId, source: node.source };
        }
        if (selection.type === 'port') {
            const entry = index.ports.get(String(selection.id));
            if (entry) {
                const { node, port } = entry;
                return { name: port.label || port.id, kind: ['input', 'output', 'inout'].includes(node.kind) ? '模块端口' : '单元引脚', properties: [['所属单元', node.label || node.id], ['方向', port.declaredDirection || port.direction || 'unknown'], ...(port.originalWidth ? [['原始端口位宽', String(port.originalWidth)]] : []), ...(port.description ? [['语义', port.description]] : []), ...(port.bitPositions ? [['端口位映射（LSB=0）', mappingText(port)]] : []), ...bitsProperties(port.originalBits || port.bits, index)], cellId: node.cellId, source: node.source };
            }
        }
        if (selection.type === 'edge') {
            const edge = index.edges.get(String(selection.id));
            if (!edge) return null;
            const portName = id => { const entry = index.ports.get(String(id)); return entry ? `${entry.node.label || entry.node.id}.${entry.port.label || entry.port.id}` : id; };
            const endpoints = new Set();
            for (const item of index.networkEdges(edge)) { endpoints.add(portName(item.source)); endpoints.add(portName(item.target)); }
            return { name: edge.label || edge.netId, kind: '网络', properties: [...bitsProperties(edge.originalBits || edge.bits, index), ['网络 ID', edge.netId], ['连接端点', [...endpoints].join('\n')]] };
        }
        return null;
    }

    function provenanceText(provenance) {
        if (!provenance) return '已加载网表';
        if (typeof provenance === 'string') return provenance;
        const version = typeof provenance.version === 'string' ? provenance.version.replace(/^Yosys\s+(\S+)[\s\S]*$/, '$1') : provenance.version;
        return [provenance.engine || provenance.tool || provenance.type, version, provenance.stage, (provenance.flat || provenance.flattened || provenance.hierarchy === 'flat') ? '平面网表' : '', provenance.source].filter(value => typeof value === 'string' && value).join(' · ') || '已加载网表';
    }

    /**
     * 绑定页面和宿主协议。所有监听由 destroy 释放；缩放/选择属于 UI，不发送布局变更。
     * @param {Document} document 页面。 @param {Window} window 页面窗口。
     * @param {object} bridge VS Code 消息与状态桥。 @param {object} renderer SVG 渲染模块。
     * @returns {{receive:function,destroy:function,getState:function}} 生命周期和验收入口。
     */
    function createClient(document, window, bridge, renderer) {
        const ids = ['designTitle', 'provenance', 'back', 'home', 'modules', 'fit', 'zoomOut', 'zoomIn', 'zoom', 'search', 'searchCount', 'nextMatch', 'reload', 'breadcrumbs', 'graphStats', 'viewport', 'circuit', 'message', 'messageTitle', 'messageDetail', 'selectionEmpty', 'selectionDetails', 'selectionKind', 'selectionName', 'properties', 'enterInstance', 'openSource', 'exportImage', 'status'];
        const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
        const imageRequests = new Map(); let imageRequestId = 0, exportingImage = false;
        const disposers = [], saved = bridge.getState?.(), views = new Map(Array.isArray(saved?.views) ? saved.views.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string').slice(-MAX_SAVED_VIEWS) : []);
        let graph = null, design = null, currentModuleId = null, drawing = null, selection = undefined, selected = null, camera = cleanCamera(), stateKey = null, isFit = true, isLoading = true, sourceStale = false, drag = null, lastClickHit = null, matches = [], matchIndex = -1, searchTimer = null, saveTimer = null, cameraFrame = null, saveAfterFrame = false, viewportRect = null, isDestroyed = false;
        const listen = (target, type, callback, options) => { target.addEventListener(type, callback, options); disposers.push(() => target.removeEventListener(type, callback, options)); };
        const post = message => { if (!isDestroyed) bridge.postMessage(message); };
        const traceControls = traceClient.createTraceControls({ document, post, applyFocus: focus => drawing?.setFocus?.(focus) });
        const waveControls = waveLinkClient.createWaveLinkControls({document,window,post});
        const valueControls = cursorValuesClient.createCursorValueControls({document,post,getDrawing:()=>drawing});
        function measureViewport() {
            const rect = ui.circuit.getBoundingClientRect();
            viewportRect = { left: rect.left, top: rect.top, width: Math.max(1, rect.width || 800), height: Math.max(1, rect.height || 500) };
            return viewportRect;
        }
        const size = () => viewportRect || measureViewport();
        function resize() {
            measureViewport();
            if (graph && !isLoading) { if (isFit) fit(); else applyCamera(false); }
        }

        function saveView() {
            if (!stateKey || !graph) return;
            views.delete(stateKey); views.set(stateKey, { camera: cleanCamera(camera), isFit });
            while (views.size > MAX_SAVED_VIEWS) views.delete(views.keys().next().value);
            bridge.setState?.({ views: [...views] });
        }

        function paintCamera() {
            cameraFrame = null;
            if (!drawing || isDestroyed || isLoading) return;
            const view = size();
            drawing.setViewport(camera, view.width, view.height);
            drawing.layer.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.scale})`);
            const label = `${Math.round(camera.scale * 1000) / 10}%`;
            if (ui.zoom.textContent !== label) ui.zoom.textContent = label;
            if (saveAfterFrame) { saveAfterFrame = false; window.clearTimeout(saveTimer); saveTimer = window.setTimeout(saveView, 120); }
        }
        function cancelCameraFrame() {
            if (cameraFrame !== null) window.cancelAnimationFrame(cameraFrame);
            cameraFrame = null; saveAfterFrame = false;
        }
        function applyCamera(shouldSave = true) {
            if (!drawing) return;
            camera = cleanCamera(camera); saveAfterFrame ||= shouldSave;
            if (cameraFrame === null) cameraFrame = window.requestAnimationFrame(paintCamera);
        }

        function fit() { if (!graph || isLoading) return; const view = size(); camera = fitCamera(graph, view.width, view.height); isFit = true; applyCamera(); }
        function zoom(factor, point) { if (!drawing || isLoading) return; const view = size(); camera = zoomCamera(camera, factor, point || { x: view.width / 2, y: view.height / 2 }); isFit = false; applyCamera(); }

        function inspect(value) {
            if (selection !== undefined && selection?.type === value?.type && selection?.id === value?.id) return;
            selection = value; selected = describeSelection(graph, value, drawing?.index); drawing?.setSelection(value);
            traceControls.select(value);
            waveControls.select(value);
            ui.selectionEmpty.hidden = !!selected; ui.selectionDetails.hidden = !selected;
            if (!selected) return;
            ui.selectionKind.textContent = selected.kind; ui.selectionName.textContent = selected.name;
            ui.properties.replaceChildren();
            for (const [label, value] of selected.properties) {
                const term = document.createElement('dt'), detail = document.createElement('dd');
                term.textContent = text(label); detail.textContent = text(value); ui.properties.appendChild(term); ui.properties.appendChild(detail);
            }
            ui.enterInstance.hidden = !selected.moduleId || !selected.cellId;
            ui.openSource.disabled = sourceStale || !selected.source?.path || !!graph?.trace && !selected.source.expectedHash;
            ui.status.textContent = `${selected.kind} · ${selected.name}`;
        }

        function focusMatch(value) {
            inspect(value);
            let bounds;
            if (value.type === 'node') bounds = drawing.index.nodes.get(String(value.id));
            else {
                const edge = drawing.index.edges.get(String(value.id)), point = edge?.sections?.[0]?.startPoint;
                if (point) bounds = { ...point, width: 0, height: 0 };
            }
            if (bounds) {
                const view = size();
                camera = cleanCamera({ scale: Math.max(.6, camera.scale), x: 0, y: 0 });
                camera.x = view.width / 2 - (bounds.x + bounds.width / 2) * camera.scale;
                camera.y = view.height / 2 - (bounds.y + bounds.height / 2) * camera.scale;
                isFit = false; applyCamera();
            }
        }

        function updateSearch(advance = false, shouldFocus = true) {
            if (isLoading) return;
            matches = drawing?.setSearch(ui.search.value) || [];
            matchIndex = matches.length ? (advance ? (matchIndex + 1) % matches.length : 0) : -1;
            ui.searchCount.textContent = ui.search.value.trim() ? matches.length ? `${matchIndex + 1}/${matches.length}` : '0' : '';
            ui.nextMatch.disabled = !matches.length;
            if (matches.length && shouldFocus) focusMatch(matches[matchIndex]);
        }

        function setMode(mode, message) {
            isLoading = mode !== 'graph'; document.body.dataset.mode = mode;
            traceControls.setLoading(isLoading);
            if (isLoading) cancelCameraFrame();
            ui.message.hidden = mode === 'graph'; ui.message.setAttribute('role', mode === 'error' ? 'alert' : 'status');
            if (mode !== 'graph') { ui.messageTitle.textContent = mode === 'error' ? '无法生成电路视图' : '正在生成电路'; ui.messageDetail.textContent = message || '后台读取网表并计算布局'; ui.status.textContent = message || ui.messageTitle.textContent; }
            ui.exportImage.disabled = mode !== 'graph' || exportingImage;
            for (const control of [ui.fit, ui.zoomOut, ui.zoomIn, ui.search]) control.disabled = mode !== 'graph';
            ui.modules.disabled = mode === 'loading' || !design?.modules?.length;
            ui.back.disabled = mode === 'loading' || !ui.back.dataset.available;
            ui.home.disabled = mode === 'loading' || !design?.top;
            ui.nextMatch.disabled = mode !== 'graph' || !matches.length;
            ui.reload.disabled = mode === 'loading'; ui.enterInstance.disabled = mode !== 'graph'; ui.openSource.disabled = sourceStale || mode !== 'graph' || !selected?.source?.path || !!graph?.trace && !selected?.source?.expectedHash;
            if (mode === 'error') ui.graphStats.textContent = '';
        }

        function showDesign(next, moduleId) {
            design = next || {}; currentModuleId = moduleId || design.top;
            traceControls.setDesign(design);
            ui.designTitle.textContent = text(design.title || graph?.name || '电路结构'); ui.provenance.textContent = provenanceText(design.provenance); ui.provenance.title = JSON.stringify(design.provenance || {});
            ui.modules.replaceChildren();
            for (const module of design.modules || []) { const option = document.createElement('option'); option.value = module.id; option.textContent = module.name; option.selected = module.id === currentModuleId; ui.modules.appendChild(option); }
            if (!ui.modules.children.length && currentModuleId) { const option = document.createElement('option'); option.value = currentModuleId; option.textContent = graph?.name || currentModuleId; ui.modules.appendChild(option); }
            ui.modules.value = currentModuleId;
        }

        function showBreadcrumbs(crumbs) {
            ui.breadcrumbs.replaceChildren();
            crumbs.forEach((crumb, index) => { const span = document.createElement('span'); span.textContent = text(crumb.name); span.className = index === crumbs.length - 1 ? 'currentCrumb' : 'parentCrumb'; if (index) ui.breadcrumbs.appendChild(document.createTextNode(' / ')); ui.breadcrumbs.appendChild(span); });
            ui.back.dataset.available = crumbs.length > 1 ? 'true' : '';
        }

        function receive(message) {
            if (isDestroyed || !message || typeof message !== 'object') return;
            waveControls.receive(message);
            valueControls.receive(message);
            if (message.type === 'source-stale') {
                sourceStale = true; ui.openSource.disabled = true;
                ui.status.textContent = '源码已变化，当前图仍对应生成快照；请刷新后再定位源码'; return;
            }
            if (message.type === 'notice') { ui.status.textContent = text(message.message); return; }
            if (message.type === 'trace-state') {
                traceControls.setNavigation(message.navigation);
                ui.exportImage.disabled = exportingImage || isLoading || !!message.navigation?.busy;
                if (message.navigation?.busy) ui.status.textContent = '正在计算局部电路，可继续平移或取消';
                return;
            }
            if (message.type === 'image-result') {
                const pending = imageRequests.get(message.requestId); if (!pending) return; imageRequests.delete(message.requestId);
                if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result); return;
            }
            if (message.type === 'design') { showDesign(message.design); return; }
            if (message.type === 'loading' || message.type === 'error') {
                if (drag) finishDrag(true);
                if (message.reset) { sourceStale = false; showDesign({}); showBreadcrumbs([]); }
                if (Array.isArray(message.breadcrumbs)) showBreadcrumbs(message.breadcrumbs);
                if (message.moduleId) ui.modules.value = currentModuleId = message.moduleId;
                setMode(message.type, text(message.message)); return;
            }
            if (message.type !== 'graph') return;
            if (!message.graph || !Array.isArray(message.graph.nodes) || !Array.isArray(message.graph.edges)) { setMode('error', '电路数据缺少节点或连接信息'); return; }
            if (drag) finishDrag(true);
            const previousGraph = graph, previousCamera = { ...camera }, previousSelection = selection, previousViewport = { ...size() };
            const continuous = ['expand', 'collapse'].includes(message.traceUpdate) && previousGraph?.trace?.rootKey === message.graph.trace?.rootKey;
            cancelCameraFrame(); saveView(); graph = message.graph; sourceStale = message.sourceStale === true;
            const nextDesign = message.design || design || {};
            const moduleId = graph.moduleId || (nextDesign.modules || []).find(module => module.id === graph.id || module.name === graph.name)?.id || graph.id;
            showDesign(nextDesign, moduleId); stateKey = graphStateKey(design, graph);
            drawing = renderer.renderGraph(ui.circuit, graph); lastClickHit = null; selection = undefined; selected = null;
            valueControls.graphReady();
            const crumbs = Array.isArray(message.breadcrumbs) && message.breadcrumbs.length ? message.breadcrumbs : [{ id: graph.id, name: graph.name }];
            showBreadcrumbs(crumbs);
            const stats = graph.stats || {};
            ui.graphStats.textContent = `${stats.cellCount ?? graph.nodes.filter(node => node.cellId).length} 单元 · ${graph.edges.length} 连接`;
            traceControls.showGraph(graph, message.traceNavigation);
            const view = measureViewport();
            const restored = views.get(stateKey); isFit = !restored || restored.isFit !== false;
            camera = isFit ? fitCamera(graph, view.width, view.height) : cleanCamera(restored.camera);
            if (continuous) {
                const anchor = graph.trace.anchor;
                camera = cleanCamera({ ...previousCamera,
                    x: previousCamera.x + (anchor?.previous && anchor.current ? anchor.previous.x - anchor.current.x : 0) * previousCamera.scale + previousViewport.left - view.left,
                    y: previousCamera.y + (anchor?.previous && anchor.current ? anchor.previous.y - anchor.current.y : 0) * previousCamera.scale + previousViewport.top - view.top });
                isFit = false;
            }
            setMode('graph'); inspect(continuous && describeSelection(graph, previousSelection, drawing.index) ? previousSelection : null); applyCamera(false); updateSearch(false, !continuous && message.traceUpdate !== 'history');
            ui.status.textContent = sourceStale ? '源码已变化，当前图仍对应生成快照；请刷新后再定位源码'
                : `${graph.name || graph.id} · ${graph.nodes.length} 节点${graph.nodes.length ? '' : ' · 当前模块没有可显示的电路单元'}`;
        }

        function enter() {
            if (isLoading || !selected?.cellId || !selected.moduleId) return;
            if (graph?.trace) { if (!traceControls.enter(selected.cellId)) ui.status.textContent = '请在追踪边界中选择具体模块端口进入'; return; }
            post({ type: 'navigate', cellId: selected.cellId });
        }
        function source() {
            if (isLoading || ui.openSource.disabled || !selected) return;
            const origin = graph?.trace && traceActions.traceOrigin(graph, selection);
            post({ type: 'source', ...(selected.cellId ? { cellId: selected.cellId } : {}), ...(origin ? { objectId: origin.objectId } : {}) });
        }
        function eventPoint(event) { const rect = size(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
        function finishDrag(cancel) {
            if (!drag) return;
            const current = drag; drag = null; ui.viewport.classList.remove('panning');
            if (ui.circuit.hasPointerCapture?.(current.id)) ui.circuit.releasePointerCapture(current.id);
            if (cancel) { camera = current.camera; isFit = current.isFit; applyCamera(); }
            else if (!current.moved) { lastClickHit = current.hit; inspect(current.hit); }
            else saveView();
        }

        listen(window, 'message', event => receive(event.data));
        listen(ui.fit, 'click', fit); listen(ui.zoomIn, 'click', () => zoom(1.25)); listen(ui.zoomOut, 'click', () => zoom(.8));
        listen(ui.back, 'click', () => { if (!ui.back.disabled) post({ type: 'back' }); }); listen(ui.home, 'click', () => { if (!ui.home.disabled) post({ type: 'home' }); });
        listen(ui.modules, 'change', () => { if (!ui.modules.disabled && ui.modules.value !== currentModuleId) post({ type: 'module', moduleId: ui.modules.value }); });
        listen(ui.exportImage, 'click', async () => {
            if (!graph || isLoading || exportingImage) return;
            const options = await window.ImageExport.choose(document, { returnFocus: ui.circuit }); if (!options) return;
            exportingImage = true; ui.exportImage.disabled = true; ui.status.textContent = graph.trace ? '正在生成当前局部电路图…' : '正在生成完整电路图…';
            try {
                await new Promise(resolve => window.requestAnimationFrame(resolve));
                if (isLoading) throw new Error('电路正在切换，请加载完成后重新导出');
                const image = window.CircuitImageExport.create({ graph, design, options, window, renderer });
                const params = await window.ImageExport.payload(image, { ...options, name: (graph.name || graph.id) + '-circuit' }, window);
                const result = await new Promise((resolve, reject) => { const requestId = ++imageRequestId;
                    imageRequests.set(requestId, { resolve, reject }); post({ type: 'image-save', requestId, params }); });
                ui.status.textContent = result ? '电路图片已导出' : '已取消图片导出';
            } catch (error) { ui.status.textContent = '电路导出失败：' + error.message; }
            finally { exportingImage = false; ui.exportImage.disabled = isLoading; }
        });
        listen(ui.reload, 'click', () => { if (!ui.reload.disabled) post({ type: 'reload' }); }); listen(ui.enterInstance, 'click', enter); listen(ui.openSource, 'click', source);
        listen(ui.search, 'input', () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => updateSearch(), 120); });
        listen(ui.search, 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); window.clearTimeout(searchTimer); updateSearch(true); } });
        listen(ui.nextMatch, 'click', () => updateSearch(true));
        listen(ui.circuit, 'wheel', event => { if (!drawing || isLoading) return; event.preventDefault(); zoom(Math.exp(-Math.max(-300, Math.min(300, event.deltaY)) * .002), eventPoint(event)); }, { passive: false });
        listen(ui.circuit,'contextmenu',event=>{if(!drawing||isLoading)return;inspect(drawing.hitTarget(event.target));waveControls.contextMenu(event);});
        listen(ui.circuit, 'pointerdown', event => {
            if (isLoading || !drawing || event.button !== 0 || drag) return;
            ui.circuit.focus({ preventScroll: true });
            drag = { id: event.pointerId, x: event.clientX, y: event.clientY, camera: { ...camera }, isFit, moved: false, hit: drawing.hitTarget(event.target) };
            ui.circuit.setPointerCapture?.(event.pointerId);
        });
        listen(ui.circuit, 'pointermove', event => {
            if (!drag || event.pointerId !== drag.id) return;
            const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) < 4) return;
            if (!drag.moved) { drag.moved = true; ui.viewport.classList.add('panning'); }
            isFit = false; camera = { ...drag.camera, x: drag.camera.x + dx, y: drag.camera.y + dy }; applyCamera();
        });
        listen(ui.circuit, 'pointerup', event => { if (drag?.id === event.pointerId) finishDrag(false); });
        listen(ui.circuit, 'pointercancel', () => finishDrag(true)); listen(ui.circuit, 'lostpointercapture', () => { if (drag) finishDrag(true); });
        listen(ui.circuit, 'focusin', event => { const hit = drawing?.hitTarget(event.target); if (!isLoading && hit) inspect(hit); });
        listen(ui.circuit, 'dblclick', event => { if (isLoading || !drawing) return; const hit = drawing.hitTarget(event.target) || (event.target === ui.circuit ? lastClickHit : null); if (hit?.type === 'node') { inspect(hit); enter(); } else if (!hit) fit(); });
        listen(document, 'keydown', event => {
            const isInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target?.tagName) || event.target?.isContentEditable;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); ui.search.focus(); ui.search.select(); return; }
            if (event.key === 'Escape') { if (drag) { event.preventDefault(); finishDrag(true); } else if (!isInput) inspect(null); return; }
            if (isInput || isLoading || event.ctrlKey || event.metaKey) return;
            if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); if (!traceControls.back() && !ui.back.disabled) post({ type: 'back' }); return; }
            if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); traceControls.forward(); return; }
            if (event.altKey) return;
            const actions = { f: fit, F: fit, '+': () => zoom(1.25), '=': () => zoom(1.25), '-': () => zoom(.8), Enter: enter, s: source, S: source };
            if (actions[event.key]) { event.preventDefault(); actions[event.key](); return; }
            const movement = { ArrowLeft: [32, 0], ArrowRight: [-32, 0], ArrowUp: [0, 32], ArrowDown: [0, -32] }[event.key];
            if (movement && drawing) { event.preventDefault(); camera.x += movement[0] * (event.shiftKey ? 4 : 1); camera.y += movement[1] * (event.shiftKey ? 4 : 1); isFit = false; applyCamera(); }
        });
        if (window.ResizeObserver) { const observer = new window.ResizeObserver(resize); observer.observe(ui.viewport); disposers.push(() => observer.disconnect()); }
        else listen(window, 'resize', resize);
        listen(window, 'blur', () => { if (drag) finishDrag(true); }); listen(window, 'pagehide', saveView);
        setMode('loading', '正在连接电路数据'); post({ type: 'ready' });
        return { receive, getState: () => ({ graph, selection, camera: { ...camera }, isFit, isLoading }), destroy() { if (isDestroyed) return; if (drag) finishDrag(true); saveView(); isDestroyed = true; traceControls.destroy(); waveControls.destroy(); valueControls.destroy(); for (const pending of imageRequests.values()) pending.resolve(false); imageRequests.clear(); cancelCameraFrame(); window.clearTimeout(searchTimer); window.clearTimeout(saveTimer); for (const dispose of disposers) dispose(); } };
    }

    return { cleanCamera, fitCamera, zoomCamera, graphStateKey, searchGraph, describeSelection, provenanceText, createClient };
});
