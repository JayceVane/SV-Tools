'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { startProcess } = require('./process');
const { createTaskDirectory, pruneTaskDirectories, MAX_RETAINED_RUNS } = require('./task-retention');
const { acquireWorkspaceLease, workspaceFromDirectory } = require('./workspace-lease');
const MAX_CONCURRENT_PROCESSES = 2;
const DEFAULT_RETAINED_RUNS = 5;

function cancelledError(reason) {
    const error = new Error(reason || '任务已取消'); error.code = 'TOOL_CANCELLED'; return error;
}

/** 单次工具任务拥有取消信号、阶段进程和独立产物目录；日志在结束后保留。 */
class ToolTask {
    constructor(manager, key, previous) {
        this.manager = manager; this.key = key; this.id = randomUUID(); this.previous = previous;
        this.controller = new AbortController(); this.signal = this.controller.signal;
        this.state = 'preparing'; this.reason = null; this.directories = new Map(); this.directoryLeases = new Map(); this.pending = new Set();
        this.logPaths = []; this.sequence = 0; this.finished = false; this.finishing = null;
        this.completion = new Promise(resolve => { this.resolveCompletion = resolve; });
    }
    isCurrent() { return !this.finished && !this.signal.aborted && this.manager.current.get(this.key) === this; }
    throwIfCancelled() { if (!this.isCurrent()) throw cancelledError(this.reason); }
    cancel(reason = '任务已取消') {
        if (this.finished || this.signal.aborted) return;
        this.reason = reason; this.state = 'cancelling'; this.controller.abort(reason); this.manager.changed(this);
    }
    setStage(stage) { this.throwIfCancelled(); this.state = stage; this.manager.changed(this); }
    async waitForPrevious() { if (this.previous) await this.previous.completion; this.throwIfCancelled(); }

    /** @param {string} base 任务目录的父目录。 @param {string} kind 受控阶段名。 @returns {Promise<string>} */
    async directory(base, kind = 'tool') {
        this.throwIfCancelled();
        if (!/^[a-z][a-z0-9-]*$/i.test(kind)) throw new Error('无效的工具任务目录类型');
        const root = path.resolve(base), key = root + ':' + kind;
        if (this.directories.has(key)) return this.directories.get(key);
        const lease = await createTaskDirectory(root, kind);
        this.directoryLeases.set(key, lease); this.directories.set(key, lease.path);
        this.throwIfCancelled(); return lease.path;
    }

    /**
     * @param {AbortSignal} [signal] 面板刷新或关闭时交还占用。
     * @returns {{dispose:()=>Promise<void>}} 延长当前目录的保留期；不替代 finish 的 keepArtifacts 选项。
     * @throws {Error} 任务已结束或已取消。
     */
    retainDirectories(signal) {
        this.throwIfCancelled();
        const leases = [...this.directoryLeases.values()].map(lease => lease.retain());
        let disposal;
        const dispose = () => {
            signal?.removeEventListener('abort', dispose);
            disposal ||= this.manager.releaseDirectories(this, leases);
            return disposal;
        };
        if (signal?.aborted) dispose();
        else signal?.addEventListener('abort', dispose, { once: true });
        return { dispose };
    }

    /** @param {string} command @param {string[]} args @param {object} [options] @returns {Promise<object>} */
    async run(command, args, options = {}) {
        this.throwIfCancelled();
        const stage = options.stage || 'tool'; this.setStage(stage);
        const directory = this.directories.values().next().value || await this.directory(path.join(os.tmpdir(), 'svtools-tasks'));
        const logPath = path.join(directory, String(++this.sequence).padStart(2, '0') + '-' + stage.replace(/[^a-z0-9-]/gi, '_') + '.log');
        this.logPaths.push(logPath);
        this.manager.changed(this);
        const guarded = callback => callback && ((...params) => { if (this.isCurrent()) callback(...params); });
        const release = await this.manager.acquire(this.signal);
        let run, releaseWorkspace;
        try {
            const workspace = workspaceFromDirectory(directory);
            if (workspace) releaseWorkspace = await acquireWorkspaceLease(workspace,'tool-process',{signal:this.signal,slots:MAX_CONCURRENT_PROCESSES});
            this.throwIfCancelled();
            run = this.manager.startProcess(command, args, { ...options, logPath, signal: this.signal,
                onStdout: guarded(options.onStdout), onStderr: guarded(options.onStderr) });
            this.pending.add(run.completion);
            const result = await run.completion; this.lastResult = result; return result;
        } finally { if (run) this.pending.delete(run.completion); try { await releaseWorkspace?.(); } finally { release(); } }
    }

    /** 只清理本任务创建的目录内容，完整日志与显式保留的仿真产物留供复查。 */
    async cleanup(keepArtifacts) {
        if (keepArtifacts) return;
        for (const directory of this.directories.values()) {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                if (entry.isFile() && entry.name.endsWith('.log')) continue;
                const target = path.resolve(directory, entry.name);
                if (path.dirname(target) !== path.resolve(directory)) throw new Error('任务清理路径越界');
                await fs.rm(target, { recursive: entry.isDirectory(), force: true });
            }
        }
    }
    /** @param {{keepArtifacts?:boolean}} [options] @returns {Promise<void>} */
    finish({ keepArtifacts = false } = {}) {
        if (this.finishing) return this.finishing;
        this.finishing = (async () => {
            try { await Promise.allSettled([...this.pending]); await this.cleanup(keepArtifacts); }
            finally {
                this.finished = true; this.state = this.signal.aborted ? 'cancelled' : 'finished';
                if (this.manager.current.get(this.key) === this) this.manager.current.delete(this.key);
                this.manager.tasks.delete(this);
                await this.manager.releaseDirectories(this, this.directoryLeases.values());
                this.resolveCompletion(); this.manager.changed(this);
            }
        })();
        return this.finishing;
    }
}

/**
 * 同 key 的新请求取消旧请求；不同文档任务以独立目录并行。
 * @param {{startProcess?:Function,onChange?:(task:ToolTask)=>void,retention?:{keep:number|(()=>number)}}} [options]
 * @returns {{start:(key:string)=>ToolTask,cancel:Function,cancelAll:Function,dispose:Function}}
 */
function createToolTaskManager({ startProcess: launch = startProcess, onChange = () => {}, retention = { keep: DEFAULT_RETAINED_RUNS } } = {}) {
    const acquire = createProcessSlots(MAX_CONCURRENT_PROCESSES);
    const maintenance = new Set();
    function retainedRuns() {
        try {
            const keep = typeof retention.keep === 'function' ? retention.keep() : retention.keep;
            return Number.isSafeInteger(keep) && keep >= 0 && keep <= MAX_RETAINED_RUNS ? keep : DEFAULT_RETAINED_RUNS;
        } catch (error) { console.error('读取任务目录保留配置失败：' + error.message); return DEFAULT_RETAINED_RUNS; }
    }
    const manager = { current: new Map(), tasks: new Set(), startProcess: launch, changed: onChange, acquire,
        /** 释放实际占用后仅淘汰终态目录；等待维护完成，但失败不改变工具任务结果。 */
        releaseDirectories(task, leases) {
            const work = (async () => {
                for (const lease of leases) {
                    try { await lease.dispose(); }
                    catch (error) { console.error('交还任务目录失败(' + lease.path + ')：' + error.message); }
                }
                const keep = retainedRuns();
                if (!keep) return;
                await Promise.all([...task.directories.keys()].map(async key => {
                    const separator = key.lastIndexOf(':');
                    try { await pruneTaskDirectories(key.slice(0, separator), key.slice(separator + 1), keep); }
                    catch (error) { console.error('任务目录封顶失败(' + key.slice(0, separator) + ')：' + error.message); }
                }));
            })();
            maintenance.add(work);
            const forget = () => maintenance.delete(work);
            work.then(forget, forget);
            return work;
        },
        start(key) {
            const previous = manager.current.get(key); previous?.cancel('被新的任务取代');
            const task = new ToolTask(manager, key, previous); manager.current.set(key, task); manager.tasks.add(task);
            manager.changed(task); return task;
        },
        cancel(key, reason) { manager.current.get(key)?.cancel(reason); },
        cancelAll(reason = '工具链已关闭') { for (const task of manager.tasks) task.cancel(reason); },
        async dispose() {
            manager.cancelAll();
            await Promise.all([...manager.tasks].map(task => task.completion));
            await Promise.all([...maintenance]);
        }
    };
    return manager;
}

/** 两个进程槽限制自动检查的并发量；排队的取消不会启动编译器。 */
function createProcessSlots(limit) {
    let active = 0; const queue = [];
    function release() { active--; drain(); }
    function drain() {
        while (active < limit && queue.length) {
            const entry = queue.shift(); entry.signal.removeEventListener('abort', entry.abort);
            if (entry.signal.aborted) { entry.reject(cancelledError()); continue; }
            active++; entry.resolve(release);
        }
    }
    return signal => new Promise((resolve, reject) => {
        if (signal.aborted) { reject(cancelledError()); return; }
        const entry = { signal, resolve, reject, abort() {
            const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1);
            reject(cancelledError());
        } };
        queue.push(entry); signal.addEventListener('abort', entry.abort, { once: true }); drain();
    });
}
module.exports = { createToolTaskManager, cancelledError };
