/* 菜单只负责焦点和层级；波形操作由控制器传入，关闭后恢复波形焦点。 */
(function () {
    'use strict';
    let nextMenuId = 0;

    /**
     * @param {{items:object[],x:number,y:number,title:string,returnFocus:HTMLElement,onClose:Function}} options
     * @returns {{contains:(target:Node)=>boolean,close:(restore?:boolean)=>void}}
     */
    window.createWaveMenu = function ({ items, x, y, title, returnFocus, onClose }) {
        const levels = [];
        let closed = false;

        function disposeFrom(depth) {
            for (const level of levels.splice(depth)) {
                if (level.parent) level.parent.setAttribute('aria-expanded', 'false');
                level.element.remove();
            }
        }
        function close(restore = true) {
            if (closed) return;
            closed = true; disposeFrom(0); onClose();
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
                const right = rect.right + 4;
                position(child.element, right + child.element.offsetWidth > window.innerWidth - 6 ? rect.left - child.element.offsetWidth - 4 : right, rect.top - 5);
                button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-controls', child.element.id);
            }
            if (focusFirst) levels[depth + 1].buttons[0]?.focus();
        }
        function build(entries, depth, parent = null) {
            const element = document.createElement('div');
            element.className = 'menu' + (depth ? ' submenu' : ''); element.id = 'waveMenu' + (++nextMenuId);
            element.setAttribute('role', 'menu'); element.setAttribute('aria-label', depth ? parent.textContent : title);
            const level = { element, parent, buttons: [] }; levels[depth] = level;
            if (!depth) {
                const header = document.createElement('div'); header.className = 'menuTitle'; header.textContent = title; element.appendChild(header);
            }
            for (const item of entries) {
                if (item.separator) {
                    const separator = document.createElement('div'); separator.className = 'menuSeparator'; separator.setAttribute('role', 'separator');
                    element.appendChild(separator); continue;
                }
                const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
                button.dataset.menuAction = item.id || ''; button.disabled = !!item.disabled;
                button.setAttribute('role', item.checked !== undefined ? 'menuitemradio' : 'menuitem');
                if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
                if (item.disabled) button.setAttribute('aria-disabled', 'true');
                if (item.submenu) { button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); }
                const mark = document.createElement('span'); mark.className = 'menuMark'; mark.textContent = item.checked ? '✓' : '';
                const label = document.createElement('span'); label.className = 'menuLabel'; label.textContent = item.label;
                const hint = document.createElement('span'); hint.className = 'menuHint'; hint.textContent = item.submenu ? '›' : item.detail || '';
                button.append(mark, label, hint); element.appendChild(button);
                if (!item.disabled) level.buttons.push(button);
                button.addEventListener('pointerenter', () => {
                    if (item.disabled) return;
                    button.focus({ preventScroll: true });
                    if (item.submenu) openChildren(item, button, depth, false); else disposeFrom(depth + 1);
                });
                button.onclick = () => {
                    if (item.submenu) openChildren(item, button, depth, true);
                    else { close(); item.action(); }
                };
                button.onkeydown = event => {
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
            document.body.appendChild(element);
            return level;
        }
        const first = build(items, 0); position(first.element, x, y); first.buttons[0]?.focus();
        return { contains: target => levels.some(level => level.element.contains(target)), close };
    };
})();
