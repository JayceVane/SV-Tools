/**
 * 构建 Rust 原生模块，并把 napi 产物复制到扩展根目录。
 *
 * extension.js 与 test/golden_test.js 按 `svtools.<triple>.node` 的文件名在仓库根目录
 * 加载原生模块，而 napi build 把产物写在 src-rust/ 下，本脚本负责搬运这一步。
 *
 * 用法：npm run build:native
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_RUST = path.join(ROOT, 'src-rust');

const build = spawnSync('npm run build', { cwd: SRC_RUST, stdio: 'inherit', shell: true });
if (build.status !== 0) {
    console.error('原生模块构建失败（见上方 napi/cargo 输出）');
    process.exit(build.status || 1);
}

// napi --platform 产出 svtools.<triple>.node；src-rust/svtools.node 是非 --platform 构建的残留
const artifacts = fs
    .readdirSync(SRC_RUST)
    .filter((f) => /^svtools\..+\.node$/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(SRC_RUST, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

if (!artifacts.length) {
    console.error(`src-rust/ 下没有找到 svtools.<triple>.node，napi build 可能未产出平台文件`);
    process.exit(1);
}

const source = path.join(SRC_RUST, artifacts[0].f);
const target = path.join(ROOT, artifacts[0].f);
fs.copyFileSync(source, target);
console.log(`已复制 ${path.relative(ROOT, source)} → ${path.relative(ROOT, target)}`);
