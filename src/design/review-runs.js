'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { directory, writeJson } = require('../agent/storage');
const { walk } = require('../agent/context');
const { fingerprint, safePath, MAX_TEXT, MAX_ARTIFACT, unchanged } = require('./workflow-files');
const HDL = /\.(?:v|sv|vh|svh)$/i;
const SUBDIR = '.svtools/agent/review-runs';
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

/** Before compilation, hash only inputs that could be identified as coming from this workspace. */
async function captureInputs(root, files) {
    const found = [...new Set([...files, ...await walk(root, file => HDL.test(file))])];
    const snapshot = new Map();
    let total = 0;
    for (const name of found) {
        const file = relative(root, name);
        if (file === '..' || file.startsWith('../') || path.isAbsolute(file)) continue;
        const item = await fingerprint(root, file, MAX_TEXT);
        total += item.bytes;
        if (total > 64 * 1024 * 1024) throw new Error('工程的 HDL 快照超过 64 MiB');
        snapshot.set(file, { path: file, sha256: item.sha256 });
    }
    return snapshot;
}

async function saveIcarusRun({ root, prep, snapshot, dependencies, files, waves, logs, command }) {
    const identity = await fs.readFile(dependencies, 'utf8');
    const paths = new Set([...files.map(file => relative(root, file))]);
    for (const line of identity.split(/\r?\n/).filter(Boolean)) {
        if (!/^[IM] .+/u.test(line)) throw new Error('Icarus 依赖列表格式无效');
        paths.add(relative(root, path.resolve(prep.fileDir, line.slice(2))));
    }
    if (!identity.trim()) throw new Error('Icarus 未报告编译输入');
    const inputs = [...paths].map(file => snapshot.get(file));
    if (inputs.some(file => !file) || inputs.length > 48 || !await unchanged(root, inputs)) throw new Error('编译输入不存在于运行前快照、已变化或超过预算');
    for (const input of inputs) {
        const text = await fs.readFile(await safePath(root, input.path), 'utf8');
        if (/\$(?:readmem[bh]|fopen)\s*\(/ui.test(text)) throw new Error('需要为运行期外部文件补充输入身份');
    }
    const artifacts = [];
    for (const item of [...new Set([...logs, ...waves].filter(Boolean))]) {
        const ref = await fingerprint(root, relative(root, item), MAX_ARTIFACT);
        artifacts.push({ path: ref.path, sha256: ref.sha256 });
    }
    if (!artifacts.length || artifacts.length > 80 || !await unchanged(root, inputs)) throw new Error('仿真产物缺失或编译输入已变化');
    const runId = randomUUID();
    const target = await directory(root, 'review-runs');
    const name = Date.now() + '-' + runId + '.json';
    await writeJson(path.join(target, name), { schemaVersion: 1, runId, simulator: prep.toolchain.version || 'Icarus Verilog',
        entry: relative(root, prep.filePath), top: prep.waveformOptions.top, command, inputs, artifacts });
    return SUBDIR + '/' + name;
}

async function listRuns(root) {
    let entries;
    try { entries = await fs.readdir(await safePath(root, SUBDIR), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return entries.filter(entry => entry.isFile() && /^\d{13}-[\da-f-]{36}\.json$/iu.test(entry.name))
        .map(entry => `${SUBDIR}/${entry.name}`).sort().reverse().slice(0, 20);
}

module.exports = { captureInputs, saveIcarusRun, listRuns };
