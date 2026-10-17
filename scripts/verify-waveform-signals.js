'use strict';
// 本机浏览器验收：正式页面、真实Pointer事件和VCD Worker；不修改用户IDE配置。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const out = path.resolve(option('--out', path.join(root, 'bin/wave-beta6-browser')));
const browserPath = option('--browser', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
    const deadline = Date.now() + 15000;
    while (!await predicate()) { if (Date.now() > deadline) throw Error('超时：' + label); await pause(50); }
}
async function main() {
    fs.mkdirSync(out, { recursive: true });
    const previewArgs = [path.join(root, 'scripts/preview-waveform.js'), '--signals'];
    if (args.includes('--extension-root')) previewArgs.push('--extension-root', option('--extension-root'));
    const preview = spawn(process.execPath, previewArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverInfo, previewOutput = '', previewError = '', browser, socket;
    preview.stdout.on('data', chunk => { previewOutput += chunk; for (const line of previewOutput.split('\n')) { try { const value = JSON.parse(line); if (value.url) serverInfo = value; } catch { /* stdout分块中的不完整JSON行等待下一块补齐。 */ } } });
    preview.stderr.on('data', chunk => { previewError += chunk; });
    try {
        await until(() => { if (preview.exitCode !== null) throw Error(previewError); return serverInfo; }, '预览服务');
        const profile = fs.mkdtempSync(path.join(out, 'edge-'));
        browser = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
            '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,1000', '--force-device-scale-factor=1', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
        const portFile = path.join(profile, 'DevToolsActivePort'); await until(() => fs.existsSync(portFile), '浏览器CDP');
        const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
        const tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
        socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
        let nextId = 0; const pending = new Map(), errors = [];
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
            if (message.id) { const job = pending.get(message.id); if (!job) return; clearTimeout(job.timer); pending.delete(message.id);
                message.error ? job.reject(Error(JSON.stringify(message.error))) : job.resolve(message.result); }
        });
        const call = (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP超时：' + method)); }, 30000);
            pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
        });
        socket.addEventListener('close', () => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Error('浏览器连接关闭')); } pending.clear(); });
        const evaluate = async expression => { const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails)); return value.result.value; };
        await call('Page.enable'); await call('Runtime.enable');
        await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.__waveLabels=[];const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){window.__waveLabels.push({text,x,y});if(window.__waveLabels.length>5000)window.__waveLabels.splice(0,1000);return original.call(this,text,x,y,...rest);};` });
        const report = async () => (await fetch(new URL('/report', serverInfo.url))).json();
        const waitReady = async () => { await until(() => evaluate("document.getElementById('loading')?.classList.contains('hidden') && document.getElementById('status').textContent.includes('就绪')"), '页面就绪'); await pause(100); };
        const clickRow = async (key, { right = false, ctrl = false } = {}) => {
            const saved = (await report()).saved, index = saved.selected.indexOf(key); assert.ok(index >= 0, key);
            const box = await evaluate("(()=>{const r=document.getElementById('waveCanvas').getBoundingClientRect();return {x:r.left,y:r.top};})()");
            const params = { x: box.x + 80, y: box.y + index * 38 + 18, button: right ? 'right' : 'left', clickCount: 1, modifiers: ctrl ? 2 : 0 };
            await call('Input.dispatchMouseEvent', { ...params, type: 'mousePressed' }); await call('Input.dispatchMouseEvent', { ...params, type: 'mouseReleased' }); await pause(60);
        };
        const action = async id => { assert.equal(await evaluate(`(()=>{const b=document.querySelector('.menu button[data-menu-action=${JSON.stringify(id)}]');if(!b||b.disabled)return false;b.click();return true;})()`), true, id); await pause(70); };
        const input = 'wave_tb.dut.ctrl', internal = 'wave_tb.ctrl', bit = JSON.stringify(['$bit', input, 2]);
        const results = [];
        for (const theme of ['dark', 'light']) {
            await call('Page.navigate', { url: serverInfo.url + '?theme=' + theme }); await waitReady();
            const roles = await evaluate("Array.from(document.querySelectorAll('.signalRole'),e=>({label:e.getAttribute('aria-label'),role:e.className}))");
            assert.ok(roles.some(item => item.role.includes('role-input'))); assert.ok(roles.some(item => item.role.includes('role-output')));
            assert.ok(roles.some(item => item.role.includes('role-inout'))); assert.ok(roles.some(item => item.role.includes('role-internal')));
            await clickRow(internal); await clickRow(input, { ctrl: true }); await clickRow(input, { right: true });
            const before = (await report()).counts; await action('signal-highlight'); await action('highlight-sky');
            await until(async () => (await report()).saved.highlights?.[input] === 'sky', '批量着色');
            const after = await report(); assert.equal(after.saved.highlights[internal], 'sky'); assert.deepEqual(after.counts, before);
            await clickRow(input); await clickRow(input, { right: true }); await action('expand-bus');
            await until(async () => (await report()).saved.selected.includes(bit), '展开bit');
            const expanded = await report(); const children = expanded.saved.selected.filter(key => key.startsWith('["$bit"'));
            assert.equal(children.length, 4); assert.ok(expanded.saved.selected.includes(input));
            await clickRow(bit); await clickRow(bit, { right: true }); await action('signal-highlight'); await action('highlight-rose');
            const cursorLabels = await evaluate(`(()=>{const c=document.getElementById('waveCanvas'),g=WaveColumnLayout.waveGeometry(c.clientWidth,undefined,false);return __waveLabels.filter(l=>l.x===g.names-96);})()`);
            assert.ok(cursorLabels.some(label => label.text === '0')); assert.ok(cursorLabels.some(label => label.text === '1'));
            await evaluate("document.getElementById('nextEdge').click()");
            await until(async () => (await report()).saved.cursorA === 40, '只跳到目标位的边沿40ns');
            await call('Page.reload'); await waitReady();
            assert.equal((await report()).saved.highlights[bit], 'rose'); assert.ok((await report()).saved.selected.includes(bit));
            await clickRow(bit, { right: true }); await action('signal-highlight');
            const screenshot = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, theme + '.png'), Buffer.from(screenshot.data, 'base64'));
            await evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
            await clickRow(input, { right: true }); await action('collapse-bus');
            await until(async () => !(await report()).saved.selected.includes(bit), '收起保留父总线');
            assert.ok((await report()).saved.selected.includes(input));
            results.push({ theme, roleIcons: true, batchHighlightWithoutQuery: true, expandedBits: children.length, exactBitEdge: 40, restored: true, collapsed: true });
        }
        assert.deepEqual(errors, []);
        const result = { browser: await call('Browser.getVersion'), results, errors };
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
        await call('Browser.close');
    } finally { socket?.close(); browser?.kill(); preview.kill(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
