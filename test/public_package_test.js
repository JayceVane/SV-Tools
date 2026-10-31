'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { assertPublicManifest, assertPublicPaths, assertPublicFiles, verifyPublicVsix } = require('../scripts/check-public-package');
const buildDependency = createRequire(require.resolve('@vscode/vsce'));
const manifest = require('../package.json');
const copyManifest = () => JSON.parse(JSON.stringify(manifest));

test('发行清单拒绝版本、入口、命令、配置和额外元数据偏差', () => {
    assert.doesNotThrow(() => assertPublicManifest(copyManifest()));
    for (const change of [
        value => { value.version = '0.0.0'; },
        value => { value.main = './alternate.js'; },
        value => { value.buildVariant = 'experimental'; },
        value => { value.contributes.commands.push({ command: 'example.simulate' }); },
        value => { value.contributes.configuration = { properties: { 'example.path': {} } }; }
    ]) {
        const value = copyManifest(); change(value);
        assert.throws(() => assertPublicManifest(value), /公开包/);
    }
});

test('发行文件表拒绝未声明路径，兼容归档前缀、大小写和Windows路径', () => {
    assert.doesNotThrow(() => assertPublicPaths(['extension.js', 'src/toolchains/job.js', 'bin/vendor/yosys/yosys.wasm']));
    assert.doesNotThrow(() => assertPublicPaths(['extension/SRC/EDITOR/formatting.js', 'src\\editor\\formatting.js']));
    for (const file of ['src/experimental/tool.js', 'extension/SRC/EXPERIMENTAL/tool.js', 'src\\experimental\\tool.js', 'extension/.cache/entry.js', 'src-rust/target/old.obj', 'svtools.win32-x64-msvc.node', 'extension/.ZCODE/plans/session.md', '.vscode-test/profile/cache.json']) {
        assert.throws(() => assertPublicPaths([file]), /公开包/);
    }
    assert.throws(() => assertPublicPaths(Array(4097).fill('extension.js')), /预算/);
});

test('复制和压缩前限制未压缩体积，防止旧缓存进入staging', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-package-budget-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'extension.js'), 'abc');
    assert.equal(await assertPublicFiles(root, ['extension.js'], { maxBytes: 3 }), 3);
    await assert.rejects(assertPublicFiles(root, ['extension.js'], { maxBytes: 2 }), /预算/);
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

test('实际VSIX逐项对照清单和入口，而非只检查菜单', async t => {
    const normal = { 'extension.vsixmanifest': '<manifest/>', '[Content_Types].xml': '<Types/>', 'extension/package.json': JSON.stringify(manifest), 'extension/extension.js': await fs.readFile(path.join(__dirname, '../extension.js'), 'utf8') };
    const result = await verifyPublicVsix(await archive(t, normal));
    assert.equal(result.version, manifest.version); assert.equal(result.files, 4);
    for (const extra of [
        { 'extension/src/experimental/adapter.js': 'module.exports = {};' },
        { 'extension.js': 'module.exports = {};' },
        { 'extension/.zcode/plans/session.md': 'local session' },
        { 'extension/.vscode-test/profile/settings.json': '{}' },
        { 'extension/extension.js': 'require("./src/editor/alternate");' },
        { 'extension/package.nls.json': '{"example":"unexpected translation"}' },
        { 'extension/Extension.js': normal['extension/extension.js'] },
        { 'extension/package.json': JSON.stringify({ ...manifest, main: './alternate.js' }) }
    ]) await assert.rejects(verifyPublicVsix(await archive(t, { ...normal, ...extra })), /公开包/);
});

test('损坏或缺少清单的归档明确失败', async t => {
    await assert.rejects(verifyPublicVsix(await archive(t, { 'extension/icon.png': 'placeholder' })), /清单/);
    const file = await archive(t, { 'extension/package.json': '{"version":"4.0.0"}' });
    await fs.writeFile(file, 'invalid zip');
    await assert.rejects(verifyPublicVsix(file));
});
