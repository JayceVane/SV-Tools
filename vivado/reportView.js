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
/**
 * Vivado 报告查看器（webview）：等宽渲染 .rpt 文本 + 按行着色
 * （表头/分隔线/错误/警告/时序通过项），主题全部取 --vscode-* 变量，
 * 明暗主题自动跟随无需监听（VS Code 会热替换 webview 里的 CSS 变量）。
 */

'use strict';
const fs = require('fs');
const path = require('path');

/** @type {Map<string, import('vscode').WebviewPanel>} 同一报告复用面板 */
const panels = new Map();

/**
 * 打开（或聚焦）一份报告文件。
 * @param {import('vscode')} vscode
 * @param {{fsPath: string}} uri 文件 Uri
 * @param {string} [titleOverride] 面板标题（默认文件名）
 */
function showReport(vscode, uri, titleOverride) {
    const key = path.normalize(uri.fsPath);
    let text = '';
    try {
        text = fs.readFileSync(key, 'utf8');
    } catch (err) {
        vscode.window.showErrorMessage('读取报告失败：' + err.message);
        return;
    }
    const title = titleOverride || path.basename(key);

    const existing = panels.get(key);
    if (existing) {
        existing.webview.html = renderHtml(title, text);
        existing.title = title;
        existing.reveal();
        return;
    }
    const panel = vscode.window.createWebviewPanel(
        'svtools.report', title, vscode.ViewColumn.One,
        { enableScripts: false, retainContextWhenHidden: true });
    panel.webview.html = renderHtml(title, text);
    panel.onDidDispose(() => panels.delete(key));
    panels.set(key, panel);
}

/**
 * 报告 HTML：逐行 <span>，行类型着色——表格边框行弱化、表头强调、
 * ERROR/WARNING/CRITICAL 红/黄、负 slack（违例）红、正 slack 绿、
 * "All user specified timing constraints are met" 绿。
 */
function renderHtml(title, text) {
    const lines = String(text).split(/\r?\n/);
    const body = lines.map(l => {
        const esc = l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let cls = '';
        if (/^\s*\|[-+|]+\|\s*$/.test(l)) cls = 'sep';
        else if (/^\s*\|/.test(l)) {
            cls = 'row';
            // 表格数据行含负数 → slack 违例（Vivado 报告仅时序列会出现负值）
            if (/-\d+(?:\.\d+)?/.test(l)) cls = 'viol';
        }
        else if (/^(ERROR|CRITICAL WARNING)\b/i.test(l)) cls = 'err';
        else if (/^WARNING\b/i.test(l)) cls = 'warn';
        if (/timing constraints are met/i.test(l)) cls = 'ok';
        return '<span class="' + cls + '">' + (esc || ' ') + '</span>';
    }).join('\n');
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body {
    margin: 0; padding: 12px 16px;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.45;
    white-space: pre;
  }
  h1 {
    margin: 0 0 10px; font-size: 14px; font-weight: 600;
    color: var(--vscode-titleBar-activeForeground, var(--vscode-editor-foreground));
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    padding-bottom: 8px; font-family: var(--vscode-ui-font-family, sans-serif);
  }
  .err { color: var(--vscode-editorError-foreground, #f48771); font-weight: 600; }
  .warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .ok { color: var(--vscode-testing-iconPassed, #73c991); font-weight: 600; }
  .viol { color: var(--vscode-editorError-foreground, #f48771); font-weight: 600; }
  .sep { color: var(--vscode-descriptionForeground, rgba(128,128,128,.8)); }
  .row { color: var(--vscode-editor-foreground); }
  ::-webkit-scrollbar { width: 12px; height: 12px; }
  ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,.4)); border-radius: 6px; }
</style>
</head>
<body><h1>${title.replace(/</g, '&lt;')}</h1>
${body}
</body>
</html>`;
}

module.exports = { showReport, renderHtml };
