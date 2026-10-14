/* 分隔线只管理请求宽度和动作边界；绘制、VCD 查询与会话保存由调用方负责。 */
(function () {
    'use strict';
    const KEY_STEP = 8, LARGE_KEY_STEP = 32;
    const editable = target => /^(INPUT|SELECT|TEXTAREA)$/.test(target?.tagName || '') || target?.isContentEditable;

    /**
     * @param {object} options handles 提供请求值读写、有效宽度和动态边界；回调由控制器统一触发。
     * @returns {{active:boolean,cancel:()=>boolean,sync:()=>void,dispose:()=>void}} 独立列宽控制器。
     */
    window.createWaveColumnResize = function ({ handles, onStart = () => {}, onPreview = () => {},
        onCommit = () => {}, onCancel = () => {}, onEnd = () => {}, blocked = () => false }) {
        let drag = null, disposed = false;
        const bindings = [];
        function bind(element, name, handler, options) {
            element.addEventListener(name, handler, options); bindings.push(() => element.removeEventListener(name, handler, options));
        }
        function stop(event) { event.preventDefault?.(); event.stopPropagation?.(); }
        function limits(handle) {
            const bounds = handle.bounds();
            const min = Number.isFinite(bounds.min) ? Math.max(0, Math.ceil(bounds.min)) : 0;
            const max = Number.isFinite(bounds.max) ? Math.max(min, Math.floor(bounds.max)) : Number.MAX_SAFE_INTEGER;
            return { min, max };
        }
        function constrained(handle, value) { const { min, max } = limits(handle); return Math.round(Math.max(min, Math.min(value, max))); }
        function sync() {
            for (const handle of handles) {
                const element = handle.element, { min, max } = limits(handle), value = Math.round(handle.getEffectiveWidth());
                element.setAttribute('role', 'separator'); element.setAttribute('aria-orientation', 'vertical'); element.setAttribute('tabindex', '0');
                element.setAttribute('aria-label', handle.label || '调整栏宽');
                element.setAttribute('aria-valuemin', String(min)); element.setAttribute('aria-valuemax', String(max)); element.setAttribute('aria-valuenow', String(value));
                element.setAttribute('aria-valuetext', `${value} px`); element.setAttribute('aria-disabled', String(!!blocked()));
                element.setAttribute('title', `${handle.label || '调整栏宽'}：拖动调整；←/→ 每次 ${KEY_STEP}px，Shift 每次 ${LARGE_KEY_STEP}px；双击或 Home 恢复默认，Esc 取消`);
            }
        }
        function preview(handle, width) {
            if (Object.is(handle.getWidth(), width)) return false;
            handle.setWidth(width); onPreview(handle); sync(); return true;
        }
        function release(current) {
            drag = null; current.handle.element.classList?.toggle('is-resizing', false);
            const element = current.handle.element;
            if (element.releasePointerCapture && (!element.hasPointerCapture || element.hasPointerCapture(current.pointerId))) element.releasePointerCapture(current.pointerId);
        }
        function cancel() {
            if (!drag) return false;
            const current = drag; release(current); current.handle.setWidth(current.requested);
            try { onCancel(current.handle); } finally { onEnd(current.handle); sync(); }
            return true;
        }
        function move(event) {
            if (!drag || drag.pointerId !== event.pointerId) return;
            const delta = event.clientX - drag.x;
            preview(drag.handle, delta === 0 ? drag.requested : constrained(drag.handle, drag.effective + delta)); stop(event);
        }
        function reset(handle, event) {
            if (disposed || blocked()) return;
            if (drag) cancel(); stop(event);
            const before = handle.getWidth(); if (before === undefined) return;
            onStart(handle);
            try {
                if (handle.reset) handle.reset(); else handle.setWidth(undefined);
                if (!Object.is(before, handle.getWidth())) { onPreview(handle); onCommit(handle); }
            } finally { onEnd(handle); sync(); }
        }
        for (const handle of handles) {
            bind(handle.element, 'pointerdown', event => {
                if (disposed || blocked() || event.button !== 0 || event.isPrimary === false || drag) return;
                stop(event); onStart(handle); handle.element.focus({ preventScroll: true });
                drag = { handle, pointerId: event.pointerId, x: event.clientX, requested: handle.getWidth(), effective: handle.getEffectiveWidth() };
                handle.element.classList?.toggle('is-resizing', true); handle.element.setPointerCapture(event.pointerId);
            });
            bind(handle.element, 'pointermove', move);
            bind(handle.element, 'pointerup', event => {
                if (!drag || drag.handle !== handle || drag.pointerId !== event.pointerId) return;
                move(event); const current = drag, changed = !Object.is(current.requested, handle.getWidth()); release(current);
                try { if (changed) onCommit(handle); } finally { onEnd(handle); sync(); stop(event); }
            });
            for (const name of ['pointercancel', 'lostpointercapture']) bind(handle.element, name, event => {
                if (drag?.handle === handle && drag.pointerId === event.pointerId) cancel();
            });
            bind(handle.element, 'dblclick', event => reset(handle, event));
            bind(handle.element, 'keydown', event => {
                if (disposed || blocked() || editable(event.target)) return;
                if (event.key === 'Escape' && drag) { cancel(); stop(event); return; }
                if (drag) return;
                if (event.key === 'Home') { reset(handle, event); return; }
                if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
                stop(event);
                const step = event.shiftKey ? LARGE_KEY_STEP : KEY_STEP;
                const width = constrained(handle, handle.getEffectiveWidth() + (event.key === 'ArrowLeft' ? -step : step));
                // 已到边界的按键不把暂时 clamp 的保存宽度改为当前视口值。
                if (width === Math.round(handle.getEffectiveWidth())) return;
                onStart(handle);
                try { if (preview(handle, width)) onCommit(handle); } finally { onEnd(handle); sync(); }
            });
        }
        sync();
        return { get active() { return !!drag; }, cancel, sync,
            dispose() { if (disposed) return; cancel(); disposed = true; for (const unbind of bindings) unbind(); } };
    };
})();
