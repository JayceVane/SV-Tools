'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** 在独立 Node 进程执行固定 WASM；任务层负责超时和进程树取消。 */
async function main(configPath) {
    const { WASI } = require('node:wasi');
    const assets = path.resolve(__dirname, '../../bin/vendor/yosys');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!Array.isArray(config.args) || config.args.length > 8192
        || config.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
        || !config.preopens || Array.isArray(config.preopens) || Object.keys(config.preopens).length > 10000) {
        throw new Error('内置 Yosys 启动配置无效');
    }
    for (const [guest, host] of Object.entries(config.preopens)) {
        if (!guest.startsWith('/') || typeof host !== 'string' || !path.isAbsolute(host)) throw new Error('内置 Yosys 路径映射无效');
    }
    const bytes = await fs.readFile(path.join(assets, 'yosys.wasm'));
    const manifest = JSON.parse(await fs.readFile(path.join(assets, 'manifest.json'), 'utf8'));
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('内置 Yosys 资源校验失败，请重新安装插件');
    const wasi = new WASI({ version: 'preview1', returnOnExit: true, args: config.args,
        env: { YOSYS_DATDIR: '/share', PWD: '/' },
        preopens: { '/share': path.join(assets, 'share'), ...config.preopens } });
    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
    process.exitCode = wasi.start(instance);
}

if (require.main === module) main(process.argv[2]).catch(error => { console.error('内置 Yosys：' + error.message); process.exitCode = 1; });
module.exports = { main };
