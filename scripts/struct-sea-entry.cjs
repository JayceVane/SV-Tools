'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sea = require('node:sea');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { runStruct } = require('../src/cli/struct-cli');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function loadNative() {
    const bytes = new Uint8Array(sea.getAsset('parser'));
    const digest = hash(bytes);
    const parent = await fs.realpath(os.tmpdir());
    const directory = path.join(parent, 'svtools-struct-' + digest);
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if ((await fs.lstat(directory)).isSymbolicLink() || !((await fs.lstat(directory)).isDirectory()) || await fs.realpath(directory) !== directory) {
        throw new Error('原生解析器缓存路径不安全');
    }
    const file = path.join(directory, 'parser.node');
    const existing = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!existing) {
        const staging = path.join(directory, randomUUID() + '.tmp');
        try {
            await fs.writeFile(staging, bytes, { flag: 'wx', mode: 0o600 });
            // A simultaneous invocation can reuse the identical published file.
            try { await fs.rename(staging, file); }
            catch (error) { if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; }
        } finally { await fs.unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    const entry = await fs.lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== bytes.length || hash(await fs.readFile(file)) !== digest) {
        throw new Error('原生解析器缓存与 EXE 内置资产不一致：' + file);
    }
    return createRequire(process.execPath)(file);
}

runStruct(process.argv.slice(2), { version: sea.getAsset('version', 'utf8'), loadNative }).then(({ output, text, exitCode }) => {
    process.stdout.write(text || JSON.stringify(output) + '\n');
    process.exitCode = exitCode;
});
