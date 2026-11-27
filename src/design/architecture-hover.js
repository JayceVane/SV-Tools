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

        // 连线悬浮只高亮，不弹表格；端口/引脚/边界端子保留预览。
        const edgeOf = target => target.closest?.('.diagram-edge');
        // 同名时钟/复位联动：悬停一个网络名，高亮同一张图里所有同名网络与使用它的卡片。
        const clockOf = target => target.closest?.('[data-clock]');
        function linkClock(clock, on) {
            const svg = clock.closest?.('svg');
            if (!svg) return;
            const name = clock.getAttribute('data-clock');
            let hit = false;
            for (const node of svg.querySelectorAll('[data-clock]')) {
                if (node.getAttribute('data-clock') !== name) continue;
                hit = true;
                node.classList.toggle('is-linked', on);
                node.closest('.diagram-card.instance')?.classList.toggle('has-linked-clock', on);
            }
            // 联动时压暗无关卡片，让「谁用了这个时钟」一眼看出来。
            if (on && hit) svg.classList.add('is-clock-linked');
            else if (!on) svg.classList.remove('is-clock-linked');
        }
        document.addEventListener('pointerover', event => {
            const edge = edgeOf(event.target);
            if (edge && !edge.contains(event.relatedTarget)) edge.classList.add('is-hovered');
            const clock = clockOf(event.target);
            if (clock && !clock.contains(event.relatedTarget)) linkClock(clock, true);
            const target = event.target.closest?.('[data-preview-link]');
            if (!target || edgeOf(target) || clockOf(target) || target === active || target.contains(event.relatedTarget)) return;
            clearTimeout(timer);
            timer = setTimeout(() => show(target), 180);
        });
        document.addEventListener('pointerout', event => {
            const edge = edgeOf(event.target);
            if (edge && !edge.contains(event.relatedTarget)) edge.classList.remove('is-hovered');
            const clock = clockOf(event.target);
            if (clock && !clock.contains(event.relatedTarget)) linkClock(clock, false);
            const target = event.target.closest?.('[data-preview-link]');
            if (!target || edgeOf(target) || clockOf(target) || target.contains(event.relatedTarget) || popup.contains(event.relatedTarget)) return;
            clearTimeout(timer);
            timer = setTimeout(hide, 150);
        });
        popup.addEventListener('pointerenter', () => clearTimeout(timer));
        popup.addEventListener('pointerleave', hide);
        document.addEventListener('focusin', event => {
            const target = event.target.closest?.('[data-preview-link]');
            if (target && !edgeOf(target)) show(target);
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
