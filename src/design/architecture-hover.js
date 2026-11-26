/* global module */
(function (root) {
    'use strict';

    function attach(document, resolve) {
        const popup = document.createElement('div');
        popup.className = 'architecture-preview';
        popup.id = 'architecture-interface-preview';
        popup.hidden = true;
        popup.setAttribute('role', 'tooltip');
        document.body.append(popup);
        let active, timer;

        function hide() {
            clearTimeout(timer);
            if (active) active.removeAttribute('aria-describedby');
            active = undefined;
            popup.hidden = true;
        }

        function show(target) {
            clearTimeout(timer);
            const content = resolve(target);
            if (!content || !target.isConnected) return hide();
            if (active !== target) hide();
            active = target;
            popup.innerHTML = content;
            popup.hidden = false;
            target.setAttribute('aria-describedby', popup.id);
            const bounds = target.getBoundingClientRect();
            const viewport = document.documentElement;
            const roomBelow = viewport.clientHeight - bounds.bottom - 12;
            popup.style.left = Math.max(12, Math.min(bounds.left, viewport.clientWidth - popup.offsetWidth - 12)) + 'px';
            const top = roomBelow >= popup.offsetHeight ? bounds.bottom + 6 : bounds.top - popup.offsetHeight - 6;
            popup.style.top = Math.max(12, Math.min(top, viewport.clientHeight - popup.offsetHeight - 12)) + 'px';
        }

        document.addEventListener('pointerover', event => {
            const target = event.target.closest?.('[data-preview-link]');
            if (!target || target === active || target.contains(event.relatedTarget)) return;
            clearTimeout(timer);
            timer = setTimeout(() => show(target), 180);
        });
        document.addEventListener('pointerout', event => {
            const target = event.target.closest?.('[data-preview-link]');
            if (!target || target.contains(event.relatedTarget) || popup.contains(event.relatedTarget)) return;
            clearTimeout(timer);
            timer = setTimeout(hide, 150);
        });
        popup.addEventListener('pointerenter', () => clearTimeout(timer));
        popup.addEventListener('pointerleave', hide);
        document.addEventListener('focusin', event => {
            const target = event.target.closest?.('[data-preview-link]');
            if (target) show(target);
        });
        document.addEventListener('focusout', event => {
            if (!popup.contains(event.relatedTarget) && event.target.closest?.('[data-preview-link]')) hide();
        });
        document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
        document.addEventListener('scroll', event => { if (!popup.contains(event.target)) hide(); }, true);
        document.defaultView.addEventListener('resize', hide);
        return { hide };
    }

    if (typeof module === 'object' && module.exports) module.exports = { attach };
    else root.ArchitectureHover = { attach };
})(globalThis);
