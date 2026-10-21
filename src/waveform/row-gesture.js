/* Pointer 手势拥有预览和取消；帧动画只更新视觉坐标，不查询或保存 VCD。 */
(function () {
    'use strict';

    /**
     * @param {object} options Canvas、状态和提交回调；row-layout 负责所有行几何。
     * @returns {{active:boolean,rowActive:boolean,cancel:()=>boolean,finishMotion:()=>void}} 手势控制器。
     */
    window.createWaveRowGestures = function ({ canvas, tracks, state, model, renderer,
        refreshRows, commitRows, paint, onSelection, onPan, commitPan, onPlotClick, onSettled, onStart, blocked, status, onNameClick = () => false }) {
        const L = window.WaveRowLayout, I = window.WaveInteractions;
        const presentation = state.rowPresentation = { positions: null, targetRows: null, dragKeys: null, insertionY: null, resizeKey: null, hoverResizeKey: null };
        const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        let reducedMotion = !!motionPreference?.matches, gesture = null, motion = null, frame = null, preview = null, lastFrame = null;
        const now = () => typeof performance === 'object' ? performance.now() : Date.now();
        const positions = rows => new Map(rows.map(row => [row.key, row.y]));
        const point = event => {
            const bounds = canvas.getBoundingClientRect();
            return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        };

        function requestFrame() { if (frame === null) frame = requestAnimationFrame(tick); }
        function finishMotion() {
            motion = null; presentation.positions = null; presentation.targetRows = null;
            if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
            lastFrame = null; paint();
        }
        function animate(rows) {
            const from = presentation.positions || positions(state.rows), to = positions(rows);
            presentation.targetRows = rows;
            if (reducedMotion) { motion = null; presentation.positions = to; paint(); return; }
            motion = { from, to, start: now() }; presentation.positions = from; requestFrame();
        }
        function tick(timestamp) {
            frame = null;
            const time = Number.isFinite(timestamp) ? timestamp : now();
            if (motion) {
                const result = L.motionPositions(motion.from, motion.to, time - motion.start);
                presentation.positions = result.positions;
                if (result.done) { motion = null; if (!gesture) { presentation.positions = null; presentation.targetRows = null; } }
            }
            if (gesture && (gesture.kind === 'reorder' || gesture.kind === 'resize')) {
                const local = point(gesture.latest), velocity = L.edgeScroll(local.y, tracks.clientHeight);
                const elapsed = Math.min(32, Math.max(0, time - (lastFrame ?? time))), before = tracks.scrollTop;
                tracks.scrollTop = Math.max(0, Math.min(L.totalHeight(state.rows) - tracks.clientHeight, before + velocity * elapsed / 1000));
                if (tracks.scrollTop !== before) updateRowGesture();
                const canScroll = velocity < 0 ? tracks.scrollTop > 0 : velocity > 0 && tracks.scrollTop < L.totalHeight(state.rows) - tracks.clientHeight;
                if (canScroll) requestFrame();
            }
            lastFrame = time; paint(); if (motion) requestFrame();
        }
        function showPreview() {
            if (!preview) {
                preview = document.createElement('div'); preview.className = 'waveDragPreview'; preview.setAttribute('aria-hidden', 'true');
                const name = document.createElement('strong'), count = document.createElement('span');
                name.className = 'waveDragName'; count.className = 'waveDragCount';
                const first = state.signals.get(gesture.targets[0]);
                name.textContent = (state.fullName ? first.path : first.name) + (first.range || '') + (gesture.targets.length > 1 ? ' …' : '');
                count.textContent = `${gesture.targets.length} 条信号 · 松开完成排序`;
                preview.append(name, count); document.body.appendChild(preview);
            }
            const bounds = canvas.getBoundingClientRect(), local = point(gesture.latest), names = renderer.geometry().names;
            preview.style.left = bounds.left + Math.max(8, Math.min(names - 24, local.x + 14)) + 'px';
            preview.style.top = bounds.top + Math.max(8, Math.min(tracks.clientHeight - 54, local.y + 14)) + 'px';
        }
        function clearPreview() { preview?.remove(); preview = null; }
        function clearRowHints() {
            presentation.dragKeys = null; presentation.insertionY = null;
            presentation.resizeKey = null; presentation.hoverResizeKey = null;
            canvas.style.cursor = 'crosshair'; canvas.removeAttribute('title'); clearPreview();
        }
        function release(current) {
            gesture = null;
            if (canvas.releasePointerCapture && (!canvas.hasPointerCapture || canvas.hasPointerCapture(current.pointerId))) canvas.releasePointerCapture(current.pointerId);
        }
        function cancel() {
            if (!gesture) return false;
            const current = gesture; release(current); clearRowHints();
            if (current.kind === 'resize') {
                if (current.savedHeight === undefined) delete state.heights[current.key]; else state.heights[current.key] = current.savedHeight;
                refreshRows();
            } else if (current.kind === 'plot' && current.moved) onPan(current.view);
            if (current.kind === 'reorder') onSelection(current.selection);
            if (current.kind === 'resize' || current.kind === 'reorder') {
                tracks.scrollTop = current.scrollTop; animate(state.rows); onSettled();
            } else finishMotion();
            status('已取消拖动'); return true;
        }
        function startReorder() {
            const key = model.signalKey(gesture.row.signal);
            onSelection(I.selectContextTargets(state.selected, state.multi, key, state.selectionAnchor));
            const targets = new Set(state.multi);
            for (const row of state.rows) if (row.memberKeys?.some(key => targets.has(key))) for (const key of row.memberKeys) targets.add(key);
            gesture.kind = 'reorder'; gesture.targets = I.orderedTargets(state.selected, targets);
            gesture.order = state.selected.slice(); gesture.previewRows = state.rows;
            presentation.dragKeys = new Set(gesture.targets); canvas.style.cursor = 'grabbing';
        }
        function updateRowGesture() {
            const local = point(gesture.latest), y = local.y + tracks.scrollTop;
            if (gesture.kind === 'resize') {
                const requested = gesture.height + gesture.latest.clientY - gesture.clientY + tracks.scrollTop - gesture.scrollTop;
                const height = L.analogHeight(Math.max(L.MIN_ANALOG_HEIGHT, requested));
                if (state.heights[gesture.key] !== height) { state.heights[gesture.key] = height; refreshRows(); }
                status(`模拟量行高 ${height} px · 松开保存，Esc 取消`); paint();
            } else if (gesture.kind === 'reorder') {
                const slot = L.insertionSlot(gesture.previewRows, gesture.targets, y);
                const order = L.insertBlock(state.selected, gesture.targets, slot);
                if (order.some((key, index) => key !== gesture.order[index])) {
                    gesture.order = order;
                    gesture.previewRows = L.buildRows(order, state.signals, state.formats, state.heights, state.groups, state.collapsedGroups); animate(gesture.previewRows);
                }
                presentation.insertionY = gesture.previewRows.find(row => row.key === gesture.targets[0])?.y ?? 0;
                showPreview(); paint();
            }
            if (L.edgeScroll(local.y, tracks.clientHeight)) requestFrame();
        }
        function hover(event) {
            const local = point(event), resizing = L.resizeAt(state.rows, local.y + tracks.scrollTop);
            const key = resizing?.key || null;
            if (presentation.hoverResizeKey !== key) { presentation.hoverResizeKey = key; paint(); }
            canvas.style.cursor = resizing ? 'ns-resize' : local.x < renderer.geometry().names ? 'grab' : 'crosshair';
            if (resizing) canvas.setAttribute('title', `拖动底边调整模拟量行高（${L.MIN_ANALOG_HEIGHT}–${L.MAX_ANALOG_HEIGHT} px）`);
            else {
                const row = L.rowAt(state.rows, local.y + tracks.scrollTop), signal = row?.signal;
                if (signal) canvas.setAttribute('title', signal.path + (signal.range || '') + ' · ' + model.signalDisplay.roleInfo(signal).label
                    + (Number.isInteger(signal.bitOffset) ? ' · ' + signal.bitIndexSource + '[' + signal.bitIndex + ']' : model.signalDisplay.isBus(signal) ? ' · 点击三角或Enter展开/收起' : ''));
                else canvas.removeAttribute('title');
            }
        }
        canvas.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.isPrimary === false || !state.metadata || blocked()) return;
            if (gesture) cancel(); finishMotion(); onStart();
            const local = point(event), y = local.y + tracks.scrollTop, row = L.rowAt(state.rows, y), resizing = L.resizeAt(state.rows, y);
            canvas.focus({ preventScroll: true });
            gesture = { pointerId: event.pointerId, kind: resizing ? 'resize' : local.x < renderer.geometry().names ? 'name' : 'plot', row,
                clientX: event.clientX, clientY: event.clientY, latest: event, scrollTop: tracks.scrollTop, moved: false,
                view: { ...state.view }, selection: { keys: [...state.multi], anchor: state.selectionAnchor, activeKey: state.activeKey } };
            if (resizing) {
                gesture.key = resizing.key; gesture.height = resizing.height; gesture.savedHeight = state.heights[resizing.key];
                presentation.resizeKey = resizing.key; canvas.style.cursor = 'ns-resize'; paint();
            }
            canvas.setPointerCapture(event.pointerId); event.preventDefault?.();
        });
        canvas.addEventListener('pointermove', event => {
            if (!gesture) { hover(event); return; }
            if (event.pointerId !== gesture.pointerId) return;
            gesture.latest = event;
            const dx = event.clientX - gesture.clientX, dy = event.clientY - gesture.clientY;
            if (Math.abs(dx) + Math.abs(dy) > 4) gesture.moved = true;
            if (gesture.kind === 'name' && gesture.row && gesture.moved) startReorder();
            if (gesture.kind === 'resize' || gesture.kind === 'reorder') updateRowGesture();
            else if (gesture.kind === 'plot' && gesture.moved) onPan({ start: gesture.view.start - dx / renderer.geometry().plot * gesture.view.span, span: gesture.view.span });
        });
        canvas.addEventListener('pointerup', event => {
            if (!gesture || gesture.pointerId !== event.pointerId) return;
            gesture.latest = event;
            if (gesture.kind === 'resize' || gesture.kind === 'reorder') updateRowGesture();
            const current = gesture; release(current); clearRowHints();
            if (current.kind === 'resize') { commitRows(); status(`模拟量行高 ${L.analogHeight(state.heights[current.key])} px`); finishMotion(); }
            else if (current.kind === 'reorder') {
                state.selected = current.order; commitRows(); animate(state.rows);
                if (reducedMotion) finishMotion(); status(`已整体移动 ${current.targets.length} 条信号`);
            } else if (current.kind === 'name' && current.row && !onNameClick(point(event), current.row, event)) onSelection(I.selectSignals(state.selected, state.multi, model.signalKey(current.row.signal), state.selectionAnchor, event));
            else if (current.kind === 'plot') {
                if (current.moved) commitPan(); else onPlotClick(point(event), event, current.row);
            }
        });
        canvas.addEventListener('pointercancel', event => { if (gesture?.pointerId === event.pointerId) cancel(); });
        canvas.addEventListener('lostpointercapture', event => { if (gesture?.pointerId === event.pointerId) cancel(); });
        canvas.addEventListener('pointerleave', () => { if (!gesture) { presentation.hoverResizeKey = null; canvas.style.cursor = 'crosshair'; canvas.removeAttribute('title'); paint(); } });
        motionPreference?.addEventListener?.('change', event => {
            reducedMotion = event.matches;
            if (reducedMotion) {
                finishMotion();
                if (gesture?.kind === 'reorder') { presentation.positions = positions(gesture.previewRows); presentation.targetRows = gesture.previewRows; }
                paint();
                if (gesture && L.edgeScroll(point(gesture.latest).y, tracks.clientHeight)) requestFrame();
            }
        });
        return { get active() { return !!gesture; }, get rowActive() { return gesture?.kind === 'resize' || gesture?.kind === 'reorder'; }, cancel, finishMotion };
    };
})();
