'use strict';
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { createCircuitHtml } = require('../src/circuit/view');
const { bindCircuitPanel } = require('../src/circuit/host');

// 开发预览复用真实 Worker、模型、ELK 和页面；SSE 仅替代 VS Code 的消息桥。
const { values } = parseArgs({ options: { json: { type: 'string' }, root: { type: 'string' }, port: { type: 'string', default: '0' } } });
if (!values.json) throw new Error('用法：node scripts/preview-circuit.js --json <网表.json> [--root <源码根>] [--port 0]');
const clients = new Map();
const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (request.method === 'GET' && url.pathname === '/') {
            const id = randomUUID(), listeners = new Set(), disposers = new Set();
            const client = { events: [], response: null, listeners };
            const panel = { webview: {
                postMessage(message) {
                    const data = 'data: ' + JSON.stringify(message) + '\n\n';
                    if (client.response) client.response.write(data); else client.events.push(data);
                    return Promise.resolve(true);
                },
                onDidReceiveMessage(handler) { listeners.add(handler); return { dispose: () => listeners.delete(handler) }; }
            }, onDidDispose(handler) { disposers.add(handler); return { dispose: () => disposers.delete(handler) }; } };
            client.dispose = () => { for (const dispose of [...disposers]) dispose(); client.response?.end(); clients.delete(id); };
            bindCircuitPanel({ panel, load: () => ({ filePath: path.resolve(values.json), sourceRoot: path.resolve(values.root || path.dirname(values.json)) }),
                onSource: source => console.log(JSON.stringify({ source })), onError: error => console.error(error.message) });
            clients.set(id, client);
            let html = createCircuitHtml();
            html = html.replace("default-src 'none';", "default-src 'none'; connect-src 'self';");
            const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
            html = html.replace('<body>', `<body class="vscode-${theme}">`);
            if (theme === 'light') html = html.replace('</style>', 'body{--vscode-editor-background:#f6f8fb;--vscode-editor-foreground:#243445;--vscode-sideBar-background:#fff;--vscode-descriptionForeground:#66788a;--vscode-panel-border:#d7e1e9;--vscode-input-background:#fff;--vscode-button-secondaryBackground:#e8eff6;--vscode-button-secondaryForeground:#294359;--vscode-focusBorder:#2176bb}</style>');
            const bridge = `
const events = new EventSource('/events?client=${id}');
const queued = [];
function emit(message) { fetch('/command?client=${id}', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)}).catch(console.error); }
events.onmessage = event => window.postMessage(JSON.parse(event.data), '*');
events.onopen = () => { for (const message of queued.splice(0)) emit(message); };
window.acquireVsCodeApi = () => ({postMessage(message){ if(events.readyState===1)emit(message);else queued.push(message); },getState(){return {};},setState(){}});
`;
            const index = html.indexOf('>', html.lastIndexOf('<script nonce=')) + 1;
            html = html.slice(0, index) + bridge + html.slice(index);
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html);
            const timer = setTimeout(() => { if (!client.response) client.dispose(); }, 15000); timer.unref();
        } else if (request.method === 'GET' && url.pathname === '/events') {
            const client = clients.get(url.searchParams.get('client'));
            if (!client) { response.writeHead(404); response.end(); return; }
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            response.write(': connected\n\n'); client.response = response;
            for (const event of client.events.splice(0)) response.write(event);
            request.on('close', () => client.dispose());
        } else if (request.method === 'POST' && url.pathname === '/command') {
            const client = clients.get(url.searchParams.get('client'));
            if (!client) { response.writeHead(404); response.end(); return; }
            const chunks = []; let size = 0;
            for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error('预览请求过大'); chunks.push(chunk); }
            const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            for (const listener of client.listeners) listener(message);
            response.writeHead(204); response.end();
        } else { response.writeHead(404); response.end(); }
    } catch (error) { console.error(error); if (!response.headersSent) response.writeHead(500); response.end(error.message); }
});
server.listen(Number(values.port), '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, pid: process.pid })));
process.on('SIGINT', () => { for (const client of clients.values()) client.dispose(); server.close(); });
