'use strict';
// 每个预览号只创建一次产物；manifest将安装包和CLI绑定到干净的源码提交。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function run(command, args, inherit = false) {
    const result = spawnSync(command, args, { cwd: root, windowsHide: true, stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || command + ' exit ' + result.status);
    return result.stdout?.trim();
}
function main() {
    const read = file => fs.readFileSync(path.join(root, file), 'utf8');
    const version = JSON.parse(read('package.json')).version;
    if (!/^\d+\.\d+\.\d+-(?:beta|preview)\.\d+$/.test(version)) throw new Error('此入口仅用于带独立预览号的版本');
    const versions = ['package-lock.json','src/native/package.json','src/native/package-lock.json'].map(file => JSON.parse(read(file)).version);
    versions.push(...['src/native/Cargo.toml','src/native/Cargo.lock'].map(file => read(file).match(file.endsWith('lock')
        ? /name = "svtools"\r?\nversion = "([^"]+)"/ : /^version = "([^"]+)"/m)?.[1]));
    if (versions.some(value => value !== version)) throw new Error('JS、Rust与锁文件版本不一致');
    const target = 'win32-x64';
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前预览交付入口仅构建Windows x64');
    const stem = `svtools-${version}-${target}`, archive = path.join(root,'bin',stem+'.vsix'), manifest = path.join(root,'bin',stem+'.manifest.json');
    if (fs.existsSync(archive) || fs.existsSync(manifest)) throw new Error('该预览号已存在产物；请使用下一个版本号，禁止覆盖：'+stem);
    const cli = path.join(root,'bin/svtools.exe');
    if (run(cli,['--version']) !== 'svtools '+version) throw new Error('CLI版本不匹配，请先构建当前原生版本');
    if (process.argv.includes('--check')) { console.log('预览版本与原生CLI一致：'+version); return; }
    if (run('git',['status','--porcelain','--untracked-files=normal'])) throw new Error('请先提交源码、验证脚本与发布说明，再生成可追溯安装包');
    const sourceCommit=run('git',['rev-parse','HEAD']);
    run(process.execPath,[path.join(root,'node_modules/@vscode/vsce/vsce'),'package','--target',target,'--out',archive],true);
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const artifacts = [archive,cli,path.join(root,'bin/svtools.win32-x64-msvc.node')].map(file=>({file:path.basename(file),bytes:fs.statSync(file).size,sha256:hash(file)}));
    const report={version,target,sourceCommit,sourceTreeClean:true,createdUtc:new Date().toISOString(),node:process.version,artifacts};
    fs.writeFileSync(manifest,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report,null,2));
}
try { main(); } catch(error) { console.error(error.message); process.exitCode=1; }
