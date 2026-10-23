'use strict';
// 本机浏览器验收：正式页面、真实Pointer事件和VCD Worker；不修改用户IDE配置。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const out = path.resolve(option('--out', path.join(root, 'bin/wave-beta7-browser')));
const browserPath = option('--browser', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
    const deadline = Date.now() + 15000;
    while (!await predicate()) { if (Date.now() > deadline) throw Error('超时：' + label); await pause(50); }
}
async function main() {
    fs.mkdirSync(out, { recursive: true });
    const corpus = option('--file', null);
    const previewArgs = [path.join(root, 'scripts/preview-waveform.js'), ...(corpus ? ['--file',path.resolve(corpus)] : args.includes('--floating') ? [] : ['--signals'])];
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
        await call('Page.addScriptToEvaluateOnNewDocument', { source: `let rendererFactory;Object.defineProperty(window,'createWaveRenderer',{get(){return rendererFactory},set(factory){rendererFactory=options=>{const renderer=factory(options);window.__renderer=renderer;return renderer;}}});window.__waveLabels=[];const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){window.__waveLabels.push({text,x,y});if(window.__waveLabels.length>5000)window.__waveLabels.splice(0,1000);return original.call(this,text,x,y,...rest);};` });
        const report = async () => (await fetch(new URL('/report', serverInfo.url))).json();
        const waitReady = async () => { await until(() => evaluate("document.getElementById('loading')?.classList.contains('hidden') && /就绪|密集跳变/.test(document.getElementById('status').textContent)"), '页面就绪'); await pause(100); };
        const clickRow = async (key, { right = false, ctrl = false } = {}) => {
            const saved = (await report()).saved, index = saved.selected.indexOf(key); assert.ok(index >= 0, key);
            const box = await evaluate("(()=>{const r=document.getElementById('waveCanvas').getBoundingClientRect();return {x:r.left,y:r.top};})()");
            const params = { x: box.x + 80, y: box.y + index * 38 + 18, button: right ? 'right' : 'left', clickCount: 1, modifiers: ctrl ? 2 : 0 };
            await call('Input.dispatchMouseEvent', { ...params, type: 'mousePressed' }); await call('Input.dispatchMouseEvent', { ...params, type: 'mouseReleased' }); await pause(60);
        };
        const action = async id => { assert.equal(await evaluate(`(()=>{const b=document.querySelector('.menu button[data-menu-action=${JSON.stringify(id)}]');if(!b||b.disabled)return false;b.click();return true;})()`), true, id); await pause(70); };
        if (args.includes('--exports')) {
            const results=[];
            for (const theme of ['dark','light']) {
                await call('Page.navigate',{url:serverInfo.url+'?theme='+theme});await waitReady();
                const exportEnd=args.includes('--floating')?300:40;
                if(args.includes('--floating')){
                    for(const [key,format]of [['float_tb.fp64','fp64'],['float_tb.fp32','fp32'],['float_tb.tf32_packed','tf32'],['float_tb.bf16','bf16'],['float_tb.fp16','fp16'],['float_tb.fp8_e3m4','fp8e3m4']]){
                        await clickRow(key,{right:true});await action('display-format');await action('format-'+format);
                    }
                    await evaluate("document.getElementById('cursorMode').click();document.getElementById('jumpTime').value='300 ns';document.getElementById('jump').click()");
                }else if(!(await report()).saved.selected.some(key=>key.startsWith('["$bit"'))){
                    await clickRow('wave_tb.dut.ctrl',{right:true});await action('expand-bus');
                }
                for(const style of ['document','theme']) for(const format of ['svg','png']) {
                    const before=await report();
                    await evaluate("document.getElementById('exportImage').click()");
                    await until(()=>evaluate("!!document.getElementById('imageConfirm')"),'导出选项');
                    await evaluate(`document.getElementById('imageStyle').value=${JSON.stringify(style)};document.getElementById('imageFormat').value=${JSON.stringify(format)};document.getElementById('imageConfirm').click();`);
                    await until(async()=>{const current=await report();const status=await evaluate("document.getElementById('status').textContent");if(status.includes('失败'))throw Error(status);return current.exports.length>before.exports.length;},'导出文件');
                    const after=await report(),file=after.exports.at(-1).file,data=fs.readFileSync(file);
                    assert.deepEqual(after.saved.selected,before.saved.selected);assert.equal(after.saved.cursorA,before.saved.cursorA);assert.equal(after.saved.cursorB,before.saved.cursorB);
                    const query=after.queries.filter(q=>q.type==='window').at(-1);assert.equal(query.params.start,0);assert.equal(query.params.end,exportEnd);
                    if(format==='svg'){assert.match(data.toString(),/0 ns/);assert.ok(data.toString().includes(exportEnd+' ns'));if(args.includes('--floating'))assert.match(data.toString(),/1\.5/);assert.doesNotMatch(data.toString(),/0xX|↕|▸/);if(style==='document')assert.doesNotMatch(data.toString(),/#52d4ac|#e5ba76/);}
                    else {assert.equal(data.subarray(1,4).toString(),'PNG');assert.ok(data.readUInt32BE(16)>=1100);}
                    results.push({theme,style,format,file,bytes:data.length,range:[0,exportEnd]});
                }
            }
            assert.deepEqual(errors,[]);const result={results,errors};fs.writeFileSync(path.join(out,'exports.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await call('Browser.close');return;
        }
        if (corpus) {
            await call('Page.navigate',{url:serverInfo.url+'?theme=dark'});await waitReady();
            const performanceReport=await evaluate(`(()=>{
                const renderer=window.__renderer,measure=fn=>{const values=[];for(let i=0;i<50;i++){const start=performance.now();fn();values.push(performance.now()-start);}values.sort((a,b)=>a-b);return {medianMs:values[25],p95Ms:values[47]};};
                const full=measure(()=>renderer.draw()),before=renderer.metrics.staticDraws,overlay=measure(()=>renderer.drawOverlay());
                return {full,overlay,overlayStaticDraws:renderer.metrics.staticDraws-before,metrics:renderer.metrics,visibleRows:renderer.visibleRows().length,geometry:renderer.geometry(),metadata:document.getElementById('metadata').textContent};})()`);
            assert.equal(performanceReport.overlayStaticDraws,0);assert.ok(performanceReport.overlay.medianMs<performanceReport.full.medianMs);
            const result={browser:await call('Browser.getVersion'),file:path.resolve(corpus),...performanceReport,errors};
            fs.writeFileSync(path.join(out,'performance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
            await call('Browser.close');return;
        }
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
            assert.equal((await report()).saved.highlights[bit],'rose');
            await call('Page.reload'); await waitReady();
            await clickRow(input,{right:true});await action('expand-bus');
            assert.equal((await report()).saved.highlights[bit],'rose');
            await clickRow(bit,{right:true});await action('new-group');
            await evaluate("(()=>{const i=document.querySelector('.waveGroupDialog input');i.value='控制位';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()");
            await until(async()=>(await report()).saved.groups[bit]==='控制位','新建分组');
            await clickRow(bit,{right:true});await action('toggle-group-控制位');
            await until(async()=>(await report()).saved.collapsedGroups.includes('控制位'),'分组收起');
            const expected=(await report()).saved;
            await evaluate("document.getElementById('saveLayout').click()");await until(()=>evaluate("document.getElementById('status').textContent.includes('已保存')"),'保存实际布局文件');
            await evaluate("document.getElementById('clearSignals').click()");await until(async()=>(await report()).saved.selected.length===0,'清空布局');
            await evaluate("document.getElementById('loadLayout').click()");await until(async()=>(await report()).saved.highlights?.[bit]==='rose','加载实际布局文件');
            const imported=(await report()).saved;assert.deepEqual(imported.selected,expected.selected);assert.deepEqual(imported.groups,expected.groups);
            assert.deepEqual(imported.collapsedGroups,expected.collapsedGroups);assert.equal(imported.cursorA,expected.cursorA);
            await clickRow(bit,{right:true});await action('toggle-group-控制位');
            await clickRow(input,{right:true});await action('collapse-bus');
            results.push({ theme, roleIcons: true, batchHighlightWithoutQuery: true, expandedBits: children.length, exactBitEdge: 40, restored: true, collapsed: true, hiddenBitRestored:true, groupCollapsedRestored:true, layoutFileRoundTrip:true });
        }
        assert.deepEqual(errors, []);
        const result = { browser: await call('Browser.getVersion'), results, errors };
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
        await call('Browser.close');
    } finally { socket?.close(); browser?.kill(); preview.kill(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
