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
 *  - parseVcd / buildSignalTree 为纯函数，不依赖 vscode，可独立单元测试；
 *  - activateWaveViewer() 负责 VSCode 集成（webview 面板、命令、与仿真联动）。
 *
 * VCD 语法参考 IEEE 1364：头信息（$date/$timescale 等）、$scope/$var 层级、
 * #时间戳 + 值变更（标量 0/1/x/z，向量 b/r）。
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
        const parent = scopeNodes.get(v.scopePath) || root;
        parent.children.push({
            name: v.name,
            path: v.path,
            id: v.id,
            width: v.width,
            type: v.type
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
 * 生成波形查看器 webview HTML（内联全部脚本与样式，Canvas 渲染）。
 * @param {ReturnType<typeof parseVcd>} vcd
 * @param {{fileName: string, timescale: string, cspSource: string}} meta
 * @returns {string}
 */
function buildWaveformHtml(vcd, meta) {
    const tree = buildSignalTree(vcd);
    // 传给 webview 的精简数据：id → 变更时间轴
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
  :root { --bg:#1e1e1e; --fg:#cccccc; --panel:#252526; --border:#3c3c3c; --accent:#007acc;
          --line-0:#4fc3f7; --line-1:#4fc3f7; --bus:#ffb74d; --x:#f44336; --sel:#264f78; }
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
  .sig .dir { color:#6a9955; }
  .sig .w { color:#6a6a6a; }
  #waveWrap { flex:1; overflow:auto; position:relative; }
  #waveCanvas { display:block; cursor:crosshair; }
  #cursorInfo { position:sticky; top:0; left:0; padding:2px 8px; background:rgba(37,37,38,.92);
                border-bottom:1px solid var(--border); color:#dcdcaa; min-height:1.2em; }
  footer { padding:4px 10px; background:var(--panel); border-top:1px solid var(--border);
           display:flex; gap:10px; align-items:center; }
  button { background:#333; color:var(--fg); border:1px solid var(--border); border-radius:3px;
           padding:2px 10px; cursor:pointer; }
  button:hover { background:#3f3f46; }
  #zoomLabel { color:#9e9e9e; min-width:90px; text-align:center; }
</style>
</head>
<body>
<header>
  <b>${escapeHtml(meta.fileName)}</b>
  <span class="meta">timescale: ${escapeHtml(meta.timescale || '(未声明)')}</span>
  <span class="meta" id="endTime"></span>
</header>
<div id="main">
  <div id="sigPanel"></div>
  <div id="waveWrap"><div id="cursorInfo"></div><canvas id="waveCanvas"></canvas></div>
</div>
<footer>
  <button id="zoomOut">−</button>
  <span id="zoomLabel"></span>
  <button id="zoomIn">+</button>
  <button id="zoomFit">Fit</button>
  <span class="meta">点击波形放置游标 · Ctrl+滚轮缩放 · 滚轮横向滚动</span>
</footer>
<script>
const DATA = ${json};
</script>
<script>
/* 波形渲染：信号面板 + Canvas 时序图（内联脚本第二段，DATA 已注入） */
(function () {
  const canvas = document.getElementById('waveCanvas');
  const wrap = document.getElementById('waveWrap');
  const sigPanel = document.getElementById('sigPanel');
  const cursorInfo = document.getElementById('cursorInfo');
  const zoomLabel = document.getElementById('zoomLabel');
  document.getElementById('endTime').textContent = 'end: ' + DATA.endTime;

  const ROW_H = 26, WAVE_LEFT = 10, EDGE_TICK = 6;
  const SIG_COLORS = { scalar: '#4fc3f7', bus: '#ffb74d' };
  let selectedIds = new Set();
  let pxPerTime = 20;            // 缩放
  let viewOffset = 0;            // 横向滚动（时间单位）

  const signalsById = new Map(DATA.signals.map(s => [s.id, s]));

  // ---- 信号树 ----
  function renderTree() {
    sigPanel.innerHTML = '';
    (function walk(nodes) {
      for (const node of nodes) {
        if (node.children) {
          const div = document.createElement('div');
          div.className = 'scope';
          div.textContent = node.path + ' (scope ' + node.type + ')';
          sigPanel.appendChild(div);
          walk(node.children);
        } else {
          const div = document.createElement('div');
          div.className = 'sig' + (selectedIds.has(node.id) ? ' selected' : '');
          div.dataset.id = node.id;
          div.innerHTML = '<span>' + escapeHtml(node.name) + '</span>' +
            '<span class="w">' + (node.width > 1 ? '[' + node.width + 'b]' : '') + '</span>';
          div.onclick = () => toggleSignal(node.id);
          sigPanel.appendChild(div);
        }
      }
    })(DATA.tree.children);
    if (!DATA.tree.children.length) sigPanel.textContent = '(无信号)';
  }

  function toggleSignal(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    if (selectedIds.size === 0) DATA.signals.forEach(s => selectedIds.add(s.id));
    renderTree();
    draw();
  }
  // 默认全选
  DATA.signals.forEach(s => selectedIds.add(s.id));

  // ---- 坐标换算 ----
  const t2x = t => WAVE_LEFT + (t - viewOffset) * pxPerTime;
  const x2t = x => viewOffset + (x - WAVE_LEFT) / pxPerTime;

  function visibleRows() {
    return DATA.signals.filter(s => selectedIds.has(s.id));
  }

  // ---- Canvas 绘制 ----
  function draw() {
    const rows = visibleRows();
    const width = Math.max(wrap.clientWidth, t2x(DATA.endTime) + 40);
    const height = Math.max(rows.length * ROW_H + 8, wrap.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px Consolas,monospace';

    rows.forEach((sig, i) => {
      const yTop = i * ROW_H + 4, yMid = i * ROW_H + ROW_H / 2;
      // 行背景交替
      if (i % 2) { ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(0, yTop - 4, width, ROW_H); }
      drawSignal(ctx, sig, yTop, yMid);
    });
    zoomLabel.textContent = Math.round(pxPerTime * 10) / 10 + ' px/t';
  }

  function drawSignal(ctx, sig, yTop, yMid) {
    const changes = sig.changes;
    if (!changes.length) {
      ctx.fillStyle = '#777'; ctx.fillText('(无变更)', yMid && WAVE_LEFT, yMid);
      return;
    }
    const color = sig.width > 1 ? SIG_COLORS.bus : SIG_COLORS.scalar;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.4;

    if (sig.width === 1 && sig.type !== 'real') {
      drawScalar(ctx, changes, yTop, yMid, color);
    } else {
      drawBus(ctx, changes, yTop, yMid, sig.width);
    }
  }

  function drawScalar(ctx, changes, yTop, yMid, color) {
    const yHigh = yTop + 4, yLow = yTop + ROW_H - 8, yXmid = yMid;
    ctx.beginPath();
    let prevX = null, prevLevel = null;
    for (let i = 0; i <= changes.length; i++) {
      const ch = changes[i];
      const t = i < changes.length ? ch.t : (DATA.endTime + (changes[changes.length-1].t < DATA.endTime ? DATA.endTime - changes[changes.length-1].t : 1));
      const x = t2x(t);
      if (x < -EDGE_TICK) { prevX = x; prevLevel = levelOf(changes[Math.max(i-1,0)].value); continue; }
      const level = prevLevel !== null ? prevLevel : levelOf(changes[Math.max(i-1,0)] ? changes[Math.max(i-1,0)].value : 'x');
      const xStart = Math.max(prevX !== null ? prevX : x, -10);
      const xEnd = Math.min(x, canvas.clientWidth / (window.devicePixelRatio||1) + 50);
      const prevT = i > 0 ? changes[i-1].t : 0;
      const xSegStart = t2x(prevT), xSegEnd = x;
      const lv = levelOf(i > 0 ? changes[i-1].value : (changes[0].value === '1' ? '0' : 'x'));
      drawSegment(ctx, xSegStart, xSegEnd, yHigh, yLow, yXmid, lv);
      prevX = x; prevLevel = levelOf(ch.value);
    }
    ctx.stroke();
  }

  function levelOf(v) { return v === '1' ? 1 : (v === '0' ? 0 : 2); }

  function drawSegment(ctx, x1, x2, yHigh, yLow, yXmid, level) {
    if (x2 < 0 || x1 > canvas.clientWidth) return;
    const xx1 = Math.max(x1, 0), xx2 = x2;
    if (level === 2) {
      // x/z：中轴双横线
      ctx.moveTo(xx1, yXmid - 3); ctx.lineTo(xx2, yXmid - 3);
      ctx.moveTo(xx1, yXmid + 3); ctx.lineTo(xx2, yXmid + 3);
    } else {
      const y = level === 1 ? yHigh : yLow;
      ctx.moveTo(xx1, y); ctx.lineTo(xx2, y);
    }
  }

  function drawBus(ctx, changes, yTop, yMid, width) {
    const yTopL = yTop + 4, yBotL = yTop + ROW_H - 8;
    for (let i = 0; i < changes.length; i++) {
      const t1 = changes[i].t, t2 = i + 1 < changes.length ? changes[i+1].t : DATA.endTime + 1;
      const x1 = t2x(t1), x2 = t2x(t2);
      if (x2 < -50 || x1 > canvas.clientWidth + 50) continue;
      const value = changes[i].value;
      const hasXZ = /[^01]/.test(value);
      if (hasXZ) {
        // 含 x/z：画中轴阴影带
        ctx.save();
        ctx.strokeStyle = '#f44336';
        ctx.beginPath();
        ctx.moveTo(Math.max(x1,0), yMid); ctx.lineTo(x2, yMid);
        ctx.moveTo(Math.max(x1,0), yMid - 4); ctx.lineTo(x2, yMid - 4);
        ctx.moveTo(Math.max(x1,0), yMid + 4); ctx.lineTo(x2, yMid + 4);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      // 正常总线段：六边形
      ctx.beginPath();
      const pad = EDGE_TICK;
      ctx.moveTo(x1 + pad, yTopL); ctx.lineTo(x2 - pad > x1 + pad ? x2 - pad : x1 + pad, yTopL);
      ctx.lineTo(Math.min(x2, x2), yMid); ctx.lineTo(x2 - pad > x1 + pad ? x2 - pad : x1 + pad, yBotL);
      ctx.lineTo(x1 + pad, yBotL); ctx.lineTo(x1, yMid); ctx.closePath();
      ctx.stroke();
      const label = '0x' + bigIntToHex(value) + ' (' + value + ')';
      if (x2 - x1 > ctx.measureText(label).width + 12) {
        ctx.fillStyle = '#e0e0e0';
        ctx.fillText(label, x1 + pad + 3, yMid + 4);
        ctx.fillStyle = '#ffb74d';
      }
    }
  }

  function bigIntToHex(bin) {
    try { return BigInt('0b' + (bin || '0')).toString(16).toUpperCase(); }
    catch (e) { return bin; }
  }

  // ---- 交互：缩放 / 滚动 / 游标 ----
  wrap.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const tAtCursor = x2t(e.offsetX);
      pxPerTime = clamp(pxPerTime * factor, 0.05, 5000);
      viewOffset = tAtCursor - (e.offsetX - WAVE_LEFT) / pxPerTime;
      draw();
    } else if (e.deltaX) {
      wrap.scrollLeft += e.deltaX;
    }
  }, { passive: false });

  canvas.addEventListener('click', (e) => {
    const t = x2t(e.offsetX);
    const row = Math.floor((e.offsetY - 0) / ROW_H);
    const sig = visibleRows()[row];
    let valueText = '(无信号)';
    if (sig) valueText = valueAt(sig, t);
    cursorInfo.textContent = 't=' + t + '  ' + (sig ? sig.path + ' = ' + valueText : '');
    drawCursor(t);
  });

  let cursorT = null;
  function drawCursor(t) {
    cursorT = t; draw();
    if (cursorT === null) return;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.strokeStyle = '#dcdcaa'; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(t2x(cursorT), 0); ctx.lineTo(t2x(cursorT), canvas.height); ctx.stroke();
    ctx.restore();
  }

  function valueAt(sig, t) {
    const list = sig.changes;
    if (!list.length) return '?';
    let v = list[0].value;
    for (const ch of list) { if (ch.t <= t) v = ch.value; else break; }
    return sig.width > 1 ? ("0x" + bigIntToHex(v) + " (0b" + v + ")") : v;
  }

  document.getElementById('zoomIn').onclick = () => { pxPerTime = clamp(pxPerTime * 1.3, 0.05, 5000); draw(); };
  document.getElementById('zoomOut').onclick = () => { pxPerTime = clamp(pxPerTime / 1.3, 0.05, 5000); draw(); };
  document.getElementById('zoomFit').onclick = () => {
    const wpx = wrap.clientWidth - 2 * WAVE_LEFT;
    pxPerTime = DATA.endTime > 0 ? wpx / DATA.endTime : 20;
    viewOffset = 0; draw();
  };
  window.addEventListener('resize', draw);

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  renderTree();
  document.getElementById('zoomFit').onclick();
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
    buildWaveformHtml
};
