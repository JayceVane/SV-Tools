'use strict';

const { runProcess } = require('../src/toolchains/process');
const fs = require('fs');
const path = require('path');
const { nativeArtifactName } = require('../src/native-loader');

const rootDir = path.resolve(__dirname, '..');
const nativeDir = path.join(rootDir, 'src', 'native');
const binDir = path.join(rootDir, 'bin');
const COPY_RETRY_COUNT = 3;
const COPY_RETRY_DELAY_MS = 200;

/** 构建失败时保留工具的完整输出并停止，避免复制旧产物。 */
async function build(command, args) {
    const result = await runProcess(command, args, {
        cwd: nativeDir,
        onStdout: text => process.stdout.write(text),
        onStderr: text => process.stderr.write(text)
    });
    if (result.errorMessage || result.code !== 0) {
        throw new Error('原生模块构建失败：' + (result.errorMessage || `exit ${result.code}`));
    }
}

/** Windows 扩展宿主或扫描器短暂占用 .node 时，仅重试文件锁错误。 */
function copyArtifact(source, target) {
    for (let attempt = 0; attempt <= COPY_RETRY_COUNT; attempt++) {
        try {
            fs.copyFileSync(source, target);
            return;
        } catch (error) {
            if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === COPY_RETRY_COUNT) {
                console.error('无法复制构建产物 ' + source + ' → ' + target + '：' + error.message);
                console.error('请关闭正在使用原生模块的扩展宿主后重试。');
                process.exit(1);
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, COPY_RETRY_DELAY_MS);
        }
    }
}

async function main() {
    await build(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
    await build('cargo', ['build', '--release', '--bin', 'svtools-cli']);
    fs.mkdirSync(binDir, { recursive: true });
    const nativeName = nativeArtifactName();
    const executableName = process.platform === 'win32' ? 'svtools.exe' : 'svtools';
    const cargoExecutableName = process.platform === 'win32' ? 'svtools-cli.exe' : 'svtools-cli';
    const targetDir = process.env.CARGO_TARGET_DIR
        ? path.resolve(nativeDir, process.env.CARGO_TARGET_DIR) : path.join(nativeDir, 'target');
    for (const [source, target] of [
        [path.join(nativeDir, nativeName), path.join(binDir, nativeName)],
        [path.join(targetDir, 'release', cargoExecutableName), path.join(binDir, executableName)]
    ]) {
        if (!fs.existsSync(source)) throw new Error('构建没有生成所需产物：' + source);
        copyArtifact(source, target);
        console.log(`已复制 ${path.relative(rootDir, source)} → ${path.relative(rootDir, target)}`);
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
