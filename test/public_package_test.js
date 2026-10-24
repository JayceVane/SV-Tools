'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { assertPublicManifest, assertPublicPaths, assertPublicFiles, verifyPublicVsix } = require('../scripts/check-public-package');
const buildDependency = createRequire(require.resolve('@vscode/vsce'));

test('公开清单拒绝自用版本、构建标识及专用命令或配置', () => {
    assert.doesNotThrow(() => assertPublicManifest({ version: '4.0.0', contributes: {} }));
    for (const manifest of [
        { version: '4.0.1-local.1' }, { version: '4.0.0', svtoolsBuildFlavor: 'local' },
        { version: '4.0.0', contributes: { commands: [{ command: 'svtools.modelsim.simulate' }] } },
        { version: '4.0.0', contributes: { configuration: { properties: { 'svtools.modelsim.path': {} } } } }
    ]) assert.throws(() => assertPublicManifest(manifest), /公开包/);
});

test('公开文件表拒绝私有目录，兼容归档前缀、大小写和Windows路径', () => {
    assert.doesNotThrow(() => assertPublicPaths(['extension.js', 'src/toolchains/job.js', 'bin/vendor/yosys/yosys.wasm']));
    for (const file of ['src/private/tool.js', 'extension/SRC/PRIVATE/tool.js', 'src\\private\\tool.js', 'extension/.local/entry.js', 'src-rust/target/old.obj', 'svtools.win32-x64-msvc.node']) {
        assert.throws(() => assertPublicPaths([file]), /公开包/);
    }
    assert.throws(() => assertPublicPaths(Array(4097).fill('extension.js')), /预算/);
});

test('复制和压缩前限制未压缩体积，防止旧缓存进入staging', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-package-budget-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'sample.js'), 'abc');
    assert.equal(await assertPublicFiles(root, ['sample.js'], { maxBytes: 3 }), 3);
    await assert.rejects(assertPublicFiles(root, ['sample.js'], { maxBytes: 2 }), /预算/);
    await assert.rejects(assertPublicFiles(root, ['../outside.js']), /越界/);
});

async function archive(t, entries) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-public-package-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'candidate.vsix');
    const zip = new (buildDependency('yazl').ZipFile)();
    for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name);
    const { createWriteStream } = require('node:fs');
    const { pipeline } = require('node:stream/promises');
    const done = pipeline(zip.outputStream, createWriteStream(file)); zip.end(); await done;
    return file;
}

test('检查实际VSIX内容，不只依赖编辑器菜单是否隐藏', async t => {
    const normal = { 'extension/package.json': '{"version":"4.0.0"}', 'extension/extension.js': 'module.exports = {};' };
    const result = await verifyPublicVsix(await archive(t, normal));
    assert.equal(result.version, '4.0.0'); assert.equal(result.files, 2);
    for (const extra of [
        { 'extension/src/private/adapter.js': 'module.exports = {};' },
        { 'extension/extension.js': 'require("./src/private/entry"); // SVTOOLS_LOCAL_ONLY' },
        { 'extension/package.json': '{"version":"4.0.0","contributes":{"commands":[{"command":"svtools.modelsim.simulate"}]}}' }
    ]) await assert.rejects(verifyPublicVsix(await archive(t, { ...normal, ...extra })), /公开包/);
});

test('损坏或缺少清单的归档明确失败', async t => {
    await assert.rejects(verifyPublicVsix(await archive(t, { 'extension/entry.js': 'ok' })), /清单/);
    const file = await archive(t, { 'extension/package.json': '{"version":"4.0.0"}' });
    await fs.writeFile(file, 'invalid zip');
    await assert.rejects(verifyPublicVsix(file));
});
