'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const MAX_PENDING_REQUESTS = 8;

function sessionError(message, code) { return Object.assign(new Error(message), { code }); }

/**
 * 单文件 worker 会话；宿主只接收元数据和有界视窗，不读取 VCD 全文。
 * @param {{onProgress?: (progress: object) => void, maxStoreBytes?: number, maxFileBytes?: number, readBufferBytes?: number, parserLimits?: object}} [options]
 */
class VcdSession {
    constructor(options = {}) {
        this.options = options;
        this.worker = null;
        this.pending = new Map();
        this.nextRequestId = 1;
        this.opened = false;
        this.ready = false;
        this.disposed = false;
        this.failure = null;
        this.closing = null;
    }
    rejectAll(error) {
        this.failure = error;
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
    request(method, params) {
        if (this.disposed) return Promise.reject(sessionError('VCD 会话已关闭', 'VCD_DISPOSED'));
        if (this.failure) return Promise.reject(this.failure);
        if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(sessionError('VCD 查询并发超过 ' + MAX_PENDING_REQUESTS + '，请合并过期请求', 'VCD_BUSY'));
        const requestId = this.nextRequestId++;
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            try { this.worker.postMessage({ requestId, method, params }); }
            catch (error) { this.pending.delete(requestId); reject(error); }
        });
    }
    /** @param {string} filePath @param {object} [sourceContext] 有界工作区源上下文。@returns {Promise<object>} 只允许打开一次；重试请创建新会话。 */
    async open(filePath, sourceContext) {
        if (this.disposed) throw sessionError('VCD 会话已关闭', 'VCD_DISPOSED');
        if (this.opened) throw sessionError('VCD 会话已打开文件', 'VCD_ALREADY_OPEN');
        this.opened = true;
        const { onProgress, ...workerData } = this.options;
        this.worker = new Worker(path.join(__dirname, 'worker.js'), { workerData,
            resourceLimits: { maxOldGenerationSizeMb: 256 } });
        this.worker.on('message', message => {
            if (message.type === 'progress') {
                if (!this.disposed && onProgress) {
                    try { onProgress(message.progress); }
                    catch (error) { console.error('VCD 进度回调失败：', error); }
                }
                return;
            }
            const pending = this.pending.get(message.requestId);
            if (!pending) return;
            this.pending.delete(message.requestId);
            if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
            else pending.resolve(message.result);
        });
        this.worker.on('error', error => {
            const isMemoryLimit = error.code === 'ERR_WORKER_OUT_OF_MEMORY';
            this.rejectAll(sessionError(isMemoryLimit ? 'VCD worker 超过 256 MiB JS 堆预算，请减少信号或记录范围' : 'VCD worker 失败：' + error.message,
                isMemoryLimit ? 'VCD_RESOURCE_LIMIT' : error.code || 'VCD_WORKER'));
        });
        this.worker.on('exit', code => {
            if (!this.disposed) this.rejectAll(sessionError('VCD worker 意外退出：' + code, 'VCD_WORKER_EXIT'));
        });
        const metadata = await this.request('open', { filePath, sourceContext });
        this.ready = true;
        return metadata;
    }
    query(method, params) {
        if (!this.ready && !this.disposed) return Promise.reject(sessionError('VCD 尚未完成加载', 'VCD_NOT_READY'));
        return this.request(method, params);
    }
    /** @param {{ids: string[], start: number, end: number, pixels: number}} params @returns {Promise<object>} */
    window(params) { return this.query('window', params); }
    /** @param {{ids: string[], time: number}} params @returns {Promise<object>} */
    values(params) { return this.query('values', params); }
    /** @param {{id: string, time: number, direction: 'next'|'previous'|1|-1, bitOffset?:number, continuation?:number}} params @returns {Promise<object>} */
    edge(params) { return this.query('edge', params); }
    /** @param {object} sourceContext 有界RTL清单。 @returns {Promise<object>} 只重算方向，不重新读取VCD或创建事件存储。 */
    roles(sourceContext) { return this.query('roles', sourceContext); }
    /** 取消读取和全部 pending 请求；释放 worker 及其事件存储。 */
    dispose() {
        if (this.disposed) return this.closing;
        this.disposed = true;
        this.ready = false;
        this.rejectAll(sessionError('VCD 会话已关闭', 'VCD_DISPOSED'));
        this.closing = this.worker ? this.worker.terminate() : Promise.resolve();
        return this.closing;
    }
}

module.exports = { VcdSession };
