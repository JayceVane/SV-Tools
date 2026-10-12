'use strict';

const fs = require('fs');
const path = require('path');

/** @returns {'gnu'|'musl'} 当前 Linux 运行时使用的 libc。 */
function detectLinuxLibc() {
    return process.report && process.report.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl';
}

/**
 * 选择 napi 平台产物，未知平台明确报错。
 * @param {string} [platform] @param {string} [arch] @param {'gnu'|'musl'} [libc]
 * @returns {string} bin/ 中的原生模块文件名
 */
function nativeArtifactName(platform = process.platform, arch = process.arch, libc) {
    const linuxLibc = platform === 'linux' ? libc || detectLinuxLibc() : 'gnu';
    const targets = {
        win32: { x64: 'win32-x64-msvc', arm64: 'win32-arm64-msvc', ia32: 'win32-ia32-msvc' },
        darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
        linux: { x64: `linux-x64-${linuxLibc}`, arm64: `linux-arm64-${linuxLibc}` },
        freebsd: { x64: 'freebsd-x64' },
        android: { arm64: 'android-arm64', arm: 'android-arm-eabi' }
    };
    const target = targets[platform] && targets[platform][arch];
    if (!target) throw new Error(`不支持的原生模块平台：${platform}/${arch}`);
    return `svtools.${target}.node`;
}

/**
 * 惰性原生模块加载器，依赖可注入以便无原生二进制时验证错误路径。
 * @param {{rootDir?: string, platform?: string, arch?: string, libc?: 'gnu'|'musl', requireModule?: (path: string) => object, existsSync?: typeof fs.existsSync}} [options]
 * @returns {{load: () => object, reset: () => void, modulePath: string}}
 */
function createNativeLoader(options = {}) {
    const rootDir = options.rootDir || path.resolve(__dirname, '..');
    const modulePath = path.join(rootDir, 'bin', nativeArtifactName(options.platform, options.arch, options.libc));
    const existsSync = options.existsSync || fs.existsSync;
    const requireModule = options.requireModule || require;
    let native = null;
    return {
        modulePath,
        load() {
            if (native) return native;
            const remedy = '请执行 npm run build:native，或从 GitHub Releases 下载对应平台的 .node 放入 bin/ 后重新加载窗口。';
            if (!existsSync(modulePath)) throw new Error(`缺少 Rust 原生模块：${modulePath}。${remedy}`);
            try {
                native = requireModule(modulePath);
                return native;
            } catch (cause) {
                throw new Error(`无法加载 Rust 原生模块：${modulePath}（${cause.message}）。${remedy}`, { cause });
            }
        },
        reset() { native = null; }
    };
}

module.exports = { nativeArtifactName, createNativeLoader };
