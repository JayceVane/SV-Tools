'use strict';

const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { TextDecoder } = require('util');
const { createVcdParser } = require('./parser');
const { VcdStore } = require('./store');
const { readSignalRoles } = require('./source-roles');
const { restorePackedBuses } = require('./packed-buses');

let store = null;
let variables = null;
let displayVariables = null;
let loading = false;
const options = workerData || {};
const maxFileBytes = options.maxFileBytes || 2 * 1024 * 1024 * 1024;

async function open(filePath, sourceContext) {
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
    variables = parsed.vars;
    const after = await fs.promises.stat(filePath);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('VCD读取期间文件已变化，请在仿真结束后重新打开');
    store = candidate;
    loading = false;
    progress('ready');
    let roles = {};
    if (sourceContext) {
        progress('source-roles');
        try { roles = await readSignalRoles(parsed.vars, sourceContext); }
        catch (error) { roles.sourceRoleNote = '方向匹配不可用：' + error.message; }
    }
    const vars = restorePackedBuses(roles.vars || parsed.vars, store);
    displayVariables = vars;
    return { ...store.metadata({ ...parsed, ...roles, vars }, bytesRead), sourceRoleRetry: sourceContext?.invalidated === true, fileIdentity: { size: stat.size, mtimeMs: stat.mtimeMs }, parseMs: Date.now() - startedAt,
        workerHeapBytes: process.memoryUsage().heapUsed, workerArrayBufferBytes: process.memoryUsage().arrayBuffers };
}

parentPort.on('message', async message => {
    const { requestId, method, params } = message;
    try {
        let result;
        if (method === 'open') result = await open(params.filePath, params.sourceContext);
        else {
            if (!store || loading) throw Object.assign(new Error('VCD 尚未完成加载'), { code: 'VCD_NOT_READY' });
            if (method === 'roles') {
                const roles = await readSignalRoles(variables, params);
                const byPath = new Map(roles.vars.map(signal => [signal.path, signal]));
                const annotated = displayVariables.map(signal => {
                    const role = byPath.get(signal.bitPaths?.[0] || signal.path);
                    return { ...signal, role: role?.role || 'unknown', roleSource: role?.roleSource,
                        packedBit: signal.bitPaths ? undefined : role?.packedBit };
                });
                // 已确认的dump结构不随脏源码编辑而拆散；新恢复的RTL事实仍可归并其余逐位声明。
                const refreshed = restorePackedBuses(annotated, store);
                const changed = refreshed.length !== displayVariables.length || refreshed.some((signal, at) => signal.path !== displayVariables[at].path);
                displayVariables = refreshed;
                result = { roles: refreshed.map(signal => ({ path: signal.path, role: signal.role || 'unknown', roleSource: signal.roleSource })),
                    ...(changed ? { vars: store.metadata({ vars: refreshed }).vars } : {}),
                    sourceRoleNote: roles.sourceRoleNote, sourceRoleRetry: params?.invalidated === true };
            } else {
                if (!['window', 'values', 'edge', 'changes', 'sample'].includes(method)) throw new Error('未知 VCD 请求：' + method);
                result = store[method](params);
            }
        }
        parentPort.postMessage({ requestId, result });
    } catch (error) {
        parentPort.postMessage({ requestId, error: { message: error.message, code: error.code || 'VCD_WORKER', line: error.line, column: error.column } });
    }
});
