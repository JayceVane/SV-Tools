/* 时间导航只映射视窗与轨道坐标；波形查询及持久化由页面控制器负责。 */
(function (root, factory) {
    const model = typeof module === 'object' && module.exports ? require('./model') : root.WaveModel;
    const api = factory(model);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WaveTimeNavigation = api;
})(typeof globalThis === 'object' ? globalThis : this, function (model) {
    'use strict';
    const MIN_THUMB_PX = 24, KEY_FRACTION = .1, PAGE_FRACTION = .9, BUTTON_FRACTION = .25;

    /** @param {object} view 时间视窗。 @param {number} end 完整时间终点。 @param {number} width 轨道像素宽度。 @returns {object} 有最小抓取宽度的滑块几何。 */
    function scrollGeometry(view, end, width) {
        const total = Number.isFinite(end) ? Math.max(0, end) : 0, rail = Math.max(0, Number.isFinite(width) ? width : 0);
        const bounded = model.clampView(view?.start, view?.span, total), maximum = Math.max(0, total - bounded.span);
        const thumb = maximum > 0 ? Math.min(rail, Math.max(MIN_THUMB_PX, rail * bounded.span / total)) : rail;
        const travel = rail - thumb, left = maximum ? bounded.start / maximum * travel : 0;
        return { view: bounded, maximum, width: rail, thumb, travel, left, disabled: maximum === 0 || travel === 0 };
    }

    /** @param {number} left 滑块左端像素。 @param {object} geometry 轨道几何。 @returns {object} 保持原缩放比例，准确到达两个端点。 */
    function viewFromThumb(left, geometry) {
        return { start: geometry.travel > 0 ? Math.max(0, Math.min(1, left / geometry.travel)) * geometry.maximum : 0, span: geometry.view.span };
    }

    /**
     * @param {object} options DOM边界与视窗读写；预览不保存，释放时提交，取消恢复原视窗。
     * @returns {{active:boolean,sync:Function,cancel:Function,dispose:Function}} 独立时间滚动条控制器。
     */
    function createTimeScrollbar({ rail, thumb, previous, next, extent, getView, getEnd, formatTime,
        onPreview, onCommit, onStart = () => {}, onEnd = () => {}, blocked = () => false }) {
        let drag = null, disposed = false;
        const bindings = [], stop = event => { event.preventDefault(); event.stopPropagation?.(); };
        function bind(node, type, handler, options) { node.addEventListener(type, handler, options); bindings.push(() => node.removeEventListener(type, handler, options)); }
        const railBounds = () => ({ left: rail.getBoundingClientRect().left + (rail.clientLeft || 0),
            width: Number.isFinite(rail.clientWidth) ? rail.clientWidth : rail.getBoundingClientRect().width });
        const geometry = () => scrollGeometry(getView(), getEnd(), railBounds().width);
        const sameView = (a, b) => a.start === b.start && a.span === b.span;
        function sync() {
            const g = geometry(), unavailable = g.disabled || blocked();
            thumb.style.width = g.thumb + 'px'; thumb.style.transform = `translateX(${g.left}px)`;
            rail.setAttribute('aria-valuemin', '0'); rail.setAttribute('aria-valuemax', String(g.maximum)); rail.setAttribute('aria-valuenow', String(g.view.start));
            rail.setAttribute('aria-valuetext', `${formatTime(g.view.start)} → ${formatTime(g.view.start + g.view.span)}，全程 ${formatTime(getEnd() || 0)}`);
            rail.setAttribute('aria-disabled', String(unavailable));
            previous.disabled = unavailable || g.view.start <= 0; next.disabled = unavailable || g.view.start >= g.maximum;
            extent.textContent = '全程 0 → ' + formatTime(getEnd() || 0); extent.title = extent.textContent;
        }
        function preview(view) {
            const bounded = model.clampView(view.start, view.span, getEnd());
            if (sameView(bounded, getView())) return false;
            onPreview(bounded); sync(); return true;
        }
        function release() {
            const current = drag; drag = null; rail.classList.toggle('is-dragging', false);
            if (rail.hasPointerCapture(current.pointerId)) rail.releasePointerCapture(current.pointerId);
            onEnd();
            return current;
        }
        function cancel() { if (!drag) return false; const current = release(); preview(current.view); sync(); return true; }
        function move(event) {
            if (!drag || drag.pointerId !== event.pointerId) return;
            const g = geometry();
            preview(viewFromThumb(event.clientX - railBounds().left - drag.anchor, g)); stop(event);
        }
        function change(view, event) {
            if (disposed || drag || blocked() || geometry().disabled) return;
            stop(event); onStart(); if (preview(view)) onCommit();
        }
        bind(rail, 'pointerdown', event => {
            if (disposed || drag || blocked() || geometry().disabled || event.button !== 0 || event.isPrimary === false) return;
            stop(event); onStart(); rail.focus({ preventScroll: true });
            let g = geometry(); const view = { ...getView() }, x = event.clientX - railBounds().left;
            if (x < g.left || x > g.left + g.thumb) {
                preview({ start: x / g.width * getEnd() - g.view.span / 2, span: g.view.span }); g = geometry();
            }
            drag = { pointerId: event.pointerId, view, anchor: x - g.left };
            rail.setPointerCapture(event.pointerId); rail.classList.toggle('is-dragging', true);
        });
        bind(rail, 'pointermove', move);
        bind(rail, 'pointerup', event => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            move(event); const current = release(); if (!sameView(current.view, getView())) onCommit(); sync(); stop(event);
        });
        for (const type of ['pointercancel','lostpointercapture']) bind(rail, type, event => { if (drag?.pointerId === event.pointerId) cancel(); });
        bind(rail, 'keydown', event => {
            if (event.key === 'Escape' && drag) { stop(event); cancel(); return; }
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            const g = geometry(), steps = { ArrowLeft: -KEY_FRACTION, ArrowRight: KEY_FRACTION, PageUp: -PAGE_FRACTION, PageDown: PAGE_FRACTION };
            if (event.key === 'Home' || event.key === 'End') change({ start: event.key === 'Home' ? 0 : g.maximum, span: g.view.span }, event);
            else if (Object.hasOwn(steps, event.key)) change({ start: g.view.start + g.view.span * steps[event.key], span: g.view.span }, event);
        });
        bind(rail, 'wheel', event => {
            if (drag) { stop(event); return; }
            if (event.ctrlKey || event.metaKey || geometry().disabled) return;
            const g = geometry(), delta = event.deltaX || event.deltaY;
            if (!Number.isFinite(delta) || !delta) return;
            const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? g.width : 1);
            change({ start: g.view.start + pixels / Math.max(1, g.width) * g.view.span, span: g.view.span }, event);
        }, { passive: false });
        for (const [button, direction] of [[previous,-1],[next,1]]) bind(button, 'click', event => {
            const view = getView(); change({ start: view.start + view.span * BUTTON_FRACTION * direction, span: view.span }, event);
        });
        sync();
        return { get active() { return !!drag; }, sync, cancel,
            dispose() { if (disposed) return; cancel(); disposed = true; for (const unbind of bindings) unbind(); } };
    }
    return { scrollGeometry, viewFromThumb, createTimeScrollbar };
});
