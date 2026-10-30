'use strict';

/** 合并同版本自动检查；显式检查、停止和配置失效统一消费挂起的防抖。 */
function createLintScheduler({ run, engineOf, debounceMs }) {
    const pending = new Map(), running = new Map();
    const keyOf = document => document?.uri?.toString();
    let disposed = false;
    function clear(document) {
        const key = keyOf(document), timer = pending.get(key);
        if (timer) clearTimeout(timer);
        pending.delete(key);
    }
    function invalidate(document) { clear(document); running.delete(keyOf(document)); }
    function request(document, kind = 'lint', options = {}) {
        const key = keyOf(document);
        if (!key || disposed) return run(document, kind, options);
        clear(document);
        const engine = kind === 'elaborate' ? 'xvlog' : engineOf(document), current = running.get(key);
        if (options.automatic && current?.version === document.version && (current.engine === engine || current.manual)) return current.promise;
        const entry = { version: document.version, engine, manual: !options.automatic };
        entry.promise = Promise.resolve().then(() => run(document, kind, options)).finally(() => {
            if (running.get(key) === entry) running.delete(key);
        });
        running.set(key, entry);
        return entry.promise;
    }
    function schedule(document, callback) {
        if (disposed) return;
        clear(document);
        const key = keyOf(document), delay = Math.max(100, Number(debounceMs(document)) || 800);
        pending.set(key, setTimeout(() => { pending.delete(key); callback(document); }, delay));
    }
    function dispose() {
        disposed = true;
        for (const timer of pending.values()) clearTimeout(timer);
        pending.clear(); running.clear();
    }
    return { request, schedule, clear, invalidate, dispose };
}

module.exports = { createLintScheduler };
