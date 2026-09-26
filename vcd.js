/**
 * Copyright (c) 2025 JayceVane (JayceVane@163.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * 内置 VCD 波形查看器：解析 + webview 渲染。
 *
 * 模块分层：
 *  - parseVcd / buildSignalTree / parseTimescaleSeconds 为纯函数，不依赖 vscode，可独立单元测试；
 *  - activateWaveViewer() 负责 VSCode 集成（webview 面板、命令、与仿真联动）。
 *
 * 渲染采用视口窗口模型：canvas 固定为可视区大小，只绘制 [viewStart, viewStart+viewSpan]
 * 时间窗口内的变更（二分查找定位），任意时间跨度（如 1ns 下 245e9 ticks）均可缩放浏览。
 */

const HEADER_KEYS = ['$date', '$version', '$timescale', '$comment'];

/**
 * 解析 VCD 文本。
 * @param {string} text VCD 文件全文
 * @returns {{
 *   headers: {key: string, value: string}[],
 *   scopes: {name: string, type: string, path: string}[],
 *   vars: {id: string, name: string, width: number, type: string, scopePath: string, path: string}[],
 *   changes: Map<string, {t: number, value: string}[]>,
 *   endTime: number,
 *   timescale: string
 * }}
 *  - changes 以信号 id 为键，时间升序；value 为字符串形式（标量 '0'/'1'/'x'/'z'，
 *    向量为去掉前缀的二进制串如 'x0x00xxx'，实数为十进制文本）
 */
function parseVcd(text) {
    const headers = [];
    const scopes = [];
    const vars = [];
    const changes = new Map();
    let timescale = '';
    let endTime = 0;

    const scopeStack = [];
    let currentVar = null;
    let currentHeader = null;
    /** $dumpvars/$dumpall 节：其后、下一个 #时间戳 之前的变更都是 #0 初值 */
    let inInitialDump = false;
    /** 最近一次 # 时间戳 */
    let lastTime = 0;

    const lines = String(text).split(/\r?\n/);
    for (let raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        // --- 头信息节（$key ... $end）---
        if (currentHeader) {
            if (/^\$end$/i.test(line)) {
                currentHeader.value = currentHeader.parts.join(' ');
                headers.push(currentHeader);
                if (currentHeader.key === '$timescale') timescale = currentHeader.value;
                currentHeader = null;
            } else {
                currentHeader.parts.push(line);
            }
            continue;
        }
        const headerStart = line.match(/^\$(date|version|timescale|comment)$/i);
        if (headerStart) {
            currentHeader = { key: '$' + headerStart[1], parts: [] };
            continue;
        }

        // --- scope 层级 ---
        const scopeStart = line.match(/^\$scope\s+(\w+)\s+(\S+)\s*\$end$/i);
        if (scopeStart) {
            scopeStack.push({ type: scopeStart[1], name: scopeStart[2] });
            scopes.push({
                name: scopeStart[2],
                type: scopeStart[1],
                path: scopeStack.map(s => s.name).join('.')
            });
            continue;
        }
        if (/^\$upscope/i.test(line)) {
            scopeStack.pop();
            continue;
        }

        const varStart = line.match(/^\$var\s+(\w+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(\[[^\]]+\]))?\s*\$end$/i);
        if (varStart) {
            const scopePath = scopeStack.map(s => s.name).join('.');
            currentVar = {
                id: varStart[3],
                name: varStart[4],
                width: parseInt(varStart[2], 10),
                type: varStart[1],
                scopePath,
                path: scopePath ? `${scopePath}.${varStart[4]}` : varStart[4]
            };
            vars.push(currentVar);
            continue;
        }
        if (/^\$enddefinitions/i.test(line)) {
            currentVar = null;
            continue;
        }

        // --- 值变更区 ---
        const timeMatch = line.match(/^#(\S+)$/);
        if (timeMatch) {
            const t = parseNumber(timeMatch[1]);
            if (t !== null) {
                if (t > endTime) endTime = t;
                lastTime = t;
            }
            inInitialDump = false;
            continue;
        }
        if (/^\$dumpvars\b/i.test(line) || /^\$dumpall\b/i.test(line)) {
            inInitialDump = true;
            continue;
        }
        if (/^\$dumpoff\b/i.test(line) || /^\$dumpon\b/i.test(line)) continue;
        if (/^\$end\b/i.test(line)) continue;
        if (/^\$comment\b/i.test(line)) continue;

        const change = parseValueChange(line);
        if (!change) continue;
        pushChange(changes, change.id, { t: inInitialDump ? 0 : lastTime, value: change.value });
    }
    return { headers, scopes, vars, changes, endTime, timescale };
}

function pushChange(map, id, entry) {
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(entry);
}

/**
 * 解析单行值变更。
 * 标量：`0!` `1"` `x$` `z%`；向量：`b1010 #` 或 `B1010 #`；实数：`r25.5 %`。
 * @returns {{id: string, value: string}|null}
 */
function parseValueChange(line) {
    let m = line.match(/^([01xzXZ])(\S+)$/);
    if (m) return { id: m[2], value: m[1].toLowerCase() };
    m = line.match(/^([brBR])\s*(\S+)\s+(\S+)$/);
    if (m) return { id: m[3], value: m[2].toLowerCase() };
    return null;
}

/** VCD 时间/实数解析（支持普通整数与小数）。 */
function parseNumber(text) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
}

/**
 * 解析 $timescale 为「每个时间单位对应的秒数」。如 '1ns' → 1e-9，'10ps' → 1e-10。
 * @param {string} timescale 如 '1s'、'1ns'、'100ps'、'10 us'
 * @returns {number|null} 秒数；无法解析返回 null
 */
function parseTimescaleSeconds(timescale) {
    const m = String(timescale || '').trim().match(/^(\d+(?:\.\d+)?)\s*(s|ms|us|ns|ps|fs)$/i);
    if (!m) return null;
    const value = parseFloat(m[1]);
    const unitFactors = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 };
    return value * unitFactors[m[2].toLowerCase()];
}

/**
 * 把扁平 var 列表组织成 scope 树（供信号树面板展示）。
 * 同一 id 可能在多个 scope 出现（父模块信号在子 scope 的引用），按 path 全部保留。
 * @param {ReturnType<typeof parseVcd>} vcd
 * @returns {{name: string, path: string, type: string, children: (object|var)[]}}
 *          树节点：scope 节点有 children；信号节点含 id/width/type。
 */
function buildSignalTree(vcd) {
    const root = { name: '', path: '', type: 'root', children: [] };
    const scopeNodes = new Map([['', root]]);

    for (const scope of vcd.scopes) {
        const parentPath = scope.path.includes('.')
            ? scope.path.slice(0, scope.path.lastIndexOf('.'))
            : '';
        const parent = scopeNodes.get(parentPath) || root;
        const node = { name: scope.name, path: scope.path, type: scope.type, children: [] };
        scopeNodes.set(scope.path, node);
        parent.children.push(node);
    }
    for (const v of vcd.vars) {
        // 参数/规格参数是常量，对波形查看无意义（iverilog 会把它们 dump 成 t=0 变更），不进树
        if (/^(spec)?parameter$/i.test(v.type)) continue;
        const parent = scopeNodes.get(v.scopePath) || root;
        parent.children.push({
            name: v.name,
            path: v.path,
            id: v.id,
            width: v.width,
            type: v.type,
            hasChanges: vcd.changes.has(v.id) && vcd.changes.get(v.id).length > 0
        });
    }
    return root;
}

// ---------------------------------------------------------------------------
// VSCode 集成
// ---------------------------------------------------------------------------

/**
 * 激活 VCD 波形查看器：
 *  - openWaveform 命令（仿真自动打开走这里）；
 *  - CustomEditorProvider：.vcd 文件双击直接以波形面板打开（package.json priority=option）；
 *  - editor/title 切换命令：文本视图 ↔ 波形视图（package.json menus.editor/title）。
 * @param {vscode.ExtensionContext} context
 * @param {{channel: vscode.OutputChannel}} deps 与仿真模块共享的输出通道
 */
function activateWaveViewer(context, deps) {
    const vscode = require('vscode');
    const panels = new Map(); // vcd 文件路径 -> webviewPanel

    const ERROR_PAGE = (msg) => '<html><body style="font-family:sans-serif;color:#d4d4d4;' +
        'background:#1e1e1e;padding:24px;font-size:14px">VCD 打开失败：' +
        String(msg).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</body></html>';

    /**
     * 把面板与 VCD 文件绑定：解析、渲染 HTML、登记生命周期。
     * 命令式打开与 CustomEditorProvider 两条路径共用。
     */
    function attachPanel(vcdPath, panel) {
        const existing = panels.get(vcdPath);
        if (existing && existing !== panel) existing.dispose();
        panels.set(vcdPath, panel);
        panel.onDidDispose(() => {
            if (panels.get(vcdPath) === panel) panels.delete(vcdPath);
        }, null, context.subscriptions);

        let vcd;
        try {
            vcd = parseVcd(require('fs').readFileSync(vcdPath, 'utf8'));
        } catch (err) {
            panel.webview.html = ERROR_PAGE(err.message);
            return;
        }
        if (vcd.vars.length === 0) {
            panel.webview.html = ERROR_PAGE('该 VCD 文件中没有信号定义。');
            return;
        }
        panel.webview.html = buildWaveformHtml(vcd, {
            fileName: require('path').basename(vcdPath),
            timescale: vcd.timescale,
            cspSource: panel.webview.cspSource
        });
    }

    /**
     * 打开（或聚焦已打开的）波形面板。
     * @param {string} vcdPath VCD 文件绝对路径
     */
    async function openWaveform(vcdPath) {
        const existing = panels.get(vcdPath);
        if (existing) {
            existing.reveal();
            return;
        }
        if (!require('fs').existsSync(vcdPath)) {
            vscode.window.showWarningMessage(`文件不存在：${vcdPath}`);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'svtoolsWaveViewer',
            `波形 · ${require('path').basename(vcdPath)}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        attachPanel(vcdPath, panel);
    }

    // .vcd 双击直接打开波形（priority=option 使其成为 .vcd 默认编辑器）
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('svtoolsWaveViewer', {
            async openCustomDocument(uri) {
                return { uri, dispose() { } };
            },
            async resolveCustomEditor(document, panel) {
                panel.webview.options = { enableScripts: true, localResourceRoots: [] };
                attachPanel(document.uri.fsPath, panel);
            }
        }, { supportsMultipleEditorsPerDocument: false })
    );

    // editor/title 双向切换：取当前活动标签的 URI（文本或自定义编辑器均适用）
    function activeUri() {
        const editor = vscode.window.activeTextEditor;
        if (editor) return editor.document.uri;
        const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTab;
        const input = tab && tab.input;
        return (input && input.uri) ? input.uri : undefined;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.iverilog.waveformFromText', () => {
            const uri = activeUri();
            if (!uri) {
                vscode.window.showWarningMessage('没有打开的 VCD 文件。');
                return;
            }
            vscode.commands.executeCommand('vscode.openWith', uri, 'svtoolsWaveViewer');
        }),
        vscode.commands.registerCommand('svtools.iverilog.showText', () => {
            const uri = activeUri();
            if (!uri) return;
            vscode.commands.executeCommand('vscode.openWith', uri, 'default');
        }),
        vscode.commands.registerCommand('svtools.iverilog.openWaveform', async () => {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'VCD Waveform': ['vcd'], 'All Files': ['*'] }
            });
            if (picked && picked[0]) openWaveform(picked[0].fsPath);
        })
    );

    return { openWaveform };
}

/**
 * 生成波形查看器 webview HTML（内联全部脚本与样式，Canvas 视口窗口渲染）。
 * 功能：信号树（折叠/排序/分组/单独显示/常量开关）、右键格式菜单（二级菜单，
 * Hex/Bin/Dec/SDec/模拟量）、边沿导航、游标吸附、模拟量行高拖拽、Shift 多选分组。
 * @param {ReturnType<typeof parseVcd>} vcd
 * @param {{fileName: string, timescale: string, cspSource: string}} meta
 * @returns {string}
 */
function buildWaveformHtml(vcd, meta) {
    const tree = buildSignalTree(vcd);
    const signals = [];
    for (const v of vcd.vars) {
        signals.push({
            id: v.id, name: v.name, path: v.path,
            width: v.width, type: v.type,
            changes: vcd.changes.get(v.id) || []
        });
    }
    const payload = {
        fileName: meta.fileName,
        timescale: meta.timescale,
        secondsPerTime: parseTimescaleSeconds(meta.timescale),
        endTime: vcd.endTime,
        tree,
        signals
    };
    // </script> 防提前闭合
    const json = JSON.stringify(payload).replace(/<\/script/gi, '<\\/script');

    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  :root {
    --bg:#1a1c1f; --panel:#202327; --panel2:#24272c; --border:#33373d;
    --fg:#d4d4d4; --dim:#8a8f98; --faint:#5a5f66;
    --accent:#4fc3f7; --bus:#ffcc80; --x:#ef5350; --cursor:#ffd54f;
    --sel:#2b3a4a; --hover:#2a2d33;
  }
  * { box-sizing: border-box; }
  body { margin:0; display:flex; flex-direction:column; height:100vh;
         background:var(--bg); color:var(--fg);
         font-family:'Segoe UI',Consolas,monospace; font-size:14px; }
  ::-webkit-scrollbar { width:11px; height:11px; }
  ::-webkit-scrollbar-thumb { background:#3a3f46; border-radius:5px; }
  ::-webkit-scrollbar-thumb:hover { background:#464c55; }
  ::-webkit-scrollbar-corner { background:transparent; }

  header { padding:8px 14px; background:var(--panel); border-bottom:1px solid var(--border);
           display:flex; gap:18px; align-items:baseline; }
  header b { font-weight:600; font-size:14px; }
  header .meta { color:var(--dim); font-size:13px; }

  #main { flex:1; display:flex; min-height:0; }
  #sigPanel { width:300px; min-width:210px; overflow:auto; border-right:1px solid var(--border);
              background:var(--panel); padding:0 0 14px; }
  .treeBar { display:flex; gap:6px; padding:5px 8px; border-bottom:1px solid var(--border); }
  .treeBar button { flex:none; font-size:11px; padding:2px 9px; }
  .treeBar button.on { border-color:#3a5a74; color:#9cdcfe; background:#253340; }
  .scope { color:#9cdcfe; padding:4px 10px; cursor:pointer; white-space:nowrap;
           font-family:Consolas,monospace; font-size:13px; display:flex; align-items:center; }
  .scope:hover { color:#c8e1ff; }
  .scope.solo { color:#ffd54f; }
  .scope .tw { color:var(--faint); margin-right:6px; width:11px; display:inline-block; }
  .sig { padding:4px 10px 4px 14px; cursor:pointer; white-space:nowrap; display:flex; gap:8px;
         align-items:center; font-family:Consolas,monospace; font-size:13px;
         border-left:2px solid transparent; }
  .sig:hover { background:var(--hover); }
  .sig.selected { background:var(--sel); border-left-color:var(--accent); }
  .sig.multisel { background:rgba(156,220,254,.2); border-left-color:#9cdcfe; }
  .sig .dot { width:9px; height:9px; flex:none; border-radius:2px; }
  .sig .dot.scalar { background:var(--accent); border-radius:50%; }
  .sig .dot.bus { background:var(--bus); }
  .sig .w { color:var(--faint); font-size:12px; }
  .hidden-note { color:var(--faint); padding:7px 12px; font-size:12px; }

  #right { flex:1; display:flex; flex-direction:column; min-width:0; }
  #cursorInfo { padding:5px 14px; background:var(--panel); border-bottom:1px solid var(--border);
                color:var(--cursor); min-height:1.4em; white-space:nowrap; overflow:hidden;
                text-overflow:ellipsis; font-family:Consolas,monospace; font-size:13px; }
  #cursorInfo .t { color:var(--dim); }
  #ruler { display:block; cursor:pointer; }
  #waveScroller { flex:1; overflow-y:auto; overflow-x:hidden; }
  #waveCanvas { display:block; cursor:crosshair; }

  footer { padding:6px 14px; background:var(--panel); border-top:1px solid var(--border);
           display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  button { background:var(--panel2); color:var(--fg); border:1px solid var(--border);
           border-radius:4px; padding:4px 13px; cursor:pointer; font-size:13px; }
  button:hover { background:#2c313a; border-color:#4a505a; }
  button.accent { border-color:#3a5a74; color:#9cdcfe; }
  button.accent:hover { background:#253340; }
  #navLabel { color:var(--dim); font-size:12px; max-width:280px; white-space:nowrap;
              overflow:hidden; text-overflow:ellipsis; }
  #zoomLabel { color:var(--dim); min-width:130px; text-align:center; font-size:12px; }
  .hint { color:var(--faint); font-size:12px; margin-left:auto; }

  .ctxMenu { position:fixed; z-index:10; background:#252526; border:1px solid #454545;
             border-radius:4px; padding:4px 0; min-width:170px;
             box-shadow:0 4px 14px rgba(0,0,0,.45); font-size:12px; }
  .ctxMenu.sub { position:absolute; left:100%; top:-5px; display:none; min-width:150px; }
  .ctxTitle { padding:4px 12px 5px; color:#8a8f98; font-size:11px;
              border-bottom:1px solid #33373d; margin-bottom:3px; }
  .ctxItem { padding:5px 14px; cursor:pointer; white-space:nowrap; position:relative; }
  .ctxItem:hover { background:#2a2d2e; }
  .ctxItem.cur { color:#9cdcfe; }
  .ctxItem.off { color:#5a5f66; cursor:default; }
  .ctxItem.off:hover { background:transparent; }
</style>
</head>
<body>
<header>
  <b id="title"></b>
  <span class="meta" id="tsInfo"></span>
  <span class="meta" id="endTime"></span>
</header>
<div id="main">
  <div id="sigPanel"></div>
  <div id="right">
    <div id="cursorInfo"><span class="t">点击波形行放游标（边沿自动吸附）· 双击树层级单独显示</span></div>
    <canvas id="ruler" height="28"></canvas>
    <div id="waveScroller"><canvas id="waveCanvas"></canvas></div>
  </div>
</div>
<footer>
  <button id="prevEdge" class="accent" title="上一个边沿（←）">◀ 沿</button>
  <button id="nextEdge" class="accent" title="下一个边沿（→）">沿 ▶</button>
  <span id="navLabel">边沿: (点击波形行选择)</span>
  <button id="zoomOut" title="缩小">−</button>
  <span id="zoomLabel"></span>
  <button id="zoomIn" title="放大">＋</button>
  <button id="zoomFit" title="适配全程">Fit</button>
  <span class="hint">Ctrl+滚轮缩放 · 左右滚轮（或 Shift+滚轮）平移时间轴 · 上下滚轮滚动信号行 · 名称栏拖拽调序 · Ctrl 单选 / Shift 范围多选后右键分组（可命名）</span>
</footer>
<script>
const DATA = ${json};
</script>
<script>
/* 波形渲染（视口窗口模型）：只画 [viewStart, viewStart+viewSpan] 窗口内的变更段 */
(function () {
  var RULER_H = 28, ROW_H = 30, NAME_W = 185, EDGE = 7;
  var canvas = document.getElementById('waveCanvas');
  var ruler = document.getElementById('ruler');
  var scroller = document.getElementById('waveScroller');
  var sigPanel = document.getElementById('sigPanel');
  var cursorInfo = document.getElementById('cursorInfo');
  var zoomLabel = document.getElementById('zoomLabel');
  var navLabel = document.getElementById('navLabel');

  var END = DATA.endTime > 0 ? DATA.endTime : 1;
  var SEC = (typeof DATA.secondsPerTime === 'number') ? DATA.secondsPerTime : 1e-9;
  var viewStart = 0, viewSpan = END;
  var cursorT = null;
  var edgeSig = null;          // 边沿导航目标信号
  var dragging = null;         // 横向平移拖拽
  var heightDrag = null;       // 模拟量行高拖拽
  var collapsed = {};          // scope 路径 -> 是否折叠
  var soloScope = null;        // 单独显示的 scope 路径（双击层级设置）
  var soloPrevChecked = null;  // 进入 solo 前的勾选状态快照
  var sortMode = 'default';    // 'default'（VCD 原始顺序）| 'name'
  var groupByScope = false;    // 按模块分组显示
  var showConst = false;       // 常量（parameter）显示开关，默认隐藏，显示时沉底
  var fmt = {};                // key -> 显示格式：'hex'(默认) | 'bin' | 'dec' | 'sdec' | 'analog'
  var heights = {};            // key -> 模拟量行高倍率
  var menuEl = null;           // 右键菜单元素
  var multiSel = {};           // key -> true（Ctrl/Shift 多选，用于分组）
  var lastTreeIdx = -1;        // 树中最近一次普通点击的信号行序号（Shift 范围选择锚点）
  var lastWaveIdx = -1;        // 波形区最近一次普通点击的行序号（Shift 范围选择锚点）
  var groups = {};             // key -> 自定义分组 id
  var groupNames = {};         // gid -> 组名
  var nextGid = 1;
  var manualRank = {};         // key -> 手动排序号（名称栏拖拽调序，优先于分组/排序）
  var showFullName = false;    // 名称栏显示全名（层级路径）还是简称
  var reorderDrag = null;      // {fromIdx,toIdx,moved,startY} 名称栏拖拽调序状态
  var suppressNextClick = false;

  var selected = [];           // 当前显示的行（applyRows 派生）
  var byId = {};               // key: id|path -> signal 对象
  var origIdx = {};            // key -> DATA.signals 中的原始顺序
  var noChangeCount = 0;
  var checked = {};            // key -> 是否显示在波形区
  DATA.signals.forEach(function (s, i) {
    var k = s.id + '|' + s.path;
    byId[k] = s;
    origIdx[k] = i;
    if (s.changes.length > 0 && !isConstSig(s)) checked[k] = true;
    else if (!isConstSig(s)) noChangeCount++;
  });

  function keyOf(s) { return s.id + '|' + s.path; }
  function isConstSig(s) { return /parameter/i.test(s.type); }
  function plotW() { return Math.max(canvas.clientWidth - NAME_W - 12, 50); }
  function viewEnd() { return viewStart + viewSpan; }
  function t2x(t) { return NAME_W + (t - viewStart) / viewSpan * plotW(); }
  function x2t(x) { return viewStart + (x - NAME_W) / plotW() * viewSpan; }

  function fmtSeconds(sec) {
    var abs = Math.abs(sec);
    var units = [[1e-12,'ps'],[1e-9,'ns'],[1e-6,'us'],[1e-3,'ms'],[1,'s']];
    for (var i = 0; i < units.length; i++) {
      if (abs < units[i][0] * (i < units.length-1 ? 500 : 1e9) || i === units.length-1) {
        if (abs < units[i][0]) continue;
        var v = sec / units[i][0];
        return (Math.round(v * 1000) / 1000) + ' ' + units[i][1];
      }
    }
    return sec + ' s';
  }
  function fmtTime(t) { return fmtSeconds(t * SEC); }

  // ---------- 信号树 ----------
  function depthOf(path) { var n = 0, i = path.indexOf('.'); while (i >= 0) { n++; i = path.indexOf('.', i + 1); } return n; }

  function renderTree() {
    sigPanel.innerHTML = '';
    var bar = document.createElement('div');
    bar.className = 'treeBar';
    function barBtn(text, title, on, cb) {
      var b = document.createElement('button');
      b.textContent = text; b.title = title;
      b.className = on ? 'on' : '';
      b.onclick = cb;
      bar.appendChild(b);
      return b;
    }
    barBtn('名称排序', '按信号名排序显示（再点一次恢复原始顺序，并清除拖拽手动排序）', sortMode === 'name', function () {
      sortMode = sortMode === 'name' ? 'default' : 'name';
      manualRank = {};
      applyRows(); renderTree(); draw();
    });
    barBtn('按模块分组', '按所属层级路径分组排列（并清除拖拽手动排序）', groupByScope, function () {
      groupByScope = !groupByScope;
      if (groupByScope) sortMode = 'default';
      manualRank = {};
      applyRows(); renderTree(); draw();
    });
    barBtn('常量', '显示/隐藏 parameter 常量（默认隐藏，显示时沉底到列表末尾）', showConst, function () {
      showConst = !showConst;
      DATA.signals.forEach(function (s) {
        if (isConstSig(s) && s.changes.length > 0) {
          if (showConst) checked[keyOf(s)] = true;
          else delete checked[keyOf(s)];
        }
      });
      applyRows(); renderTree(); draw();
    });
    barBtn('全部显示', '退出单独显示，恢复之前的信号勾选状态', !!soloScope, function () {
      if (!soloScope) return;
      exitSolo();
      applyRows(); renderTree(); draw();
    });
    barBtn(showFullName ? '全名 ✓' : '全名', '波形名称栏显示完整层级路径 ↔ 短名（类似 Vivado）', showFullName, function () {
      showFullName = !showFullName;
      NAME_W = showFullName ? 300 : 185;
      renderTree(); draw();
    });
    sigPanel.appendChild(bar);
    var hint = document.createElement('div');
    hint.className = 'hidden-note';
    hint.textContent = '单击折叠/展开 · 双击层级=单独显示 · Ctrl 单选 / Shift 范围多选（树与波形行均可）';
    sigPanel.appendChild(hint);

    var selectedKeys = {};
    selected.forEach(function (s) { selectedKeys[keyOf(s)] = 1; });
    var flatIdx = -1;
    (function walk(nodes) {
      nodes.forEach(function (node) {
        if (node.children) {
          var isCollapsed = !!collapsed[node.path];
          var d = depthOf(node.path);
          var div = document.createElement('div');
          div.className = 'scope' + (soloScope === node.path ? ' solo' : '');
          div.style.paddingLeft = (10 + d * 15) + 'px';
          div.innerHTML = '<span class="tw">' + (isCollapsed ? '▸' : '▾') + '</span>' + esc(node.name);
          div.title = '单击折叠/展开 · 双击单独显示该层级';
          div.onclick = function () {
            if (collapsed[node.path]) delete collapsed[node.path];
            else collapsed[node.path] = true;
            renderTree();
          };
          div.ondblclick = function () {
            if (soloScope === node.path) exitSolo();
            else { if (soloScope) exitSolo(); enterSolo(node.path); }
            applyRows(); renderTree(); draw();
          };
          sigPanel.appendChild(div);
          if (!isCollapsed) walk(node.children);
        } else {
          flatIdx++;
          var myIdx = flatIdx; // 闭包按值捕获本行序号（共享变量在遍历后会保持末值）
          var pd = node.path.lastIndexOf('.') >= 0 ? depthOf(node.path.slice(0, node.path.lastIndexOf('.'))) + 1 : 0;
          var key = keyOf(node);
          var row = document.createElement('div');
          var isSel = selectedKeys[key] === 1;
          row.className = 'sig' + (isSel ? ' selected' : '') + (multiSel[key] ? ' multisel' : '');
          row.style.paddingLeft = (14 + pd * 15) + 'px';
          row.innerHTML = '<span class="dot ' + (node.width > 1 ? 'bus' : 'scalar') + '"></span>' +
            '<span>' + esc(node.name) + '</span>' +
            '<span class="w">' + (node.width > 1 ? node.width + 'b' : '') + '</span>';
          row.onclick = function (ev) {
            if (ev && (ev.ctrlKey || ev.metaKey)) {
              if (node.hasChanges) toggleMultiSelOf(byId[key] || node);
              return;
            }
            if (ev && ev.shiftKey) { shiftSelect(myIdx); return; }
            if (multiSelCount() > 0) { multiSel = {}; }
            lastTreeIdx = myIdx;
            toggleSignal(node);
          };
          row.oncontextmenu = function (ev) {
            ev.preventDefault();
            lastTreeIdx = myIdx;
            var full = byId[key];
            if (!full) return;
            var sigs = multiSel[key] ? multiSelSignals() : [full];
            showSigMenu(ev.clientX, ev.clientY, sigs);
          };
          sigPanel.appendChild(row);
        }
      });
    })(DATA.tree.children);
    if (noChangeCount > 0) {
      var note = document.createElement('div');
      note.className = 'hidden-note';
      note.textContent = '(' + noChangeCount + ' 个无变更信号已隐藏)';
      sigPanel.appendChild(note);
    }
  }
  function multiSelCount() { var n = 0, k; for (k in multiSel) n++; return n; }
  function multiSelSignals() {
    return DATA.signals.filter(function (s) { return multiSel[keyOf(s)]; });
  }
  function toggleMultiSelOf(sig) {
    var k = keyOf(sig);
    if (multiSel[k]) delete multiSel[k]; else multiSel[k] = true;
    renderTree();
    draw();
  }
  function waveRangeSelect(idx) {
    if (lastWaveIdx < 0) lastWaveIdx = idx;
    var lo = Math.min(lastWaveIdx, idx), hi = Math.max(lastWaveIdx, idx);
    for (var i = lo; i <= hi && i < selected.length; i++) {
      multiSel[keyOf(selected[i])] = true;
    }
    renderTree();
    draw();
  }
  function shiftSelect(idx) {
    var rows = treeSignalRows();
    if (lastTreeIdx < 0) lastTreeIdx = idx;
    var lo = Math.min(lastTreeIdx, idx), hi = Math.max(lastTreeIdx, idx);
    for (var i = lo; i <= hi && i < rows.length; i++) {
      var node = rows[i];
      if (node.hasChanges) multiSel[keyOf(node)] = true;
    }
    renderTree();
  }
  function treeSignalRows() {
    var arr = [];
    (function walk(nodes) {
      nodes.forEach(function (node) {
        if (node.children) {
          if (collapsed[node.path]) return;
          walk(node.children);
        } else arr.push(node);
      });
    })(DATA.tree.children);
    return arr;
  }
  function scopeOf(sig) {
    var i = sig.path.lastIndexOf('.');
    return i >= 0 ? sig.path.slice(0, i) : '(顶层)';
  }
  function computeRows() {
    var normal = [], consts = [];
    DATA.signals.forEach(function (s) {
      if (s.changes.length === 0) return;
      if (isConstSig(s)) { consts.push(s); return; }
      if (soloScope && s.path.slice(0, soloScope.length + 1) !== soloScope + '.') return;
      normal.push(s);
    });
    var hasCustom = false, k;
    for (k in groups) { hasCustom = true; break; }
    var hasManual = false;
    for (k in manualRank) { hasManual = true; break; }
    if (hasManual) {
      // 手动拖拽排序优先（未参与拖拽的信号按原始顺序沉到后面）
      normal.sort(function (a, b) {
        var ra = manualRank[keyOf(a)], rb = manualRank[keyOf(b)];
        if (ra === undefined) ra = Infinity;
        if (rb === undefined) rb = Infinity;
        if (ra !== rb) return ra - rb;
        return (origIdx[keyOf(a)] || 0) - (origIdx[keyOf(b)] || 0);
      });
    } else if (hasCustom) {
      normal.sort(function (a, b) {
        var ga = groups[keyOf(a)] || 2147483647, gb = groups[keyOf(b)] || 2147483647;
        if (ga !== gb) return ga - gb;
        if (sortMode === 'name') {
          var c = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
          if (c) return c;
        }
        return (origIdx[keyOf(a)] || 0) - (origIdx[keyOf(b)] || 0);
      });
    } else if (groupByScope) {
      normal.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
    } else if (sortMode === 'name') {
      normal.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : (a.path < b.path ? -1 : 1); });
    }
    if (showConst) {
      consts.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
      return normal.concat(consts);   // 常量沉底
    }
    return normal;
  }
  function applyRows() {
    selected = computeRows().filter(function (s) { return checked[keyOf(s)]; });
  }
  function applyManualOrder(from, to) {
    if (to === from || to === from + 1) return;
    var arr = selected.slice();
    var moved = arr.splice(from, 1)[0];
    arr.splice(to > from ? to - 1 : to, 0, moved);
    arr.forEach(function (s, i) { manualRank[keyOf(s)] = i; });
    applyRows(); renderTree();
    console.log('DBG after applyRows selected=', selected.slice(0, 3).map(function (s) { return s.name; }).join(','));
  }
  function enterSolo(scopePath) {
    soloScope = scopePath;
    soloPrevChecked = Object.assign({}, checked);
    DATA.signals.forEach(function (s) {
      if (s.changes.length > 0 && s.path.slice(0, scopePath.length + 1) === scopePath + '.') {
        checked[keyOf(s)] = true;
      }
    });
  }
  function exitSolo() {
    if (soloPrevChecked) { checked = soloPrevChecked; soloPrevChecked = null; }
    soloScope = null;
  }
  function toggleSignal(node) {
    if (!node.hasChanges) return;
    var key = keyOf(node);
    if (checked[key]) {
      delete checked[key];
      if (edgeSig && keyOf(edgeSig) === key) {
        edgeSig = null;
        navLabel.textContent = '边沿: (点击波形行选择)';
      }
    } else {
      checked[key] = true;
    }
    applyRows();
    renderTree();
    draw();
  }

  // ---------- 值定位 / 格式化 ----------
  function firstVisibleIdx(list) {
    var lo = 0, hi = list.length - 1, ans = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (list[mid].t <= viewStart) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }
  function valueAt(sig, t) {
    var list = sig.changes;
    if (!list.length) return '?';
    var v = list[0].value;
    for (var i = 0; i < list.length; i++) {
      if (list[i].t <= t) v = list[i].value; else break;
    }
    return v;
  }
  function hexOf(bin) {
    try { return BigInt('0b' + (bin || '0')).toString(16).toUpperCase(); }
    catch (e) { return null; }
  }
  function sigFmt(sig) {
    return fmt[keyOf(sig)] || (sig.type === 'real' ? 'analog' : 'hex');
  }
  function fmtValue(sig, v) {
    if (sig.type === 'real') return v;
    if (/[^01]/.test(v)) return v;
    if (sigFmt(sig) === 'bin') return '0b' + v;
    if (sigFmt(sig) === 'dec') {
      try { return BigInt('0b' + v).toString(10); } catch (e) { return v; }
    }
    if (sigFmt(sig) === 'sdec') {
      try {
        var n = BigInt('0b' + v);
        if (sig.width > 1 && n >= (BigInt(1) << BigInt(sig.width - 1))) {
          n -= (BigInt(1) << BigInt(sig.width));
        }
        return n.toString(10);
      } catch (e) { return v; }
    }
    var hx = hexOf(v);
    return hx !== null ? '0x' + hx : v;
  }
  function numOf(sig, v) {
    if (sig.type === 'real') { var r = Number(v); return isFinite(r) ? r : null; }
    if (/[^01]/.test(v)) return null;
    try {
      var n = BigInt('0b' + v);
      if (sigFmt(sig) === 'sdec' && sig.width > 1 && n >= (BigInt(1) << BigInt(sig.width - 1))) {
        n -= (BigInt(1) << BigInt(sig.width));
      }
      var f = Number(n);
      return isFinite(f) ? f : null;
    } catch (e) { return null; }
  }
  function truncText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
  }

  // ---------- 游标与边沿导航 ----------
  function cursorInfoHtml(t, sig) {
    var html = '<span class="t">t =</span> ' + esc(fmtTime(t)) +
      ' <span class="t">(' + t + ' ticks)</span>';
    if (sig) {
      var v = valueAt(sig, t);
      var pretty;
      if (sig.width > 1) {
        pretty = esc(fmtValue(sig, v));
        if (fmt[keyOf(sig)] && fmt[keyOf(sig)] !== 'hex' && !/[^01]/.test(v)) {
          var hx = hexOf(v);
          if (hx !== null) pretty += ' <span class="t">(0x' + hx + ')</span>';
        }
      } else {
        pretty = esc(v);
      }
      html += '   <span style="color:' + (sig.width > 1 ? '#ffcc80' : '#4fc3f7') + '">' +
        esc(sig.path) + '</span> = ' + pretty;
    }
    return html;
  }
  function applyCursor(t, sig, recenter) {
    cursorT = Math.min(Math.max(t, 0), END);
    if (sig) {
      edgeSig = sig;
      navLabel.textContent = '边沿: ' + sig.path;
      navLabel.title = sig.path;
    }
    if (recenter) {
      var x = t2x(cursorT);
      if (x < NAME_W || x > canvas.clientWidth - 12) {
        viewStart = cursorT - viewSpan / 2;
        clampView();
      }
    }
    cursorInfo.innerHTML = cursorInfoHtml(cursorT, sig || edgeSig);
    draw();
  }
  function edgeStep(dir) {
    if (!edgeSig) {
      cursorInfo.innerHTML = '<span class="t">请先点击一个波形行，选它作为边沿导航信号</span>';
      return;
    }
    var list = edgeSig.changes;
    if (!list.length) return;
    var EPS = 1e-9, t = null;
    var i;
    if (dir > 0) {
      for (i = 0; i < list.length; i++) { if (list[i].t > cursorT + EPS) { t = list[i].t; break; } }
    } else {
      for (i = list.length - 1; i >= 0; i--) { if (list[i].t < cursorT - EPS) { t = list[i].t; break; } }
    }
    if (t === null) {
      cursorInfo.innerHTML = '<span class="t">已是 ' + (dir > 0 ? '最后一个' : '最早一个') +
        '边沿（' + esc(edgeSig.name) + '）</span>';
      return;
    }
    applyCursor(t, edgeSig, true);
  }

  // ---------- 行布局（模拟量行高可变） ----------
  var layout = { tops: [], hs: [], total: 0 };
  function rowHeightOf(sig) {
    return sigFmt(sig) === 'analog' ? ROW_H * (heights[keyOf(sig)] || 1) : ROW_H;
  }
  function buildLayout() {
    layout.tops = []; layout.hs = [];
    var y = 0;
    selected.forEach(function (s) {
      var h = rowHeightOf(s);
      layout.tops.push(y); layout.hs.push(h);
      y += h;
    });
    layout.total = y;
  }
  function rowIndexAt(y) {
    for (var i = 0; i < selected.length; i++) {
      if (y >= layout.tops[i] && y < layout.tops[i] + layout.hs[i]) return i;
    }
    return -1;
  }

  // ---------- 绘制 ----------
  function draw() {
    buildLayout();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(document.getElementById('right').clientWidth, 100);
    var h = Math.max(layout.total + 8, scroller.clientHeight);
    setup(canvas, w, h, dpr);
    setup(ruler, w, RULER_H, dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '12px Consolas,monospace';

    var ticks = computeTicks();
    drawGrid(ctx, w, ticks);

    // 分组边界：自定义分组优先，其次按模块分组，常量块恒有分隔
    var groupStarts = {};
    var hasCustom = false, k;
    for (k in groups) { hasCustom = true; break; }
    if (hasCustom) {
      var prevC = null;
      selected.forEach(function (s, i) {
        var g = groups[keyOf(s)] || 0;
        if (g !== prevC) { groupStarts[i] = g === 0 ? '(未分组)' : (groupNames[g] || ('组' + g)); prevC = g; }
      });
    } else if (groupByScope) {
      var prevG = null;
      selected.forEach(function (s, i) {
        var g = scopeOf(s);
        if (g !== prevG) { groupStarts[i] = g; prevG = g; }
      });
    }
    if (showConst) {
      for (var ci = 0; ci < selected.length; ci++) {
        if (isConstSig(selected[ci])) { groupStarts[ci] = '(常量)'; break; }
      }
    }

    if (selected.length === 0) {
      ctx.fillStyle = '#5a5f66';
      ctx.fillText(soloScope
        ? ('(层级 ' + soloScope + ' 下没有正在显示的信号)')
        : '(在左侧信号树中点击信号以添加波形)', NAME_W + 16, 34);
      finish(ctx, w, h, dpr, ticks, -1, groupStarts);
      return;
    }

    var edgeRow = -1;
    if (edgeSig) {
      for (var r = 0; r < selected.length; r++) {
        if (selected[r] === edgeSig) { edgeRow = r; break; }
      }
    }

    selected.forEach(function (sig, i) {
      var yTop = layout.tops[i], hh = layout.hs[i];
      if (i === edgeRow) {
        ctx.fillStyle = 'rgba(255,213,79,.06)';
        ctx.fillRect(0, yTop, w, hh);
      } else if (i % 2) {
        ctx.fillStyle = 'rgba(255,255,255,.028)';
        ctx.fillRect(0, yTop, w, hh);
      }
      var f = sigFmt(sig);
      var stroke = f === 'analog' ? '#4fc3f7' : (sig.width > 1 ? '#ffcc80' : '#4fc3f7');
      var fill = sig.width > 1 ? 'rgba(255,204,128,.14)' : 'rgba(79,195,247,.12)';
      ctx.strokeStyle = stroke; ctx.fillStyle = stroke; ctx.lineWidth = 1.5;
      if (f === 'analog') drawAnalog(ctx, sig, yTop, hh);
      else if (sig.width === 1 && sig.type !== 'real') drawScalar(ctx, sig, yTop, hh);
      else drawBus(ctx, sig, yTop, hh, fill);
    });
    finish(ctx, w, h, dpr, ticks, edgeRow, groupStarts);
  }

  function finish(ctx, w, h, dpr, ticks, edgeRow, groupStarts) {
    // 分组加强分隔线（自定义分组 / 按模块分组 / 常量块）
    ctx.strokeStyle = 'rgba(79,195,247,.28)';
    ctx.beginPath();
    for (var g in groupStarts) {
      var rowIdx = parseInt(g, 10);
      if (rowIdx > 0) {
        var yy = layout.tops[rowIdx] + 0.5;
        ctx.moveTo(0, yy); ctx.lineTo(w, yy);
      }
    }
    ctx.stroke();
    drawNames(ctx, h, edgeRow, groupStarts);
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.beginPath();
    for (var i = 1; i < selected.length; i++) {
      if (groupStarts[i] !== undefined) continue; // 分组处已画加强线
      ctx.moveTo(0, layout.tops[i] + 0.5); ctx.lineTo(w, layout.tops[i] + 0.5);
    }
    ctx.stroke();
    // 拖拽调序：插入位置指示线
    if (reorderDrag && reorderDrag.moved) {
      var iy = reorderDrag.toIdx >= selected.length
        ? layout.total + 0.5
        : layout.tops[reorderDrag.toIdx] + 0.5;
      ctx.save();
      ctx.strokeStyle = '#ffd54f'; ctx.lineWidth = 2; ctx.setLineDash([7, 4]);
      ctx.beginPath(); ctx.moveTo(0, iy); ctx.lineTo(w, iy); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#ffd54f';
      ctx.beginPath();
      ctx.moveTo(2, iy - 5); ctx.lineTo(10, iy); ctx.lineTo(2, iy + 5);
      ctx.closePath(); ctx.fill();
    }
    if (cursorT !== null) {
      var x = t2x(cursorT);
      if (x >= NAME_W && x <= w) {
        ctx.save();
        ctx.strokeStyle = '#ffd54f'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        ctx.restore();
      }
    }
    drawRuler(w, dpr, ticks);
    zoomLabel.textContent = '可见 ' + fmtTime(viewSpan);
  }
  function hasCustomGroups() {
    for (var k in groups) return true;
    return false;
  }

  function setup(c, w, h, dpr) {
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = w + 'px'; c.style.height = h + 'px';
  }

  function computeTicks() {
    var secPerPx = SEC * viewSpan / plotW();
    var targetSec = secPerPx * 110;
    var pow = Math.pow(10, Math.floor(Math.log10(Math.max(targetSec, 1e-18))));
    var step = pow;
    [5, 2, 1].some(function (m) { if (targetSec <= m * pow) { step = m * pow; return true; } return false; });
    var stepT = Math.max(step / SEC, viewSpan / 14);
    var guard = 0;
    while (viewSpan / stepT > 40 && guard++ < 20) stepT *= 2;
    var list = [];
    for (var t = Math.ceil(viewStart / stepT) * stepT; t <= viewEnd(); t += stepT) {
      list.push(t);
      if (list.length > 60) break;
    }
    return list;
  }

  function drawGrid(ctx, w, ticks) {
    ctx.strokeStyle = 'rgba(255,255,255,.045)';
    ctx.beginPath();
    ticks.forEach(function (t) {
      var x = t2x(t);
      if (x >= NAME_W) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, layout.total); }
    });
    ctx.stroke();
  }

  function drawNames(ctx, h, edgeRow, groupStarts) {
    ctx.fillStyle = '#202327';
    ctx.fillRect(0, 0, NAME_W, h);
    ctx.strokeStyle = '#33373d';
    ctx.beginPath(); ctx.moveTo(NAME_W + 0.5, 0); ctx.lineTo(NAME_W + 0.5, h); ctx.stroke();
    ctx.font = '12px Consolas,monospace';
    selected.forEach(function (sig, i) {
      var yTop = layout.tops[i], hh = layout.hs[i];
      var isGroupStart = groupStarts && groupStarts[i] !== undefined;
      var y = yTop + hh / 2 + 4;
      if (isGroupStart) {
        ctx.fillStyle = 'rgba(79,195,247,.06)';
        ctx.fillRect(0, yTop, NAME_W, hh);
        ctx.fillStyle = '#9cdcfe';
        ctx.font = '10px Consolas,monospace';
        ctx.fillText(truncText(ctx, groupStarts[i], NAME_W - 20), 8, yTop + 11);
        ctx.font = '12px Consolas,monospace';
        y = yTop + hh - 8;
      }
      if (i === edgeRow) {
        ctx.fillStyle = 'rgba(255,213,79,.08)';
        ctx.fillRect(0, yTop, NAME_W, hh);
      }
      if (multiSel[keyOf(sig)]) {
        ctx.fillStyle = 'rgba(156,220,254,.16)';
        ctx.fillRect(0, yTop, NAME_W, hh);
        ctx.fillStyle = '#9cdcfe';
        ctx.fillRect(0, yTop, 3, hh);
      }
      if (reorderDrag && i === reorderDrag.fromIdx) {
        ctx.fillStyle = 'rgba(255,213,79,.18)';
        ctx.fillRect(0, yTop, NAME_W, hh);
        ctx.fillStyle = '#ffd54f';
        ctx.fillRect(0, yTop, 3, hh);
      }
      ctx.fillStyle = sig.width > 1 ? '#ffcc80' : '#4fc3f7';
      ctx.beginPath();
      if (sig.width > 1) ctx.fillRect(10, y - 9, 8, 8);
      else { ctx.arc(14, y - 5, 4, 0, 7); ctx.fill(); }
      ctx.fillStyle = multiSel[keyOf(sig)] ? '#9cdcfe' : (i === edgeRow ? '#ffe9a8' : '#d4d4d4');
      ctx.fillText(truncText(ctx, showFullName ? sig.path : sig.name, NAME_W - 46), 24, y);
      var f2 = sigFmt(sig);
      if (f2 !== 'hex') {
        var badge = { bin: 'B', dec: 'D', sdec: 'S', analog: 'A' }[f2] || '';
        if (badge) {
          ctx.fillStyle = '#9cdcfe';
          ctx.font = '10px Consolas,monospace';
          ctx.fillText(badge, NAME_W - 16, y);
          ctx.font = '12px Consolas,monospace';
        }
      }
    });
  }

  function drawRuler(w, dpr, ticks) {
    var ctx = ruler.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, RULER_H);
    ctx.font = '11px Consolas,monospace';
    ctx.fillStyle = '#202327'; ctx.fillRect(0, 0, NAME_W, RULER_H);
    ctx.strokeStyle = '#33373d';
    ctx.beginPath(); ctx.moveTo(NAME_W + 0.5, 0); ctx.lineTo(NAME_W + 0.5, RULER_H); ctx.stroke();
    ctx.fillStyle = '#8a8f98';
    ctx.fillText('时间', 10, 18);
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.fillStyle = '#8a8f98';
    ctx.beginPath();
    var lastLabelEnd = -1;
    ticks.forEach(function (t) {
      var x = t2x(t);
      ctx.moveTo(x + 0.5, RULER_H - 10); ctx.lineTo(x + 0.5, RULER_H);
      var label = fmtSeconds(t * SEC);
      var lw = ctx.measureText(label).width;
      if (x >= NAME_W - 4 && x - lastLabelEnd > 8 && x + lw <= w + 4) {
        ctx.fillText(label, x + 4, 11);
        lastLabelEnd = x + lw;
      }
    });
    ctx.stroke();
    var ovY = RULER_H - 4;
    ctx.fillStyle = 'rgba(79,195,247,.25)';
    ctx.fillRect(NAME_W, ovY, plotW(), 3);
    ctx.fillStyle = '#4fc3f7';
    var wx = NAME_W + viewStart / END * plotW();
    var ww = Math.max(viewSpan / END * plotW(), 6);
    ctx.fillRect(wx, ovY - 1, ww, 5);
    if (cursorT !== null) {
      var x = t2x(cursorT);
      if (x >= NAME_W && x <= w) {
        var label = fmtTime(cursorT);
        var tw = ctx.measureText(label).width + 12;
        var bx = Math.min(Math.max(x - tw / 2, NAME_W), w - tw);
        ctx.fillStyle = '#ffd54f';
        ctx.fillRect(bx, 0, tw, 16);
        ctx.fillStyle = '#1a1c1f';
        ctx.fillText(label, bx + 6, 12);
      }
    }
  }

  function levelY(yTop, v) {
    return v === '1' ? yTop + 7 : (v === '0' ? yTop + ROW_H - 10 : yTop + ROW_H / 2);
  }

  function drawScalar(ctx, sig, yTop) {
    var list = sig.changes;
    var i0 = firstVisibleIdx(list);
    var yXm = yTop + ROW_H / 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    for (var i = i0; i < list.length; i++) {
      var t1 = Math.max(list[i].t, viewStart);
      if (t1 > viewEnd()) break;
      var t2 = (i + 1 < list.length) ? list[i + 1].t : viewEnd();
      var x1 = t2x(t1), x2 = t2x(Math.min(t2, viewEnd()));
      var v = list[i].value;
      if (v === '1' || v === '0') {
        var y = levelY(yTop, v);
        ctx.moveTo(x1, y); ctx.lineTo(x2 + 1, y);
      } else {
        ctx.moveTo(x1, yXm - 3); ctx.lineTo(x2 + 1, yXm - 3);
        ctx.moveTo(x1, yXm + 3); ctx.lineTo(x2 + 1, yXm + 3);
      }
      if (i + 1 < list.length && list[i + 1].t <= viewEnd() && x2 > NAME_W) {
        var vN = list[i + 1].value;
        var yA = levelY(yTop, (v === '1' || v === '0') ? v : 'x');
        var yB = levelY(yTop, (vN === '1' || vN === '0') ? vN : 'x');
        if (yA !== yB) { ctx.moveTo(x2, yA); ctx.lineTo(x2, yB); }
      }
    }
    ctx.stroke();
    ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
  }

  function drawBus(ctx, sig, yTop, rowH, fill) {
    var list = sig.changes;
    var i0 = firstVisibleIdx(list);
    var yT = yTop + 7, yB = yTop + rowH - 10, yM = yTop + rowH / 2;
    for (var i = i0; i < list.length; i++) {
      var t1 = Math.max(list[i].t, viewStart);
      if (t1 > viewEnd()) break;
      var t2 = (i + 1 < list.length) ? list[i + 1].t : viewEnd();
      var x1 = Math.max(t2x(t1), NAME_W), x2 = Math.min(t2x(t2), t2x(viewEnd()));
      if (x2 - x1 < 1) continue;
      var v = list[i].value;
      if (/[^01]/.test(v)) {
        ctx.save();
        ctx.strokeStyle = '#ef5350';
        ctx.beginPath();
        ctx.moveTo(x1, yM - 3); ctx.lineTo(x2, yM - 3);
        ctx.moveTo(x1, yM); ctx.lineTo(x2, yM);
        ctx.moveTo(x1, yM + 3); ctx.lineTo(x2, yM + 3);
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = '#ffcc80';
        continue;
      }
      if (x2 - x1 < 4) continue;
      var pad = Math.min(EDGE, (x2 - x1) / 3);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(x1 + pad, yT); ctx.lineTo(x2 - pad, yT);
      ctx.lineTo(x2, yM); ctx.lineTo(x2 - pad, yB);
      ctx.lineTo(x1 + pad, yB); ctx.lineTo(x1, yM);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      var label = fmtValue(sig, v);
      var tw = ctx.measureText(label).width;
      if (x2 - x1 >= 48 && tw < x2 - x1 - 14) {
        var cx = (x1 + x2) / 2;
        ctx.fillStyle = 'rgba(26,28,31,.85)';
        ctx.fillRect(cx - tw / 2 - 4, yM - 8, tw + 8, 16);
        ctx.fillStyle = '#ffe0b2';
        ctx.fillText(label, cx - tw / 2, yM + 4);
      }
    }
  }

  function drawAnalog(ctx, sig, yTop, rowH) {
    var list = sig.changes;
    if (!list.length) return;
    var yTopPad = yTop + 5, yBotPad = yTop + rowH - 7;
    var min = null, max = null, nums = [];
    for (var i = 0; i < list.length; i++) {
      var n0 = numOf(sig, list[i].value);
      nums.push(n0);
      if (n0 === null) continue;
      if (min === null || n0 < min) min = n0;
      if (max === null || n0 > max) max = n0;
    }
    if (min === null) return;
    if (min === max) { min = min - 1; max = max + 1; }
    else { var pad2 = (max - min) * 0.06; min -= pad2; max += pad2; }
    var started = false;
    ctx.beginPath();
    var right = canvas.clientWidth;
    for (var j = 0; j < list.length; j++) {
      var t1 = list[j].t, t2 = (j + 1 < list.length) ? list[j + 1].t : viewEnd();
      var x1 = t2x(Math.max(t1, viewStart)), x2 = t2x(Math.min(t2, viewEnd()));
      if (x2 < NAME_W) { started = false; continue; }
      if (x1 > right) break;
      var n1 = nums[j];
      if (n1 === null) { started = false; continue; }
      var y = yBotPad - (n1 - min) / (max - min) * (yBotPad - yTopPad);
      if (!started) { ctx.moveTo(Math.max(x1, NAME_W), y); started = true; }
      else ctx.lineTo(x1, y);
      ctx.lineTo(x2, y);
    }
    ctx.stroke();
  }

  // ---------- 视图控制 ----------
  function clampView() {
    viewSpan = Math.min(Math.max(viewSpan, END / 1e9), END * 1.2);
    viewStart = Math.min(Math.max(viewStart, 0), Math.max(END - viewSpan, 0));
  }
  function zoomAt(factor, anchorX) {
    var tAnchor = x2t(anchorX != null ? anchorX : (NAME_W + plotW() / 2));
    viewSpan = viewSpan / factor;
    clampView();
    viewStart = tAnchor - ((anchorX != null ? anchorX : NAME_W + plotW() / 2) - NAME_W) / plotW() * viewSpan;
    clampView();
    draw();
  }

  document.getElementById('right').addEventListener('wheel', function (e) {
    if (e.ctrlKey) {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.offsetX);
      return;
    }
    // 归一化 deltaMode（Firefox 按行/页，Chromium/WebKit 按像素）
    var mul = e.deltaMode === 1 ? 33 : (e.deltaMode === 2 ? (scroller.clientHeight || 600) : 1);
    var dx = e.deltaX * mul, dy = e.deltaY * mul;
    var horiz = Math.abs(dx) > Math.abs(dy) || e.shiftKey;
    if (horiz) {
      // 左右滚轮（倾斜轮/触控板横扫，或 Shift+滚轮）：平移时间轴
      e.preventDefault();
      var amt = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      viewStart += amt * viewSpan / plotW();
      clampView();
      draw();
    } else if (dy !== 0) {
      // 上下滚轮：滚动查看上方/下方信号行（ruler 上滚动同样生效）
      if (scroller.scrollHeight > scroller.clientHeight + 1) e.preventDefault();
      scroller.scrollTop += dy;
    }
  }, { passive: false });

  canvas.addEventListener('mousedown', function (e) {
    // 模拟量行底边 ±4px 热区：拖拽调整行高
    var row = rowIndexAt(e.offsetY);
    if (row >= 0 && sigFmt(selected[row]) === 'analog') {
      var bottom = layout.tops[row] + layout.hs[row];
      if (Math.abs(e.offsetY - bottom) <= 4) {
        heightDrag = { key: keyOf(selected[row]), startY: e.clientY, startH: layout.hs[row] };
        return;
      }
    }
    // 名称栏：拖拽调整行顺序（类似 Vivado）
    if (e.offsetX < NAME_W && row >= 0 && selected.length > 1) {
      reorderDrag = { fromIdx: row, toIdx: row, moved: false, startY: e.clientY };
      canvas.style.cursor = 'grabbing';
      return;
    }
    dragging = { x: e.clientX, viewStart: viewStart, moved: false };
  });
  window.addEventListener('mousemove', function (e) {
    if (heightDrag) {
      var newH = Math.min(Math.max(heightDrag.startH + (e.clientY - heightDrag.startY), 24), 240);
      heights[heightDrag.key] = newH / ROW_H;
      draw();
      return;
    }
    if (reorderDrag) {
      if (Math.abs(e.clientY - reorderDrag.startY) > 3) reorderDrag.moved = true;
      if (reorderDrag.moved) {
        var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { top: 0 };
        var y = e.clientY - (rect.top || 0);
        var idx = rowIndexAt(y);
        if (idx < 0) idx = y <= 0 ? 0 : selected.length - 1;
        var mid = layout.tops[idx] + layout.hs[idx] / 2;
        reorderDrag.toIdx = y > mid ? idx + 1 : idx;
        draw();
      }
      return;
    }
    if (!dragging) return;
    var dx = e.clientX - dragging.x;
    if (Math.abs(dx) > 3) dragging.moved = true;
    viewStart = dragging.viewStart - dx * viewSpan / plotW();
    clampView();
    draw();
  });
  window.addEventListener('mouseup', function () {
    if (reorderDrag) {
      if (reorderDrag.moved && reorderDrag.toIdx !== reorderDrag.fromIdx) {
        applyManualOrder(reorderDrag.fromIdx, reorderDrag.toIdx);
      }
      if (reorderDrag.moved) suppressNextClick = true;
      reorderDrag = null;
      draw();
    }
    heightDrag = null; dragging = null;
  });
  canvas.addEventListener('mousemove', function (e) {
    if (dragging || heightDrag) return;
    var row = rowIndexAt(e.offsetY);
    var near = row >= 0 && sigFmt(selected[row]) === 'analog' &&
      Math.abs(e.offsetY - (layout.tops[row] + layout.hs[row])) <= 4;
    var inName = e.offsetX < NAME_W && row >= 0;
    canvas.style.cursor = near ? 'ns-resize' : (inName ? 'grab' : 'crosshair');
  });

  canvas.addEventListener('click', function (e) {
    if (suppressNextClick) { suppressNextClick = false; return; }
    if (heightDrag || (dragging && dragging.moved)) return;
    var row = rowIndexAt(e.offsetY);
    var sig = selected[row];
    // Ctrl+点击：单选加/减；Shift+点击：范围多选（供右键分组/批量改格式）
    if ((e.ctrlKey || e.metaKey) && sig) { toggleMultiSelOf(sig); return; }
    if (e.shiftKey && sig) { waveRangeSelect(row); return; }
    if (multiSelCount() > 0) { multiSel = {}; renderTree(); draw(); }
    lastWaveIdx = row;
    if (e.offsetX < NAME_W) {
      // 点名称栏：只选边沿导航信号，不动游标
      if (sig) applyCursor(cursorT === null ? 0 : cursorT, sig, false);
      return;
    }
    var tCand = x2t(e.offsetX);
    if (sig && sig.changes.length) {
      // 边沿吸附：点击位置 8px 内的最近跳变
      var snapTicks = 8 / plotW() * viewSpan;
      var best = null, bestD = snapTicks;
      for (var i = 0; i < sig.changes.length; i++) {
        var d = Math.abs(sig.changes[i].t - tCand);
        if (d <= bestD) { bestD = d; best = sig.changes[i].t; }
        if (sig.changes[i].t > tCand + snapTicks) break;
      }
      if (best !== null) tCand = best;
    }
    applyCursor(tCand, sig || null, false);
  });

  document.getElementById('prevEdge').onclick = function () { edgeStep(-1); };
  document.getElementById('nextEdge').onclick = function () { edgeStep(1); };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); edgeStep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); edgeStep(1); }
  });

  ruler.addEventListener('click', function (e) {
    if (e.offsetX < NAME_W) return;
    if (e.offsetY >= RULER_H - 9) {
      var t = (e.offsetX - NAME_W) / plotW() * END;
      viewStart = t - viewSpan / 2;
      clampView();
      draw();
    } else {
      applyCursor(x2t(e.offsetX), null, false);
    }
  });

  document.getElementById('zoomIn').onclick = function () { zoomAt(1.3, null); };
  document.getElementById('zoomOut').onclick = function () { zoomAt(1 / 1.3, null); };
  document.getElementById('zoomFit').onclick = function () {
    viewStart = 0; viewSpan = END; clampView(); draw();
  };
  window.addEventListener('resize', draw);

  // ---------- 右键菜单：二级格式菜单 / 分组 / 移除 ----------
  function hideMenu() {
    if (menuEl && menuEl.remove) menuEl.remove();
    menuEl = null;
  }
  // 分组命名：把菜单项原位替换为输入框（Enter 确认 / Esc 取消）
  function renameInput(itemEl, gid) {
    itemEl.innerHTML = '';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = groupNames[gid] || ('组' + gid);
    inp.style.cssText = 'width:132px;background:#1e2126;color:#d4d4d4;border:1px solid #4fc3f7;' +
      'border-radius:3px;padding:2px 6px;font-size:12px;outline:none;';
    itemEl.appendChild(inp);
    if (inp.focus) inp.focus();
    if (inp.select) inp.select();
    function commit() {
      var v = String(inp.value).replace(/^\s+|\s+$/g, '');
      if (v) groupNames[gid] = v;
      hideMenu();
      draw();
    }
    inp.onkeydown = function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter') commit();
      else if (ev.key === 'Escape') { hideMenu(); draw(); }
    };
    inp.onblur = function () { if (menuEl) commit(); };
  }
  function showSigMenu(cx, cy, sigs) {
    hideMenu();
    if (!sigs.length) return;
    var anyMulti = sigs.length > 1;
    menuEl = document.createElement('div');
    menuEl.className = 'ctxMenu';
    menuEl.style.left = Math.min(cx, (window.innerWidth || 1600) - 190) + 'px';
    menuEl.style.top = cy + 'px';
    var title = document.createElement('div');
    title.className = 'ctxTitle';
    title.textContent = anyMulti ? (sigs.length + ' 个信号') : (sigs[0].name);
    menuEl.appendChild(title);

    // 显示格式 ▸（二级菜单）
    var fmtItem = document.createElement('div');
    fmtItem.className = 'ctxItem';
    fmtItem.textContent = '显示格式 ▸';
    var sub = document.createElement('div');
    sub.className = 'ctxMenu sub';
    var cur = sigs.length === 1 ? sigFmt(sigs[0]) : null;
    [['hex', 'Hex 十六进制'], ['bin', 'Bin 二进制'], ['dec', 'Dec 无符号十进制'],
     ['sdec', 'SDec 有符号十进制'], ['analog', 'Analog 模拟量']].forEach(function (it) {
      var d = document.createElement('div');
      d.className = 'ctxItem' + (cur === it[0] ? ' cur' : '');
      d.textContent = it[1];
      d.onclick = function () {
        sigs.forEach(function (s) { fmt[keyOf(s)] = it[0]; });
        hideMenu();
        draw();
      };
      sub.appendChild(d);
    });
    fmtItem.appendChild(sub);
    fmtItem.onmouseenter = function () { sub.style.display = 'block'; };
    fmtItem.onmouseleave = function () { sub.style.display = 'none'; };
    menuEl.appendChild(fmtItem);

    // 分组（Ctrl/Shift 多选 ≥2 时可用）：组员聚拢到第一个成员位置，其余行相对顺序不变
    if (multiSelCount() >= 2) {
      var gItem = document.createElement('div');
      gItem.className = 'ctxItem';
      gItem.textContent = '✦ 分组（' + multiSelCount() + ' 个信号）';
      gItem.onclick = function () {
        var gid = nextGid++;
        groupNames[gid] = '组' + gid;
        multiSelSignals().forEach(function (s) { groups[keyOf(s)] = gid; });
        multiSel = {};
        var order = selected.slice();
        var members = order.filter(function (s) { return groups[keyOf(s)] === gid; });
        var firstPos = order.indexOf(members[0]);
        var rest = order.filter(function (s) { return groups[keyOf(s)] !== gid; });
        rest.slice(0, firstPos).concat(members, rest.slice(firstPos))
          .forEach(function (s, i) { manualRank[keyOf(s)] = i; });
        applyRows(); renderTree(); draw();
        renameInput(gItem, gid);   // 分组后原位命名
      };
      menuEl.appendChild(gItem);
    }
    // 重命名 / 解除分组（选中信号中有已分组者）
    var gidOf = null;
    for (var gi = 0; gi < sigs.length; gi++) {
      var g0 = groups[keyOf(sigs[gi])];
      if (g0) { gidOf = g0; break; }
    }
    if (gidOf) {
      var nItem = document.createElement('div');
      nItem.className = 'ctxItem';
      nItem.textContent = '✎ 重命名分组（' + (groupNames[gidOf] || ('组' + gidOf)) + '）';
      nItem.onclick = function () { renameInput(nItem, gidOf); };
      menuEl.appendChild(nItem);
      var uItem = document.createElement('div');
      uItem.className = 'ctxItem';
      uItem.textContent = '解除分组';
      uItem.onclick = function () {
        sigs.forEach(function (s) { delete groups[keyOf(s)]; });
        applyRows(); renderTree(); hideMenu(); draw();
      };
      menuEl.appendChild(uItem);
    }

    var rm = document.createElement('div');
    rm.className = 'ctxItem';
    rm.textContent = anyMulti ? ('✕ 移除 ' + sigs.length + ' 个信号') : '✕ 移除该信号';
    rm.onclick = function () {
      hideMenu();
      sigs.forEach(function (s) { delete checked[keyOf(s)]; });
      if (edgeSig && sigs.indexOf(edgeSig) >= 0) {
        edgeSig = null;
        navLabel.textContent = '边沿: (点击波形行选择)';
      }
      multiSel = {};
      applyRows(); renderTree(); draw();
    };
    menuEl.appendChild(rm);
    document.body.appendChild(menuEl);
  }
  canvas.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var row = rowIndexAt(e.offsetY);
    var sig = selected[row];
    if (!sig) return;
    var sigs = multiSel[keyOf(sig)] ? multiSelSignals() : [sig];
    showSigMenu(e.clientX, e.clientY, sigs);
  });
  document.addEventListener('mousedown', function (e) {
    if (menuEl && menuEl.contains && menuEl.contains(e.target)) return;
    hideMenu();
  });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  document.getElementById('title').textContent = DATA.fileName;
  document.getElementById('tsInfo').textContent = 'timescale: ' + (DATA.timescale || '(未声明)');
  document.getElementById('endTime').textContent = 'end: ' + fmtTime(END) + ' (' + END + ' ticks)';
  applyRows();
  renderTree();
  draw();
})();
</script>
</body>
</html>`;
}
function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

module.exports = {
    activateWaveViewer,
    parseVcd,
    buildSignalTree,
    parseTimescaleSeconds,
    buildWaveformHtml
};
