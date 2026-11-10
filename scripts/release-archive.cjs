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

// `napi build --platform --release`（Release 工作流的「构建原生模块」步骤）会重写 napi
// 生成的绑定桩 src/native/index.js 与 index.d.ts；Windows runner 的生成环境与仓库提交
// 存在差异时，这两个文件会相对 HEAD 显示为已修改。它们是 napi crate 的构建脚手架：
// .vscodeignore 排除整个 src/native/，公开包路径白名单也只放行 src/native-loader.js，
// 随包发布的是 bin/*.node，因此它们的漂移不影响任何已发布产物。
// 只豁免「修改」态：删除、新增、重命名与未跟踪仍按源码污染拒绝。
const GENERATED_BINDINGS = /^(?: M|M |MM) src\/native\/index\.(?:js|d\.ts)$/;

/**
 * 过滤构建期派生文件，返回不允许出现在发行候选工作区里的改动行。
 * @param {string} statusText `git status --porcelain` 的原始输出；不得预先 trim——
 *   porcelain 的 XY 列是前导空格，trim 会吃掉首行状态位使规则失配。
 * @returns {string[]} 非生成文件的改动行。
 */
function unexpectedChanges(statusText) {
    return statusText.split('\n').filter(line => line && !GENERATED_BINDINGS.test(line));
}

async function openCandidate(vsix, destination) {
    const sourceRoot = path.resolve(__dirname, '..');
    // gitLine 只用于取回单行值；porcelain 输出必须用原始读取，不能 trim。
    const gitLine = args => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true });
    const unexpected = unexpectedChanges(status);
    assert.deepEqual(unexpected, [], '请在干净的源码提交上绑定发行候选：' + unexpected.join(' | '));
    const sha = await sha256(vsix);
    const { version } = await verifyPublicVsix(vsix);
    await extract(vsix, destination, name => name.startsWith('extension/') ? name.slice('extension/'.length) : null);
    assert.equal(await sha256(vsix), sha, 'VSIX 验证期间发生变化');
    const commit = gitLine(['rev-parse', 'HEAD']);
    return { commit, version, vsixSha256: sha };
}

module.exports = { extract, openCandidate, sha256, fromVsce, unexpectedChanges };
