'use strict';
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { findModule } = require('./model');
const { layoutModule } = require('./layout');
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
let design;
let loadSequence = 0;

/** 只有快照文件映射回原文位置，模型坐标与原始 JSON 均不发送到扩展宿主。 */
function remapSources(model, sourceMap = {}, sourceDirectories = []) {
    const replacements = new Map(Object.entries(sourceMap).map(([from, to]) => [path.resolve(from), to]));
    for (const module of model.modules) {
        for (const item of [module, ...module.ports, ...module.cells, ...module.cells.flatMap(cell => cell.ports)]) {
            if (item.source && replacements.has(path.resolve(item.source.path))) {
                item.source = { ...item.source, path: replacements.get(path.resolve(item.source.path)) };
            } else if (item.source) {
                for (const directory of sourceDirectories) {
                    const relative = path.relative(directory.from, item.source.path);
                    if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
                        item.source = { ...item.source, path: path.join(directory.to, relative) };
                        break;
                    }
                }
            }
        }
    }
}

async function load({ filePath, format, stage, top, title, sourceRoot, sourceMap, sourceDirectories }) {
    const version = ++loadSequence;
    design = undefined;
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error('电路 JSON 必须为不超过 64 MiB 的普通文件');
    const chunks = [];
    let length = 0;
    for await (const chunk of createReadStream(filePath)) {
        length += chunk.length;
        if (length > MAX_JSON_BYTES) throw new Error('读取期间电路 JSON 超过 64 MiB');
        chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, length);
    if (version !== loadSequence) throw new Error('电路加载已被取代');
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
    format ||= raw?.engine === 'vivado' ? 'vivado' : 'yosys';
    const adapters = { yosys: () => require('./adapters/yosys').fromYosys,
        vivado: () => require('./adapters/vivado').fromVivado };
    if (!Object.hasOwn(adapters, format)) throw new Error('未知电路数据格式：' + format);
    const loaded = adapters[format]()(raw, { stage, top, title: title || path.basename(filePath), sourceRoot: sourceRoot || path.dirname(filePath) });
    remapSources(loaded, sourceMap, sourceDirectories);
    if (version !== loadSequence) throw new Error('电路加载已被取代');
    design = loaded;
    return { id: createHash('sha256').update(bytes).update(design.top).digest('hex'), title: design.title,
        top: design.top, provenance: design.provenance, modules: design.modules.map(module => ({ id: module.id, name: module.name })) };
}

const commands = {
    load,
    topCandidates: ({ text }) => {
        if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) {
            throw new Error('RTL 顶层扫描超过 16 MiB');
        }
        return require('./source-request').topCandidates(text);
    },
    layout: ({ moduleId }) => {
        if (!design) throw new Error('电路尚未加载');
        return layoutModule(design, moduleId);
    },
    source: ({ moduleId, cellId }) => {
        const module = design && findModule(design, moduleId);
        if (!module) throw new Error('电路模块已不存在');
        return (cellId ? module.cells.find(cell => cell.id === cellId) : module)?.source || null;
    }
};

parentPort.on('message', async ({ id, command, payload }) => {
    try {
        if (!Object.hasOwn(commands, command)) throw new Error('未知电路请求');
        const result = await commands[command](payload || {});
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_MESSAGE_BYTES) {
            throw new Error('电路展示数据超过 16 MiB，请选择更小的模块');
        }
        parentPort.postMessage({ id, result });
    } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
