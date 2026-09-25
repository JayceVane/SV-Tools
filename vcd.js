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
 * 激活 VCD 波形查看器：注册打开 .vcd 的命令与 webview 面板管理。
 * @param {vscode.ExtensionContext} context
 * @param {{channel: vscode.OutputChannel}} deps 与仿真模块共享的输出通道
 */
function activateWaveViewer(context, deps) {
    const vscode = require('vscode');
    const panels = new Map(); // vcd 文件路径 -> webviewPanel

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

        let vcd;
        try {
            vcd = parseVcd(require('fs').readFileSync(vcdPath, 'utf8'));
        } catch (err) {
            vscode.window.showErrorMessage(`VCD 解析失败：${err.message}`);
            return;
        }
        if (vcd.vars.length === 0) {
            vscode.window.showWarningMessage('该 VCD 文件中没有信号定义。');
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'svtoolsWaveViewer',
            `波形 · ${require('path').basename(vcdPath)}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panels.set(vcdPath, panel);
        panel.onDidDispose(() => panels.delete(vcdPath), null, context.subscriptions);

        panel.webview.html = buildWaveformHtml(vcd, {
            fileName: require('path').basename(vcdPath),
            timescale: vcd.timescale,
            cspSource: panel.webview.cspSource
        });
    }

    context.subscriptions.push(
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
  :root { --bg:#1e1e1e; --fg:#cccccc; --panel:#252526; --border:#3c3c3c;
          --line:#4fc3f7; --bus:#ffb74d; --x:#f44336; --sel:#264f78; --ruler:#9e9e9e; }
  body { margin:0; display:flex; flex-direction:column; height:100vh;
         background:var(--bg); color:var(--fg); font-family:Consolas,monospace; font-size:13px; }
  header { padding:6px 10px; background:var(--panel); border-bottom:1px solid var(--border);
           display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  header b { font-weight:600; }
  header span.meta { color:#9e9e9e; }
  #main { flex:1; display:flex; min-height:0; }
  #sigPanel { width:260px; min-width:180px; overflow:auto; border-right:1px solid var(--border);
              background:var(--panel); padding:4px 0; }
  .scope { font-weight:600; color:#9cdcfe; padding:2px 8px; cursor:default; }
  .sig { padding:2px 8px 2px 20px; cursor:pointer; white-space:nowrap; display:flex; gap:6px; }
  .sig:hover { background:#2a2d2e; }
  .sig.selected { background:var(--sel); }
  .sig .w { color:#6a6a6a; }
  .hidden-note { color:#6a6a6a; padding:4px 8px; }
  #right { flex:1; display:flex; flex-direction:column; min-width:0; }
  #cursorInfo { padding:2px 8px; background:rgba(37,37,38,.92);
                border-bottom:1px solid var(--border); color:#dcdcaa; min-height:1.2em;
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #ruler { display:block; background:var(--bg); }
  #waveScroller { flex:1; overflow-y:auto; overflow-x:hidden; position:relative; }
  #waveCanvas { display:block; cursor:crosshair; }
  footer { padding:4px 10px; background:var(--panel); border-top:1px solid var(--border);
           display:flex; gap:10px; align-items:center; }
  button { background:#333; color:var(--fg); border:1px solid var(--border); border-radius:3px;
           padding:2px 10px; cursor:pointer; }
  button:hover { background:#3f3f46; }
  #zoomLabel { color:#9e9e9e; min-width:110px; text-align:center; }
  span.hint { color:#6a6a6a; }
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
    <div id="cursorInfo">点击波形放置游标</div>
    <canvas id="ruler" height="24"></canvas>
    <div id="waveScroller"><canvas id="waveCanvas"></canvas></div>
  </div>
</div>
<footer>
  <button id="zoomOut">−</button>
  <span id="zoomLabel"></span>
  <button id="zoomIn">+</button>
  <button id="zoomFit">Fit</button>
  <span class="hint">点击放游标 · Ctrl+滚轮缩放 · 滚轮/拖拽平移 · 点击信号树加/删波形</span>
</footer>
<script>
const DATA = ${json};
</script>
<script>
/* 波形渲染（视口窗口模型）：只画 [viewStart, viewStart+viewSpan] 窗口内的时间段 */
(function () {
  var RULER_H = 24, ROW_H = 26, WAVE_LEFT = 10, EDGE = 6;
  var canvas = document.getElementById('waveCanvas');
  var ruler = document.getElementById('ruler');
  var scroller = document.getElementById('waveScroller');
  var sigPanel = document.getElementById('sigPanel');
  var cursorInfo = document.getElementById('cursorInfo');
  var zoomLabel = document.getElementById('zoomLabel');

  var END = DATA.endTime > 0 ? DATA.endTime : 1;
  var SEC = (typeof DATA.secondsPerTime === 'number') ? DATA.secondsPerTime : 1e-9;
  var viewStart = 0, viewSpan = END;   // 视口窗口（时间单位）
  var cursorT = null;
  var dragging = null;

  var selected = [];
  var byId = {};
  var noChangeCount = 0;
  DATA.signals.forEach(function (s) {
    byId[s.id + '|' + s.path] = s;
    if (s.changes.length > 0) selected.push(s);
    else noChangeCount++;
  });

  function plotW() { return Math.max(canvas.clientWidth - WAVE_LEFT - 10, 50); }
  function viewEnd() { return viewStart + viewSpan; }
  function t2x(t) { return WAVE_LEFT + (t - viewStart) / viewSpan * plotW(); }
  function x2t(x) { return viewStart + (x - WAVE_LEFT) / plotW() * viewSpan; }

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
  function renderTree() {
    sigPanel.innerHTML = '';
    var selectedKeys = {};
    selected.forEach(function (s) { selectedKeys[s.id + '|' + s.path] = 1; });
    (function walk(nodes) {
      nodes.forEach(function (node) {
        if (node.children) {
          var div = document.createElement('div');
          div.className = 'scope';
          div.textContent = node.path;
          sigPanel.appendChild(div);
          walk(node.children);
        } else {
          var row = document.createElement('div');
          var isSel = selectedKeys[node.id + '|' + node.path] === 1;
          row.className = 'sig' + (isSel ? ' selected' : '');
          row.innerHTML = '<span>' + esc(node.name) + '</span>' +
            '<span class="w">' + (node.width > 1 ? '[' + node.width + 'b]' : '') + '</span>';
          row.onclick = function () { toggleSignal(node); };
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
  function toggleSignal(node) {
    if (!node.hasChanges) return;
    var idx = -1;
    for (var i = 0; i < selected.length; i++) {
      if (selected[i].id === node.id && selected[i].path === node.path) { idx = i; break; }
    }
    if (idx >= 0) selected.splice(idx, 1); else selected.push(node);
    renderTree();
    draw();
  }

  // ---------- 可见变更定位 ----------
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

  // ---------- 绘制 ----------
  function draw() {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(document.getElementById('right').clientWidth, 100);
    var h = Math.max(selected.length * ROW_H + 8, scroller.clientHeight);
    setupCanvas(canvas, w, h, dpr);
    setupCanvas(ruler, w, RULER_H, dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px Consolas,monospace';

    drawRuler(w, dpr);

    // 视口范围内的信号变更量级保护：窗口内变更点过多时跳过标签
    selected.forEach(function (sig, i) {
      var yTop = i * ROW_H + 4;
      if (i % 2) { ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(0, yTop - 4, w, ROW_H); }
      ctx.strokeStyle = sig.width > 1 ? '#ffb74d' : '#4fc3f7';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1.4;
      if (sig.width === 1 && sig.type !== 'real') drawScalar(ctx, sig, yTop);
      else drawBus(ctx, sig, yTop);
      // 行首信号名水印
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.fillText(sig.name, 2, yTop + ROW_H / 2 + 2);
      ctx.fillStyle = sig.width > 1 ? '#ffb74d' : '#4fc3f7';
    });
    if (cursorT !== null) drawCursorLine(ctx, h);
    zoomLabel.textContent = '可见 ' + fmtTime(viewSpan);
  }

  function setupCanvas(c, w, h, dpr) {
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = w + 'px'; c.style.height = h + 'px';
  }

  function drawRuler(w, dpr) {
    var ctx = ruler.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, RULER_H);
    ctx.font = '10px Consolas,monospace';
    ctx.fillStyle = '#9e9e9e';
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    // 刻度步长取 1-2-5 序列，保证相邻刻度 ≥ 90px
    var secPerPx = SEC * viewSpan / plotW();
    var targetSec = secPerPx * 90;
    var pow = Math.pow(10, Math.floor(Math.log10(targetSec)));
    var step = pow;
    [5, 2, 1].some(function (m) { if (targetSec <= m * pow) { step = m * pow; return true; } return false; });
    var stepT = step / SEC;
    ctx.beginPath();
    for (var t = Math.ceil(viewStart / stepT) * stepT; t <= viewEnd(); t += stepT) {
      var x = t2x(t);
      ctx.moveTo(x, 14); ctx.lineTo(x, RULER_H);
      ctx.fillText(fmtSeconds(t * SEC), x + 3, 10);
    }
    ctx.stroke();
    // 全程概览条
    ctx.fillStyle = 'rgba(79,195,247,.35)';
    ctx.fillRect(WAVE_LEFT, 17, plotW(), 3);
    ctx.fillStyle = '#4fc3f7';
    ctx.fillRect(t2x(viewStart), 16, Math.max(plotW() * viewSpan / END, 4), 5);
  }

  function levelY(yTop, v) {
    return v === '1' ? yTop + 5 : (v === '0' ? yTop + ROW_H - 9 : yTop + ROW_H / 2);
  }

  function drawScalar(ctx, sig, yTop) {
    var list = sig.changes;
    var i0 = firstVisibleIdx(list);
    var yXm = yTop + ROW_H / 2;
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
      // 跳变沿垂直线
      if (i + 1 < list.length && list[i + 1].t <= viewEnd() && x2 > 0) {
        var vN = list[i + 1].value;
        if ((v === '1' || v === '0') && (vN === '1' || vN === '0')) {
          ctx.moveTo(x2, levelY(yTop, v)); ctx.lineTo(x2, levelY(yTop, vN));
        } else if (v !== vN) {
          ctx.moveTo(x2, levelY(yTop, v === '1' || v === '0' ? v : 'x'));
          ctx.lineTo(x2, levelY(yTop, vN === '1' || vN === '0' ? vN : 'x'));
        }
      }
    }
    ctx.stroke();
  }

  function hexOf(bin) {
    try { return BigInt('0b' + (bin || '0')).toString(16).toUpperCase(); }
    catch (e) { return null; }
  }

  function drawBus(ctx, sig, yTop) {
    var list = sig.changes;
    var i0 = firstVisibleIdx(list);
    var yT = yTop + 5, yB = yTop + ROW_H - 9, yM = yTop + ROW_H / 2;
    for (var i = i0; i < list.length; i++) {
      var t1 = Math.max(list[i].t, viewStart);
      if (t1 > viewEnd()) break;
      var t2 = (i + 1 < list.length) ? list[i + 1].t : viewEnd();
      var x1 = t2x(t1), x2 = Math.min(t2x(t2), t2x(viewEnd()));
      if (x2 - x1 < 1) continue;
      var v = list[i].value;
      if (/[^01]/.test(v)) {
        // 含 x/z：红色中轴带
        ctx.save();
        ctx.strokeStyle = '#f44336';
        ctx.beginPath();
        ctx.moveTo(x1, yM - 3); ctx.lineTo(x2, yM - 3);
        ctx.moveTo(x1, yM); ctx.lineTo(x2, yM);
        ctx.moveTo(x1, yM + 3); ctx.lineTo(x2, yM + 3);
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = '#ffb74d';
        continue;
      }
      if (x2 - x1 < 4) continue; // 太窄不画六边形
      var pad = Math.min(EDGE, (x2 - x1) / 3);
      ctx.beginPath();
      ctx.moveTo(x1 + pad, yT); ctx.lineTo(x2 - pad, yT);
      ctx.lineTo(x2, yM); ctx.lineTo(x2 - pad, yB);
      ctx.lineTo(x1 + pad, yB); ctx.lineTo(x1, yM);
      ctx.closePath();
      ctx.stroke();
      var hx = hexOf(v);
      var label = hx !== null ? ('0x' + hx) : v;
      if (v.length <= 8) label += ' (0b' + v + ')';
      if (ctx.measureText(label).width < x2 - x1 - 10) {
        ctx.fillStyle = '#e0e0e0';
        ctx.fillText(label, x1 + pad + 3, yM + 4);
        ctx.fillStyle = '#ffb74d';
      }
    }
  }

  function drawCursorLine(ctx, h) {
    var x = t2x(cursorT);
    if (x < 0 || x > canvas.clientWidth) return;
    ctx.save();
    ctx.strokeStyle = '#dcdcaa'; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.restore();
  }

  // ---------- 交互 ----------
  function clampView() {
    viewSpan = Math.min(Math.max(viewSpan, END / 1e9), END * 1.2);
    viewStart = Math.min(Math.max(viewStart, 0), Math.max(END - viewSpan, 0));
  }
  function zoomAt(factor, anchorX) {
    var tAnchor = x2t(anchorX != null ? anchorX : (WAVE_LEFT + plotW() / 2));
    viewSpan = viewSpan / factor;
    clampView();
    viewStart = tAnchor - (anchorX != null ? anchorX - WAVE_LEFT : plotW() / 2) / plotW() * viewSpan;
    clampView();
    draw();
  }

  document.getElementById('right').addEventListener('wheel', function (e) {
    e.preventDefault();
    if (e.ctrlKey) {
      zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.offsetX);
    } else {
      var delta = (e.deltaX !== 0 ? e.deltaX : e.deltaY) * viewSpan / plotW();
      viewStart += delta;
      clampView();
      draw();
    }
  }, { passive: false });

  canvas.addEventListener('mousedown', function (e) {
    dragging = { x: e.clientX, viewStart: viewStart, moved: false };
  });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var dx = e.clientX - dragging.x;
    if (Math.abs(dx) > 3) dragging.moved = true;
    viewStart = dragging.viewStart - dx * viewSpan / plotW();
    clampView();
    draw();
  });
  window.addEventListener('mouseup', function () { dragging = null; });

  canvas.addEventListener('click', function (e) {
    if (dragging && dragging.moved) return;
    cursorT = x2t(e.offsetX);
    var row = Math.floor(e.offsetY / ROW_H);
    var sig = selected[row];
    var vTxt = sig ? valueAt(sig, cursorT) : null;
    var pretty = vTxt === null ? '' :
      (sig.width > 1 ? (hexOf(vTxt) !== null ? '0x' + hexOf(vTxt) + ' (0b' + vTxt + ')' : vTxt)
        : (sig.type === 'real' ? vTxt : vTxt));
    cursorInfo.textContent = 't=' + fmtTime(cursorT) +
      (sig ? '   ' + sig.path + ' = ' + pretty : '');
    draw();
  });

  document.getElementById('zoomIn').onclick = function () { zoomAt(1.3, null); };
  document.getElementById('zoomOut').onclick = function () { zoomAt(1 / 1.3, null); };
  document.getElementById('zoomFit').onclick = function () {
    viewStart = 0; viewSpan = END; clampView(); draw();
  };
  window.addEventListener('resize', draw);

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  document.getElementById('title').textContent = DATA.fileName;
  document.getElementById('tsInfo').textContent = 'timescale: ' + (DATA.timescale || '(未声明)');
  document.getElementById('endTime').textContent = 'end: ' + fmtTime(END) + ' (' + END + ' ticks)';
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
