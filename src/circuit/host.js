'use strict';
const { CircuitSession } = require('./session');
const MAX_ID_LENGTH = 32768;

/**
 * @param {{panel:object,load:Function,onSource?:Function,onError?:Function,session?:CircuitSession}} options
 * @returns {{dispose:Function,reload:Function,loaded:Promise<object>}} loaded 明确返回首轮成败，页面只提交对象 ID。
 */
function bindCircuitPanel({ panel, load, onSource, onError = console.error, session = new CircuitSession() }) {
    let closed = false, started = false, generation = 0, operation = 0, descriptor, currentGraph, breadcrumbs = [];
    let loadController;
    let completeLoad;
    const loaded = new Promise(resolve => { completeLoad = resolve; });
    const send = message => { if (!closed) return Promise.resolve(panel.webview.postMessage(message)); };
    const validId = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
    const report = error => {
        completeLoad({ ok: false, error: error.message });
        if (!closed) { onError(error); send({ type: 'error', message: error.message }); }
    };
    const readyTimer = setTimeout(() => report(new Error('电路页面未能连接到扩展宿主')), 15000);

    async function display(path) {
        const version = ++generation;
        currentGraph = null;
        breadcrumbs = path;
        await send({ type: 'loading', message: '正在布局 ' + path.at(-1).name, breadcrumbs, moduleId: path.at(-1).id });
        const graph = await session.request('layout', { moduleId: path.at(-1).id });
        if (closed || version !== generation) return;
        breadcrumbs = path;
        currentGraph = graph;
        await send({ type: 'graph', graph, design: descriptor, breadcrumbs });
        completeLoad({ ok: true, design: descriptor, graph });
    }

    async function reload() {
        const version = ++generation;
        currentGraph = null;
        descriptor = null;
        breadcrumbs = [];
        loadController?.abort('电路加载被新的请求取代');
        loadController = new AbortController();
        await send({ type: 'loading', message: '正在生成并读取电路数据', reset: true });
        const options = await load({ signal: loadController.signal });
        if (closed || version !== generation || !options) return;
        const loaded = await session.request('load', options);
        if (closed || version !== generation) return;
        descriptor = loaded;
        await send({ type: 'design', design: descriptor });
        const top = descriptor.modules.find(module => module.id === descriptor.top);
        if (!top) throw new Error('电路顶层模块不存在');
        await display([top]);
    }

    const handlers = {
        ready: async () => { if (!started) { started = true; clearTimeout(readyTimer); await reload(); } },
        reload,
        home: () => descriptor && display([descriptor.modules.find(module => module.id === descriptor.top)]),
        back: () => descriptor && breadcrumbs.length > 1 && display(breadcrumbs.slice(0, -1)),
        module: message => {
            const module = validId(message.moduleId) && descriptor?.modules.find(item => item.id === message.moduleId);
            if (module) return display([module]);
        },
        navigate: message => {
            const node = validId(message.cellId) && currentGraph?.nodes.find(item => item.cellId === message.cellId && item.moduleId);
            if (node && descriptor.modules.some(module => module.id === node.moduleId)) {
                if (breadcrumbs.length >= 64) throw new Error('层级浏览超过 64 层');
                return display([...breadcrumbs, { id: node.moduleId, name: node.label }]);
            }
        },
        source: async message => {
            if (!currentGraph || !onSource) return;
            const version = generation;
            if (message.cellId !== undefined && (!validId(message.cellId)
                || !currentGraph.nodes.some(node => node.cellId === message.cellId))) return;
            const source = await session.request('source', { moduleId: breadcrumbs.at(-1).id, cellId: message.cellId });
            if (source && !closed && version === generation) await onSource(source);
        }
    };

    const messageSubscription = panel.webview.onDidReceiveMessage(message => {
        if (closed || !message || typeof message !== 'object' || !Object.hasOwn(handlers, message.type)) return;
        if (message.type === 'ready' && started) return;
        const version = ++operation;
        Promise.resolve().then(() => handlers[message.type](message)).catch(error => {
            // 新导航已取代的旧布局失败不能覆盖当前页面。
            if (version === operation) report(error);
        });
    });
    const panelSubscription = panel.onDidDispose(dispose);
    function dispose() {
        if (closed) return;
        closed = true; generation++; operation++;
        clearTimeout(readyTimer);
        completeLoad({ ok: false, error: '电路页面已关闭' });
        loadController?.abort('电路页面已关闭');
        messageSubscription.dispose(); panelSubscription.dispose(); session.dispose();
    }
    return { dispose, loaded, reload: () => {
        const version = ++operation;
        return reload().catch(error => { if (version === operation) report(error); });
    } };
}
module.exports = { bindCircuitPanel };
