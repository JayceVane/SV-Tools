'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const REQUEST_TIMEOUT_MS = 60000;
const WORKER_HEAP_MB = 384;
const MAX_PENDING_REQUESTS = 8;

/** 文件解析、模型构建和 ELK 布局均在独立 Worker 中执行，关闭页面释放整个会话。 */
class CircuitSession {
    constructor({ WorkerClass = Worker, timeoutMs = REQUEST_TIMEOUT_MS, workerFile = path.join(__dirname, 'worker.js') } = {}) {
        this.worker = new WorkerClass(workerFile, {
            resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB }
        });
        this.timeoutMs = timeoutMs;
        this.pending = new Map();
        this.sequence = 0;
        this.closed = false;
        this.worker.on('message', reply => this.receive(reply));
        this.worker.on('error', error => this.dispose(error));
        this.worker.on('exit', code => {
            if (!this.closed) this.dispose(new Error('电路 Worker 意外退出：' + code));
        });
    }

    /** @param {string} command @param {object} [payload] @returns {Promise<object>} 超时会终止会话。 */
    request(command, payload = {}) {
        if (this.closed) return Promise.reject(new Error('电路会话已关闭'));
        if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error('电路请求过于频繁，请等待当前布局完成'));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.dispose(new Error('电路解析或布局超时，请选择更小的模块')), this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try { this.worker.postMessage({ id, command, payload }); }
            catch (error) { this.dispose(error); }
        });
    }

    receive({ id, result, error }) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
    }

    /** @param {Error} [reason] @returns {void} 拒绝迟到的请求并结束资源所有权。 */
    dispose(reason = new Error('电路会话已关闭')) {
        if (this.closed) return;
        this.closed = true;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
        this.pending.clear();
        Promise.resolve(this.worker.terminate()).catch(error => console.error('电路 Worker 终止失败：' + error.message));
    }
}
module.exports = { CircuitSession };
