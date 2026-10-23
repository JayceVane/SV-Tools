'use strict';
// 本机浏览器验收：正式页面、完整电路布局和图片保存；不修改用户IDE配置。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const out = path.resolve(option('--out', path.join(root, 'bin/circuit-beta8-export')));
const browserPath = option('--browser', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
    const deadline = Date.now() + 15000;
    while (!await predicate()) { if (Date.now() > deadline) throw Error('超时：' + label); await pause(50); }
}
async function main() {
    fs.mkdirSync(out, { recursive: true });
    const fixture=path.join(out,'pipeline.json'),bits=stage=>Array.from({length:8},(_,i)=>2+stage*8+i),cells={};
    const stages=Number(option('--stages','12')),nodeCount=stages+3;
    if(!Number.isInteger(stages)||stages<1||stages>32)throw Error('--stages必须在1..32之间');
    for(let stage=0;stage<stages;stage++)cells['pipeline_'+stage]={type:'$dff',parameters:{WIDTH:8,CLK_POLARITY:1},port_directions:{CLK:'input',D:'input',Q:'output'},connections:{CLK:[1],D:bits(stage),Q:bits(stage+1)}};
    fs.writeFileSync(fixture,JSON.stringify({modules:{top:{ports:{clk:{direction:'input',bits:[1]},a:{direction:'input',bits:bits(0)},y:{direction:'output',bits:bits(stages)}},cells,netnames:{}}}}));
    const previewArgs=[path.join(root,'scripts/preview-circuit.js'),'--json',fixture,'--out',path.join(out,'images')];
    if(args.includes('--extension-root'))previewArgs.push('--extension-root',option('--extension-root'));

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

        const results=[];
        for(const theme of ['dark','light']){
            await call('Page.navigate',{url:serverInfo.url+'/?theme='+theme});
            await until(()=>evaluate("document.body.dataset.mode==='graph'"),'完整电路加载');
            await evaluate("for(let i=0;i<5;i++)document.getElementById('zoomIn').click()");await pause(150);
            const beforeView=await evaluate("({transform:document.querySelector('.graphLayer').getAttribute('transform'),visible:document.querySelectorAll('#circuit .cell').length})");
            assert.ok(beforeView.visible<nodeCount);
            for(const style of ['document','theme'])for(const format of ['svg','png']){
                const before=await report();await evaluate("document.getElementById('exportImage').click()");
                await until(()=>evaluate("!!document.getElementById('imageConfirm')"),'导出对话框');
                await evaluate(`document.getElementById('imageStyle').value=${JSON.stringify(style)};document.getElementById('imageFormat').value=${JSON.stringify(format)};document.getElementById('imageConfirm').click();`);
                await until(async()=>{const status=await evaluate("document.getElementById('status').textContent");if(status.includes('失败'))throw Error(status);return (await report()).exports.length>before.exports.length;},'保存图片');
                const file=(await report()).exports.at(-1).file,data=fs.readFileSync(file);
                if(format==='svg'){
                    assert.equal((data.toString().match(/class="cell /g)||[]).length,nodeCount);assert.ok(data.toString().includes('pipeline_'+(stages-1)));assert.match(data.toString(),/busWidth/);assert.doesNotMatch(data.toString(),/data-detail="overview"/);
                    if(style==='document')assert.doesNotMatch(data.toString(),/#7ccabf|rgb\(124, 202, 191\)/);
                }else{assert.equal(data.subarray(1,4).toString(),'PNG');assert.ok(data.readUInt32BE(16)>1000);}
                assert.equal(await evaluate("document.querySelector('#circuit .graphLayer').getAttribute('transform')"),beforeView.transform);
                results.push({theme,style,format,file,bytes:data.length,completeNodes:nodeCount,screenNodes:beforeView.visible});
            }
        }
        assert.deepEqual(errors,[]);const result={results,errors};fs.writeFileSync(path.join(out,'exports.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await call('Browser.close');
    }finally{socket?.close();browser?.kill();preview.kill();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
