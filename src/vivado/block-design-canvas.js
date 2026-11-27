/* global ResizeObserver */
'use strict';
(() => {
    const ns = 'http://www.w3.org/2000/svg';
    const minZoom = 0.035;
    const maxZoom = 4;
    const short = (text, max = 33) => text.length > max ? text.slice(0, max - 1) + '…' : text;
    const sameItem = (a, b) => a && b && a.kind === b.kind && a.index === b.index;
    function shape(tag, attributes = {}, text) {
        const node = document.createElementNS(ns, tag);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const title = name => shape('title', {}, name);
    function action(kind, index, name, classes, position) {
        const attributes = { class: classes, 'data-kind': kind, 'data-index': index, role: 'button', tabindex: 0,
            'aria-label': name, 'aria-pressed': 'false' };
        if (position) attributes.transform = `translate(${position.x} ${position.y})`;
        const item = shape('g', attributes);
        item.append(title(name));
        return item;
    }

    function pinShape(pin) {
        const east = pin.side === 'EAST';
        const text = short(pin.label);
        const hitWidth = Math.max(20, text.length * 7 + 16);
        const pinNode = action('endpoint', pin.index, pin.name, 'bd-pin ' + pin.kind, pin);
        pinNode.append(shape('rect', { class: 'bd-hit', x: east ? 8 - hitWidth : -8, y: -9, width: hitWidth, height: 18, rx: 3 }));
        pinNode.append(shape('line', { class: 'bd-pin-stem', x1: east ? -7 : 0, y1: 0, x2: east ? 0 : 7, y2: 0 }));
        if (pin.kind === 'interface' || pin.kind === 'bus') {
            pinNode.append(shape('rect', { class: 'bd-pin-tip', x: -3.25, y: -3.25, width: 6.5, height: 6.5, rx: pin.kind === 'bus' ? 1 : 0 }));
        } else {
            pinNode.append(shape('circle', { class: 'bd-pin-tip', cx: 0, cy: 0, r: 2.7 }));
        }
        pinNode.append(shape('text', { class: 'bd-pin-label', x: east ? -12 : 12, y: 4, 'text-anchor': east ? 'end' : 'start' }, text));
        return pinNode;
    }

    function terminal(node) {
        const pin = node.ports[0];
        const { points, labelX, centerY, anchor } = node.terminal;
        const group = action('endpoint', pin.index, pin.name, 'bd-terminal ' + pin.kind, node);
        group.append(shape('polygon', { class: 'bd-terminal-outline', points }),
            shape('text', { class: 'bd-terminal-caption', x: labelX, y: centerY + 4, 'text-anchor': anchor }, node.caption));
        return group;
    }

    function block(node) {
        const group = shape('g', { class: 'bd-block', transform: `translate(${node.x} ${node.y})` });
        const body = action('cell', node.index, node.name + ' · ' + node.subtitle, 'bd-body' + (node.hierarchy ? ' hierarchy' : ''));
        body.append(shape('rect', { class: 'bd-frame', x: 0, y: 0, width: node.width, height: node.height, rx: 6 }),
            shape('line', { class: 'bd-divider', x1: 0, x2: node.width, y1: 44, y2: 44 }),
            shape('text', { class: 'bd-instance-name', x: 12, y: 19 }, short(node.label, 42)),
            shape('text', { class: 'bd-instance-type', x: 12, y: 35 }, short(node.subtitle, 42)));
        if (node.hierarchy) body.append(shape('text', { class: 'bd-open-level', x: node.width - 13, y: 19, 'text-anchor': 'end' }, '↳'));
        group.append(body, ...node.ports.map(pinShape));
        return group;
    }

    function makeSvg(layout, model, level) {
        const { width, height } = layout;
        const svg = shape('svg', { class: 'bd-schematic', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group',
            'aria-label': (level || model.name) + ' 原理图' });
        const byNet = new Map();
        for (const edge of layout.edges) {
            if (!byNet.has(edge.net)) {
                const group = action('net', edge.net, model.nets[edge.net].id, 'bd-net ' + edge.kind);
                byNet.set(edge.net, group);
                svg.append(group);
            }
            const group = byNet.get(edge.net);
            for (const section of edge.sections) {
                const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
                const d = points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join('');
                group.append(shape('path', { class: 'bd-net-hit', d }), shape('path', { class: 'bd-net-line', d }));
            }
        }
        for (const node of layout.nodes) {
            if (node.kind === 'cell') svg.append(block(node));
            else if (node.kind === 'boundary') svg.append(terminal(node));
            else byNet.get(node.net)?.append(shape('rect', { class: 'bd-junction', x: node.x, y: node.y, width: node.width, height: node.height, rx: 1 }));
        }
        return svg;
    }

    function create(viewport, drawing, { onSelect, onOpen, onZoom }) {
        let svg, layout, zoom = 1, autoFit = true, drag, skipClick = false;
        function applyZoom(next, anchor) {
            if (!layout) return;
            const old = svg.getBoundingClientRect(), view = viewport.getBoundingClientRect();
            const { x, y } = anchor || { x: view.left + viewport.clientWidth / 2, y: view.top + viewport.clientHeight / 2 };
            const from = { x: (x - old.left) / zoom, y: (y - old.top) / zoom };
            zoom = Math.max(minZoom, Math.min(maxZoom, next));
            svg.setAttribute('width', String(layout.width * zoom));
            svg.setAttribute('height', String(layout.height * zoom));
            const after = svg.getBoundingClientRect();
            viewport.scrollLeft += after.left + from.x * zoom - x;
            viewport.scrollTop += after.top + from.y * zoom - y;
            onZoom(zoom);
        }
        function fit() {
            if (!layout) return;
            autoFit = true;
            const scale = Math.min((viewport.clientWidth - 40) / layout.width, (viewport.clientHeight - 40) / layout.height, 1.35);
            applyZoom(scale);
            viewport.scrollLeft = 0;
            viewport.scrollTop = 0;
        }
        function setZoom(scale, anchor) {
            autoFit = false;
            applyZoom(scale, anchor);
        }
        const itemOf = target => {
            const control = target.closest?.('[data-kind]');
            return control && { kind: control.dataset.kind, index: Number(control.dataset.index) };
        };
        viewport.addEventListener('click', event => {
            if (!skipClick) onSelect(itemOf(event.target));
            skipClick = false;
        });
        viewport.addEventListener('dblclick', event => {
            const item = itemOf(event.target);
            if (item?.kind === 'cell') onOpen(item);
        });
        viewport.addEventListener('keydown', event => {
            const item = itemOf(event.target);
            if (item && ['Enter', ' '].includes(event.key)) {
                event.preventDefault();
                onSelect(item);
            }
        });
        viewport.addEventListener('wheel', event => {
            if (!event.ctrlKey && !event.metaKey || !layout) return;
            event.preventDefault();
            setZoom(zoom * Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.0025), { x: event.clientX, y: event.clientY });
        }, { passive: false });
        viewport.addEventListener('pointerdown', event => {
            skipClick = false;
            if (event.button !== 1 && (event.button !== 0 || itemOf(event.target))) return;
            drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
            viewport.setPointerCapture(event.pointerId);
            viewport.classList.add('panning');
            if (event.button === 1) event.preventDefault();
        });
        viewport.addEventListener('pointermove', event => {
            if (!drag || drag.id !== event.pointerId) return;
            const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 4) skipClick = true;
            viewport.scrollLeft = drag.left - dx;
            viewport.scrollTop = drag.top - dy;
        });
        const endDrag = event => {
            if (!drag || drag.id !== event.pointerId) return;
            drag = undefined;
            viewport.classList.remove('panning');
        };
        viewport.addEventListener('pointerup', endDrag);
        viewport.addEventListener('lostpointercapture', endDrag);
        new ResizeObserver(() => { if (autoFit) fit(); }).observe(viewport);
        return {
            clear() {
                layout = undefined;
                svg = undefined;
                drawing.replaceChildren();
            },
            draw(next, model, level, previous) {
                layout = next;
                zoom = 1;
                svg = makeSvg(next, model, level);
                drawing.replaceChildren(svg);
                if (!previous || previous.autoFit) fit();
                else {
                    setZoom(previous.zoom);
                    viewport.scrollLeft = previous.left;
                    viewport.scrollTop = previous.top;
                }
            },
            state: () => layout && { zoom, autoFit, left: viewport.scrollLeft, top: viewport.scrollTop },
            zoomBy: factor => setZoom(zoom * factor),
            reset: () => setZoom(1),
            fit,
            highlight(active, relevant, wiring) {
                viewport.classList.toggle('wiring', Boolean(wiring));
                if (!svg) return;
                svg.classList.toggle('has-selection', Boolean(active));
                for (const entry of svg.querySelectorAll('[data-kind]')) {
                    const item = { kind: entry.dataset.kind, index: Number(entry.dataset.index) };
                    const picked = sameItem(active, item);
                    entry.setAttribute('aria-pressed', String(Boolean(picked)));
                    entry.classList.toggle('picked', Boolean(picked));
                    entry.classList.toggle('related', relevant[item.kind].has(item.index));
                    entry.classList.toggle('wire-start', sameItem(wiring, item) || false);
                }
            },
            focus(item) {
                // 来自检查器的定位使用画布坐标，保持编辑器与检查器的滚动各自独立。
                const target = svg?.querySelector(`[data-kind="${item.kind}"][data-index="${item.index}"]`);
                if (!target) return;
                const a = target.getBoundingClientRect(), b = viewport.getBoundingClientRect();
                if (a.left < b.left || a.right > b.right) viewport.scrollLeft += (a.left + a.right - b.left - b.right) / 2;
                if (a.top < b.top || a.bottom > b.bottom) viewport.scrollTop += (a.top + a.bottom - b.top - b.bottom) / 2;
            }
        };
    }
    globalThis.SVToolsBlockDesignCanvas = { create };
})();
