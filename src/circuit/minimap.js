(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CircuitMinimap = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const WIDTH = 192, HEIGHT = 120, PADDING = 8;

    /** @param {object} bounds 图形边界。 @returns {object} 小地图坐标变换。 */
    function mapTransform(bounds) {
        const width = Math.max(1, bounds.right - bounds.left), height = Math.max(1, bounds.bottom - bounds.top);
        const scale = Math.min((WIDTH - PADDING * 2) / width, (HEIGHT - PADDING * 2) / height);
        return { scale, x: (WIDTH - width * scale) / 2 - bounds.left * scale, y: (HEIGHT - height * scale) / 2 - bounds.top * scale };
    }

    /**
     * 缓存简化图形；相机帧只合成位图和视口框，不遍历网表或复制SVG。
     * @param {HTMLCanvasElement} canvas 导航画布。 @param {Window} window 页面窗口。
     * @param {function} navigate 接收图坐标中心。 @returns {object} setGraph/update/destroy。
     */
    function createMinimap(canvas, window, navigate) {
        const context = canvas?.getContext?.('2d'), disposers = [];
        if (!context) return { setGraph() {}, update() {}, destroy() {} };
        const bitmap = canvas.ownerDocument.createElement('canvas'), cache = bitmap.getContext('2d');
        let transform = null, graph = null, bounds = null, view = null, pointer = null, activeColor = '#0969da';
        const listen = (target, type, handler) => { target.addEventListener(type, handler); disposers.push(() => target.removeEventListener(type, handler)); };
        const color = (style, name, fallback) => style.getPropertyValue(name).trim() || fallback;
        function redraw() {
            if (!graph || !bounds) return;
            const ratio = Math.min(2, window.devicePixelRatio || 1), style = window.getComputedStyle(canvas);
            activeColor = color(style, '--diagramActive', '#0969da');
            canvas.width = bitmap.width = WIDTH * ratio; canvas.height = bitmap.height = HEIGHT * ratio;
            transform = mapTransform(bounds);
            cache.setTransform(ratio, 0, 0, ratio, 0, 0); cache.clearRect(0, 0, WIDTH, HEIGHT);
            cache.fillStyle = color(style, '--bg', '#ffffff'); cache.fillRect(0, 0, WIDTH, HEIGHT);
            cache.save(); cache.translate(transform.x, transform.y); cache.scale(transform.scale, transform.scale);
            cache.strokeStyle = color(style, '--wire', '#52616e'); cache.lineWidth = .65 / transform.scale; cache.beginPath();
            for (const edge of graph.edges) for (const section of edge.sections || []) {
                cache.moveTo(section.startPoint.x, section.startPoint.y);
                for (const point of section.bendPoints || []) cache.lineTo(point.x, point.y);
                cache.lineTo(section.endPoint.x, section.endPoint.y);
            }
            cache.stroke(); cache.fillStyle = color(style, '--symbol', '#26333f');
            for (const node of graph.nodes) cache.fillRect(node.x, node.y, node.width, node.height);
            cache.restore(); if (view) update(...view);
        }
        function update(camera, width, height) {
            view = [camera, width, height]; if (!transform || canvas.hidden) return;
            const ratio = canvas.width / WIDTH, t = transform;
            context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, WIDTH, HEIGHT);
            context.drawImage(bitmap, 0, 0, WIDTH, HEIGHT);
            const left = Math.max(0, t.x - camera.x / camera.scale * t.scale), top = Math.max(0, t.y - camera.y / camera.scale * t.scale);
            const right = Math.min(WIDTH, t.x + (width - camera.x) / camera.scale * t.scale), bottom = Math.min(HEIGHT, t.y + (height - camera.y) / camera.scale * t.scale);
            if (right > left && bottom > top) {
                context.strokeStyle = activeColor; context.lineWidth = 1.5;
                context.strokeRect(left + .75, top + .75, Math.max(0, right - left - 1.5), Math.max(0, bottom - top - 1.5));
            }
        }
        function move(event) {
            if (!transform || !view) return;
            const rect = canvas.getBoundingClientRect();
            navigate({ x: ((event.clientX - rect.left) * WIDTH / rect.width - transform.x) / transform.scale,
                y: ((event.clientY - rect.top) * HEIGHT / rect.height - transform.y) / transform.scale });
        }
        listen(canvas, 'pointerdown', event => {
            if (event.button !== 0 || !transform || pointer !== null) return;
            event.preventDefault(); pointer = event.pointerId; canvas.setPointerCapture?.(pointer); move(event);
        });
        listen(canvas, 'pointermove', event => { if (event.pointerId === pointer) move(event); });
        const release = () => { const id = pointer; pointer = null; if (id !== null && canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id); };
        listen(canvas, 'pointerup', release); listen(canvas, 'pointercancel', release); listen(canvas, 'lostpointercapture', release); listen(window, 'blur', release);
        if (window.MutationObserver) {
            const observer = new window.MutationObserver(redraw); observer.observe(canvas.ownerDocument.body, { attributes: true, attributeFilter: ['class', 'style'] });
            disposers.push(() => observer.disconnect());
        }
        const media = window.matchMedia?.('(prefers-color-scheme: light)');
        if (media?.addEventListener) listen(media, 'change', redraw);
        return { setGraph(next, nextBounds) { graph = next; bounds = nextBounds; redraw(); }, update,
            destroy() { release(); disposers.forEach(dispose => dispose()); graph = null; view = null; } };
    }
    return { mapTransform, createMinimap };
});
