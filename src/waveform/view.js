'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseTimescaleSeconds } = require('./parser');
let assets;

/** 小型静态资源只读取一次；波形事件从不进入 HTML。 */
function readAssets() {
    if (!assets) assets = Object.fromEntries(['view.css', 'model.js', 'renderer.js', 'client.js'].map(name =>
        [name, fs.readFileSync(path.join(__dirname, name), 'utf8')]));
    return assets;
}

/**
 * 生成 worker 数据服务的页面壳。metadata 可缺省，随后由 init 消息提供。
 * @param {object|null} metadata 仅信号元数据；兼容小文本 parseVcd 返回值，不嵌入 changes。
 * @param {{fileName:string,fileKey?:string,nonce?:string}} meta 页面身份。
 * @returns {string} 带 nonce CSP 的独立 HTML。
 */
function buildWaveformHtml(metadata, meta) {
    const content = readAssets();
    const nonce = meta.nonce || crypto.randomBytes(18).toString('hex');
    const boot = { fileName: meta.fileName, fileKey: meta.fileKey || meta.fileName };
    if (metadata) {
        boot.metadata = { headers: metadata.headers, scopes: metadata.scopes, endTime: metadata.endTime,
            timescale: metadata.timescale, secondsPerTick: metadata.secondsPerTick ?? parseTimescaleSeconds(metadata.timescale), eventCount: metadata.eventCount, fileBytes: metadata.fileBytes,
            vars: metadata.vars.map(signal => ({ ...signal, changeCount: signal.changeCount ?? metadata.changes?.get(signal.id)?.length ?? 0 })) };
    }
    const json = JSON.stringify(boot).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<title>SV Tools · Waveform</title><style nonce="${nonce}">${content['view.css']}</style></head><body>
<header><span class="brand" aria-hidden="true">∿</span><div class="title"><h1 id="title">波形查看器</h1><div id="metadata" class="subtle">VCD · 正在读取信号定义</div></div><span class="tag">WAVEFORM</span></header>
<div class="toolbar" role="toolbar" aria-label="时序导航">
<button id="fit" title="适配全程 F">全程 F</button><button id="zoomIn" title="放大 +">＋</button><button id="zoomOut" title="缩小 −">−</button><button id="rangeFit" title="适配 A/B 游标区间">A ↔ B</button>
<span class="divider"></span><button id="prevEdge" title="所选信号上一个真实边沿 ←">← 边沿</button><button id="nextEdge" title="所选信号下一个真实边沿 →">边沿 →</button>
<span class="divider"></span><button id="cursorMode" title="切换活动游标 A/B；Shift 点击放置 B">游标 A</button><button id="snap" class="active" title="吸附所选信号的真实边沿">吸附</button>
<input id="jumpTime" aria-label="跳转时间" placeholder="时间 / 125 ns"><button id="jump">跳转</button><span class="grow"></span><button id="fullName" title="切换完整层级名称">全名</button>
</div>
<div class="cursorStrip"><span class="a" id="cursorA">A —</span><span class="b" id="cursorB">B —</span><span id="delta">Δt —</span><span class="grow"></span><span id="viewRange" class="subtle"></span></div>
<main><aside aria-label="设计信号"><div class="sectionTitle">DESIGN SIGNALS</div><div class="catalogTools">
<input id="search" type="search" aria-label="搜索层级或信号" placeholder="搜索信号或完整层级…"><select id="scope" aria-label="设计层级"><option value="">全部层级</option></select>
<label><input id="constants" type="checkbox">显示 parameter 常量</label><span id="signalCount" class="subtle"></span></div>
<div id="catalog" role="list" aria-label="可添加信号"><div id="catalogSpace"></div></div><div class="catalogActions"><button id="addFiltered">添加检索结果</button><button id="clearSignals">清空波形</button></div></aside>
<section id="right" aria-label="时序波形"><canvas id="ruler"></canvas><div id="tracks"><div id="trackSpace"><canvas id="waveCanvas" tabindex="0" aria-label="波形；点击放置游标，名称栏选择和排序"></canvas></div></div>
<div id="empty">从左侧添加信号，开始分析时序<br>Ctrl 点击多选 · 名称拖拽排序 · 右键设置进制、分组和模拟量</div>
<div id="loading"><div id="loadTitle">正在加载 VCD</div><progress id="progress"></progress><div id="loadDetail">后台解析，编辑器保持响应</div><div id="loadError" role="alert"></div><button id="cancel">取消加载</button></div></section></main>
<footer><span id="status" role="status">准备加载</span><span class="hint">Ctrl + 滚轮缩放 · Shift + 滚轮平移 · 拖动波形平移 · Shift 点击放置 B</span></footer>
<script nonce="${nonce}">const BOOT=${json};</script><script nonce="${nonce}">${content['model.js']}</script><script nonce="${nonce}">${content['renderer.js']}</script><script nonce="${nonce}">${content['client.js']}</script></body></html>`;
}
module.exports = { buildWaveformHtml };
