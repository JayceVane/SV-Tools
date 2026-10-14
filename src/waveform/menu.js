/* 菜单只负责焦点和层级；波形操作由控制器传入，关闭后恢复波形焦点。 */
(function () {
    'use strict';
    let nextMenuId = 0;
    const HOVER_OPEN_MS = 90, HOVER_CLOSE_MS = 150;
    const ICON_PATHS = {
        format: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
        height: 'M5 9V4l-3 3m3-3 3 3M5 15v5l-3-3m3 3 3-3M12 5h9M12 12h9M12 19h9',
        group: 'M3 7h7l2-3h8v15H3V7Z',
        'group-add': 'M3 7h7l2-3h8v6M3 7v12h7M17 12v8M13 16h8',
        ungroup: 'M3 7h7l2-3h8v6M3 7v12h7M14 13l6 6m0-6-6 6',
        remove: 'M5 5h14v14H5V5Zm4 7h6'
    };

    /** @param {string} name 已登记的图标名。@returns {SVGElement|null} 只使用本地固定路径。 */
    function icon(name) {
        if (!Object.hasOwn(ICON_PATHS, name)) return null;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', ICON_PATHS[name]); svg.appendChild(path); return svg;
    }

    /**
     * @param {{items:object[],x:number,y:number,title:string,subtitle?:string,returnFocus:HTMLElement,onClose:Function}} options
     * @returns {{contains:(target:Node)=>boolean,close:(restore?:boolean)=>void}}
     */
    window.createWaveMenu = function ({ items, x, y, title, subtitle, returnFocus, onClose }) {
        const levels = [];
        let closed = false, hoverTimer = null;

        function cancelHover() { clearTimeout(hoverTimer); hoverTimer = null; }
        function deferHover(callback, delay) {
            cancelHover(); hoverTimer = setTimeout(() => { hoverTimer = null; if (!closed) callback(); }, delay);
        }

        function disposeFrom(depth) {
            for (const level of levels.splice(depth)) {
                if (level.parent) level.parent.setAttribute('aria-expanded', 'false');
                level.element.remove();
            }
        }
        function close(restore = true) {
            if (closed) return;
            closed = true; cancelHover(); disposeFrom(0); onClose();
            if (restore) returnFocus.focus({ preventScroll: true });
        }
        function position(element, left, top) {
            const point = window.WaveInteractions.menuPosition(left, top, element.offsetWidth, element.offsetHeight, window.innerWidth, window.innerHeight);
            element.style.left = point.x + 'px'; element.style.top = point.y + 'px';
        }
        function openChildren(item, button, depth, focusFirst) {
            if (levels[depth + 1]?.parent !== button) {
                disposeFrom(depth + 1);
                const rect = button.getBoundingClientRect();
                const child = build(item.submenu, depth + 1, button);
                const right = rect.right + 5, leftSide = right + child.element.offsetWidth > window.innerWidth - 6;
                child.element.dataset.side = leftSide ? 'left' : 'right';
                button.dataset.submenuSide = child.element.dataset.side;
                position(child.element, leftSide ? rect.left - child.element.offsetWidth - 5 : right, rect.top - 7);
                button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-controls', child.element.id);
            }
            if (focusFirst) levels[depth + 1].buttons[0]?.focus();
        }
        function build(entries, depth, parent = null) {
            const element = document.createElement('div');
            element.className = 'menu' + (depth ? ' submenu' : ''); element.id = 'waveMenu' + (++nextMenuId);
            element.setAttribute('role', 'menu'); element.setAttribute('aria-label', depth ? parent.getAttribute('aria-label') : title);
            element.addEventListener('pointerenter', cancelHover);
            const level = { element, parent, buttons: [] }; levels[depth] = level;
            if (!depth) {
                const header = document.createElement('div'); header.className = 'menuTitle';
                const eyebrow = document.createElement('span'); eyebrow.className = 'menuEyebrow'; eyebrow.textContent = 'SIGNAL ACTIONS';
                const selection = document.createElement('span'); selection.className = 'menuSelection'; selection.textContent = title;
                header.append(eyebrow, selection);
                if (subtitle) { const summary = document.createElement('div'); summary.className = 'menuSummary'; summary.textContent = subtitle; summary.title = subtitle; header.appendChild(summary); }
                element.appendChild(header);
            }
            for (const item of entries) {
                if (item.separator) {
                    const separator = document.createElement('div'); separator.className = item.label ? 'menuSeparator menuSection' : 'menuSeparator'; separator.setAttribute('role', 'separator');
                    if (item.label) { separator.textContent = item.label; separator.setAttribute('aria-label', item.label); }
                    element.appendChild(separator); continue;
                }
                const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
                button.dataset.menuAction = item.id || ''; button.disabled = !!item.disabled;
                button.className = item.danger ? 'menuDanger' : '';
                button.setAttribute('aria-label', item.label);
                if (item.detail) button.setAttribute('aria-description', item.detail);
                button.title = item.detail ? `${item.label} · ${item.detail}` : item.label;
                button.setAttribute('role', item.checked !== undefined ? 'menuitemradio' : 'menuitem');
                if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
                if (item.disabled) button.setAttribute('aria-disabled', 'true');
                if (item.submenu) { button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); }
                const mark = document.createElement('span'); mark.className = 'menuMark'; mark.textContent = item.checked ? '✓' : '';
                mark.setAttribute('aria-hidden', 'true');
                const glyph = item.checked === undefined && icon(item.icon); if (glyph) mark.appendChild(glyph);
                const label = document.createElement('span'); label.className = 'menuLabel'; label.textContent = item.label;
                const hint = document.createElement('span'); hint.className = 'menuHint'; hint.textContent = item.detail || '';
                button.append(mark, label, hint); element.appendChild(button);
                if (item.submenu) { const arrow = document.createElement('span'); arrow.className = 'menuArrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true'); button.appendChild(arrow); }
                if (!item.disabled) level.buttons.push(button);
                button.addEventListener('pointerenter', () => {
                    cancelHover();
                    if (item.disabled) return;
                    button.focus({ preventScroll: true });
                    deferHover(() => item.submenu ? openChildren(item, button, depth, false) : disposeFrom(depth + 1), item.submenu ? HOVER_OPEN_MS : HOVER_CLOSE_MS);
                });
                button.addEventListener('pointerleave', () => { if (item.submenu) cancelHover(); });
                button.onclick = () => {
                    cancelHover();
                    if (item.submenu) openChildren(item, button, depth, true);
                    else { close(); item.action(); }
                };
                button.onkeydown = event => {
                    cancelHover();
                    const index = level.buttons.indexOf(button);
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        disposeFrom(depth + 1);
                        level.buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + level.buttons.length) % level.buttons.length]?.focus();
                    } else if (event.key === 'Home' || event.key === 'End') {
                        disposeFrom(depth + 1); level.buttons[event.key === 'Home' ? 0 : level.buttons.length - 1]?.focus();
                    } else if (event.key === 'ArrowRight') {
                        if (item.submenu) openChildren(item, button, depth, true);
                    } else if (event.key === 'ArrowLeft') {
                        if (depth) { disposeFrom(depth); parent.focus(); }
                    } else if (event.key === 'Escape') {
                        if (depth) { disposeFrom(depth); parent.focus(); } else close();
                    } else if (event.key === 'Enter' || event.key === ' ') button.click();
                    else if (event.key === 'Tab') close();
                    else return;
                    event.preventDefault(); event.stopPropagation();
                };
            }
            if (!depth) {
                const footer = document.createElement('div'); footer.className = 'menuFooter'; footer.setAttribute('aria-hidden', 'true');
                footer.textContent = '↑↓ 选择 · Enter 确认 · Esc 关闭'; element.appendChild(footer);
            }
            document.body.appendChild(element);
            return level;
        }
        const first = build(items, 0); position(first.element, x, y); first.buttons[0]?.focus();
        return { contains: target => levels.some(level => level.element.contains(target)), close };
    };
})();
