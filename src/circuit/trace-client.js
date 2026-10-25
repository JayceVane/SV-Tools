(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./trace-actions'));
    else root.CircuitTraceClient = factory(root.CircuitTraceActions);
})(typeof globalThis === 'object' ? globalThis : this, function (actions) {
    'use strict';
    /** @param {object} options 页面和消息适配。 @returns {object} 追踪操作面板，状态与绘图分离。 */
    function createTraceControls({ document, post, applyFocus = () => {} }) {
        const ids = ['traceChoose', 'traceDrivers', 'traceLoads', 'traceBits', 'traceFocus', 'tracePanel', 'traceSummary',
            'tracePrecision', 'traceLimit', 'traceBack', 'traceForward', 'traceCancel', 'traceBranches', 'traceFrontiers'];
        const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)])), disposers = [];
        let graph, selection, navigation = {}, ready = false, loading = true;
        ui.traceBits.value = '*';
        const listen = (target, type, callback) => { target.addEventListener(type, callback); disposers.push(() => target.removeEventListener(type, callback)); };
        function refresh() {
            const origin = actions.traceOrigin(graph, selection), focused = origin && navigation.focus?.includes(origin.objectId);
            const blocked = loading || !!navigation.busy;
            ui.traceChoose.disabled = !ready || blocked;
            ui.traceDrivers.disabled = ui.traceLoads.disabled = ui.traceBits.disabled = !origin || blocked;
            ui.traceFocus.disabled = !origin || !graph?.trace || blocked;
            ui.traceFocus.textContent = focused ? '取消关注' : '固定关注'; ui.traceFocus.setAttribute('aria-pressed', String(!!focused));
            ui.tracePanel.hidden = !graph?.trace && !navigation.visible;
            ui.traceBack.disabled = !navigation.back || blocked; ui.traceForward.disabled = !navigation.forward || blocked;
            ui.traceCancel.hidden = !navigation.busy;
            for (const parent of [ui.traceBranches, ui.traceFrontiers]) for (const element of parent.children) if (element.tagName === 'BUTTON') element.disabled = blocked;
            applyFocus(navigation.focus || []);
        }
        function add(parent, tag, text, field, id) {
            const element = document.createElement(tag); element.textContent = text;
            if (field) element.dataset[field] = id;
            parent.appendChild(element); return element;
        }
        function showGraph(next, nextNavigation) {
            graph = next; selection = null; navigation = nextNavigation || navigation;
            ui.traceBranches.replaceChildren(); ui.traceFrontiers.replaceChildren();
            const trace = graph?.trace;
            const bitCount = trace?.origin.bits?.length;
            ui.traceSummary.textContent = trace ? `${trace.origin.name}${bitCount ? ` · ${bitCount}/${trace.origin.width} bit` : ''} · ${trace.direction === 'drivers' ? '追踪驱动' : '追踪负载'} · ${trace.contextLabel || (trace.context.kind === 'instance' ? '实例上下文' : '模块定义')}` : '模块全图';
            ui.traceSummary.title = ui.traceSummary.textContent;
            ui.tracePrecision.textContent = trace ? trace.precision === 'cell' ? '含保守依赖范围' : '结构位映射' : '';
            ui.tracePrecision.dataset.precision = trace?.precision || '';
            ui.traceLimit.textContent = trace?.truncated ? '容量已截断：' + (trace.truncationLabels || trace.truncationReasons).join(' / ') : '';
            ui.traceLimit.title = trace?.truncated ? '请缩小位范围或进入子模块追踪，当前图保留已发现的部分结果' : '';
            for (const branch of trace?.branches || []) add(ui.traceBranches, 'button', branch.label + ' · 收起 ×', 'branchId', branch.id);
            for (const frontier of trace?.frontiers || []) {
                if (frontier.kind === 'boundary' && (frontier.reason.endsWith('-budget') || ['constant', 'module-port', 'no-dependent-bits'].includes(frontier.reason))) continue;
                const label = frontier.kind === 'expand' ? (frontier.reason === 'sequential' ? '跨时序展开 · ' : '展开 · ') + frontier.name
                    : frontier.kind === 'enter' ? '进入模块端口 · ' + frontier.name : frontier.label;
                const element = add(ui.traceFrontiers, frontier.kind === 'boundary' ? 'span' : 'button', label,
                    frontier.kind === 'boundary' ? null : 'frontierId', frontier.id);
                element.classList.add('traceBoundary'); element.dataset.reason = frontier.reason;
                element.title = (frontier.controls || []).map(control => control.name + '：' + control.description).join('\n') || frontier.label;
            }
            refresh();
        }
        function delegated(event, parent, field, type) {
            let target = event.target;
            while (target && target !== parent) {
                if (target.dataset?.[field]) { if (!loading && !navigation.busy) post({ type, [field]: target.dataset[field] }); return; }
                target = target.parentNode;
            }
        }
        for (const [id, direction] of [['traceDrivers', 'drivers'], ['traceLoads', 'loads']]) listen(ui[id], 'click', () => {
            if (!ui[id].disabled) post({ type: 'trace-start', selection, direction, bitChoice: ui.traceBits.value });
        });
        listen(ui.traceChoose, 'click', () => { if (!ui.traceChoose.disabled) post({ type: 'trace-choose', direction: 'drivers' }); });
        listen(ui.traceBack, 'click', () => { if (!ui.traceBack.disabled) post({ type: 'trace-back' }); });
        listen(ui.traceForward, 'click', () => { if (!ui.traceForward.disabled) post({ type: 'trace-forward' }); });
        listen(ui.traceCancel, 'click', () => post({ type: 'trace-cancel' }));
        listen(ui.traceFocus, 'click', () => { if (!ui.traceFocus.disabled) post({ type: 'trace-focus', selection }); });
        listen(ui.traceFrontiers, 'click', event => delegated(event, ui.traceFrontiers, 'frontierId', 'trace-expand'));
        listen(ui.traceBranches, 'click', event => delegated(event, ui.traceBranches, 'branchId', 'trace-collapse'));
        refresh();
        return { showGraph, select(value) { selection = value; refresh(); },
            setDesign(value) { ready = !!value?.modules?.length; refresh(); },
            setLoading(value) { loading = value; refresh(); },
            setNavigation(value) { navigation = value || {}; refresh(); },
            back() { if (ui.traceBack.disabled) return false; post({ type: 'trace-back' }); return true; },
            forward() { if (ui.traceForward.disabled) return false; post({ type: 'trace-forward' }); return true; },
            enter(cellId) {
                const candidates = graph?.trace?.frontiers.filter(frontier => frontier.kind === 'enter' && frontier.next.cellId === cellId) || [];
                if (candidates.length === 1) { post({ type: 'trace-expand', frontierId: candidates[0].id }); return true; }
                return false;
            },
            destroy() { for (const dispose of disposers) dispose(); } };
    }
    return { createTraceControls };
});
