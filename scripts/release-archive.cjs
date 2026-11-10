'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const { verifyPublicVsix } = require('./check-public-package');
const fromVsce = createRequire(require.resolve('@vscode/vsce'));
const yauzl = fromVsce('yauzl');

async function sha256(file) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

async function extract(file, destination, choose) {
    const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, strictFileNames: true },
        (error, result) => error ? reject(error) : resolve(result)));
    const seen = new Set();
    let total = 0;
    await new Promise((resolve, reject) => {
        zip.once('error', reject);
        zip.once('end', resolve);
        zip.on('entry', async entry => {
            try {
                const name = choose(entry.fileName);
                if (name) {
                    assert.ok(name.split('/').every(part => part && part !== '.' && part !== '..' && !/[:\\]/.test(part)), '归档路径无效');
                    const key = name.toLowerCase();
                    assert.ok(!seen.has(key), '重复归档路径 ' + name);
                    seen.add(key);
                    total += entry.uncompressedSize;
                    assert.ok(seen.size <= 4096 && total <= 256 * 1024 * 1024, '归档超过解包预算');
                    const output = path.join(destination, name);
                    const stream = await new Promise((resolveStream, rejectStream) => zip.openReadStream(entry,
                        (error, input) => error ? rejectStream(error) : resolveStream(input)));
                    await fsp.mkdir(path.dirname(output), { recursive: true });
                    await pipeline(stream, fs.createWriteStream(output, { flags: 'wx' }));
                }
                zip.readEntry();
            } catch (error) { zip.close(); reject(error); }
        });
        zip.readEntry();
    });
    return [...seen];
}

async function openCandidate(vsix, destination) {
    const sourceRoot = path.resolve(__dirname, '..');
    const git = args => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(git(['status', '--porcelain']), '', '请在干净的源码提交上绑定发行候选');
    const sha = await sha256(vsix);
    const { version } = await verifyPublicVsix(vsix);
    await extract(vsix, destination, name => name.startsWith('extension/') ? name.slice('extension/'.length) : null);
    assert.equal(await sha256(vsix), sha, 'VSIX 验证期间发生变化');
    const commit = git(['rev-parse', 'HEAD']);
    return { commit, version, vsixSha256: sha };
}

module.exports = { extract, openCandidate, sha256, fromVsce };
