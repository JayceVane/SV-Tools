'use strict';
// 使用本机 Chromium 的 CDP 验收真实 SVG 页面，不安装浏览器或修改用户配置。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const { createCircuitHtml } = require(path.resolve(option('--extension-root', '.'), 'src/circuit/view'));
const browserPath = option('--browser', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const out = path.resolve(option('--out', 'bin/circuit-interaction'));
const label = option('--label', 'current');
const count = Number(option('--nodes', '2000'));
const initialScale = Number(option('--scale', '.75'));
if (!Number.isFinite(initialScale) || initialScale < .0001 || initialScale > 8) throw new Error('--scale 必须为 .0001..8');
if (!Number.isInteger(count) || count < 4 || count > 2000) throw new Error('--nodes 必须为 4..2000');
fs.mkdirSync(out, { recursive: true });

function browserScenario(count) {
    const nodes = [], edges = [];
    const columns = 40, pitchX = 250, pitchY = 160;
    for (let i = 0; i < count; i++) {
        const x = i % columns * pitchX, y = Math.floor(i / columns) * pitchY;
        nodes.push({ id: 'n' + i, label: 'pipeline_' + i, kind: i % 3 ? 'logic' : 'register', detail: i % 3 ? '$add' : '$dff', x, y, width: 160, height: 100,
            ports: [{ id: 'p' + i + 'd', label: 'D', direction: 'input', x: 0, y: 35, bits: ['b' + i] }, { id: 'p' + i + 'q', label: 'Q', direction: 'output', x: 160, y: 35, bits: ['b' + (i + 1)] }] });
        for (let branch = 1; branch <= 3; branch++) {
            if (i < branch) continue;
            const previous = nodes[i - branch], sx = previous.x + 160, sy = previous.y + 35;
            edges.push({ id: 'e' + i + '-' + branch, netId: 'net' + (i - branch), label: 'data_' + (i - branch), source: 'p' + (i - branch) + 'q', target: 'p' + i + 'd', bits: ['b' + i], sections: [{ startPoint: { x: sx, y: sy }, bendPoints: [{ x: sx + 35 + branch * 7, y: sy }, { x: sx + 35 + branch * 7, y: y + 35 }], endPoint: { x, y: y + 35 } }] });
        }
    }
    const message = { type: 'graph', design: { id: 'perf', top: 'top', title: '交互性能验收', modules: [{ id: 'top', name: 'top' }] }, graph: { id: 'top', name: 'top', width: columns * pitchX, height: Math.ceil(count / columns) * pitchY, nodes, edges, signals: [] } };
    const svg = document.getElementById('circuit');
    // 合成事件不属于操作系统活动指针；仅替换捕获 API，事件仍走正式客户端监听器。
    svg.setPointerCapture = () => {}; svg.hasPointerCapture = () => false;
    const next = () => new Promise(resolve => requestAnimationFrame(resolve));
    const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: sorted.at(-1), samples: values.length }; };
    const event = (type, values) => svg.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, ...values }));
    const sample = async action => {
        const times = [], handlers = []; let previous = await next();
        for (let i = 0; i < 90; i++) { const start = performance.now(); action(i); handlers.push(performance.now() - start); const now = await next(); times.push(now - previous); previous = now; }
        return { frame: summary(times.slice(5)), handler: summary(handlers.slice(5)) };
    };
    return (async () => {
        const started = performance.now(); window.dispatchEvent(new MessageEvent('message', { data: message }));
        await next(); await next(); const loadMs = performance.now() - started;
        const graphLayer = svg.firstElementChild;
        let transforms = 0, classes = 0;
        const observer = new MutationObserver(records => { for (const item of records) { if (item.attributeName === 'transform' && item.target === graphLayer) transforms++; if (item.attributeName === 'class') classes++; } });
        observer.observe(svg, { subtree: true, attributes: true, attributeFilter: ['transform', 'class'] });
        event('pointerdown', { clientX: 600, clientY: 400 });
        const pan = await sample(i => { for (let sub = 0; sub < 8; sub++) event('pointermove', { clientX: 600 - i * 3 - sub * .3, clientY: 400 - Math.sin(i / 25) * 140 }); });
        event('pointerup', {}); const panTransforms = transforms; transforms = 0;
        const zoom = await sample(i => { for (let sub = 0; sub < 4; sub++) svg.dispatchEvent(new WheelEvent('wheel', { clientX: 500, clientY: 350, deltaY: i < 45 ? 1.5 : -1.5, cancelable: true })); });
        const zoomTransforms = transforms; classes = 0;
        // 选择通过正式 focusin 路径触发，避免每次点击先平移/聚焦画布带来的额外噪声。
        const view = svg.getBoundingClientRect();
        const selectTargets = [...svg.querySelectorAll('.cell')].filter(item => {
            const box = item.getBoundingClientRect();
            return box.right > view.left && box.left < view.right && box.bottom > view.top && box.top < view.bottom;
        }).slice(0, 4);
        if (selectTargets.length < 2) throw new Error('基准需要至少两个可见节点');
        const select = await sample(i => selectTargets[i % selectTargets.length].dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
        await next(); const selectionClassWrites = classes; observer.disconnect();
        const visible = [...svg.querySelectorAll('.cell,.wire')].filter(item => getComputedStyle(item).display !== 'none').length;
        const result = { count, edges: edges.length, domElements: svg.querySelectorAll('*').length, visibleObjects: visible, loadMs, pan, zoom, select, panTransforms, zoomTransforms, selectionClassWrites, browser: navigator.userAgent };
        window.benchmarkResult = result;
        return result;
    })();
}

async function browserAcceptance(count) {
    const svg = document.getElementById('circuit'), layer = svg.firstElementChild;
    const next = () => new Promise(resolve => requestAnimationFrame(resolve));
    const check = (value, message) => { if (!value) throw new Error(message); };
    const before = layer.getAttribute('transform');
    svg.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 400, clientY: 300 }));
    svg.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 500, clientY: 350 }));
    await next(); await next();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await next(); await next();
    check(layer.getAttribute('transform') === before, '取消拖拽必须恢复相机');
    const search = document.getElementById('search'); search.value = 'pipeline_' + (count - 1);
    search.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 180)); await next(); await next();
    const found = svg.querySelector('[data-node-id="n' + (count - 1) + '"]');
    check(found && found.classList.contains('selected'), '搜索必须恢复并选中屏外节点');
    const box = found.getBoundingClientRect(), view = svg.getBoundingClientRect();
    check(box.left >= view.left && box.right <= view.right && box.top >= view.top && box.bottom <= view.bottom, '搜索对象必须进入可见画布');
    const edge = svg.querySelector('.wire'); check(edge, '目标周围必须有可显示连线');
    const [, destination, branch] = edge.getAttribute('data-edge-id').match(/^e(\d+)-(\d+)$/);
    const netId = 'net' + (Number(destination) - Number(branch));
    // 点击走与用户相同的 pointerdown/up 路径；断言网络详情和至少一个分支高亮。
    edge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 500, clientY: 300 }));
    svg.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    check(document.getElementById('selectionKind').textContent === '网络', '连线点击必须选择网络');
    check(svg.querySelector('.wire.selected'), '网络分支必须高亮');
    check(document.getElementById('properties').textContent.includes(netId), '网络详情必须匹配被点击的连线');
    document.body.classList.add('vscode-dark'); await next(); await next();
    return { dragCancel: true, offscreenSearch: true, networkClick: true, darkTheme: true };
}

async function main() {
    const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(createCircuitHtml()); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const profile = fs.mkdtempSync(path.join(out, 'edge-'));
    const child = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,1000', '--force-device-scale-factor=1', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let socket;
    try {
        child.on('error', error => { console.error(error); process.exitCode = 1; });
        const portFile = path.join(profile, 'DevToolsActivePort'), deadline = Date.now() + 20000;
        while (!fs.existsSync(portFile)) { if (Date.now() > deadline) throw new Error('浏览器 CDP 启动超时'); await new Promise(resolve => setTimeout(resolve, 100)); }
        const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
        const tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
        socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
        let id = 0; const pending = new Map(), errors = [];
        socket.addEventListener('message', event => { const data = JSON.parse(event.data); if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails); if (data.id) { const item = pending.get(data.id); if (item) { clearTimeout(item.timer); pending.delete(data.id); data.error ? item.reject(new Error(JSON.stringify(data.error))) : item.resolve(data.result); } } });
        const call = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(method + ' 超时')); }, 120000); pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params })); });
        socket.addEventListener('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('浏览器连接已关闭')); } pending.clear(); });
        await call('Page.enable'); await call('Runtime.enable');
        await call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.acquireVsCodeApi = () => ({postMessage(){},setState(){},getState(){return {views:[[JSON.stringify(["perf","top"]),{camera:{x:40,y:40,scale:' + initialScale + '},isFit:false}]]}}});' });
        await call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
        for (let i = 0; i < 100; i++) { const ready = await call('Runtime.evaluate', { expression: '!!window.CircuitClient' }); if (ready.result.value) break; await new Promise(resolve => setTimeout(resolve, 50)); }
        const evaluated = await call('Runtime.evaluate', { expression: '(' + browserScenario + ')(' + count + ')', awaitPromise: true, returnByValue: true });
        if (evaluated.exceptionDetails || errors.length) throw new Error(JSON.stringify({ exception: evaluated.exceptionDetails, errors }));
        const result = { label, initialScale, ...evaluated.result.value };
        const screenshot = await call('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, label + '.png'), Buffer.from(screenshot.data, 'base64'));
        if (args.includes('--acceptance')) {
            const acceptance = await call('Runtime.evaluate', { expression: '(' + browserAcceptance + ')(' + count + ')', awaitPromise: true, returnByValue: true });
            if (acceptance.exceptionDetails || errors.length) throw new Error(JSON.stringify({ acceptance: acceptance.exceptionDetails, errors }));
            result.acceptance = acceptance.result.value;
            const dark = await call('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(out, label + '-dark.png'), Buffer.from(dark.data, 'base64'));
        }
        fs.writeFileSync(path.join(out, label + '.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
        await call('Browser.close');
    } finally { socket?.close(); child.kill(); server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
