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
    assets ||= Object.fromEntries(['view.css', 'symbol-library.js', 'route-geometry.js', 'minimap.js', 'graph-index.js', 'viewport.js', 'renderer.js', 'image-export.js', 'trace-actions.js', 'trace-client.js', 'wave-link-client.js', 'cursor-values-client.js', 'client.js'].map(name =>
        [name, fs.readFileSync(path.join(__dirname, name), 'utf8')]));
    assets.shared ||= Object.fromEntries(['svg-canvas.js','image-export.js','image-export.css'].map(name => [name, fs.readFileSync(path.join(__dirname, '../graphics', name), 'utf8')]));
    const nonce = crypto.randomBytes(18).toString('hex');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<title>SV Tools · Circuit</title><style nonce="${nonce}">${assets['view.css']}
${assets.shared['image-export.css']}</style></head><body>
<header><div class="heading"><h1 id="designTitle">电路结构</h1><div id="provenance" class="muted">正在连接设计数据</div></div></header>
<div class="toolbar" role="toolbar" aria-label="电路导航">
<button id="back" disabled title="返回上一级 Alt + ←">← 返回</button><button id="home" disabled title="返回顶层">顶层</button>
<select id="modules" aria-label="选择模块" disabled><option>等待设计</option></select><span class="divider"></span>
<button id="fit" title="适配画布 F">适配 F</button><button id="zoomOut" title="缩小 −" aria-label="缩小">−</button><button id="zoomIn" title="放大 +" aria-label="放大">＋</button><span id="zoom" class="zoomValue">—</span><button id="toggleMinimap" aria-pressed="false" title="显示或隐藏导航小地图">小地图</button><button id="toggleInspector" aria-pressed="false" title="显示或隐藏对象属性">属性</button><button id="waveLinkSetup" disabled title="人工确认电路顶层与已打开VCD的根层级">关联波形…</button><button id="traceChoose" disabled title="从实际网表中选择信号，打开局部追踪">追踪信号…</button>
<span class="grow"></span><div class="searchBox"><input id="search" type="search" aria-label="搜索单元、端口或网络" placeholder="搜索单元 / 网络"><span id="searchCount" aria-live="polite"></span><button id="nextMatch" title="下一个匹配 Enter" disabled aria-label="下一个搜索匹配">↓</button></div><button id="exportImage" disabled title="导出当前电路视图，选择文档黑白或当前主题">导出图片</button><button id="reload" title="重新读取当前设计">刷新</button>
</div>
<div class="contextBar"><nav id="breadcrumbs" aria-label="实例层级">等待设计</nav><span id="waveLinkState" class="waveLinkState">尚未关联VCD</span><span id="graphStats" class="muted"></span></div>
<section id="tracePanel" class="tracePanel" aria-label="信号追踪导航" hidden><div class="traceHeading"><button id="traceBack" disabled title="追踪后退 Alt + ←">←</button><button id="traceForward" disabled title="追踪前进 Alt + →">→</button><strong id="traceSummary"></strong><span id="tracePrecision" class="traceBadge"></span><button id="traceCancel" hidden>取消追踪</button></div><div id="traceLimit" role="status"></div><div id="traceBranches" class="traceBranches" aria-label="已展开分支"></div><div id="traceFrontiers" class="traceFrontiers" aria-label="追踪边界"></div></section>
<main><section id="viewport" aria-label="电路画布"><svg id="circuit" xmlns="http://www.w3.org/2000/svg" role="group" aria-roledescription="电路图" aria-label="RTL 电路结构，Tab 选择单元，方向键平移，F 适配，Enter 进入选中实例" tabindex="0"></svg>
<canvas id="minimap" class="minimap" width="192" height="120" role="group" tabindex="0" aria-label="电路导航小地图，点击定位，方向键移动视口，Enter适配"></canvas><div id="message" class="message"><div class="messageGlyph" aria-hidden="true">◇</div><strong id="messageTitle">准备电路视图</strong><span id="messageDetail">选择顶层后，按模块查看电路连接</span></div>
<div class="canvasLegend" aria-hidden="true"><span class="legendWire">单比特</span><span class="legendBus">总线 / 位宽</span><span class="legendDriver">追踪驱动</span><span class="legendLoad">追踪负载</span></div></section>
<aside id="inspector" aria-label="电路对象详情" hidden><div class="panelTitle">对象属性</div><div id="selectionEmpty" class="selectionEmpty">点击单元、引脚或网络查看详情。<p>双击模块实例进入下一级。</p><p>拖动画布平移 · 滚轮缩放</p></div><div id="selectionDetails" hidden><div id="selectionKind" class="objectKind"></div><h2 id="selectionName"></h2><dl id="properties"></dl><div class="traceSelection"><label for="traceBits">追踪位 / 范围</label><input id="traceBits" value="*" aria-label="追踪的HDL下标或范围" placeholder="* 当前选择 / 如7:4"><div class="selectionActions"><button id="traceDrivers" disabled>追踪驱动 ←</button><button id="traceLoads" disabled>追踪负载 →</button><button id="traceFocus" disabled>固定关注</button></div></div><div class="selectionActions"><button id="enterInstance" hidden>进入模块 ↗</button><button id="waveLinkWatch" disabled title="观察选定位在A/B游标时刻的精确值">观察 A/B 值…</button><button id="waveLinkShow" disabled title="在已确认的VCD实例中添加或定位所选信号">添加到波形…</button><button id="openSource" disabled title="源码内容与生成快照一致时可跳转">查看源码</button></div></div><section id="waveValuesPanel" class="waveValuesPanel" aria-label="波形游标读值" hidden><div class="waveValuesHeading"><strong>波形读值</strong><button id="waveValuesOverlay" aria-pressed="true" title="显示或隐藏画布上的A值标注">画布标注</button><button id="waveValuesClear">清空</button></div><div id="waveValuesTimes" class="muted"></div><div id="waveValuesList"></div><p class="muted">A/B按VCD精确取值；含X/Z时不作确定值比较。</p></section><div class="inspectorNote">结构来自所选工具生成的网表。综合优化可能合并信号，或移除未使用的逻辑。</div></aside></main>
<footer><span id="status" role="status" aria-live="polite">准备加载</span><span id="fitHint" class="fitHint" hidden>按 F 适配全图</span><span class="keyboardHint">F 适配 · + / − 缩放 · 方向键平移 · Esc 取消选择</span></footer>
<script nonce="${nonce}">${assets['symbol-library.js']}</script><script nonce="${nonce}">${assets['route-geometry.js']}</script><script nonce="${nonce}">${assets['minimap.js']}</script><script nonce="${nonce}">${assets['graph-index.js']}</script><script nonce="${nonce}">${assets['viewport.js']}</script><script nonce="${nonce}">${assets['renderer.js']}</script><script nonce="${nonce}">${assets['trace-actions.js']}</script><script nonce="${nonce}">${assets['trace-client.js']}</script><script nonce="${nonce}">${assets['wave-link-client.js']}</script><script nonce="${nonce}">${assets['cursor-values-client.js']}</script><script nonce="${nonce}">${assets.shared['svg-canvas.js']}</script><script nonce="${nonce}">${assets.shared['image-export.js']}</script><script nonce="${nonce}">${assets['image-export.js']}</script><script nonce="${nonce}">${assets['client.js']}</script></body></html>`;
}

module.exports = { createCircuitHtml };
