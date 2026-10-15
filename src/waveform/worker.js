'use strict';

const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { TextDecoder } = require('util');
const { createVcdParser } = require('./parser');
const { VcdStore } = require('./store');

let store = null;
let loading = false;
const options = workerData || {};
const maxFileBytes = options.maxFileBytes || 2 * 1024 * 1024 * 1024;

async function open(filePath) {
    if (loading || store) throw Object.assign(new Error('VCD worker 已在使用'), { code: 'VCD_BUSY' });
    loading = true;
    const startedAt = Date.now();
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error('VCD 路径不是普通文件');
    if (stat.size > maxFileBytes) throw Object.assign(new Error('VCD 文件超过 ' + Math.round(maxFileBytes / 1048576) + ' MiB 上限'), { code: 'VCD_RESOURCE_LIMIT' });
    const candidate = new VcdStore(options);
    const parser = createVcdParser({ onVariable: variable => candidate.register(variable),
        onChange: (id, time, value) => candidate.add(id, time, value), limits: options.parserLimits });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytesRead = 0;
    let reportedAt = 0;
    const progress = phase => parentPort.postMessage({ type: 'progress', progress: {
        phase, bytesRead, fileBytes: stat.size, eventCount: candidate.eventCount } });
    progress('loading');
    const stream = fs.createReadStream(filePath, { highWaterMark: options.readBufferBytes || 64 * 1024 });
    for await (const chunk of stream) {
        bytesRead += chunk.length;
        if (bytesRead > maxFileBytes) throw Object.assign(new Error('VCD 文件读取时超过资源上限'), { code: 'VCD_RESOURCE_LIMIT' });
        parser.write(decoder.decode(chunk, { stream: true }));
        if (Date.now() - reportedAt >= 200) { progress('loading'); reportedAt = Date.now(); }
    }
    parser.write(decoder.decode());
    const parsed = parser.finish();
    store = candidate;
    loading = false;
    progress('ready');
    return { ...store.metadata(parsed, bytesRead), parseMs: Date.now() - startedAt,
        workerHeapBytes: process.memoryUsage().heapUsed, workerArrayBufferBytes: process.memoryUsage().arrayBuffers };
}

parentPort.on('message', async message => {
    const { requestId, method, params } = message;
    try {
        let result;
        if (method === 'open') result = await open(params.filePath);
        else {
            if (!store || loading) throw Object.assign(new Error('VCD 尚未完成加载'), { code: 'VCD_NOT_READY' });
            if (!['window', 'values', 'edge'].includes(method)) throw new Error('未知 VCD 请求：' + method);
            result = store[method](params);
        }
        parentPort.postMessage({ requestId, result });
    } catch (error) {
        parentPort.postMessage({ requestId, error: { message: error.message, code: error.code || 'VCD_WORKER', line: error.line, column: error.column } });
    }
});
