'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { startProcess } = require('./process');
const { pruneTaskDirectories } = require('./task-retention');
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
        this.state = 'preparing'; this.reason = null; this.directories = new Map(); this.pending = new Set();
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
        await fs.mkdir(root, { recursive: true }); this.throwIfCancelled();
        const directory = await fs.mkdtemp(path.join(root, kind + '-'));
        this.directories.set(key, directory); this.throwIfCancelled(); return directory;
    }

    /** @param {string} command @param {string[]} args @param {object} [options] @returns {Promise<object>} */
    async run(command, args, options = {}) {
        this.throwIfCancelled();
        const stage = options.stage || 'tool'; this.setStage(stage);
        const directory = this.directories.values().next().value || await this.directory(path.join(os.tmpdir(), 'svtools-tasks'));
        const logPath = path.join(directory, String(++this.sequence).padStart(2, '0') + '-' + stage.replace(/[^a-z0-9-]/gi, '_') + '.log');
        this.logPaths.push(logPath);
        const guarded = callback => callback && ((...params) => { if (this.isCurrent()) callback(...params); });
        const release = await this.manager.acquire(this.signal);
        let run;
        try {
            this.throwIfCancelled();
            run = this.manager.startProcess(command, args, { ...options, logPath, signal: this.signal,
                onStdout: guarded(options.onStdout), onStderr: guarded(options.onStderr) });
            this.pending.add(run.completion);
            const result = await run.completion; this.lastResult = result; return result;
        } finally { if (run) this.pending.delete(run.completion); release(); }
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
                this.manager.retain(this);
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
    function retainedRuns() {
        try {
            const keep = typeof retention.keep === 'function' ? retention.keep() : retention.keep;
            return Number.isSafeInteger(keep) && keep >= 0 && keep <= 100 ? keep : DEFAULT_RETAINED_RUNS;
        } catch (error) { console.error('读取任务目录保留配置失败：' + error.message); return DEFAULT_RETAINED_RUNS; }
    }
    const manager = { current: new Map(), tasks: new Set(), startProcess: launch, changed: onChange, acquire,
        /** 任务结束后对其使用的各 (base,kind) 目录封顶；失败不影响任务结果。 */
        retain(task) {
            const keep = retainedRuns();
            if (!keep) return;
            const protect = new Set();
            for (const live of manager.tasks) for (const directory of live.directories.values()) protect.add(path.resolve(directory));
            for (const key of task.directories.keys()) {
                const separator = key.lastIndexOf(':');
                pruneTaskDirectories(key.slice(0, separator), key.slice(separator + 1), keep, { protect })
                    .catch(error => console.error('任务目录封顶失败(' + key.slice(0, separator) + ')：' + error.message));
            }
        },
        start(key) {
            const previous = manager.current.get(key); previous?.cancel('被新的任务取代');
            const task = new ToolTask(manager, key, previous); manager.current.set(key, task); manager.tasks.add(task);
            manager.changed(task); return task;
        },
        cancel(key, reason) { manager.current.get(key)?.cancel(reason); },
        cancelAll(reason = '工具链已关闭') { for (const task of manager.tasks) task.cancel(reason); },
        async dispose() { manager.cancelAll(); await Promise.all([...manager.tasks].map(task => task.completion)); }
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
