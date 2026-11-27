/* global module */
(function (root) {
    'use strict';

    function attach(document, { resolve, onOpen = () => {} }) {
        const window = document.defaultView;
        const popup = document.createElement('aside');
        popup.id = 'architecture-group-popup';
        popup.className = 'architecture-group-popup';
        popup.setAttribute('role', 'dialog');
        popup.setAttribute('aria-labelledby', 'architecture-group-title');
        popup.hidden = true;
        popup.innerHTML = `<header><div><h2 id="architecture-group-title" tabindex="-1"></h2><p></p></div>
            <div class="group-popup-tools"><button type="button" data-group-fit aria-pressed="false">原始尺寸</button><button type="button" data-group-close>关闭</button></div></header>
            <div class="group-popup-diagram" tabindex="0" aria-label="组内互联图"></div>`;
        document.body.append(popup);
        const title = popup.querySelector('h2');
        const summary = popup.querySelector('p');
        const graph = popup.querySelector('.group-popup-diagram');
        const fit = popup.querySelector('[data-group-fit]');
        let trigger;
        let point;

        function close(restoreFocus = false) {
            if (!trigger) return;
            const previous = trigger;
            trigger = undefined;
            previous.setAttribute('aria-expanded', 'false');
            previous.removeAttribute('aria-controls');
            popup.hidden = true;
            graph.replaceChildren();
            if (restoreFocus && previous.isConnected) previous.focus({ preventScroll: true });
        }

        function place() {
            if (!trigger) return;
            const margin = 8;
            const gap = 10;
            const { clientWidth, clientHeight } = document.documentElement;
            const offset = (anchor, length, viewport) => {
                const last = viewport - length - margin;
                if (anchor + gap <= last) return anchor + gap;
                if (anchor - gap - length >= margin) return anchor - gap - length;
                return Math.max(margin, last);
            };
            popup.style.left = offset(point.x, popup.offsetWidth, clientWidth) + 'px';
            popup.style.top = offset(point.y, popup.offsetHeight, clientHeight) + 'px';
        }

        function toggle(target, event) {
            if (trigger === target) return close(true);
            close();
            const group = resolve(target, target.dataset.members || target.dataset.expand);
            if (!group) return;
            const bounds = target.getBoundingClientRect();
            point = event.type === 'click' && event.detail > 0 ? { x: event.clientX, y: event.clientY }
                : { x: bounds.left + bounds.width / 2, y: bounds.bottom };
            onOpen();
            trigger = target;
            title.textContent = group.title;
            summary.textContent = `${group.instances} 个实例 · ${group.connections} 条组内连接`;
            graph.innerHTML = group.html;
            graph.classList.remove('original-size');
            fit.textContent = '原始尺寸';
            fit.setAttribute('aria-pressed', 'false');
            popup.style.width = Math.max(360, (graph.querySelector('svg')?.viewBox.baseVal.width || 0) + 20) + 'px';
            popup.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            trigger.setAttribute('aria-controls', popup.id);
            place();
            title.focus({ preventScroll: true });
        }

        const triggerOf = event => event.target.closest?.('[data-expand], [data-members]');
        document.addEventListener('click', event => {
            const target = triggerOf(event);
            if (target) {
                event.preventDefault();
                event.stopPropagation();
                toggle(target, event);
            } else if (trigger && !popup.contains(event.target)) close();
        }, true);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && trigger) {
                event.preventDefault();
                event.stopPropagation();
                close(true);
            } else if (['Enter', ' '].includes(event.key)) {
                const target = triggerOf(event);
                if (!target) return;
                event.preventDefault();
                event.stopPropagation();
                toggle(target, event);
            }
        }, true);
        popup.querySelector('[data-group-close]').onclick = () => close(true);
        fit.onclick = () => {
            const original = graph.classList.toggle('original-size');
            fit.textContent = original ? '适应窗口' : '原始尺寸';
            fit.setAttribute('aria-pressed', String(original));
            place();
        };
        document.addEventListener('scroll', event => { if (trigger && !popup.contains(event.target)) close(); }, true);
        window.addEventListener('resize', place);
        window.addEventListener('beforeprint', () => close());

        return { close, popup, get trigger() { return trigger; } };
    }

    if (typeof module === 'object' && module.exports) module.exports = { attach };
    else root.ArchitectureGroupPopup = { attach };
})(globalThis);
