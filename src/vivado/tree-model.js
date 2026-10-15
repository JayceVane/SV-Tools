'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { maskSourceText, extractDesignUnits } = require('../workspace/sources');
const { samePath } = require('./xpr');
const MAX_INDEX_FILES = 3000, MAX_HIERARCHY_NODES = 5000, MAX_HIERARCHY_DEPTH = 32;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024, MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const SOURCE_EXT = /\.(sv|v|svh|vh)$/i;
const keyOf = file => process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file);

async function readBoundedSource(file) {
    const chunks = []; let bytes = 0;
    for await (const chunk of createReadStream(file, { highWaterMark: 65536 })) {
        bytes += chunk.length;
        if (bytes > MAX_SOURCE_BYTES) throw new Error('源码超过单文件预览预算');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
}

function skipSpace(code, index) { while (/\s/.test(code[index] || '') && index < code.length) index++; return index; }
function afterBalanced(code, index, open, close) {
    if (code[index] !== open) return -1;
    let depth = 0;
    for (; index < code.length; index++) { if (code[index] === open) depth++; else if (code[index] === close && !--depth) return index + 1; }
    return -1;
}

/** 按已知单元识别实例/包引用，屏蔽文本保护区；这是源码预览，不代替工具详细化。 */
function referencedUnits(text, units) {
    const code = maskSourceText(text), references = new Set(); let previous = '';
    for (const match of code.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
        const name = match[0];
        if (!units.has(name) || /^(module|macromodule|interface|package|program|function|task)$/.test(previous)) { previous = name; continue; }
        let offset = skipSpace(code, match.index + name.length);
        if (code.slice(offset, offset + 2) === '::') references.add(name);
        else {
            if (code[offset] === '#') offset = afterBalanced(code, skipSpace(code, offset + 1), '(', ')');
            if (offset >= 0) {
                offset = skipSpace(code, offset); const instance = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(code.slice(offset));
                if (instance) {
                    offset = skipSpace(code, offset + instance[0].length);
                    while (code[offset] === '[' && offset >= 0) offset = afterBalanced(code, offset, '[', ']');
                    if (offset >= 0 && code[skipSpace(code, offset)] === '(') references.add(name);
                }
            }
        }
        previous = name;
    }
    return [...references];
}

/**
 * 从 XPR 真实成员建立树快照，仅索引本工程文件；节点不包含 VS Code 对象。
 * @param {object} parsed @param {{workspaceFiles?:string[],readFile?:Function,stat?:Function}} [options]
 * @returns {Promise<{roots:object[],issues:string[],project:string}>} 缺失成员仍显示并解释原因。
 */
async function buildProjectTree(parsed, { workspaceFiles = [], readFile = readBoundedSource, stat = fs.stat } = {}) {
    const project = parsed.path, prefix = 'project:' + keyOf(project), issues = [], texts = new Map(), units = new Map(), names = new Map();
    const members = new Map(parsed.sets.flatMap(set => set.files.map(file => [keyOf(file), file])));
    const sourceFiles = [...members.values()].filter(file => SOURCE_EXT.test(file));
    if (sourceFiles.length > MAX_INDEX_FILES) issues.push('层级预览只索引前 ' + MAX_INDEX_FILES + ' 个源码文件，文件清单仍完整');
    const failures = new Set(); let sourceBytes = 0;
    // 逐批读文件，避免每次刷新为大型工程同时打开几千个文件。
    for (let index = 0; index < Math.min(sourceFiles.length, MAX_INDEX_FILES); index += 8) {
        await Promise.all(sourceFiles.slice(index, Math.min(index + 8, MAX_INDEX_FILES)).map(async file => {
            try {
                const size = (await stat(file)).size;
                if (size > MAX_SOURCE_BYTES || sourceBytes + size > MAX_TOTAL_SOURCE_BYTES) {
                    issues.push('源码预览达到字节预算，仍保留文件清单：' + file); return;
                }
                sourceBytes += size;
                const text = await readFile(file, 'utf8');
                if (Buffer.byteLength(text, 'utf8') > size) { issues.push('源码在读取时变化，暂不预览：' + file); return; }
                texts.set(file, text);
            }
            catch (error) { failures.add(keyOf(file)); issues.push('读取成员失败：' + file + '：' + error.message); }
        }));
    }
    for (const file of sourceFiles) {
        const declared = extractDesignUnits(texts.get(file) || ''); names.set(keyOf(file), declared.map(unit => unit.name));
        for (const { name } of declared) {
            if (units.has(name) && !samePath(units.get(name), file)) { issues.push('重复设计单元 ' + name + '，层级预览采用工程清单中的首项'); continue; }
            units.set(name, file);
        }
    }
    const references = new Map();
    for (const [file, text] of texts) {
        const declarations = extractDesignUnits(text), preamble = text.slice(0, declarations[0]?.start || 0);
        for (const unit of declarations) if (samePath(units.get(unit.name), file)) references.set(unit.name, referencedUnits(preamble + text.slice(unit.start, unit.end), units));
    }
    let hierarchyNodes = 0, limitShown = false;
    const info = (id, label) => ({ id, label, icon: 'info', contextValue: 'info', children: [] });
    const category = (id, label, children, expanded = true) => ({ id, label, icon: 'folder-library', contextValue: 'category', expanded, children });
    function moduleNode(name, parent, set, allowed, ancestors = new Set(), top = false) {
        const id = parent + '/unit:' + name, file = units.get(name);
        if (hierarchyNodes >= MAX_HIERARCHY_NODES - 1 || ancestors.size >= MAX_HIERARCHY_DEPTH) {
            if (limitShown) return null;
            limitShown = true; hierarchyNodes++; return info(id, '层级预览达到上限，请用 Vivado 详细化');
        }
        hierarchyNodes++;
        if (ancestors.has(name)) return info(id, name + '（循环引用）');
        const next = new Set([...ancestors, name]);
        const children = [];
        for (const unit of references.get(name) || []) {
            if (hierarchyNodes >= MAX_HIERARCHY_NODES) break;
            if (!allowed.has(keyOf(units.get(unit)))) continue;
            const child = moduleNode(unit, id, set, allowed, next); if (child) children.push(child);
        }
        const isReference = !set.files.some(member => samePath(member, file));
        const owner = isReference ? parsed.sets.find(entry => entry.files.some(member => samePath(member, file)))?.name : set.name;
        return { id, label: name, description: path.basename(file), tooltip: file + '\n源码引用预览，实际层级以 Vivado 详细化为准',
            icon: isReference ? 'references' : top ? 'rocket' : 'symbol-module', contextValue: isReference ? 'referenceModule' : top ? 'topModule' : 'module', children,
            nodeData: { kind: 'module', file, module: name, fileset: owner, isReference, isTop: top, xpr: project } };
    }
    function fileNode(file, kind, parent, set) {
        const id = parent + '/file:' + keyOf(file), missing = failures.has(keyOf(file));
        const children = set ? (names.get(keyOf(file)) || []).map(name => ({ id: id + '/unit:' + name, label: name, icon: 'symbol-module', contextValue: name === set.top ? 'topModule' : 'module', children: [],
            nodeData: { kind: 'module', file, module: name, fileset: set.name, isTop: name === set.top, xpr: project } })) : [];
        return { id, label: path.basename(file), description: missing ? '无法读取 · ' + path.dirname(file) : path.relative(parsed.dir, path.dirname(file)) || '.',
            tooltip: file, contextValue: kind, icon: missing ? 'warning' : kind === 'orphan' ? 'diff-add' : kind === 'constraint' ? 'gauge' : kind === 'simFile' ? 'beaker' : 'file-code', children,
            nodeData: { kind, file, fileset: set?.name, xpr: project } };
    }
    const actions = [['xelab 详细化', 'zap', 'quickElaborate'], ['工程综合', 'tools', 'synthesize'], ['综合报告', 'graph', 'reportSynth'],
        ['布局布线', 'circuit-board', 'implement'], ['资源报告', 'list-tree', 'reportImplUtil'], ['时序报告', 'watch', 'reportTiming'], ['生成 Bitstream', 'package', 'bitstream']]
        .map(([label, icon, command]) => ({ id: prefix + '/action:' + command, label, icon, contextValue: 'action', command: 'svtools.vivado.tree.' + command, children: [], nodeData: { xpr: project } }));
    const children = [category(prefix + '/actions', '工程操作', actions, false)];
    for (const set of parsed.sets) {
        const id = prefix + '/set:' + set.name, kind = set.type === 'SimulationSrcs' ? 'simFile' : set.type === 'Constrs' ? 'constraint' : 'file';
        const allowed = new Set(set.files.map(keyOf));
        if (set.type === 'SimulationSrcs') for (const member of parsed.sets.filter(entry => entry.type === 'DesignSrcs').flatMap(entry => entry.files)) allowed.add(keyOf(member));
        const files = set.files.map(file => fileNode(file, kind, id, set)), contents = [];
        if (set.top) contents.push(units.has(set.top) && allowed.has(keyOf(units.get(set.top)))
            ? category(id + '/hierarchy', '层级预览 · ' + set.top, [moduleNode(set.top, id + '/hierarchy', set, allowed, new Set(), true)].filter(Boolean), false)
            : info(id + '/top-missing', '顶层 ' + set.top + ' 未在文件集中找到'));
        contents.push(...files.length ? files : [info(id + '/empty', '文件集为空，使用“加入文件”添加')]);
        const node = category(id, set.name + (set.top ? ' · top: ' + set.top : ''), contents);
        node.contextValue = 'setRoot'; node.description = set.files.length + ' 文件'; node.nodeData = { fileset: set.name, xpr: project }; children.push(node);
    }
    const unadded = [...new Set(workspaceFiles)].filter(file => !members.has(keyOf(file))).sort().map(file => fileNode(file, 'orphan', prefix + '/unadded'));
    if (unadded.length) children.push(category(prefix + '/unadded', '未加入工程', unadded, false));
    if (issues.length) children.push(category(prefix + '/issues', '工程提示 · ' + issues.length, issues.map((issue, index) => info(prefix + '/issue:' + index, issue)), false));
    return { project, issues, units, roots: [{ id: prefix, label: path.basename(project, '.xpr'), description: parsed.part || 'Vivado 工程', tooltip: project,
        icon: 'circuit-board', contextValue: 'project', expanded: true, nodeData: { file: project, xpr: project }, children }] };
}
module.exports = { buildProjectTree, referencedUnits };
