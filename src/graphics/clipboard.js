'use strict';
const { createNativeLoader } = require('../native-loader');
const loader = createNativeLoader();

/**
 * 复用包内NAPI原生模块写图片；不启动shell、辅助进程或写临时文件。
 * @param {Buffer} bytes 已通过宿主载荷检查的PNG字节。
 * @returns {Promise<void>} 原生层另行解码、校验尺寸并提交系统剪贴板，失败抛错。
 */
async function writeClipboardPng(bytes) {
    const native = loader.load();
    if (typeof native.writeClipboardPng !== 'function') throw new Error('原生模块缺少图片剪贴板接口，请安装新版插件并重载窗口');
    await native.writeClipboardPng(bytes);
}

module.exports = { writeClipboardPng };
