'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pipeline } = require('node:stream/promises');
const { prepareMarketplace } = require('../scripts/prepare-marketplace');
const dependency = createRequire(require.resolve('@vscode/vsce'));

async function fixture(t, { sameDocumentation = false } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-marketplace-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sourceRoot = path.join(root, 'source'), documentationRoot = path.join(root, 'docs'), assetsDir = path.join(root, 'assets');
    for (const directory of [sourceRoot, documentationRoot, assetsDir]) await fs.mkdir(directory);
    const source = JSON.parse(JSON.stringify(require('../package.json')));
    source.version = '1.2.3';
    source.devDependencies['@vscode/vsce'] = '4.0.0';
    for (const directory of [sourceRoot, documentationRoot]) await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(source));
    await fs.writeFile(path.join(sourceRoot, 'extension.js'), 'module.exports = {};\n');
    await fs.writeFile(path.join(documentationRoot, 'CHANGELOG.md'), sameDocumentation ? 'Original notes\n' : 'Updated notes #3\n');
    const entries = {
        'extension.vsixmanifest': Buffer.from('<manifest/>'),
        'extension/package.json': Buffer.from(JSON.stringify(source)),
        'extension/extension.js': Buffer.from('module.exports = {};\n'),
        'extension/bin/svtools.win32-x64-msvc.node': Buffer.from([0, 1, 2, 255]),
        'extension/readme.md': Buffer.from('User guide\n'),
        'extension/changelog.md': Buffer.from('Original notes\n')
    };
    const name = `svtools-v${source.version}-win32-x64.vsix`, file = path.join(assetsDir, name);
    const zip = new (dependency('yazl').ZipFile)();
    for (const [name, content] of Object.entries(entries)) zip.addBuffer(content, name);
    const written = pipeline(zip.outputStream, createWriteStream(file)); zip.end(); await written;
    const hash = createHash('sha256'); await pipeline(createReadStream(file), hash);
    await fs.writeFile(path.join(assetsDir, 'SHA256SUMS.txt'), hash.digest('hex') + '  ' + name + '\n');
    return { tag: 'v' + source.version, sourceRoot, documentationRoot, assetsDir, entries };
}

async function archiveEntries(file) {
    const zip = await new Promise((resolve, reject) => dependency('yauzl').open(file, { lazyEntries: true }, (error, zip) => error ? reject(error) : resolve(zip)));
    return new Promise((resolve, reject) => {
        const result = {};
        zip.on('error', reject); zip.on('end', () => resolve(result));
        zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
            if (error) { reject(error); return; }
            const chunks = []; stream.on('error', reject); stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => { result[entry.fileName] = Buffer.concat(chunks); zip.readEntry(); });
        }));
        zip.readEntry();
    });
}

test('补发只同步同版本Changelog，逐字节保留运行载荷与扩展清单', async t => {
    const fixtureData = await fixture(t), report = await prepareMarketplace(fixtureData);
    const entries = await archiveEntries(report.vsix);
    assert.deepEqual(Object.keys(entries).sort(), Object.keys(fixtureData.entries).sort());
    for (const [name, content] of Object.entries(fixtureData.entries)) {
        if (name === 'extension/changelog.md') assert.equal(entries[name].toString(), 'Updated notes [#3](https://github.com/JayceVane/SV-Tools/issues/3)\n');
        else assert.deepEqual(entries[name], content, name);
    }
    assert.notEqual(report.sha256, report.originalSha256);
    assert.deepEqual(report.updatedDocuments, ['CHANGELOG.md']);
});

test('文档一致时直接保留发行附件字节和SHA256', async t => {
    const report = await prepareMarketplace(await fixture(t, { sameDocumentation: true }));
    assert.equal(report.sha256, report.originalSha256);
    assert.deepEqual(report.updatedDocuments, []);
});

test('拒绝校验值篡改、源码漂移、版本错配及预览tag', async t => {
    const f = await fixture(t);
    await assert.rejects(prepareMarketplace({ ...f, tag: f.tag + '-preview.1' }), /正式版本/);
    await assert.rejects(prepareMarketplace({ ...f, tag: 'v0.0.0' }), /不一致/);
    await fs.writeFile(path.join(f.sourceRoot, 'extension.js'), 'module.exports = { changed: true };\n');
    await assert.rejects(prepareMarketplace(f), /运行文本/);
    await fs.writeFile(path.join(f.assetsDir, 'SHA256SUMS.txt'), '0'.repeat(64) + `  svtools-${f.tag}-win32-x64.vsix\n`);
    await assert.rejects(prepareMarketplace(f), /SHA256/);
});
