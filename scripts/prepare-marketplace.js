'use strict';
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream, constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pipeline } = require('node:stream/promises');
const { verifyPublicVsix } = require('./check-public-package');
const { ChangelogProcessor } = require('@vscode/vsce/out/package');
const buildDependency = createRequire(require.resolve('@vscode/vsce'));
const ROOT = path.resolve(__dirname, '..');
const CHANGELOG = 'extension/changelog.md';

async function sha256(file) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    return hash.digest('hex');
}

function openZip(file) {
    return new Promise((resolve, reject) => buildDependency('yauzl').open(file, { lazyEntries: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}

async function readChangelog(file) {
    const zip = await openZip(file);
    return new Promise((resolve, reject) => {
        zip.on('error', reject);
        zip.on('end', () => reject(new Error('发行归档缺少Changelog')));
        zip.on('entry', entry => {
            if (entry.fileName.toLowerCase() !== CHANGELOG) { zip.readEntry(); return; }
            if (entry.uncompressedSize > 8 * 1024 * 1024) { zip.close(); reject(new Error('Changelog超过检查预算')); return; }
            zip.openReadStream(entry, (error, stream) => {
                if (error) { zip.close(); reject(error); return; }
                const chunks = [];
                stream.on('error', reject);
                stream.on('data', chunk => chunks.push(chunk));
                stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString('utf8')); });
            });
        });
        zip.readEntry();
    });
}

/** 逐项保留发行载荷，仅同步同版本的Changelog；不重新编译或改写运行文件。 */
async function replaceChangelog(input, output, text) {
    const reader = await openZip(input), writer = new (buildDependency('yazl').ZipFile)();
    const written = pipeline(writer.outputStream, createWriteStream(output, { flags: 'wx' }));
    const copied = new Promise((resolve, reject) => {
        reader.on('error', reject);
        writer.on('error', reject);
        reader.on('end', () => { writer.end(); resolve(); });
        reader.on('entry', entry => {
            const options = { mtime: entry.getLastModDate() };
            if (entry.fileName.toLowerCase() === CHANGELOG) {
                writer.addBuffer(Buffer.from(text), entry.fileName, options); reader.readEntry(); return;
            }
            reader.openReadStream(entry, (error, stream) => {
                if (error) { reject(error); return; }
                stream.on('error', reject);
                stream.on('end', () => reader.readEntry());
                writer.addReadStream(stream, entry.fileName, options);
            });
        });
        reader.readEntry();
    });
    try { await Promise.all([copied, written]); }
    catch (error) { writer.outputStream.destroy(error); throw error; }
    finally { reader.close(); }
}

async function prepareMarketplace({ tag, sourceRoot, assetsDir, documentationRoot = ROOT }) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Marketplace发布仅接受正式版本tag');
    const source = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
    const documentation = JSON.parse(await fs.readFile(path.join(documentationRoot, 'package.json'), 'utf8'));
    if ([source, documentation].some(manifest => manifest.version !== tag.slice(1) || manifest.publisher !== 'JayceVane' || manifest.name !== 'svtools')) {
        throw new Error('tag、发行源码与当前文档的扩展身份或版本不一致');
    }
    const name = `svtools-${tag}-win32-x64.vsix`, input = path.join(assetsDir, name);
    const checksums = await fs.readFile(path.join(assetsDir, 'SHA256SUMS.txt'), 'utf8');
    const entries = checksums.split(/\r?\n/).map(line => line.match(/^([a-f\d]{64})\s+\*?(.+)$/i)).filter(match => match?.[2] === name);
    const originalSha256 = await sha256(input);
    if (entries.length !== 1 || entries[0][1].toLowerCase() !== originalSha256) throw new Error('GitHub发行附件的SHA256不匹配');
    await verifyPublicVsix(input, { sourceRoot });
    const rendered = await new ChangelogProcessor(documentation).onFile({ path: CHANGELOG, contents: await fs.readFile(path.join(documentationRoot, 'CHANGELOG.md')) });
    const changelog = rendered.contents.toString('utf8').replace(/\r\n/g, '\n');
    const changed = (await readChangelog(input)).replace(/\r\n/g, '\n') !== changelog;
    const destination = path.join(assetsDir, 'marketplace'); await fs.mkdir(destination, { recursive: true });
    const output = path.join(destination, name);
    if (changed) await replaceChangelog(input, output, changelog);
    else await fs.copyFile(input, output, constants.COPYFILE_EXCL);
    const verified = await verifyPublicVsix(output, { sourceRoot });
    const report = { tag, version: verified.version, target: 'win32-x64', files: verified.files, originalSha256, sha256: await sha256(output), updatedDocuments: changed ? ['CHANGELOG.md'] : [], vsix: path.resolve(output) };
    await fs.writeFile(path.join(destination, 'publication.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return report;
}

if (require.main === module) {
    const [tag, sourceRoot, assetsDir] = process.argv.slice(2);
    prepareMarketplace({ tag, sourceRoot, assetsDir }).then(async report => {
        if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `vsix=${report.vsix}\n`);
        console.log(JSON.stringify(report));
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { prepareMarketplace };
