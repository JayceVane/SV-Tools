'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const notes = require('./note-service');
const history = require('./note-history-store');
const anchors = require('./note-anchor');
const file = require('./workflow-files');
const { relative } = require('./workflow-contract');
const { createContainedDirectories } = require('./scaffold-paths');
const { fail } = require('../agent/protocol');

const KIND = 'svtools-note-export';
const MAX_MANIFEST = 2 * 1024 * 1024;
const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const MarkdownIt = () => {
    try { const bundled = require('../../bin/vendor/note-markdown.cjs'); return bundled.default || bundled; }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return require('markdown-it'); }
};

async function reviewedEvidence(root, selected) {
    const review = require('./review-model');
    let loaded;
    try { loaded = await review.loadReview(root); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const selectedById = new Map(selected.map(note => [note.id, note]));
    const latest = new Map();
    for (const rule of loaded.snapshot.rules) if (selectedById.has(rule.note?.id)) latest.set(rule.note.id, rule);
    if (!latest.size) return [];
    const refs = new Map();
    for (const rule of latest.values()) {
        const frozen = loaded.notes.get(rule.note.token);
        if (frozen.sha256 !== selectedById.get(frozen.id).sha256) fail('EVIDENCE_STALE', '笔记在绑定仿真后已修改：' + frozen.id);
        if (frozen.binding) refs.set(frozen.binding.path, frozen.binding);
        for (const event of rule.events) for (const item of event.evidence) {
            const record = loaded.observations.get(item.token);
            const observation = await review.revealObservation(root, record);
            if (observation.status === 'unavailable') fail('EVIDENCE_STALE', '笔记关联的运行证据已变化', { issues: observation.issues });
            for (const entry of record.files) {
                const previous = refs.get(entry.path);
                if (previous && previous.sha256 !== entry.sha256) fail('EVIDENCE_STALE', '定版中存在两个版本的同一文件：' + entry.path);
                refs.set(entry.path, { path: entry.path, sha256: entry.sha256 });
            }
        }
    }
    return [...refs.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function html(title, content) {
    const render = new (MarkdownIt())({ html: false, linkify: false });
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
        `<title>${escape(title)}</title><style>
        body{max-width:900px;margin:32px auto;padding:0 24px;font:15px/1.65 system-ui,sans-serif;color:#161b24}
        pre{background:#f3f5f7;padding:12px;white-space:pre-wrap}code{overflow-wrap:anywhere}
        table{border-collapse:collapse}th,td{border:1px solid #c5cbd3;padding:4px 10px}a{color:#16518e}
        @media print{body{margin:0;color:#000}h1,h2,h3{break-after:avoid}tr,pre{break-inside:avoid}}</style><main>` +
        render.render(content) + '</main></html>\n';
}

async function printPdf(directory, browser, basename = 'notes') {
    const candidates = [browser, process.env.SVTOOLS_PDF_BROWSER,
        ...[process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map(dir => path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))].filter(Boolean);
    let executable;
    for (const item of candidates) {
        if ((await fs.stat(item).catch(() => null))?.isFile()) { executable = item; break; }
    }
    if (!executable) fail('TOOL_NOT_FOUND', '找不到用于 PDF 导出的 Edge/Chromium，请提供 --browser');
    const temp = await fs.realpath(os.tmpdir());
    const profile = await fs.mkdtemp(path.join(temp, 'svtools-note-print-'));
    const target = path.join(directory, basename + '.pdf');
    try {
        const run = await promisify(execFile)(executable, ['--headless', '--disable-gpu', '--disable-background-networking', '--no-pdf-header-footer', '--no-first-run',
            '--user-data-dir=' + profile, '--print-to-pdf=' + target, pathToFileURL(path.join(directory, basename + '.html')).href],
        { windowsHide: true, timeout: 60_000 });
        for (let attempt = 0; attempt < 100; attempt++) {
            const bytes = await fs.readFile(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
            if (bytes?.subarray(0, 5).toString('ascii') === '%PDF-' && bytes.subarray(-1024).includes('%%EOF')) return;
            await delay(100);
        }
        fail('PDF_FAILED', '浏览器未生成完整的 PDF', { detail: run.stderr.slice(-800) });
    } finally {
        // Browser child processes can briefly keep their profile open after printing.
        const safe = await fs.realpath(profile).catch(() => null);
        if (safe && path.dirname(safe) === temp && path.basename(safe).startsWith('svtools-note-print-')) {
            await fs.rm(safe, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
        }
    }
}

async function inspectExport(root, manifest) {
    if (manifest?.schemaVersion !== 1 || manifest.kind !== KIND || manifest.final !== true || !Array.isArray(manifest.notes) ||
        !manifest.notes.length || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || !Array.isArray(manifest.evidence)) {
        fail('EVIDENCE_INVALID', '需要定版 Note 导出清单');
    }
    for (const ref of [...manifest.notes, ...manifest.artifacts, ...manifest.evidence]) {
        if (!/^[a-f0-9]{64}$/u.test(ref?.sha256 || '')) fail('EVIDENCE_INVALID', '定版清单缺少 SHA-256');
        let current;
        try { current = await file.fingerprint(root, relative(ref.path, '定版文件'), file.MAX_ARTIFACT); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current?.sha256 !== ref.sha256) fail('EVIDENCE_STALE', '定版文件已变化：' + ref.path);
    }
    for (const note of manifest.notes) {
        const pinned = await history.readRevision(root, note.id, note.revision);
        if (pinned.sha256 !== note.sha256 || history.notePath(note.id) !== note.path) fail('EVIDENCE_STALE', '定版笔记身份不一致：' + note.id);
        const metadata = await anchors.readAnchor(root, note.id);
        if (metadata) {
            const resolved = await anchors.resolve(root, metadata);
            if (resolved.status !== 'resolved' || resolved.path !== note.anchor?.path || resolved.line !== note.anchor?.line ||
                (await file.fingerprint(root, anchors.anchorPath(note.id))).sha256 !== note.anchor.metadata) {
                fail('EVIDENCE_STALE', '定版笔记的源码锚点已变化：' + note.id);
            }
        } else if (note.anchor) fail('EVIDENCE_STALE', '定版笔记的源码锚点已删除：' + note.id);
    }
    return manifest;
}

async function exportNotes(root, options = {}) {
    const { note, topic, final = false } = options;
    const title = options.title || topic || '设计笔记';
    const format = options.imageFormat || 'html';
    if (!['md', 'html', 'pdf'].includes(format) || typeof title !== 'string' || !title.trim() || title.length > 120) fail('INVALID_ARGUMENT', '支持 md、html 或 pdf，标题最多 120 字符');
    const selected = note ? [await notes.info(root, note, { content: true })] : await notes.inventory(root, { topic });
    if (!selected.length || selected.length > 64) fail('INVALID_ARGUMENT', '一次导出须选中 1 至 64 篇笔记');
    const snapshots = [];
    let publishedBytes = 0;
    for (const entry of selected) {
        const content = entry.content ?? await history.readNote(root, entry.id);
        if (history.digest(content ?? '') !== entry.sha256) fail('NOTE_CONFLICT', '导出期间笔记已修改：' + entry.id);
        publishedBytes += Buffer.byteLength(content);
        if (publishedBytes > 8 * 1024 * 1024) fail('SOURCE_LIMIT', '导出正文超过 8 MiB');
        let location;
        if (entry.anchor) {
            location = await anchors.resolve(root, entry.anchor);
            if (final && location.status !== 'resolved') fail('EVIDENCE_STALE', '有笔记锚点仍待重定位：' + entry.id);
        }
        snapshots.push({ ...entry, content, location });
    }
    const evidence = final ? await reviewedEvidence(root, snapshots) : [];
    const stamped = [];
    for (const entry of snapshots) {
        const record = { id: entry.id, path: entry.path, sha256: entry.sha256 };
        if (final) record.revision = await history.record(root, entry.id, entry.content, 'save');
        if (entry.location?.status === 'resolved') {
            record.anchor = { path: entry.location.path, line: entry.location.line, metadata: (await file.fingerprint(root, anchors.anchorPath(entry.id))).sha256 };
            if (final && !evidence.some(item => item.path === record.anchor.path)) {
                const { path, sha256 } = await file.fingerprint(root, record.anchor.path);
                evidence.push({ path, sha256 });
            }
        }
        stamped.push(record);
    }
    const heading = title.replace(/[\r\n]/gu, ' ');
    const content = '# ' + heading + '\n\n' + snapshots.map(entry => {
        const ref = entry.location?.status === 'resolved' ? `> 源码位置 ${entry.location.path}:${entry.location.line}\n\n` : '';
        return ref + entry.content.replace(/(?:\r?\n)+$/u, '');
    }).join('\n\n---\n\n') + '\n';
    const output = relative(options.out || 'docs/design-note-export', '输出目录');
    const destination = await file.safePath(root, output, { missing: true });
    await createContainedDirectories(path.dirname(destination), root);
    try { await fs.mkdir(destination); }
    catch (error) { if (error.code === 'EEXIST') fail('EXPORT_EXISTS', '输出目录已存在：' + output); throw error; }
    const written = [];
    try {
        await fs.writeFile(path.join(destination, 'notes.md'), content, { flag: 'wx' });
        written.push('notes.md');
        if (format !== 'md') {
            await fs.writeFile(path.join(destination, 'notes.html'), html(title, content), { flag: 'wx' });
            written.push('notes.html');
        }
        if (format === 'pdf') { written.push('notes.pdf'); await printPdf(destination, options.browser); }
        const artifacts = [];
        for (const name of written) {
            const { path, sha256 } = await file.fingerprint(root, output + '/' + name, file.MAX_ARTIFACT);
            artifacts.push({ path, sha256 });
        }
        const manifest = { schemaVersion: 1, kind: KIND, final, title, topic, module: options.module, notes: stamped, artifacts, evidence };
        if (final) await inspectExport(root, manifest);
        const manifestText = JSON.stringify(manifest, null, 2) + '\n';
        if (Buffer.byteLength(manifestText) > MAX_MANIFEST) fail('SOURCE_LIMIT', '导出清单超过 2 MiB');
        await fs.writeFile(path.join(destination, 'manifest.json'), manifestText, { flag: 'wx' });
        return { manifest: output + '/manifest.json', ...manifest };
    } catch (error) {
        for (const name of written) await fs.unlink(path.join(destination, name)).catch(() => {});
        await fs.rmdir(destination).catch(() => {});
        throw error;
    }
}

module.exports = { exportNotes, inspectExport, printPdf, KIND, MAX_MANIFEST };
