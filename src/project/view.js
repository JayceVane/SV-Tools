'use strict';
const { randomBytes } = require('node:crypto');
/** @param {object} webview VS Code Webview。 @param {object} extensionUri 扩展根URI。 @param {object} vscode 宿主API。 @returns {string} 本地脚本／样式与严格CSP，工程文本只由textContent提交。 */
function projectHtml(webview, extensionUri, vscode) {
    const nonce = randomBytes(24).toString('base64');
    const resource = name => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'project', name));
    const chinese = /^zh\b/i.test(vscode.env?.language || 'zh-CN');
    const flow = chinese ? 'Vivado 流程' : 'Vivado Flow';
    const showFlow = chinese ? '展开 Vivado 流程' : 'Show Vivado Flow';
    const addVivado = chinese ? '添加文件到 Vivado 工程' : 'Add files to the Vivado project';
    const refresh = chinese ? '刷新工程' : 'Refresh project';
    const actions = chinese ? '工程操作' : 'Project actions';
    return `<!DOCTYPE html>
<html lang="${chinese ? 'zh-CN' : 'en'}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('style.css')}"></head><body>
<header><button id="choose" class="project" aria-label="${chinese ? '切换工程' : 'Switch project'}"><span class="grow"><span id="projectName">${chinese ? '选择或创建工程' : 'Select or create a project'}</span><span id="projectLocation" hidden></span></span><span id="projectKind" class="badge"></span><span class="chevron" data-icon="chevron"></span></button></header>
<div class="modes"><button id="files" aria-pressed="true">${chinese ? '文件' : 'Files'}</button><button id="instances" aria-pressed="false">${chinese ? '实例层级' : 'Hierarchy'}</button><button id="progress" aria-pressed="false">${chinese ? '设计进展' : 'Progress'}</button><span class="grow"></span><button id="add" class="icon-button"><span data-icon="plus"></span>${chinese ? '添加' : 'Add'}</button><button id="ipManager" title="${chinese ? '配置和管理工程中的 IP' : 'Configure and manage project IP'}" hidden>${chinese ? 'IP 管理' : 'IP Manager'}</button><button id="vivadoTools" class="icon-button" aria-label="${showFlow}" hidden><span data-icon="instance"></span>Vivado</button><button id="refresh" class="icon-button" aria-label="${refresh}" title="${refresh}" data-icon="refresh"></button><button id="actions" class="icon-button" aria-label="${actions}" title="${actions}" aria-haspopup="menu" aria-expanded="false" aria-controls="menu">⋯</button></div>
<div id="trace" class="trace" hidden><span id="traceRoot" class="grow">追踪编辑器所选信号</span><button id="pin" aria-pressed="false">固定</button><button id="clear" class="icon-button" aria-label="退出追踪" title="退出追踪" data-icon="close"></button></div>
<div id="menu" class="menu" role="menu" hidden></div><div id="message" role="status" aria-live="polite"></div>
<div id="tree" role="tree" aria-label="工程文件和实例"></div>
<section id="tools" aria-label="${flow}" hidden><div class="tools-heading"><button id="toggleTools" class="grow" aria-expanded="true" aria-controls="toolBody"><span data-icon="chevron"></span>${flow}</button><button id="addVivado" class="icon-button" title="${addVivado}"><span data-icon="plus"></span>${chinese ? '文件' : 'Files'}</button></div><div id="toolBody"><div id="toolOverview"></div><div id="toolActions" class="tool-grid"></div><div id="assetActions" class="tool-grid asset-actions" role="group" aria-label="${chinese ? 'Vivado 设计资产' : 'Vivado design assets'}"></div><button id="toolReports" aria-haspopup="menu" aria-expanded="false" aria-controls="menu"><span data-icon="report"></span><span class="grow">${chinese ? '查看报告' : 'Reports'}</span><span class="chevron" data-icon="chevron"></span></button></div></section>
<details id="diagnostics" hidden><summary>分析提示</summary><div id="issues"></div></details>
<script nonce="${nonce}" src="${resource('icons.js')}"></script><script nonce="${nonce}" src="${resource('client.js')}"></script></body></html>`;
}
module.exports = { projectHtml };
