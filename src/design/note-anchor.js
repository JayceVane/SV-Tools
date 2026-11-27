'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { tokenize, parseDocument } = require('../editor/completion/syntax');
const { walk } = require('../agent/context');
const { isExcludedSourcePath } = require('../workspace/source-policy');
const { relative } = require('./workflow-contract');
const { safePath, json, fingerprint, MAX_TEXT } = require('./workflow-files');
const { notePath } = require('./note-history-store');
const HDL = /\.(?:sv|v|svh|vh)$/i;
const LIMIT = 512;
const anchorPath = id => notePath(id).replace(/\.md$/, '.anchor.json');
const tokensOf = text => tokenize(text).map(token => ({ ...token, key: token.kind === 'comment' ? token.value.replace(/\s+/gu, ' ').trim() : token.value }));
const keys = tokens => tokens.map(token => token.key);

function anchorAt(file, text, start, end, symbol = false) {
    relative(file, '笔记源码');
    if (!HDL.test(file) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length) {
        throw new Error('无效的 HDL 源码选区');
    }
    let tokens = tokensOf(text);
    let first = tokens.findIndex(token => token.end > start);
    let last = tokens.findIndex(token => token.start >= end) - 1;
    if (!tokens.some(token => token.start >= end)) last = tokens.length - 1;
    let block;
    if (symbol) {
        tokens = tokens.filter(token => token.kind !== 'comment');
        block = blocks(tokens).filter(item => tokens[item.first].start <= start && tokens[item.last].end >= start).at(-1);
        if (!block) throw new Error('请将光标放在具名 begin : name 块中');
        ({ first, last } = block);
    }
    if (first < 0 || last < first || last - first >= LIMIT) throw new Error('请选中 1 至 512 个 HDL 词法单元');
    const body = keys(tokens.slice(first, last + 1));
    if (block) body[2] = null;
    return { schemaVersion: 1, path: file, kind: block ? 'block' : 'range', name: block?.name,
        body, before: keys(tokens.slice(Math.max(0, first - 6), first)), after: keys(tokens.slice(last + 1, last + 7)) };
}

function blocks(tokens) {
    const stack = [], result = [];
    for (let first = 0; first < tokens.length; first++) {
        const token = tokens[first];
        if (token.kind !== 'identifier') continue;
        if (token.key === 'begin') {
            const name = tokens[first + 1]?.key === ':' && tokens[first + 2]?.kind === 'identifier' ? tokens[first + 2].key : undefined;
            stack.push({ first, name });
        } else if (token.key === 'end' && stack.length) {
            const item = stack.pop();
            if (item.name) result.push({ ...item, last: first });
        }
    }
    return result.sort((a, b) => a.first - b.first);
}

async function readAnchor(root, id) {
    try {
        const a = await json(root, anchorPath(id), 256 * 1024);
        if (a?.schemaVersion !== 1 || !['range', 'block'].includes(a.kind) || !Array.isArray(a.body) ||
            !a.body.length || a.body.length > LIMIT || a.body.some((v, i) => typeof v !== 'string' && !(a.kind === 'block' && i === 2 && v === null)) ||
            ![a.before, a.after].every(list => Array.isArray(list) && list.length <= 6 && list.every(v => typeof v === 'string'))) {
            throw new Error('无效的笔记锚点元数据');
        }
        relative(a.path, '笔记锚点');
        return a;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function findIn(text, anchor) {
    if (anchor.kind === 'range' && !anchor.body[0].startsWith('//') && !anchor.body[0].startsWith('/*') && !text.includes(anchor.body[0])) return [];
    let tokens = tokensOf(text);
    if (anchor.kind === 'block') tokens = tokens.filter(token => token.kind !== 'comment');
    const candidates = [];
    const exact = (values, offset) => values.every((key, index) => key === null || key === tokens[offset + index]?.key);
    const add = (first, last, name) => {
        if (!exact(anchor.body, first)) return;
        const start = tokens[first].start, end = tokens[last].end;
        const context = exact(anchor.before, first - anchor.before.length) && exact(anchor.after, last + 1);
        candidates.push({ start, end, line: text.slice(0, start).split('\n').length, context, name });
    };
    if (anchor.kind === 'block') {
        const found = blocks(tokens);
        for (const item of found) if (item.last - item.first + 1 === anchor.body.length) add(item.first, item.last, item.name);
        // The label survives edits inside the block. Only consider a label-only match when its original boundary context agrees.
        if (!candidates.length) for (const item of found) {
            if (item.name !== anchor.name || !exact(anchor.before, item.first - anchor.before.length) || !exact(anchor.after, item.last + 1)) continue;
            const start = tokens[item.first].start, end = tokens[item.last].end;
            candidates.push({ start, end, line: text.slice(0, start).split('\n').length, context: true, name: item.name });
        }
    } else {
        for (let i = 0; i + anchor.body.length <= tokens.length; i++) add(i, i + anchor.body.length - 1);
    }
    return candidates;
}

async function sourceText(root, relative) {
    await fingerprint(root, relative, MAX_TEXT);
    return fs.readFile(await safePath(root, relative), 'utf8');
}

async function resolve(root, anchor, { sources, overrides = new Map(), memo = new Map() } = {}) {
    const files = sources || await walk(root, file => HDL.test(file) && !isExcludedSourcePath(file));
    const paths = new Map();
    const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
    for (const file of [anchor.path, ...files, ...overrides.keys()]) {
        const name = path.isAbsolute(file) ? path.relative(root, file).split(path.sep).join('/') : file;
        paths.set(key(name), name);
    }
    async function read(file) {
        if (overrides.has(file)) return overrides.get(file);
        if (!memo.has(file)) {
            memo.set(file, sourceText(root, file));
            if (memo.size > 128) memo.delete(memo.keys().next().value);
        }
        return memo.get(file);
    }
    const matches = [];
    for (const file of paths.values()) {
        let text;
        try { text = await read(file); }
        catch (error) { if (['ENOENT', 'SOURCE_LIMIT', 'UNSAFE_PATH'].includes(error.code)) continue; throw error; }
        for (const match of findIn(text, anchor)) matches.push({ ...match, path: file });
    }
    const contextual = matches.filter(item => item.context);
    const best = contextual.length ? contextual : matches;
    if (best.length === 1) {
        const item = best[0];
        const text = await read(item.path);
        const scopes = parseDocument(text).scopes;
        const module = scopes.find(unit => ['module', 'interface', 'package'].includes(unit.kind) && unit.start <= item.start && unit.end >= item.end)?.name;
        return { status: 'resolved', ...item, module };
    }
    return { status: best.length ? 'ambiguous' : 'stale', candidates: best.slice(0, 10).map(({ path, line }) => ({ path, line })) };
}

module.exports = { anchorAt, anchorPath, readAnchor, resolve, findIn, sourceText, HDL };
