'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const tar = require('tar-stream');
const MAX_RESOURCES_BYTES = 32 * 1024 * 1024;
const MAX_RESOURCE_ENTRIES = 8192;

/** 构建阶段只接受固定 npm 资源中的普通文件/目录，限制路径与总量。 */
async function extractResources(archive, destination) {
    const extract = tar.extract();
    let bytes = 0, entries = 0;
    extract.on('entry', (header, stream, next) => {
        const target = path.resolve(destination, header.name), relative = path.relative(destination, target);
        bytes += header.size; entries++;
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
            || bytes > MAX_RESOURCES_BYTES || entries > MAX_RESOURCE_ENTRIES || !['file', 'directory'].includes(header.type)) {
            extract.destroy(new Error('Yosys 构建资源路径、类型或容量无效')); return;
        }
        fs.mkdirSync(header.type === 'directory' ? target : path.dirname(target), { recursive: true });
        if (header.type === 'directory') { stream.resume(); stream.on('end', next); }
        else pipeline(stream, fs.createWriteStream(target)).then(next, error => extract.destroy(error));
    });
    await pipeline(fs.createReadStream(archive), extract);
}

/** 将固定版本 ELK 的运行文件和许可带入 VSIX，不在运行时依赖 node_modules。 */
async function buildCircuitAssets() {
    const root = path.resolve(__dirname, '..');
    const library = path.dirname(require.resolve('elkjs/package.json'));
    const destination = path.join(root, 'bin', 'vendor');
    fs.mkdirSync(destination, { recursive: true });
    for (const [source, target] of [['lib/elk.bundled.js', 'elk.bundled.js'], ['LICENSE.md', 'ELK-LICENSE.md']]) {
        fs.copyFileSync(path.join(library, source), path.join(destination, target));
    }
    console.log('电路布局资源：ELK ' + require('elkjs/package.json').version);
    const yosys = path.resolve(path.dirname(require.resolve('@yowasp/yosys')), '..');
    const version = JSON.parse(fs.readFileSync(path.join(yosys, 'package.json'), 'utf8')).version;
    const bundled = path.join(destination, 'yosys');
    fs.mkdirSync(path.join(bundled, 'share'), { recursive: true });
    fs.copyFileSync(path.join(yosys, 'gen/yosys.core.wasm'), path.join(bundled, 'yosys.wasm'));
    await extractResources(path.join(yosys, 'gen/yosys-resources.0.tar'), path.join(bundled, 'share'));
    fs.copyFileSync(path.join(root, 'src/circuit/licenses/yosys-NOTICES.txt'), path.join(bundled, 'THIRD-PARTY-NOTICES.txt'));
    fs.writeFileSync(path.join(bundled, 'manifest.json'), JSON.stringify({ package: '@yowasp/yosys', version,
        sha256: createHash('sha256').update(fs.readFileSync(path.join(bundled, 'yosys.wasm'))).digest('hex'),
        resourcesSha256: createHash('sha256').update(fs.readFileSync(path.join(yosys, 'gen/yosys-resources.0.tar'))).digest('hex') }, null, 2));
    console.log('内置 Yosys WASM：' + version);
}

if (require.main === module) buildCircuitAssets().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildCircuitAssets };
