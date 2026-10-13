'use strict';
const path = require('node:path');
const { VcdSession } = require('./session');
const { parseTimescaleSeconds } = require('./parser');
const { buildWaveformHtml } = require('./view');
const QUERY_METHODS = new Set(['window', 'values', 'edge']);

/**
 * 单面板数据服务：加载进度、按需查询、取消和关闭共用同一 worker 生命周期。
 * @param {{filePath:string,panel:object,channel?:object,createSession?:(options:object)=>object}} options
 * @returns {{dispose:()=>void,loaded:Promise<void>}} 可独立验证，不依赖 vscode 全局。
 */
function bindWaveformPanel({ filePath, panel, channel, createSession = options => new VcdSession(options) }) {
    let disposed = false, cancelled = false, ready = false, metadata = null, lastProgress = null, loadError = null;
    const log = text => channel?.appendLine('[VCD] ' + text);
    function send(message) {
        if (disposed || !ready) return;
        Promise.resolve(panel.webview.postMessage(message)).catch(error => { if (!disposed) log('页面消息发送失败：' + error.message); });
    }
    function reportState() {
        if (loadError) send({ type: 'error', error: loadError });
        else if (metadata) send({ type: 'init', metadata });
        else if (lastProgress) send({ type: 'progress', progress: lastProgress });
    }
    const session = createSession({ onProgress(progress) { lastProgress = progress; if (!cancelled) send({ type: 'progress', progress }); } });
    async function handleMessage(message) {
        if (!message || disposed) return;
        if (message.type === 'ready') { ready = true; reportState(); return; }
        if (message.type === 'close') { panel.dispose(); return; }
        if (message.type === 'cancel') {
            cancelled = true; loadError = '加载已取消。重新打开文件可再次加载。';
            await session.dispose(); reportState(); return;
        }
        if (!QUERY_METHODS.has(message.type) || !Number.isSafeInteger(message.requestId)) return;
        try {
            if (cancelled || !metadata) throw new Error(cancelled ? 'VCD 加载已取消' : 'VCD 尚未完成加载');
            const result = await session[message.type](message.params);
            send({ type: 'response', requestId: message.requestId, result });
        } catch (error) { send({ type: 'response', requestId: message.requestId, error: error.message }); }
    }
    const messages = panel.webview.onDidReceiveMessage(message => {
        handleMessage(message).catch(error => { if (!disposed) { loadError = error.message; reportState(); log(error.message); } });
    });
    const lifetime = panel.onDidDispose(dispose);
    function dispose() {
        if (disposed) return;
        disposed = true; metadata = null; lastProgress = null; loadError = null;
        messages.dispose(); lifetime.dispose();
        Promise.resolve(session.dispose()).catch(error => log('关闭数据服务失败：' + error.message));
    }
    panel.webview.html = buildWaveformHtml(null, { fileName: path.basename(filePath), fileKey: filePath });
    const loaded = session.open(filePath).then(result => {
        if (disposed || cancelled) return;
        if (!result.vars.length) throw new Error('该 VCD 中没有信号定义。');
        metadata = { ...result, secondsPerTick: parseTimescaleSeconds(result.timescale) };
        reportState(); log(`已加载 ${path.basename(filePath)}：${(result.fileBytes / 1048576).toFixed(1)} MiB，${result.vars.length} 条信号`);
    }).catch(async error => {
        if (disposed || cancelled) return;
        loadError = error.message; reportState(); log('加载失败：' + error.message);
        await session.dispose();
    });
    return { dispose, loaded };
}
module.exports = { bindWaveformPanel };
