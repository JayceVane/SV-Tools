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
const { verifyMarketplace } = require('../scripts/verify-marketplace');
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

test('Open VSX 等待指定 Windows 版本公开并校验下载的字节', async () => {
    const packageData = Buffer.from('public vsix');
    const report = { version: '1.2.3', target: 'win32-x64', sha256: createHash('sha256').update(packageData).digest('hex') };
    const metadata = 'https://open-vsx.org/api/JayceVane/svtools/win32-x64/1.2.3';
    const download = metadata + '/file/JayceVane.svtools-1.2.3@win32-x64.vsix';
    const release = { namespace: 'JayceVane', name: 'svtools', version: report.version, targetPlatform: report.target, files: { download } };
    const requests = [];
    const fetchImpl = async input => {
        requests.push(String(input));
        if (requests.length === 1) return new Response(null, { status: 404 });
        return String(input) === metadata ? Response.json(release) : new Response(packageData);
    };
    const options = { store: 'open-vsx', attempts: 2, delayMs: 0, fetchImpl };
    assert.equal((await verifyMarketplace(report, options)).verified, true);
    assert.deepEqual(requests, [metadata, metadata, download]);
    await assert.rejects(verifyMarketplace({ ...report, sha256: '0'.repeat(64) }, options), /SHA256不一致/);
    release.targetPlatform = 'universal';
    await assert.rejects(verifyMarketplace(report, options), /非预期扩展、版本或目标平台/);
});

test('发行候选只容忍构建期重写的原生绑定桩，其余改动一律拒绝', () => {
    const { unexpectedChanges } = require('../scripts/release-archive.cjs');
    assert.deepEqual(unexpectedChanges(''), []);
    // CI 现场：napi build 重写两个绑定桩，porcelain 原始输出保持 XY 列。
    assert.deepEqual(unexpectedChanges(' M src/native/index.d.ts\n M src/native/index.js\n'), []);
    assert.deepEqual(unexpectedChanges('M  src/native/index.js\n'), []);
    // 关键回归：若重新引入 trim，首行前导空格被吃掉，规则失配会再现 CI 失败。
    assert.deepEqual(unexpectedChanges(' M src/native/index.d.ts\n M src/native/index.js\n'.trim()),
        ['M src/native/index.d.ts']);
    // 未跟踪产物与源码改动一律拒绝。
    assert.deepEqual(unexpectedChanges('?? bin/svtools-v4.2.0-win32-x64.vsix\n'), ['?? bin/svtools-v4.2.0-win32-x64.vsix']);
    // docs/ 与 skills/ 直接取自工作区，任何改动仍必须拒绝。
    assert.deepEqual(unexpectedChanges(' M docs/CLI.md\n M skills/svtools-agent/SKILL.md\n M src/native/index.js\n'),
        [' M docs/CLI.md', ' M skills/svtools-agent/SKILL.md']);
    // 同目录下的其它文件不享受豁免；绑定桩的删除/新增/未跟踪也不算构建期重写。
    assert.deepEqual(unexpectedChanges(' M src/native/index.mjs\n'), [' M src/native/index.mjs']);
    assert.deepEqual(unexpectedChanges(' D src/native/index.js\n'), [' D src/native/index.js']);
    assert.deepEqual(unexpectedChanges('A  src/native/index.js\n'), ['A  src/native/index.js']);
    assert.deepEqual(unexpectedChanges('?? src/native/index.js\n'), ['?? src/native/index.js']);
});
