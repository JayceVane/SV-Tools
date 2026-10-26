'use strict';
const { CircuitSession } = require('./session');
const { createTraceController } = require('./trace-controller');
const { createCircuitWaveHost } = require('./wave-link-host');
const MAX_ID_LENGTH = 32768;

/**
 * @param {{panel:object,load:Function,onSource?:Function,onError?:Function,session?:CircuitSession}} options
 * @returns {{dispose:Function,reload:Function,loaded:Promise<object>}} loaded 明确返回首轮成败，页面只提交对象 ID。
 */
function bindCircuitPanel({ panel, load, onSource, onError = console.error, imageFiles, initialTrace, chooseSignal, chooseContext, chooseCandidate, onWave, onWaveInvalidated, session = new CircuitSession() }) {
    let closed = false, started = false, generation = 0, operation = 0, descriptor, currentGraph, breadcrumbs = [];
    let loadController, sourceStale = false;
    let completeLoad;
    const loaded = new Promise(resolve => { completeLoad = resolve; });
    const send = message => { if (!closed) return Promise.resolve(panel.webview.postMessage(message)); };
    const sendGraph = message => send({...message,viewGeneration:generation});
    const instancePath = () => breadcrumbs[0]?.id === descriptor?.top && breadcrumbs.slice(1).every(crumb => crumb.cellId)
        ? breadcrumbs.slice(1).map(crumb => crumb.cellId) : undefined;
    const validId = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
    const report = error => {
        completeLoad({ ok: false, error: error.message });
        if (!closed) { onError(error); send({ type: 'error', message: error.message }); }
    };
    const readyTimer = setTimeout(() => report(new Error('电路页面未能连接到扩展宿主')), 15000);
    const trace = createTraceController({ session, send, descriptor: () => descriptor, graph: () => currentGraph,
        beginOperation: () => ++generation, current: ticket => !closed && ticket === generation, chooseSignal, chooseContext, onError,
        instancePath,
        displayModule: (path, restore) => display(path, restore),
        async displayTrace(graph, { navigation, update, focus }) {
            currentGraph = graph;
            breadcrumbs = [{ id: graph.moduleId, name: descriptor.modules.find(module => module.id === graph.moduleId)?.name || graph.name }];
            await sendGraph({ type: 'graph', graph, design: descriptor, breadcrumbs, sourceStale, traceNavigation: navigation, traceUpdate: update, traceFocus: focus });
            completeLoad({ ok: true, design: descriptor, graph });
        } });
    const waveLink = createCircuitWaveHost({session,trace,instancePath,onWave,onInvalidated:onWaveInvalidated,send,onError,
        readState:()=>({design:descriptor,graph:currentGraph,generation,sourceStale,closed})});

    async function display(path, restore = false) {
        const version = ++generation;
        const previous = currentGraph, previousCrumbs = breadcrumbs;
        currentGraph = null;
        breadcrumbs = path;
        await send({ type: 'loading', message: '正在布局 ' + path.at(-1).name, breadcrumbs, moduleId: path.at(-1).id });
        let graph;
        try { graph = await session.request('layout', { moduleId: path.at(-1).id }); }
        catch (error) {
            if (closed || version !== generation) return { ok: false };
            if (!restore || !previous) throw error;
            currentGraph = previous; breadcrumbs = previousCrumbs;
            await sendGraph({ type: 'graph', graph: previous, design: descriptor, breadcrumbs, sourceStale, traceNavigation: trace.navigation(), traceUpdate: 'history' });
            await send({ type: 'notice', message: error.message }); return { ok: false };
        }
        if (closed || version !== generation) return { ok: false };
        breadcrumbs = path;
        currentGraph = graph;
        const traceNavigation = trace.moduleShown(path, restore);
        await sendGraph({ type: 'graph', graph, design: descriptor, breadcrumbs, sourceStale, traceNavigation });
        completeLoad({ ok: true, design: descriptor, graph });
        return { ok: true };
    }

    async function reload() {
        waveLink.invalidate('电路已刷新，请重新确认波形映射');
        const version = ++generation;
        currentGraph = null;
        descriptor = null;
        sourceStale = false;
        breadcrumbs = [];
        trace.reset();
        loadController?.abort('电路加载被新的请求取代');
        loadController = new AbortController();
        await send({ type: 'loading', message: '正在生成并读取电路数据', reset: true });
        const selection = initialTrace ? await initialTrace() : null;
        const options = await load({ signal: loadController.signal, traceSelection: selection });
        if (closed || version !== generation || !options) return;
        const loaded = await session.request('load', options);
        if (closed || version !== generation) return;
        descriptor = loaded;
        await send({ type: 'design', design: descriptor });
        if (selection) {
            const result = await session.request('traceCandidates', { designId: descriptor.id, revision: descriptor.revision, target: selection.target });
            if (closed || version !== generation) return;
            if (!result.candidates.length) throw new Error(result.reason || '没有可验证的追踪起点');
            const chosen = await chooseCandidate?.(result.candidates, selection.target, result.truncated);
            if (closed || version !== generation) return;
            if (!chosen) {
                completeLoad({ ok: false, cancelled: true }); await send({ type: 'error', message: '已取消起点选择，可选择模块或重新追踪' }); return;
            }
            const graph = await trace.begin({ moduleId: chosen.moduleId, origin: chosen.origin, direction: selection.direction, instancePath: chosen.instancePath });
            if (graph?.error) { completeLoad({ ok: false, error: graph.error }); await send({ type: 'error', message: graph.error }); }
            return;
        }
        const top = descriptor.modules.find(module => module.id === descriptor.top);
        if (!top) throw new Error('电路顶层模块不存在');
        await display([top]);
    }

    const handlers = {
        ...trace.handlers,
        ...waveLink.handlers,
        ready: async () => { if (!started) { started = true; clearTimeout(readyTimer); await reload(); } },
        reload,
        'image-save': async message => {
            if (!Number.isSafeInteger(message.requestId)) return;
            try {
                if (!currentGraph || !imageFiles) throw new Error('电路图片导出尚未就绪');
                const result = await imageFiles.save(message.params);
                await send({ type: 'image-result', requestId: message.requestId, result });
            } catch (error) { await send({ type: 'image-result', requestId: message.requestId, error: error.message }); }
        },
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
                return display([...breadcrumbs, { id: node.moduleId, name: node.label, cellId: node.cellId }]);
            }
        },
        source: async message => {
            if (!currentGraph || !onSource) return;
            const version = generation;
            if (message.cellId !== undefined && (!validId(message.cellId)
                || !currentGraph.nodes.some(node => node.cellId === message.cellId))) return;
            if (message.objectId !== undefined && (!validId(message.objectId) || !currentGraph.nodes.some(node => node.traceOrigin?.objectId === message.objectId
                || node.ports.some(port => port.traceOrigin?.objectId === message.objectId)))) return;
            const source = await session.request('source', { moduleId: breadcrumbs.at(-1).id, cellId: message.cellId, objectId: message.objectId });
            if (source && !closed && version === generation) {
                try { await onSource({ ...source, requireVerified: !!currentGraph.trace }); return { ok: true, source }; }
                catch (error) {
                    if (!currentGraph.trace) throw error;
                    await send({ type: 'notice', message: error.message }); onError(error);
                    return { ok: false, error: error.message };
                }
            }
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
        trace.dispose();
        messageSubscription.dispose(); panelSubscription.dispose(); session.dispose();
    }
    return { dispose, loaded, trace, waveSnapshot:waveLink.snapshot, notifyWave:waveLink.notify, waveTargets:waveLink.targets,
        findWaveTarget:waveLink.find, traceWaveTarget:waveLink.begin,
        markSourceStale() { sourceStale = true; waveLink.invalidate('源码已变化，请刷新电路并重新关联'); return send({ type: 'source-stale' }); },
        sourceSnapshotCaptured() { sourceStale = false; }, revealSource: params => handlers.source(params),
        getState: () => ({ design: descriptor, graph: currentGraph, breadcrumbs, sourceStale }), reload: () => {
        const version = ++operation;
        return reload().catch(error => { if (version === operation) report(error); });
    } };
}
module.exports = { bindCircuitPanel };
