'use strict';
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { createSourcePathMapper } = require('./source-paths');
const { keyPath, declarationsOf } = require('./trace-source');
const { parseDocument } = require('../editor/completion/syntax');
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024, MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_PARSE_BYTES = 2 * 1024 * 1024;

async function readBounded(file, maximum) {
    const handle = await fs.open(file, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maximum) return null;
        const buffer = Buffer.alloc(stat.size + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== stat.size) return null;
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); }
        catch { return null; }
        return { bytes: bytesRead, text };
    } finally { await handle.close(); }
}

/** @param {string} text 源码文本。 @returns {string} 忽略UTF-8 BOM和CRLF编码差异的内容身份。 */
function sourceHash(text) { return createHash('sha256').update(text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')).digest('hex'); }

/** @param {object} request 工具源文件和快照映射。 @returns {Promise<object[]>} 有界的生成前快照身份；超大或非UTF-8文件按无快照跳过，不阻塞生成，也不伪称可验证定位。 */
async function snapshotSources({ sources, sourceMap, sourceDirectories }) {
    const mapPath = createSourcePathMapper({ sourceMap, sourceDirectories }), snapshots = []; let bytes = 0;
    for (const inputPath of sources.slice(0, 4096)) {
        const content = await readBounded(inputPath, Math.min(MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES - bytes));
        if (!content) continue;
        bytes += content.bytes;
        snapshots.push({ path: mapPath(inputPath), inputPath, hash: sourceHash(content.text) });
    }
    return snapshots;
}

/** @param {object} design 领域模型。 @param {object[]} entries 可信生成入口提供的快照。 @returns {object} 位置查找和快照身份，不接收页面文件路径。 */
function createSourceLocator(design, entries = []) {
    const snapshots = new Map(entries.map(entry => [keyPath(entry.path), entry])), parsed = new Map();
    async function declarations(snapshot) {
        if (parsed.has(snapshot.hash)) return parsed.get(snapshot.hash);
        const content = await readBounded(snapshot.inputPath, MAX_PARSE_BYTES);
        if (!content) return null;
        if (sourceHash(content.text) !== snapshot.hash) throw new Error('生成时的源码快照已变化，请刷新电路');
        if (parsed.size >= 4) parsed.delete(parsed.keys().next().value);
        const model = parseDocument(content.text); parsed.set(snapshot.hash, model); return model;
    }
    async function locate(moduleId, { cellId, objectId } = {}) {
        const module = design.modules.find(module => module.id === moduleId);
        if (!module) throw new Error('源码定位模块不存在');
        const cell = cellId ? module.cells.find(cell => cell.id === cellId)
            : module.cells.find(cell => cell.ports.some(port => port.id === objectId));
        const object = [...module.ports, ...module.signals].find(object => object.id === objectId);
        const source = cell?.source || object?.source || (!objectId && !cellId ? module.source : undefined);
        if (source) {
            const result = { ...source }, expectedHash = snapshots.get(keyPath(source.path))?.hash;
            if (expectedHash) result.expectedHash = expectedHash;
            return result;
        }
        if (!object || !module.source) return null;
        const snapshot = snapshots.get(keyPath(module.source.path));
        if (!snapshot) return null;
        const model = await declarations(snapshot);
        if (!model) return null;
        const candidates = declarationsOf(model).filter(candidate => candidate
            && candidate.moduleLine === module.source.line && candidate.qualifiedName === object.name && !candidate.conditional);
        if (candidates.length !== 1) return null;
        return { path: snapshot.path, line: candidates[0].declLine, column: candidates[0].declColumn, expectedHash: snapshot.hash };
    }
    return { snapshots, locate, async verify() {
        for (const [key, snapshot] of snapshots) {
            const content = await readBounded(snapshot.inputPath, MAX_FILE_BYTES);
            if (!content || sourceHash(content.text) !== snapshot.hash) snapshots.delete(key);
        }
    }, dispose() { snapshots.clear(); parsed.clear(); design = null; } };
}

/** @param {string} file 已通过路径验证的源文件。 @param {string} expectedHash 生成身份。 @returns {Promise<boolean>} 有界校验磁盘内容。 */
async function sourceMatches(file, expectedHash) {
    const content = await readBounded(file, MAX_FILE_BYTES);
    return !!content && sourceHash(content.text) === expectedHash;
}

module.exports = { sourceHash, sourceMatches, snapshotSources, createSourceLocator };
