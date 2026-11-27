'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const storage = require('../agent/storage');
const history = require('./note-history-store');
const noteAnchor = require('./note-anchor');
const { listRuns } = require('./review-runs');
const { safePath, fingerprint, json, MAX_TEXT } = require('./workflow-files');
const { MANIFEST, MAX_MANIFEST, parseReview, readReviewRun, verifiedFile } = require('./review-model');
const { readAnchors } = require('../editor/design-notes');

const HDL = /\.(v|sv|vh|svh)$/i;
const ARTIFACT_LIMIT = 7;
const relativePath = (root, file) => path.relative(root, file).split(path.sep).join('/');
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

function findDesignNote(vscode, target) {
    const uri = target instanceof vscode.Uri ? target : vscode.window.activeTextEditor?.document.uri;
    const folder = uri?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri);
    const id = folder && history.noteId(relativePath(folder.uri.fsPath, uri.fsPath));
    if (id) return { root: folder.uri.fsPath, id };
}

async function sourceText(root, file) {
    await fingerprint(root, file.path, MAX_TEXT);
    const bytes = await fs.readFile(await safePath(root, file.path));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new Error('文件与仿真运行记录不一致：' + file.path);
    }
    return bytes.toString('utf8');
}

async function preparePin(root, id, runPath) {
    const runFile = { path: runPath, sha256: (await fingerprint(root, runPath, MAX_MANIFEST)).sha256 };
    const run = await readReviewRun(root, runFile);
    const sources = new Map(), anchors = [];
    for (const file of run.inputs) {
        if (!HDL.test(file.path)) {
            await verifiedFile(root, file);
            continue;
        }
        const text = await sourceText(root, file);
        sources.set(file.path, { file, text, lines: text.split(/\r\n|\r|\n/) });
        for (const marker of readAnchors(text).markers.values()) {
            if (marker.id === id) anchors.push({ path: file.path, line: marker.line + 1, title: marker.title });
        }
    }
    const metadata = await noteAnchor.readAnchor(root, id);
    if (metadata) {
        const { path, sha256 } = await fingerprint(root, noteAnchor.anchorPath(id));
        const selected = [];
        for (const [file, value] of sources) for (const location of noteAnchor.findIn(value.text, metadata)) {
            selected.push({ ...location, path: file, title: location.name || '选区', binding: { path, sha256 } });
        }
        const withContext = selected.filter(item => item.context);
        anchors.push(...(withContext.length ? withContext : selected));
    }
    if (!anchors.length) throw new Error('运行输入中找不到此 Note 的源码锚点。');
    return { runFile, run, sources, anchors };
}

function suggestCheckLine(run, lines) {
    if (Number.isSafeInteger(run.case?.line) && run.case.line > 0 && run.case.line <= lines.length) return run.case.line;
    if (typeof run.case?.id !== 'string' || !run.case.id.trim()) return 1;
    const index = lines.findIndex(line => line.includes(run.case.id) && /\bcheck_\w+\s*\(/.test(line));
    return index >= 0 ? index + 1 : 1;
}

function appendPin(manifest, id, content, prepared, selection) {
    const { run, runFile } = prepared;
    const { anchor, testbench, line, artifacts } = selection;
    const title = history.titleOf(content, anchor.title).slice(0, 120);
    const runName = [run.simulator, run.runId].filter(item => typeof item === 'string' && item.trim()).join(' · ').trim().slice(0, 100) ||
        path.posix.basename(runFile.path).slice(0, 100);
    const caseName = typeof run.case?.id === 'string' && run.case.id.trim()
        ? run.case.id.trim().slice(0, 100) : '核对测试检查与仿真产物';
    const moduleName = path.posix.basename(anchor.path).slice(0, 100);
    const ruleId = 'pin-' + randomUUID();
    function addFile(file, label) {
        const current = manifest.files.find(item => item.path === file.path && item.sha256.toLowerCase() === file.sha256);
        if (current) return current.id;
        const fileId = 'file-' + randomUUID();
        manifest.files.push({ id: fileId, path: file.path, sha256: file.sha256, label: label.slice(0, 100) });
        return fileId;
    }
    const inputs = new Map(run.inputs.map(file => [
        file.path, addFile(file, file.path === testbench ? '测试台 · ' + file.path : file.path)
    ]));
    const runId = addFile(runFile, '仿真运行记录');
    const refs = [{ file: runId, label: '打开运行记录' }];
    for (const item of artifacts) {
        const label = path.posix.basename(item.path).slice(0, 100);
        const ref = { file: addFile(item, label), label };
        if (item.sample !== undefined) ref.sample = { at: item.sample?.at, signals: item.sample?.signals };
        else if (item.line !== undefined) ref.line = item.line;
        refs.push(ref);
    }
    const rule = {
        id: ruleId, title, module: moduleName, group: 'Note 定版',
        contract: '设计说明见定版 Note。',
        mechanism: '从 RTL 锚点核对实现。',
        stimulus: '激励与判据见测试台所选行。',
        checker: '结合运行记录和产物核对结论。',
        variants: [{ id: 'run', label: runName, inputs: [...inputs.values()], run: runId }],
        events: [{
            id: 'review', title: caseName, expected: '预期行为见定版 Note 和测试台。',
            flow: [{ label: '复核', detail: '核对实现与测试检查，再查看本次运行产物。', active: true }],
            refs: [
                { file: inputs.get(anchor.path), label: '定位 RTL 锚点', line: anchor.line },
                { file: inputs.get(testbench), label: '定位测试检查', line }
            ],
            observations: [{
                variant: 'run', status: 'pending_review', text: '结合日志和波形，核对测试检查是否触发及其结果。', refs
            }]
        }]
    };
    manifest.rules.push(rule);
    return { rule, anchorRef: { file: inputs.get(anchor.path), line: anchor.line, binding: anchor.binding } };
}

async function manifestDigest(root) {
    try { return (await fingerprint(root, MANIFEST, MAX_MANIFEST)).sha256; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function savePin(root, id, prepared, selection, checkSaved = () => {}) {
    const { anchor, testbench, line, artifacts } = selection;
    const testSource = prepared.sources.get(testbench);
    if (!prepared.anchors.includes(anchor) || !testSource || !Number.isSafeInteger(line) || line < 1 || line > testSource.lines.length
        || !artifacts.length || artifacts.length > ARTIFACT_LIMIT || artifacts.some(item => !prepared.run.artifacts.includes(item))) {
        throw new Error('定版位置或产物选择无效。');
    }
    const pinnedFiles = [prepared.runFile, ...prepared.run.inputs, ...artifacts, ...(anchor.binding ? [anchor.binding] : [])];
    if (pinnedFiles.some(file => pathKey(file.path) === MANIFEST)) {
        throw new Error('当前设计讲解清单不能作为本次定版的证据。');
    }

    const guard = await storage.directory(root, 'review');
    const lock = path.join(guard, 'manifest.lock');
    let handle;
    try { handle = await fs.open(lock, 'wx'); }
    catch (error) {
        if (error.code === 'EEXIST') throw new Error('另一个定版操作正在更新清单。');
        throw error;
    }
    try {
        checkSaved();
        const previous = await manifestDigest(root);
        const target = await safePath(root, MANIFEST, { missing: true });
        const manifest = previous === undefined
            ? { schemaVersion: 1, title: '设计讲解', files: [], rules: [] }
            : await json(root, MANIFEST, MAX_MANIFEST);
        if (previous !== undefined) parseReview(manifest);
        const content = await history.readNote(root, id);
        if (!content?.trim()) throw new Error('请保存设计笔记后再定版。');
        const { rule, anchorRef } = appendPin(manifest, id, content, prepared, selection);
        parseReview(manifest);
        if (Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n') > MAX_MANIFEST) {
            throw new Error('设计讲解清单超过大小上限。');
        }

        for (const file of pinnedFiles) await verifiedFile(root, file);
        checkSaved();
        if (await manifestDigest(root) !== previous) throw new Error('设计讲解清单已被修改，请重新定版。');

        const version = await history.record(root, id, content, 'checkpoint', '评审定版 · ' + rule.variants[0].label);
        const saved = await history.readRevision(root, id, version);
        rule.note = { id, version, sha256: saved.sha256, anchor: anchorRef };
        if (Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n') > MAX_MANIFEST) {
            throw new Error('设计讲解清单超过大小上限。已保存 Note 历史版本。');
        }
        for (const file of pinnedFiles) await verifiedFile(root, file);
        checkSaved();
        if (await manifestDigest(root) !== previous) throw new Error('设计讲解清单已被修改。已保存 Note 历史版本，请重新定版。');
        await storage.writeJson(target, manifest);
        return rule.id;
    } finally {
        await handle.close();
        await fs.unlink(lock);
    }
}

async function pinFromEditor(vscode, note) {
    const { window, workspace, Uri } = vscode;
    const { root, id } = note;
    const matches = [];
    for (const file of await listRuns(root)) {
        try { matches.push(await preparePin(root, id, file)); }
        catch { /* Stale or unrelated receipts remain available by explicit selection. */ }
        if (matches.length >= 5) break;
    }
    let prepared;
    if (matches.length) {
        const selected = await window.showQuickPick([...matches.map(item => ({ label: item.run.simulator || '仿真',
            description: item.run.entry, detail: item.runFile.path, item })), { label: '选择其他运行记录…' }],
        { title: '选择与当前 Note 对应的仿真' });
        if (!selected) return;
        prepared = selected.item;
    }
    if (!prepared) {
        const picked = await window.showOpenDialog({
        title: '选择仿真运行记录',
        defaultUri: Uri.file(root),
        openLabel: '绑定运行',
        canSelectFiles: true,
        canSelectFolders: false,
        filters: { JSON: ['json'] }
        });
        if (!picked?.length) return;
        if (picked[0].scheme !== 'file') throw new Error('请选择工程目录内的运行记录。');
        prepared = await preparePin(root, id, relativePath(root, picked[0].fsPath));
    }
    const { anchors, run, sources } = prepared;
    const anchor = anchors.length === 1 ? anchors[0] : (await window.showQuickPick(
        anchors.map(item => ({ label: item.title, description: item.path + ':' + item.line, anchor: item })),
        { title: '选择 Note 对应的 RTL 锚点', matchOnDescription: true }
    ))?.anchor;
    if (!anchor) return;
    const testbench = sources.has(run.entry) ? run.entry : await window.showQuickPick(
        [...sources.keys()], { title: '选择包含测试检查的文件' }
    );
    if (!testbench) return;
    const { lines } = sources.get(testbench);
    const line = await window.showInputBox({
        title: '确认测试检查的行号',
        prompt: testbench,
        value: String(suggestCheckLine(run, lines)),
        validateInput(value) {
            return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= lines.length
                ? undefined : '请输入文件内的行号';
        }
    });
    if (line === undefined) return;
    let artifacts = run.artifacts;
    if (artifacts.length > ARTIFACT_LIMIT) {
        const selected = await window.showQuickPick(
            artifacts.map(item => ({ label: item.path, artifact: item })),
            { canPickMany: true, title: '选择最多 7 个运行产物' }
        );
        if (!selected?.length) return;
        artifacts = selected.map(item => item.artifact);
    }
    const affected = new Set([history.notePath(id), MANIFEST, prepared.runFile.path, ...run.inputs.map(item => item.path),
        ...artifacts.map(item => item.path)].map(pathKey));
    return savePin(root, id, prepared, { anchor, testbench, line: Number(line), artifacts }, () => {
        if (workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file'
            && affected.has(pathKey(relativePath(root, document.uri.fsPath))))) {
            throw new Error('请先保存相关 Note、源码或清单中的编辑。');
        }
    });
}

module.exports = { findDesignNote, preparePin, savePin, pinFromEditor };
