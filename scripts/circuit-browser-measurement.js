(function () {
    'use strict';
    // 仅由本地开发预览注入；合成事件经过正式客户端监听，不修改领域图或布局。
    const FRAMES = 90, WARMUP = 5;
    const targets = { handlerP95Ms: 8, frameP95Ms: 40 };
    const next = () => new Promise(resolve => requestAnimationFrame(resolve));
    function summary(values) {
        const sorted = [...values].sort((a, b) => a - b);
        return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1), samples: values.length };
    }
    async function sample(action) {
        const frames = [], handlers = []; let previous = await next();
        for (let i = 0; i < FRAMES; i++) {
            const start = performance.now(); action(i); handlers.push(performance.now() - start);
            const now = await next(); frames.push(now - previous); previous = now;
        }
        return { handler: summary(handlers.slice(WARMUP)), frame: summary(frames.slice(WARMUP)) };
    }
    async function measure() {
        const svg = document.getElementById('circuit'), rect = svg.getBoundingClientRect();
        const capture = svg.setPointerCapture, captured = svg.hasPointerCapture;
        svg.setPointerCapture = () => {}; svg.hasPointerCapture = () => false;
        const pointer = (type, fields = {}) => svg.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, ...fields }));
        try {
            const center = { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
            pointer('pointerdown', center);
            const pan = await sample(i => { for (let j = 0; j < 8; j++) pointer('pointermove', { clientX: center.clientX + Math.sin(i / 15) * 30 + j * .1, clientY: center.clientY + Math.cos(i / 15) * 20 }); });
            pointer('pointercancel'); await next();
            const zoom = await sample(i => { for (let j = 0; j < 4; j++) svg.dispatchEvent(new WheelEvent('wheel', { ...center, deltaY: i < FRAMES / 2 ? 1.5 : -1.5, cancelable: true })); });
            const visible = [...svg.querySelectorAll('.cell')].filter(node => {
                const box = node.getBoundingClientRect(); return box.right > rect.left && box.left < rect.right && box.bottom > rect.top && box.top < rect.bottom;
            }).slice(0, 4);
            if (visible.length < 2) throw new Error('至少需要两个可见节点');
            const select = await sample(i => visible[i % visible.length].dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
            const phases = { pan, zoom, select };
            return { fixture: document.getElementById('traceSummary').textContent || '模块全图',
                graph: document.getElementById('graphStats').textContent, browser: navigator.userAgent,
                theme: document.body.className, syntheticInput: true, frames: FRAMES, warmupFrames: WARMUP, targets, phases,
                domElements: svg.querySelectorAll('*').length,
                passed: Object.fromEntries(Object.entries(phases).map(([name, value]) => [name, value.handler.p95Ms <= targets.handlerP95Ms && value.frame.p95Ms <= targets.frameP95Ms])) };
        } finally { pointer('pointercancel'); svg.setPointerCapture = capture; svg.hasPointerCapture = captured; }
    }
    window.addEventListener('DOMContentLoaded', () => {
        const button = document.createElement('button'), output = document.createElement('pre');
        button.id = 'runBrowserMeasure'; button.textContent = '交互基准'; button.title = '开发验收：正式页面监听器、每阶段90帧，非操作系统原生输入';
        output.id = 'browserMeasurement'; output.hidden = true;
        document.querySelector('footer').appendChild(button); document.querySelector('aside').appendChild(output);
        button.addEventListener('click', async () => {
            if (document.body.dataset.mode !== 'graph' || button.disabled) return;
            button.disabled = true; button.textContent = '测量中…';
            try {
                const report = await measure(); output.textContent = JSON.stringify(report, null, 2); output.hidden = false;
                const response = await fetch('/measurements?theme=' + (document.body.classList.contains('vscode-light') ? 'light' : 'dark'), {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
                if (!response.ok) throw new Error('测量记录保存失败');
                button.textContent = Object.values(report.passed).every(Boolean) ? '基准通过' : '基准需复查';
            } catch (error) { output.textContent = error.message; output.hidden = false; button.textContent = '基准失败'; }
            finally { button.disabled = false; }
        });
    }, { once: true });
})();
