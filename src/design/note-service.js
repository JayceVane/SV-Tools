'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const storage = require('../agent/storage');
const history = require('./note-history-store');
const anchors = require('./note-anchor');
const { readOptions } = require('../agent/context');
const { fail, result } = require('../agent/protocol');
const { relative } = require('./workflow-contract');
const { safePath, json } = require('./workflow-files');
const { createContainedDirectories } = require('./scaffold-paths');

const metaPath = id => history.notePath(id).replace(/\.md$/, '.meta.json');
const EMPTY = undefined;
const etagOf = (content, anchor, topic) => history.digest(JSON.stringify([content, anchor, topic]));

async function meta(root, id) {
    try { return await json(root, metaPath(id), 4096); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
}

async function info(root, id, { content: includeContent = false, resolve = false } = {}) {
    const content = await history.readNote(root, id);
    if (content === EMPTY) fail('NOTE_NOT_FOUND', '找不到设计笔记：' + id);
    const anchor = await anchors.readAnchor(root, id);
    const { topic } = await meta(root, id);
    const value = { id, path: history.notePath(id), title: history.titleOf(content, id), topic,
        sha256: history.digest(content), etag: etagOf(content, anchor, topic), anchor };
    if (includeContent) value.content = content;
    if (resolve && anchor) value.location = await anchors.resolve(root, anchor);
    return value;
}

async function edit(root, id, expected, update) {
    const target = await safePath(root, history.notePath(id), { missing: true });
    const lockDir = await storage.directory(root, 'note-locks');
    const lock = path.join(lockDir, id + '.lock');
    let handle;
    try { handle = await fs.open(lock, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') fail('NOTE_BUSY', '笔记有一个正在写入的操作'); throw error; }
    try {
        const current = await history.readNote(root, id);
        const currentTag = current === EMPTY ? EMPTY : etagOf(current, await anchors.readAnchor(root, id), (await meta(root, id)).topic);
        if (currentTag !== expected) fail('NOTE_CONFLICT', '笔记已修改，请重新读取后合并修改', { id, etag: currentTag });
        const next = await update(current);
        if (typeof next.content !== 'string' || Buffer.byteLength(next.content) > 1024 * 1024) fail('INVALID_ARGUMENT', '笔记最多 1 MiB');
        if (next.anchor && Buffer.byteLength(JSON.stringify(next.anchor, null, 2)) >= 256 * 1024) fail('INVALID_ARGUMENT', '锚点元数据超过 256 KiB');
        if (next.topic !== undefined && (typeof next.topic !== 'string' || !next.topic.trim() || next.topic.length > 120)) fail('INVALID_ARGUMENT', '主题须为 1 至 120 个字符');
        await createContainedDirectories(path.dirname(target), root);
        // 检查点先存历史。编辑器外的并发保存有机会在这一步被检测。
        if (current !== EMPTY && current !== next.content) await history.record(root, id, current, 'save');
        if ((await history.readNote(root, id)) !== current) fail('NOTE_CONFLICT', '写入前笔记已修改', { id });
        if (current === EMPTY) await fs.writeFile(target, next.content, { flag: 'wx' });
        else if (current !== next.content) await storage.writeText(target, next.content);
        if (next.anchor) await storage.writeJson(await safePath(root, anchors.anchorPath(id), { missing: true }), next.anchor);
        if (next.topic !== undefined) await storage.writeJson(await safePath(root, metaPath(id), { missing: true }), { topic: next.topic.trim() });
        await history.record(root, id, next.content, 'save');
        return info(root, id);
    } finally {
        await handle.close();
        await fs.unlink(lock);
    }
}

function makeId() { return 'nt_' + randomBytes(6).toString('hex'); }
const add = (root, id, content, options = {}) => edit(root, id, EMPTY, () => ({ ...options, content }));

async function inventory(root, { topic, query } = {}) {
    const notes = await history.listNotes(root);
    const rows = [];
    const terms = String(query || '').trim().toLowerCase().split(/\s+/u).filter(Boolean);
    for (const [id, exists] of notes) {
        if (!exists) continue;
        const { content, ...row } = await info(root, id, { content: true });
        if (topic !== undefined && topic !== row.topic) continue;
        const search = [id, row.topic, row.anchor?.path, content].join('\n').toLowerCase();
        if (terms.every(term => search.includes(term))) rows.push(row);
    }
    return rows.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

async function sourceAnchor(root, input) {
    const file = relative(input.file, 'HDL 源码');
    const text = await anchors.sourceText(root, file);
    return anchors.anchorAt(file, text, input.offset, input.end === undefined ? input.offset : Number(input.end), input.symbol);
}

async function body(root, input) {
    if (input.body === undefined) return;
    const file = relative(input.body, 'Markdown 正文');
    return anchors.sourceText(root, file);
}

async function command(action, input) {
    const { options } = await readOptions(input);
    const root = options.workspace;
    const id = input.note;
    let data;
    if (action === 'list' || action === 'search') data = { notes: await inventory(root, input) };
    else if (action === 'get') data = await info(root, id, { content: true, resolve: true });
    else if (action === 'check') {
        const notes = id ? [await info(root, id)] : await inventory(root, input);
        data = { notes: await Promise.all(notes.map(async note => ({ id: note.id, ...note.anchor
            ? await anchors.resolve(root, note.anchor) : { status: 'unbound' } }))) };
        if (data.notes.some(note => ['stale', 'ambiguous'].includes(note.status))) return { ...result('note.check', data), status: 'failed' };
    } else if (action === 'add') {
        const content = await body(root, input) ?? '# ' + (input.title || '设计笔记') + '\n';
        const anchor = input.file !== undefined ? await sourceAnchor(root, input) : undefined;
        data = await add(root, id ?? makeId(), content, { topic: input.topic, anchor });
    } else if (action === 'update' || action === 'reanchor') {
        if (!/^[a-f0-9]{64}$/u.test(input.expect || '')) fail('INVALID_ARGUMENT', '写入需提供 note get 返回的 --expect etag');
        const content = await body(root, input);
        const anchor = action === 'reanchor' ? await sourceAnchor(root, input) : undefined;
        if (action === 'update' && content === undefined && input.topic === undefined) fail('INVALID_ARGUMENT', '需要 --body 或 --topic');
        data = await edit(root, id, input.expect, current => ({ content: content ?? current, anchor, topic: input.topic }));
    } else fail('INVALID_ARGUMENT', '未知的 note 命令');
    return result('note.' + action, data);
}

module.exports = { command, info, inventory, add, makeId };
