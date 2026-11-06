'use strict';

// 无宿主 SVG 栅格化：发布布局优先加载 bin/resvg.*.node（不依赖运行时 node_modules），
// 开发环境回退 devDependency 的 @resvg/resvg-js。中文依赖系统字体；加载失败按工具
// 资源缺失处理，与内置 Yosys 缺失同语义。
const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('../agent/protocol');

const BIN_DIRECTORY = path.resolve(__dirname, '..', '..', 'bin');
const DEFAULT_SCALE = 2;

let cached = null;

/** @returns {{Resvg:Function}} resvg 模块；bin 缺失且依赖不可用时 fail TOOL_NOT_FOUND。 */
function loadResvg() {
    if (cached) {
        return cached;
    }
    const errors = [];
    const candidates = [];
    try {
        for (const entry of fs.readdirSync(BIN_DIRECTORY)) {
            if (/^resvg\..+\.node$/.test(entry)) {
                candidates.push(path.join(BIN_DIRECTORY, entry));
            }
        }
    } catch (error) {
        errors.push('bin 目录不可读：' + error.message);
    }
    candidates.push('@resvg/resvg-js');
    for (const candidate of candidates) {
        try {
            cached = require(candidate);
            return cached;
        } catch (error) {
            errors.push(candidate + '：' + error.message);
        }
    }
    fail('TOOL_NOT_FOUND', 'SVG 栅格化组件不可用（resvg），请重新构建 bin/ 资源', { attempts: errors });
}

/**
 * 把 SVG 文本栅格化为 PNG。
 * @param {string} svg SVG 文本。 @param {{scale?:number}} [options] 像素倍率（默认 2，供报告清晰输出）。
 * @returns {{png:Buffer,width:number,height:number,scale:number}} PNG 与实际像素尺寸。
 */
function rasterizeSvg(svg, { scale = DEFAULT_SCALE } = {}) {
    if (!Number.isFinite(scale) || scale < 1 || scale > 8) {
        fail('INVALID_ARGUMENT', '--scale 要求 1–8 的倍率');
    }
    const { Resvg } = loadResvg();
    let rendered;
    try {
        // resvg-js 2.x 的选项参数是 JSON 字符串（napi 侧按 String 反序列化）。
        const options = JSON.stringify({ fitTo: { mode: 'zoom', value: scale }, font: { loadSystemFonts: true } });
        const resvg = new Resvg(svg, options);
        rendered = resvg.render();
    } catch (error) {
        fail('DESIGN_FAILED', 'SVG 栅格化失败：' + error.message);
    }
    const png = rendered.asPng();
    if (!png || png.length < 8 || png[0] !== 0x89 || png.slice(1, 4).toString() !== 'PNG') {
        fail('DESIGN_FAILED', 'SVG 栅格化未产生有效 PNG');
    }
    return { png, width: rendered.width, height: rendered.height, scale };
}

module.exports = { rasterizeSvg, loadResvg, DEFAULT_SCALE };
