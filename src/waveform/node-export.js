'use strict';
/** 无宿主波形图导出：把 webview 的 renderer 装进受控 Node 沙箱，与插件导出共用同一绘制路径。
 *  CLI 只提供 document 黑白技术文档风格；调色板分支与设备像素比在导出几何下不会被触达。 */
const fs = require('node:fs');
const path = require('node:path');
const rowLayout = require('./row-layout');
const columnLayout = require('./column-layout');
const modelApi = require('./model');
const imageExport = require('./image-export');

let sandbox = null;
/** 惰性组装渲染沙箱：renderer.js 是挂 window 的 IIFE，用受控 window 求值；其余 UMD 模块 require 后挂载。 */
function loadSandbox() {
    if (sandbox) return sandbox;
    const window = {
        WaveRowLayout: rowLayout, WaveColumnLayout: columnLayout, WaveModel: modelApi,
        // 字符宽度估算与 svg-canvas 的缺省 measure 同源（ASCII 6px / 其他 11px），只影响标签截断判断。
        document: { createElement: () => ({ getContext: () => ({ font: '',
            measureText: text => ({ width: [...String(text)].reduce((sum, ch) => sum + (/[^\x00-\x7f]/.test(ch) ? 11 : 6), 0) }) }) }) }
    };
    new Function('window', fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8'))(window);
    sandbox = window;
    return window;
}

/** @param {{state:object,options:object,request:Function,title:string}} deps @returns {Promise<{svg:string,width:number,height:number}>} 数据经 request 走 VcdStore。 */
function createWaveImage({ state, options, request, title }) {
    const window = loadSandbox();
    return imageExport.create({ state, options: { ...options, style: 'document' }, request, window, renderer: null, title });
}

module.exports = { createWaveImage, loadSandbox };
