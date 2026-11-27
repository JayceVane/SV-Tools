'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const storage = require('../agent/storage');
const { safePath } = require('./workflow-files');
const { NOTE_DIRECTORY, NOTE_KEY } = require('../editor/design-notes');

const HISTORY = '.svtools/agent/note-history';
const REVISION_SCHEME = 'svtools-note-revision';
const NOTE_FILE = new RegExp('^(' + NOTE_KEY + ')\\.svnote\\.md(?![\\s\\S])');
const NOTE_ID = new RegExp('^' + NOTE_KEY + '(?![\\s\\S])');
const REVISION = /^\d{13}-[a-f0-9]{16}(?![\s\S])/;
const KINDS = new Set(['save', 'checkpoint', 'restore-backup']);
const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

const digest = content => createHash('sha256').update(content).digest('hex');
const titleOf = (content, fallback) => /^#[ \t]+(.+)$/m.exec(content)?.[1].trim() || fallback;

function noteId(relative) {
    const directory = NOTE_DIRECTORY + '/';
    if (relative.startsWith(directory)) return NOTE_FILE.exec(relative.slice(directory.length))?.[1];
}

function notePath(id) {
    if (typeof id !== 'string' || !NOTE_ID.test(id)) throw new Error('无效的笔记 ID');
    return NOTE_DIRECTORY + '/' + id + '.svnote.md';
}

function historyPath(id, revision) {
    notePath(id);
    if (revision === undefined) return HISTORY + '/' + id;
    if (!REVISION.test(revision)) throw new Error('无效的历史版本 ID');
    return HISTORY + '/' + id + '/' + revision + '.json';
}

function revisionUri(vscode, workspaceUri, id, version) {
    historyPath(id, version);
    return vscode.Uri.from({
        scheme: REVISION_SCHEME, path: '/' + id + '/' + version + '.md', query: workspaceUri.toString()
    });
}

async function entries(root, relative) {
    try {
        return await fs.readdir(await safePath(root, relative), { withFileTypes: true });
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return [];
    }
}

async function listNotes(root) {
    const [documents, archives] = await Promise.all([entries(root, NOTE_DIRECTORY), entries(root, HISTORY)]);
    const notes = new Map();
    for (const entry of archives) if (entry.isDirectory() && NOTE_ID.test(entry.name)) notes.set(entry.name, false);
    for (const entry of documents) {
        const id = NOTE_FILE.exec(entry.name)?.[1];
        if (entry.isFile() && id) notes.set(id, true);
    }
    return notes;
}

async function readNote(root, id) {
    try {
        const filename = await safePath(root, notePath(id));
        const handle = await fs.open(filename, 'r');
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) throw new Error('笔记须为不超过 1 MiB 的普通 Markdown 文件');
            const buffer = Buffer.alloc(stat.size + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead !== stat.size) throw new Error('读取期间笔记已变化，请重试');
            return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function revisionIds(root, id) {
    return (await entries(root, historyPath(id)))
        .filter(entry => entry.isFile() && entry.name.endsWith('.json') && REVISION.test(entry.name.slice(0, -5)))
        .map(entry => entry.name.slice(0, -5)).sort().reverse();
}

async function readRevision(root, id, version) {
    const file = await safePath(root, historyPath(id, version));
    const data = await storage.readJson(file, MAX_RECORD_BYTES);
    if (data.schemaVersion !== 1 || data.noteId !== id || data.version !== version || !KINDS.has(data.kind)
        || typeof data.time !== 'number' || !Number.isFinite(data.time)
        || typeof data.content !== 'string' || typeof data.label !== 'string'
        || typeof data.title !== 'string' || data.sha256 !== digest(data.content)) {
        throw new Error('笔记历史版本校验失败：' + version);
    }
    return data;
}

async function listRevisions(root, id) {
    const revisions = [], invalid = [];
    for (const version of await revisionIds(root, id)) {
        try {
            const { content, ...entry } = await readRevision(root, id, version);
            revisions.push(entry);
        } catch (error) {
            invalid.push({ version, message: error.message });
        }
    }
    return { revisions, invalid };
}

async function newestRevision(root, id) {
    for (const version of await revisionIds(root, id)) {
        try { return await readRevision(root, id, version); }
        catch (error) { if (error.code === 'EACCES' || error.code === 'EPERM') throw error; }
    }
}

async function record(root, id, content, kind, label = '') {
    notePath(id);
    if (!KINDS.has(kind) || typeof content !== 'string' || Buffer.byteLength(content) > MAX_NOTE_BYTES) {
        throw new Error('无效的历史版本或笔记超过 1 MiB。');
    }
    const sha256 = digest(content);
    const latest = kind === 'save' ? await newestRevision(root, id) : undefined;
    if (latest?.sha256 === sha256) return latest.version;
    const directory = await storage.directory(root, 'note-history', id);
    // Sort in write order even when two checkpoints have the same clock tick.
    const [last] = await revisionIds(root, id);
    const time = Date.now();
    const version = Math.max(time, last ? Number(last.slice(0, 13)) + 1 : 0) + '-' + randomBytes(8).toString('hex');
    await storage.writeJson(path.join(directory, version + '.json'), {
        schemaVersion: 1, noteId: id, version, time, kind, label, title: titleOf(content, id), sha256, content
    });
    return version;
}

module.exports = { noteId, notePath, listNotes, readNote, listRevisions, readRevision, newestRevision, record, titleOf, digest,
    REVISION_SCHEME, revisionUri };
