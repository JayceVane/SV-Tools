'use strict';
const { traceOrigin, collapseBranches, bitIndices } = require('./trace-actions');
const MAX_HISTORY = 32;
const copy = value => structuredClone(value);

/**
 * 面板级追踪导航；页面只提交当前图的对象ID或边界令牌。
 * @param {object} deps 会话、设计身份、代次校验、绘图和选择适配。
 * @returns {object} 同时供页面协议和真实宿主验收使用的动作。
 */
function createTraceController(deps) {
    const { session, send, descriptor, graph, beginOperation, current, displayTrace, displayModule,
        chooseSignal, chooseContext, onError } = deps;
    let history = [], cursor = -1, closed = false, busy = false, operation = 0;
    const snapshot = () => ({ designId: descriptor().id, revision: descriptor().revision });
    const navigation = () => ({ back: cursor > 0, forward: cursor >= 0 && cursor < history.length - 1,
        active: !!graph()?.trace, visible: history.some(entry => entry.mode === 'trace'), busy,
        focus: history[cursor]?.focus || [] });
    function push(entry) {
        history.splice(cursor + 1); history.push(copy(entry));
        if (history.length > MAX_HISTORY) history.shift();
        cursor = history.length - 1;
    }
    function notify() { return send({ type: 'trace-state', navigation: navigation() }); }
    // 结束 busy 状态并通知页面；面板已关闭时无需通知。仅用于当前有效操作失败或被非追踪导航取代的场景。
    async function settleBusy() { if (!busy) return; busy = false; if (!closed) await notify(); }
    async function render(entry, { replace = false, historyIndex, update = 'start' } = {}) {
        if (closed || !descriptor()) return;
        const ticket = beginOperation(), traceTicket = ++operation; busy = true; await notify();
        try {
            if (!current(ticket) || closed || traceTicket !== operation) return;
            const result = await session.request('traceLayout', { ...snapshot(), ...entry.request });
            if (!current(ticket) || closed || traceTicket !== operation) return;
            if (historyIndex !== undefined) cursor = historyIndex;
            else if (replace && cursor >= 0) history[cursor] = copy(entry);
            else push(entry);
            busy = false;
            await displayTrace(result, { navigation: navigation(), update, focus: entry.focus });
            await notify();
            return result;
        } catch (error) {
            if (!current(ticket) || closed || traceTicket !== operation) return;
            await settleBusy();
            await send({ type: 'notice', message: error.message }); onError(error);
            return { error: error.message };
        }
    }
    function moduleShown(path, restore = false) {
        if (!restore) {
            const entry = { mode: 'module', path: copy(path) };
            if (history[cursor]?.mode === 'module') { history[cursor] = entry; history.splice(cursor + 1); }
            else push(entry);
        }
        busy = false; return navigation();
    }
    async function context(moduleId, instancePath) {
        if (instancePath !== undefined) return { instancePath };
        if (moduleId === descriptor().top) return { instancePath: [] };
        const result = await session.request('traceContexts', { ...snapshot(), moduleId });
        if (!result.contexts.length) return { instancePath: undefined };
        const selected = await chooseContext?.(result.contexts, result.truncated);
        return selected ? { instancePath: selected.instancePath } : null;
    }
    async function begin({ origin, direction, moduleId = graph()?.moduleId || descriptor()?.top, instancePath } = {}) {
        if (!descriptor()) return;
        const selecting = ++operation, identity = descriptor();
        const selected = origin || await chooseSignal?.({ session, snapshot: snapshot(), moduleId });
        if (closed || selecting !== operation || descriptor() !== identity) return;
        if (!selected) return settleBusy();
        const target = await context(moduleId, instancePath);
        if (closed || selecting !== operation || descriptor() !== identity) return;
        if (!target) return settleBusy();
        return render({ mode: 'trace', request: { moduleId, direction: direction || 'drivers', origin: selected,
            instancePath: target.instancePath, branches: [] }, focus: [] });
    }
    async function fromSelection(selection, direction, bitChoice) {
        let origin = traceOrigin(graph(), selection);
        if (!origin) { await send({ type: 'notice', message: '请选择具体信号、引脚或网络分支' }); return; }
        const indices = bitIndices(bitChoice || '*');
        if (indices) origin = { objectId: origin.objectId, indices };
        const path = graph()?.trace?.context;
        return begin({ origin, direction, instancePath: path?.kind === 'instance' ? path.instancePath : deps.instancePath?.() });
    }
    async function expand(id) {
        const frontier = graph()?.trace?.frontiers.find(frontier => frontier.id === id);
        const entry = history[cursor];
        if (!frontier || entry?.mode !== 'trace') throw new Error('追踪边界已过期');
        if (frontier.kind === 'enter') {
            const parent = entry.request.instancePath;
            return begin({ moduleId: frontier.next.moduleId, origin: { objectId: frontier.next.objectId, positions: frontier.origin.positions },
                direction: entry.request.direction, instancePath: parent === undefined ? undefined : [...parent, frontier.next.cellId] });
        }
        if (frontier.kind !== 'expand') return;
        const next = copy(entry); next.request.branches.push({ id });
        return render(next, { update: 'expand' });
    }
    async function collapse(id) {
        const entry = history[cursor];
        if (entry?.mode !== 'trace' || !graph()?.trace?.branches.some(branch => branch.id === id)) throw new Error('展开分支已过期');
        const next = copy(entry), remaining = collapseBranches(graph().trace.branches, id);
        next.request.branches = remaining.map(branch => ({ id: branch.id }));
        return render(next, { update: 'collapse' });
    }
    async function go(delta) {
        const target = cursor + delta;
        if (![-1, 1].includes(delta) || !history[target]) return;
        const entry = copy(history[target]);
        if (entry.mode === 'trace') return render(entry, { historyIndex: target, update: 'history' });
        const selecting = ++operation, result = await displayModule(entry.path, true);
        if (selecting !== operation || closed) return;
        if (!result?.ok) return settleBusy();
        cursor = target; busy = false; await notify();
    }
    async function focus(selection) {
        const origin = traceOrigin(graph(), selection), entry = history[cursor];
        if (busy || !origin || entry?.mode !== 'trace') return;
        const exists = entry.focus.includes(origin.objectId);
        entry.focus = exists ? entry.focus.filter(id => id !== origin.objectId) : [...entry.focus, origin.objectId].slice(-64);
        await notify();
    }
    async function cancel() {
        if (!busy) return;
        beginOperation(); operation++; busy = false;
        await session.request('traceCancel', snapshot()); await notify();
        await send({ type: 'notice', message: '已取消本次追踪操作' });
    }
    function reset() { history = []; cursor = -1; busy = false; operation++; }
    const actions = {
        'trace-start': message => fromSelection(message.selection, message.direction, message.bitChoice),
        'trace-choose': message => begin({ direction: message.direction }),
        'trace-expand': message => expand(message.frontierId), 'trace-collapse': message => collapse(message.branchId),
        'trace-back': () => go(-1), 'trace-forward': () => go(1), 'trace-focus': message => focus(message.selection),
        'trace-cancel': cancel
    };
    const handlers = Object.fromEntries(Object.entries(actions).map(([name, action]) => [name, async message => {
        try { return await action(message); }
        catch (error) {
            if (closed) return;
            await send({ type: 'notice', message: error.message }); onError(error); return { error: error.message };
        }
    }]));
    return { handlers, begin, expand, collapse, go, focus, cancel, moduleShown, settleBusy, navigation, reset,
        state: () => ({ cursor, history: copy(history), busy }),
        dispose() { closed = true; reset(); } };
}

module.exports = { createTraceController };
