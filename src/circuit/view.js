'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let assets;

/**
 * 创建无设计数据的电路页面；RTL 名称随后由消息以文本节点显示。
 * @param {{webview:object,extensionUri:object}} options 宿主页面上下文。
 * @returns {string} 仅允许本地 nonce 脚本和样式的 HTML。
 */
function createCircuitHtml({ webview, extensionUri } = {}) {
    void webview; void extensionUri;
    assets ||= Object.fromEntries(['view.css', 'graph-index.js', 'viewport.js', 'renderer.js', 'image-export.js', 'client.js'].map(name =>
        [name, fs.readFileSync(path.join(__dirname, name), 'utf8')]));
    assets.shared ||= Object.fromEntries(['svg-canvas.js','image-export.js','image-export.css'].map(name => [name, fs.readFileSync(path.join(__dirname, '../graphics', name), 'utf8')]));
    const nonce = crypto.randomBytes(18).toString('hex');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<title>SV Tools · Circuit</title><style nonce="${nonce}">${assets['view.css']}
${assets.shared['image-export.css']}</style></head><body>
<header><span class="brand" aria-hidden="true">⌘</span><div class="heading"><h1 id="designTitle">电路结构</h1><div id="provenance" class="muted">正在连接设计数据</div></div><span class="previewTag">RTL SCHEMATIC</span></header>
<div class="toolbar" role="toolbar" aria-label="电路导航">
<button id="back" disabled title="返回上一级 Alt + ←">← 返回</button><button id="home" disabled title="返回顶层">顶层</button>
<select id="modules" aria-label="选择模块" disabled><option>等待设计</option></select><span class="divider"></span>
<button id="fit" title="适配画布 F">适配 F</button><button id="zoomOut" title="缩小 −" aria-label="缩小">−</button><button id="zoomIn" title="放大 +" aria-label="放大">＋</button><span id="zoom" class="zoomValue">—</span>
<span class="grow"></span><div class="searchBox"><input id="search" type="search" aria-label="搜索单元、端口或网络" placeholder="搜索单元 / 网络"><span id="searchCount" aria-live="polite"></span><button id="nextMatch" title="下一个匹配 Enter" disabled aria-label="下一个搜索匹配">↓</button></div><button id="exportImage" disabled title="导出当前模块完整电路，选择文档黑白或当前主题">导出图片</button><button id="reload" title="重新读取当前设计">刷新</button>
</div>
<div class="contextBar"><nav id="breadcrumbs" aria-label="实例层级">等待设计</nav><span id="graphStats" class="muted"></span></div>
<main><section id="viewport" aria-label="电路画布"><svg id="circuit" xmlns="http://www.w3.org/2000/svg" role="group" aria-roledescription="电路图" aria-label="RTL 电路结构，Tab 选择单元，方向键平移，F 适配，Enter 进入选中实例" tabindex="0"></svg>
<div id="message" class="message"><div class="messageGlyph" aria-hidden="true">⌘</div><strong id="messageTitle">准备电路视图</strong><span id="messageDetail">选择顶层后，按模块查看电路连接</span></div>
<div class="canvasLegend" aria-hidden="true"><span class="legendWire">单比特</span><span class="legendBus">总线 / 位宽</span><span class="legendRegister">寄存器</span><span class="legendMux">选择器</span><span class="legendLogic">组合逻辑</span><span class="legendInstance">模块实例</span></div></section>
<aside id="inspector" aria-label="电路对象详情"><div class="panelTitle">INSPECTOR</div><div id="selectionEmpty" class="selectionEmpty">点击单元、引脚或网络查看详情。<p>双击模块实例进入下一级。</p><p>拖动画布平移 · 滚轮缩放</p></div><div id="selectionDetails" hidden><div id="selectionKind" class="objectKind"></div><h2 id="selectionName"></h2><dl id="properties"></dl><div class="selectionActions"><button id="enterInstance" hidden>进入模块 ↗</button><button id="openSource" disabled title="数据源提供可靠位置时可跳转">查看源码</button></div></div><div class="inspectorNote">结构来自所选工具生成的网表。综合优化可能合并信号，或移除未使用的逻辑。</div></aside></main>
<footer><span id="status" role="status" aria-live="polite">准备加载</span><span class="keyboardHint">F 适配 · + / − 缩放 · 方向键平移 · Esc 取消选择</span></footer>
<script nonce="${nonce}">${assets['graph-index.js']}</script><script nonce="${nonce}">${assets['viewport.js']}</script><script nonce="${nonce}">${assets['renderer.js']}</script><script nonce="${nonce}">${assets.shared['svg-canvas.js']}</script><script nonce="${nonce}">${assets.shared['image-export.js']}</script><script nonce="${nonce}">${assets['image-export.js']}</script><script nonce="${nonce}">${assets['client.js']}</script></body></html>`;
}

module.exports = { createCircuitHtml };
