'use strict';
const { randomBytes } = require('node:crypto');
/** @param {object} webview VS Code Webview。 @param {object} extensionUri 扩展根URI。 @param {object} vscode 宿主API。 @returns {string} 本地脚本／样式与严格CSP，工程文本只由textContent提交。 */
function projectHtml(webview, extensionUri, vscode) {
    const nonce = randomBytes(24).toString('base64');
    const resource = name => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'project', name));
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('style.css')}"></head><body>
<header><button id="choose" class="project" aria-label="切换工程"><span id="projectName" class="grow">选择或创建工程</span><span id="projectKind" class="badge"></span><span class="chevron" data-icon="chevron"></span></button></header>
<div class="modes"><button id="files" aria-pressed="true">文件</button><button id="instances" aria-pressed="false">实例层级</button><span class="grow"></span><button id="add" class="icon-button"><span data-icon="plus"></span>添加</button><button id="vivadoTools" class="icon-button" aria-label="展开 Vivado 流程" hidden><span data-icon="instance"></span>Vivado</button><button id="refresh" class="icon-button" aria-label="刷新工程" title="刷新工程" data-icon="refresh"></button><button id="actions" class="icon-button" aria-label="工程操作" title="工程操作">⋯</button></div>
<div id="trace" class="trace" hidden><span id="traceRoot" class="grow">追踪编辑器所选信号</span><button id="pin" aria-pressed="false">固定</button><button id="clear" class="icon-button" aria-label="退出追踪" title="退出追踪" data-icon="close"></button></div>
<div id="menu" class="menu" role="menu" hidden></div><div id="message" role="status" aria-live="polite"></div>
<div id="tree" role="tree" aria-label="工程文件和实例"></div>
<section id="tools" aria-label="Vivado 流程" hidden><div class="tools-heading"><button id="toggleTools" class="grow" aria-expanded="true" aria-controls="toolBody"><span data-icon="chevron"></span>Vivado 流程</button><button id="addVivado" class="icon-button" title="添加文件到 Vivado 工程"><span data-icon="plus"></span>文件</button></div><div id="toolBody"><div id="toolActions" class="tool-grid"></div><button id="toolReports"><span data-icon="report"></span><span class="grow">查看报告</span><span class="chevron" data-icon="chevron"></span></button></div></section>
<details id="diagnostics" hidden><summary>分析提示</summary><div id="issues"></div></details>
<script nonce="${nonce}" src="${resource('icons.js')}"></script><script nonce="${nonce}" src="${resource('client.js')}"></script></body></html>`;
}
module.exports = { projectHtml };
