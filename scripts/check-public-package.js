'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 4096, MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const LOCAL_MARKERS = /svtools\.modelsim\b|activateModelSim\b|SVTOOLS_LOCAL_ONLY|svtoolsBuildFlavor/i;

/** @param {object} manifest @returns {void} 公开构建不得使用自用版本或注册本地功能。 */
function assertPublicManifest(manifest) {
    if (!manifest || typeof manifest.version !== 'string' || /(?:^|[.-])local(?:[.-]|$)/i.test(manifest.version)
        || LOCAL_MARKERS.test(JSON.stringify(manifest))) throw new Error('公开包清单包含自用构建标识、命令或配置');
}

/** @param {string[]} files @returns {void} 同时接受构建清单和VSIX条目路径。 */
function assertPublicPaths(files) {
    if (files.length > MAX_FILES) throw new Error('公开包文件数超过4096预算，检查是否夹带缓存');
    for (const file of files) {
        const normalized = file.replace(/\\/g, '/').replace(/^extension\//i, '').toLowerCase();
        if (/^(?:src\/private|src-rust|\.local|local-private|\.zcode|\.vscode-test)(?:\/|$)/.test(normalized) || /^[^/]+\.node$/.test(normalized)) {
            throw new Error('公开包包含自用文件：' + file);
        }
    }
}

/** @param {string} root @param {string[]} files @param {{maxBytes?:number}} [options] @returns {Promise<number>} 在复制或压缩前检查普通文件及未压缩总量。 */
async function assertPublicFiles(root, files, { maxBytes = MAX_UNPACKED_BYTES } = {}) {
    assertPublicPaths(files); let total = 0;
    for (const file of files) {
        const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('公开包文件路径越界');
        const stat = await fs.lstat(absolute);
        if (!stat.isFile()) throw new Error('公开包只能包含普通文件：' + file);
        total += stat.size;
        if (total > maxBytes) throw new Error('公开包未压缩大小超出预算，检查是否夹带缓存');
    }
    return total;
}

/**
 * @param {string} file VSIX绝对或相对路径。
 * @returns {Promise<{version:string,files:number}>} 验证归档内的清单、私有路径和运行JS/本地化文本。
 */
async function verifyPublicVsix(file) {
    // 复用固定vsce构建依赖的ZIP读取器，不新增运行依赖。
    const yauzl = createRequire(require.resolve('@vscode/vsce'))('yauzl');
    const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
    return new Promise((resolve, reject) => {
        let count = 0, total = 0, manifest, settled = false;
        function fail(error) { if (!settled) { settled = true; zip.close(); reject(error); } }
        zip.on('error', fail);
        zip.on('end', () => {
            if (settled) return;
            if (!manifest) { fail(new Error('公开包缺少extension/package.json清单')); return; }
            settled = true; resolve({ version: manifest.version, files: count });
        });
        zip.on('entry', entry => {
            try { assertPublicPaths([entry.fileName]); } catch (error) { fail(error); return; }
            count++;
            total += entry.uncompressedSize;
            if (count > MAX_FILES || total > MAX_UNPACKED_BYTES) { fail(new Error('公开包归档文件数或未压缩大小超出预算')); return; }
            const name = entry.fileName.replace(/\\/g, '/');
            if (!/^extension\/(?:package(?:\.nls[^/]*)?\.json|.*\.js)$/i.test(name)) { zip.readEntry(); return; }
            if (entry.uncompressedSize > MAX_TEXT_BYTES) { fail(new Error('公开包文本超过检查预算：' + name)); return; }
            zip.openReadStream(entry, (error, stream) => {
                if (error) { fail(error); return; }
                const chunks = []; let size = 0;
                stream.on('error', fail);
                stream.on('data', chunk => { size += chunk.length; if (size > MAX_TEXT_BYTES) { stream.destroy(); fail(new Error('公开包文本读取超限')); } else chunks.push(chunk); });
                stream.on('end', () => {
                    if (settled) return;
                    try {
                        const text = Buffer.concat(chunks).toString('utf8');
                        if (LOCAL_MARKERS.test(text)) throw new Error('公开包运行文件包含自用入口：' + name);
                        if (/^extension\/package\.json$/i.test(name)) { manifest = JSON.parse(text); assertPublicManifest(manifest); }
                        zip.readEntry();
                    } catch (readError) { fail(readError); }
                });
            });
        });
        zip.readEntry();
    });
}

/** @returns {Promise<void>} 无参数检查实际打包清单；传入VSIX则检查最终归档。 */
async function main() {
    const files = process.argv.slice(2);
    if (files.length) {
        for (const file of files) console.log(JSON.stringify({ file, ...await verifyPublicVsix(file) }));
        return;
    }
    const root = path.resolve(__dirname, '..');
    assertPublicManifest(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')));
    const { listFiles, PackageManager } = require('@vscode/vsce');
    const entries = await listFiles({ cwd: root, packageManager: PackageManager.None });
    const total = await assertPublicFiles(root, entries);
    console.log('公开打包清单检查通过：' + entries.length + ' 文件，' + total + ' bytes，自用目录与入口均排除');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { assertPublicManifest, assertPublicPaths, assertPublicFiles, verifyPublicVsix };
