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
 */
// 器件库：get_parts 导出 TCL、dump 解析、筛选（纯函数，不依赖 vscode）。

const { tclQuote } = require('./tclgen');

/** 生成器件库导出 TCL（vivado batch 无工程模式跑，输出 name|family|package|speed 行）。 */
function buildExportPartsScript(outPath) {
    const tclPath = String(outPath).replace(/\\/g, '/');
    return [
        'set fh [open ' + tclQuote(tclPath) + ' w]',
        'fconfigure $fh -encoding utf-8',
        'foreach p [get_parts *] {',
        '  puts $fh "$p|[get_property FAMILY $p]|[get_property PACKAGE $p]|[get_property SPEED $p]"',
        '}',
        'close $fh',
        'puts "SVTOOLS_PARTS_EXPORTED"'
    ].join('\n') + '\n';
}

/** 解析器件库 dump 文本（跳过非法行），按名称排序。 */
function parsePartsDump(text) {
    const parts = [];
    const seen = new Set();
    String(text || '').split(/\r?\n/).forEach(function (line) {
        const seg = line.split('|');
        if (seg.length < 4 || !/^xc|^x[au]/i.test(seg[0])) return;
        const p = { name: seg[0], family: seg[1], pkg: seg[2], speed: seg[3] };
        if (seen.has(p.name)) return;
        seen.add(p.name);
        parts.push(p);
    });
    parts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return parts;
}

/** 汇总筛选维度（按选中项动态重算时使用）。 */
function partFilterOptions(parts) {
    const fam = new Set(), pkg = new Set(), spd = new Set();
    parts.forEach(p => { fam.add(p.family); pkg.add(p.pkg); spd.add(p.speed); });
    const s = a => Array.from(a).sort();
    return { families: s(fam), packages: s(pkg), speeds: s(spd) };
}

/** 按已选维度过滤器件列表。 */
function filterParts(parts, sel) {
    return parts.filter(p =>
        (!sel.family || p.family === sel.family) &&
        (!sel.pkg || p.pkg === sel.pkg) &&
        (!sel.speed || p.speed === sel.speed));
}

/** 系列显示名（详情条用）。 */
const FAMILY_DISPLAY = {
    zynq: 'Zynq-7000', artix7: 'Artix-7', kintex7: 'Kintex-7', virtex7: 'Virtex-7',
    spartan7: 'Spartan-7', zynquplus: 'Zynq UltraScale+', zynquplusRFSOC: 'Zynq UltraScale+ RFSoC',
    kintexuplus: 'Kintex UltraScale+', kintexu: 'Kintex UltraScale',
    virtexuplus: 'Virtex UltraScale+', virtexuplus58g: 'Virtex UltraScale+ 58G',
    virtexuplusHBM: 'Virtex UltraScale+ HBM', virtexu: 'Virtex UltraScale',
    versal: 'Versal', spartan6: 'Spartan-6', spartan3: 'Spartan-3'
};

/**
 * 生成器件选型详情页 HTML（Vivado 向导风格：单页筛选下拉 + 搜索联想 + 表格 + 选中详情）。
 * webview 通过 postMessage({type:'pick', part} | {type:'cancel'}) 与扩展通信。
 */
function buildPartPickerHtml(parts, defaultPart) {
    const data = JSON.stringify(parts.map(p => [p.name, p.family, p.pkg, p.speed]));
    const def = JSON.stringify(String(defaultPart || ''));
    const famDisp = JSON.stringify(FAMILY_DISPLAY);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:var(--vscode-font-family,'Segoe UI',sans-serif); font-size:13px;
         background:var(--vscode-editor-background,#1e1e1e); color:var(--vscode-editor-foreground,#ccc);
         display:flex; flex-direction:column; height:100vh; }
  .bar { display:flex; gap:10px; padding:10px 12px; border-bottom:1px solid #33373d; flex-wrap:wrap; align-items:center; }
  .bar label { color:#8a8f98; font-size:12px; }
  select, input[type=text] { background:#25282d; color:#d4d4d4; border:1px solid #3c4046; border-radius:3px;
         padding:4px 8px; font-size:13px; min-width:110px; outline:none; }
  input[type=text] { flex:1; min-width:220px; }
  select:focus, input:focus { border-color:#4fc3f7; }
  .tblwrap { flex:1; overflow:auto; }
  table { border-collapse:collapse; width:100%; }
  thead th { position:sticky; top:0; background:#232629; color:#9cdcfe; text-align:left; font-weight:600;
             padding:7px 12px; border-bottom:1px solid #3c4046; cursor:pointer; user-select:none; white-space:nowrap; }
  tbody td { padding:5px 12px; border-bottom:1px solid rgba(255,255,255,.04); white-space:nowrap; }
  tbody tr { cursor:pointer; }
  tbody tr:hover { background:rgba(79,195,247,.07); }
  tbody tr.sel { background:rgba(255,213,79,.12); outline:1px solid rgba(255,213,79,.4); }
  td.part { font-family:Consolas,monospace; color:#ffcc80; }
  .foot { border-top:1px solid #33373d; padding:8px 12px; display:flex; align-items:center; gap:12px; }
  .detail { flex:1; font-family:Consolas,monospace; font-size:12px; color:#9cdcfe; overflow:hidden;
            text-overflow:ellipsis; white-space:nowrap; }
  .count { color:#8a8f98; font-size:12px; margin-right:auto; }
  button { background:#0e639c; color:#fff; border:none; border-radius:3px; padding:6px 18px; font-size:13px; cursor:pointer; }
  button.sec { background:#3a3d41; }
  button:disabled { opacity:.45; cursor:default; }
</style>
</head>
<body>
<div class="bar">
  <label>系列</label><select id="fFamily"></select>
  <label>封装</label><select id="fPkg"></select>
  <label>速度</label><select id="fSpeed"></select>
  <input type="text" id="fSearch" placeholder="搜索型号（输入即联想过滤，如 xc7z100）…">
</div>
<div class="tblwrap"><table>
  <thead><tr>
    <th data-k="0">Part ▲▼</th><th data-k="1">系列 Family</th><th data-k="2">封装 Package</th><th data-k="3">速度 Speed</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table></div>
<div class="foot">
  <span class="count" id="count"></span>
  <span class="detail" id="detail">（点击行选择，双击直接确定；Enter 确定 / Esc 取消）</span>
  <button class="sec" id="btnNone">不设置</button>
  <button class="sec" id="btnCancel">取消</button>
  <button id="btnOk" disabled>确定</button>
</div>
<script>
(function () {
  var vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
  var DATA = ${data};
  var FAM_DISP = ${famDisp};
  var DEF = ${def};
  var sel = { family: '', pkg: '', speed: '', q: '' };
  var chosen = null, sortK = 0, sortAsc = true;
  var el = function (id) { return document.getElementById(id); };

  function uniq(arr) { var s = {}; arr.forEach(function (v) { s[v] = 1; }); return Object.keys(s).sort(); }
  function currentPool() {
    return DATA.filter(function (p) {
      if (sel.family && p[1] !== sel.family) return false;
      if (sel.pkg && p[2] !== sel.pkg) return false;
      if (sel.speed && p[3] !== sel.speed) return false;
      if (sel.q) {
        var q = sel.q.toLowerCase();
        if (p[0].toLowerCase().indexOf(q) < 0 &&
            p[1].toLowerCase().indexOf(q) < 0 && p[2].toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  function fillSelect(id, values, cur) {
    var s = el(id); s.innerHTML = '';
    [''].concat(values).forEach(function (v) {
      var o = document.createElement('option');
      o.value = v; o.textContent = v || '(全部)';
      if (v === cur) o.selected = true;
      s.appendChild(o);
    });
  }
  function refreshSelects() {
    var pool = currentPool();
    fillSelect('fFamily', uniq(DATA.map(function (p) { return p[1]; })), sel.family);
    fillSelect('fPkg', uniq(pool.map(function (p) { return p[2]; })), sel.pkg);
    fillSelect('fSpeed', uniq(pool.map(function (p) { return p[3]; })), sel.speed);
  }
  function render() {
    var pool = currentPool().slice();
    pool.sort(function (a, b) {
      var r = a[sortK] < b[sortK] ? -1 : a[sortK] > b[sortK] ? 1 : 0;
      return sortAsc ? r : -r;
    });
    var html = [];
    pool.forEach(function (p) {
      html.push('<tr data-p="' + p[0] + '"' + (chosen === p[0] ? ' class="sel"' : '') +
        '><td class="part">' + p[0] + '</td><td>' + (FAM_DISP[p[1]] || p[1]) +
        '</td><td>' + p[2] + '</td><td>' + p[3] + '</td></tr>');
    });
    el('rows').innerHTML = html.join('');
    el('count').textContent = pool.length + ' / ' + DATA.length + ' 个器件';
    el('btnOk').disabled = !chosen;
    var tr = el('rows').querySelector('tr.sel');
    if (tr) tr.scrollIntoView({ block: 'center' });
  }
  function choose(name) {
    chosen = name;
    var p = null;
    for (var i = 0; i < DATA.length; i++) if (DATA[i][0] === name) { p = DATA[i]; break; }
    el('detail').textContent = p
      ? p[0] + '  ·  ' + (FAM_DISP[p[1]] || p[1]) + ' 系列  ·  ' + p[2] + ' 封装  ·  速度等级 ' + p[3]
      : '';
    render();
  }
  function post(msg) { if (vscode) vscode.postMessage(msg); }
  function ok() { if (chosen) post({ type: 'pick', part: chosen }); }
  el('rows').addEventListener('click', function (e) {
    var tr = e.target && e.target.closest ? e.target.closest('tr') : null;
    if (tr && tr.dataset && tr.dataset.p) choose(tr.dataset.p);
  });
  el('rows').addEventListener('dblclick', function (e) {
    var tr = e.target && e.target.closest ? e.target.closest('tr') : null;
    if (tr && tr.dataset && tr.dataset.p) { choose(tr.dataset.p); ok(); }
  });
  Array.prototype.forEach.call(document.querySelectorAll('thead th'), function (th) {
    th.onclick = function () {
      var k = parseInt(th.getAttribute('data-k'), 10);
      if (sortK === k) sortAsc = !sortAsc; else { sortK = k; sortAsc = true; }
      render();
    };
  });
  el('fFamily').onchange = function () { sel.family = this.value; refreshSelects(); render(); };
  el('fPkg').onchange = function () { sel.pkg = this.value; refreshSelects(); render(); };
  el('fSpeed').onchange = function () { sel.speed = this.value; render(); };
  el('fSearch').oninput = function () { sel.q = this.value.trim(); render(); };
  el('btnOk').onclick = ok;
  el('btnNone').onclick = function () { post({ type: 'pick', part: '' }); };
  el('btnCancel').onclick = function () { post({ type: 'cancel' }); };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') post({ type: 'cancel' });
    if (e.key === 'Enter') ok();
  });
  refreshSelects();
  if (DEF) choose(DEF);
  render();
  el('fSearch').focus();
})();
</script>
</body>
</html>`;
}

module.exports = {
    buildExportPartsScript, parsePartsDump, partFilterOptions, filterParts,
    FAMILY_DISPLAY, buildPartPickerHtml
};
