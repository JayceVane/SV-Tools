'use strict';
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { tokenize } = require('../editor/completion/syntax');
const { sourceHash } = require('../circuit/source-snapshots');
const { traceSelection, traceCandidates, keyPath } = require('../circuit/trace-source');
const { traceProjectSignal } = require('./signal-flow');
const { buildRTLDesign, createRTLIndex, protectedRanges } = require('./rtl-model');
const { buildTraceContext, containsTarget } = require('./trace-context');
const MAX_FILES = 4096, MAX_FILE_BYTES = 2 * 1024 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024;
let design, identity, snapshots, issues = [], generation = 0;
async function loadRTL({ files, top, tops, target, includeDirs = [], defines = [] }) {
    const version = ++generation;
    design = undefined;
    identity = undefined;
    snapshots = undefined;
    if (!Array.isArray(files) || files.length > MAX_FILES || !files.length || files.some(file => typeof file !== 'string' || !path.isAbsolute(file))
        || (target ? !Array.isArray(tops) || tops.length > 64 || tops.some(name => typeof name !== 'string') || typeof target.moduleName !== 'string' || typeof target.path !== 'string' || !Number.isSafeInteger(target.moduleLine) : typeof top !== 'string' || !top)
        || !Array.isArray(includeDirs) || includeDirs.length > MAX_FILES || includeDirs.some(directory => typeof directory !== 'string' || !path.isAbsolute(directory))
        || !Array.isArray(defines) || defines.length > MAX_FILES || defines.some(define => typeof define !== 'string')) {
        throw new Error('静态RTL分析输入无效');
    }
    const documents = [], entries = [], readIssues = [], visited = new Set(), queued = new Set(files.map(keyPath)), queue = [...files];
    let bytes = 0;
    const warn = message => {
        if (readIssues.length < 256) {
            readIssues.push(message);
        }
    };
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const file = queue[cursor], key = keyPath(file);
        if (visited.has(key)) {
            continue;
        }
        if (visited.size >= MAX_FILES) {
            throw new Error('静态RTL分析及头文件超过4096项');
        }
        visited.add(key);
        let text;
        try {
            const handle = await fs.open(file, 'r');
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
                    throw new Error('源码不是普通文件或超过2MiB');
                }
                if (bytes + stat.size > MAX_TOTAL_BYTES) {
                    throw new RangeError('静态RTL输入超过16MiB，请缩小工程');
                }
                const buffer = Buffer.alloc(stat.size + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                if (bytesRead !== stat.size) {
                    throw new Error('读取期间源码发生变化');
                }
                text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
                bytes += bytesRead;
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            if (error instanceof RangeError) {
                throw error;
            }
            warn(file + '：' + error.message);
            continue;
        }
        if (version !== generation) {
            throw new Error('静态RTL加载已被取代');
        }
        documents.push({ path: file, text });
        entries.push({ path: file, inputPath: file, hash: sourceHash(text) });
        const tokens = tokenize(text).filter(token => token.kind !== 'comment');
        const conditional = protectedRanges(tokens, defines);
        for (let index = 0; index < tokens.length; index++)
            if (tokens[index].value === '`include') {
                if (conditional(tokens[index].start)) {
                    warn(file + '：条件include未展开');
                    continue;
                }
                const literal = tokens[index + 1];
                if (literal?.kind !== 'string' || !/^"[^"\\\r\n]+"$/.test(literal.value)) {
                    warn(file + '：动态include未展开');
                    continue;
                }
                const name = literal.value.slice(1, -1), candidates = [path.resolve(path.dirname(file), name), ...includeDirs.map(directory => path.resolve(directory, name))];
                let found;
                for (const candidate of candidates) {
                    try {
                        if ((await fs.stat(candidate)).isFile()) {
                            found = candidate;
                            break;
                        }
                    }
                    catch (error) {
                        if (error.code !== 'ENOENT') {
                            warn(candidate + '：' + error.message);
                        }
                    }
                }
                if (found) {
                    if (!queued.has(keyPath(found))) {
                        if (queued.size >= MAX_FILES) {
                            throw new Error('静态RTL分析及头文件超过4096项');
                        }
                        queued.add(keyPath(found));
                        queue.push(found);
                    }
                }
                else {
                    warn(file + '：头文件未找到 ' + name);
                }
            }
    }
    if (version !== generation) {
        throw new Error('静态RTL加载已被取代');
    }
    const built = target ? buildTraceContext(createRTLIndex(documents, { defines }), tops, target) : buildRTLDesign(documents, { top, defines });
    top = built.top || top;
    design = built.design;
    snapshots = new Map(entries.map(entry => [keyPath(entry.path), entry]));
    issues = [...new Set(['静态RTL连接分析：不调用Yosys，不执行综合；宏与生成分支未展开的部分会明确止步', ...readIssues, ...built.issues])].slice(0, 257);
    identity = createHash('sha256').update(JSON.stringify([top, defines, entries])).digest('hex');
    return { id: identity, revision: version, sourceSnapshots: entries, issues, top, fallback: !!built.fallback };
}
function current(payload) {
    if (!design || payload.designId !== identity || payload.revision !== generation) {
        throw new Error('静态RTL追踪来源已过期，请重新追踪');
    }
}
const commands = {
    loadRTL,
    traceSelection: ({ text, offset }) => traceSelection(text, { offset }),
    containsTarget(payload) {
        current(payload);
        return containsTarget(design, payload.target);
    },
    traceCandidates(payload) {
        current(payload);
        const result = traceCandidates(design, payload.target, snapshots);
        result.candidates = result.candidates.filter(candidate => candidate.instancePath !== undefined);
        if (!result.candidates.length) {
            result.reason = '静态模型无法确定该声明的实例或位宽（宏、生成块、用户类型等可能未解析），请查看分析提示';
        }
        return result;
    },
    projectFlow(payload) {
        current(payload);
        const result = traceProjectSignal(design, payload);
        return { ...result, issues: [...issues, ...result.issues], analysis: 'rtl-static' };
    }
};
parentPort.on('message', async ({ id, command, payload }) => {
    try {
        if (!Object.hasOwn(commands, command)) {
            throw new Error('未知静态RTL请求');
        }
        const result = await commands[command](payload || {});
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16 * 1024 * 1024) {
            throw new Error('静态RTL结果超过16MiB，请缩小工程');
        }
        parentPort.postMessage({ id, result });
    }
    catch (error) {
        parentPort.postMessage({ id, error: error.message });
    }
});
