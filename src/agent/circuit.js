'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, result } = require('./protocol');
const { resolveContext } = require('./context');
const { buildRTLDesign } = require('../project/rtl-model');
const { createCircuitTracer } = require('../circuit/trace');
const { firstModuleName } = require('../vivado/tclgen');

/** 源码静态网表追踪：只分析给定 HDL，顶层模块内按信号名定位起点。 */
async function trace(input) {
    const { options, context } = await resolveContext(input);
    const entry = input.file ? path.resolve(options.workspace, input.file) : context.files[0]?.path;
    if (!entry) fail('FILE_REQUIRED', 'circuit trace 需要 --file <hdl>');
    const extra = (input.sources || []).map(file => path.resolve(options.workspace, file));
    const files = [...new Set([entry, ...extra, ...context.files.map(file => file.path)])];
    const documents = [];
    for (const file of files) {
        documents.push({ path: file, text: await fs.readFile(file, 'utf8').catch(error => fail('SOURCE_NOT_FOUND', '无法读取源文件：' + error.message, { file })) });
    }
    const top = input.top || firstModuleName(documents[0].text);
    if (!top) fail('INVALID_ARGUMENT', '无法推断顶层模块，请用 --top 指定');
    let built;
    try { built = buildRTLDesign(documents, { top, defines: [...(context.defines || []), ...(options.defines || [])] }); }
    catch (error) { fail('CIRCUIT_PARSE_FAILED', error.message, {}, 1); }
    const design = built.design;
    const tracer = createCircuitTracer(design);
    const query = String(input.signal || '').trim();
    if (!query) fail('INVALID_ARGUMENT', 'circuit trace 需要 --signal <名称>');
    const list = tracer.listSignals({ moduleId: design.top, query, limit: 100 });
    const item = list.items.find(candidate => candidate.name === query) || list.items[0];
    if (!item) fail('SIGNAL_NOT_FOUND', '顶层模块中没有信号：' + query, { signals: list.items.slice(0, 10) });
    const direction = input.direction || 'loads';
    if (!['drivers', 'loads'].includes(direction)) fail('INVALID_ARGUMENT', '--direction 必须为 drivers 或 loads');
    const depth = input.depth ?? 1;
    const traced = tracer.trace({ moduleId: design.top, origin: { objectId: item.objectId }, direction, depth });
    return result('circuit.trace', { top, moduleId: design.top,
        signal: { name: item.name, objectId: item.objectId, width: item.width, direction: item.direction },
        direction, depth, issues: built.issues, ...traced });
}

module.exports = { trace };
