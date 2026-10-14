'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { VcdSession } = require('../src/waveform/session');
const { buildWaveformHtml } = require('../src/waveform/view');
const { parseTimescaleSeconds } = require('../src/waveform/parser');

/** 浮点与分组的公开验收语料；每种格式包含普通数、负零、特殊值及未知状态。 */
function fixtureVcd() {
    const signals = [
        ['fp64', 64, 'a', ['3ff8000000000000', '8000000000000000', '0000000000000001', '7ff0000000000000', '7ff8000000000001']],
        ['fp32', 32, 'b', ['3fc00000', '80000000', '00000001', '7f800000', '7fc00001']],
        ['tf32_packed', 19, 'c', ['1fe00', '40000', '00001', '3fc00', '3fe01']],
        ['tf32_container', 32, 'd', ['3fc00000', '80000000', '00002000', '7f800000', '7fc02000']],
        ['bf16', 16, 'e', ['3fc0', '8000', '0001', '7f80', '7fc1']],
        ['fp16', 16, 'f', ['3e00', '8000', '0001', '7c00', '7e01']],
        ['fp8_e3m4', 8, 'g', ['38', '80', '01', '70', '78']],
        ['flags', 8, 'h', ['01', '02', '03', '04', '05']],
        ['mem[0][0]', 32, 'i', ['3f800000', '40000000', '00000001', '7f800000', '7fc00000']],
        ['mem[0][1]', 32, 'j', ['40000000', '40400000', '80000000', 'ff800000', '7fc00001']],
        ['mem[1][0]', 32, 'k', ['40400000', '40800000', '3f000000', '3f800000', '00000000']],
        ['mem[1][1]', 32, 'l', ['40800000', '40a00000', '3f800000', 'bf800000', '00000000']]
    ];
    const lines = ['$timescale 1ns $end', '$scope module float_tb $end', ...signals.map(([name, width, id]) => `$var wire ${width} ${id} ${name} $end`), '$upscope $end', '$enddefinitions $end'];
    for (let step = 0; step < 7; step++) {
        lines.push('#' + step * 100);
        for (const [, , id, values] of signals) lines.push('b' + (step === 5 ? 'x' : step === 6 ? 'z' : BigInt('0x' + values[step]).toString(2)) + ' ' + id);
    }
    lines.push('#700'); return lines.join('\n') + '\n';
}

/** 仅绑定 loopback 的验收服务，页面运行真实 client/renderer，数据查询经过真实 VCD Worker。 */
async function main() {
    const directory = path.resolve(__dirname, '..', 'bin', 'waveform-acceptance'); await fs.mkdir(directory, { recursive: true });
    const root = await fs.mkdtemp(path.join(directory, 'run-'));
    const filePath = path.join(root, 'floating.vcd'); await fs.writeFile(filePath, fixtureVcd());
    const session = new VcdSession(), metadata = await session.open(filePath);
    metadata.secondsPerTick = parseTimescaleSeconds(metadata.timescale);
    const counts = { window: 0, values: 0, edge: 0 }, messages = [];
    let saved = null;
    const restoreIndex = process.argv.indexOf('--restore');
    if (restoreIndex >= 0) {
        const previous = path.resolve(process.argv[restoreIndex + 1] || '');
        if (!previous.startsWith(directory + path.sep)) throw new Error('只接受本项目波形验收目录中的保存状态');
        saved = { ...JSON.parse(await fs.readFile(previous, 'utf8')), fileKey: filePath };
    }
    const bridge = `
const params = new URLSearchParams(location.search);
document.body.dataset.vscodeThemeKind = params.get('theme') === 'light' ? 'vscode-light' : 'vscode-dark';
window.acquireVsCodeApi = () => ({
 getState() { return null; },
 setState(value) { fetch('/state', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}).catch(console.error); },
 postMessage(message) {
  fetch('/query', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)})
   .then(response=>response.json()).then(data=>{if(data) window.dispatchEvent(new MessageEvent('message',{data}));}).catch(console.error);
 }
});`;
    const html = buildWaveformHtml(metadata, { fileName: '浮点与分组验收', fileKey: filePath, nonce: 'local-waveform-acceptance' })
        .replace("style-src 'nonce-local-waveform-acceptance';", "style-src 'nonce-local-waveform-acceptance'; connect-src 'self';")
        .replace('const BOOT=', bridge + '\nconst BOOT=');
    const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
    async function body(request) {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('验收请求过大'); chunks.push(chunk); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    const server = http.createServer(async (request, response) => {
        try {
            if (request.method === 'GET' && request.url.startsWith('/viewer')) {
                const stored = JSON.stringify(saved).replace(/</g, '\\u003c');
                const page = html.replace('getState() { return null; }', 'getState() { return ' + stored + '; }');
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(page); return;
            }
            if (request.method === 'GET' && request.url === '/report') { json(response, 200, { root, counts, saved, messages }); return; }
            if (request.method === 'POST' && request.url === '/state') {
                saved = await body(request); await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(saved, null, 2)); json(response, 200, { ok: true }); return;
            }
            if (request.method === 'POST' && request.url === '/query') {
                const message = await body(request);
                if (!['window', 'values', 'edge'].includes(message.type)) { json(response, 200, null); return; }
                counts[message.type]++;
                try { json(response, 200, { type: 'response', requestId: message.requestId, result: await session[message.type](message.params) }); }
                catch (error) { json(response, 200, { type: 'response', requestId: message.requestId, error: error.message }); }
                return;
            }
            json(response, 404, { error: 'not found' });
        } catch (error) { messages.push(error.message); json(response, 500, { error: error.message }); }
    });
    server.listen(0, '127.0.0.1', () => {
        const info = { root, url: `http://127.0.0.1:${server.address().port}/viewer` };
        fs.writeFile(path.join(root, 'server.json'), JSON.stringify(info, null, 2)).catch(console.error);
        console.log(JSON.stringify(info));
    });
    async function close() { server.close(); await session.dispose(); process.exit(0); }
    process.once('SIGINT', close); process.once('SIGTERM', close);
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { fixtureVcd };
