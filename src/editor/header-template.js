'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/** 根据当前文档解析模板路径；相对路径优先使用其所属工作区，未归属工作区则使用源码目录。 */
function templateUri(vscode, document, file) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const workspacePrefix = /^\$\{workspaceFolder\}(?:[/\\]|$)/;
    if (workspacePrefix.test(file)) {
        if (!folder) throw new Error('模板路径使用 ${workspaceFolder}，但当前文档不属于工作区');
        return vscode.Uri.joinPath(folder.uri, file.replace(workspacePrefix, '').replace(/\\/g, '/'));
    }
    if (path.isAbsolute(file)) return vscode.Uri.file(file);
    const base = folder?.uri || (document.uri.scheme === 'file'
        ? vscode.Uri.file(path.dirname(document.fileName)) : null);
    if (!base) throw new Error('相对模板路径需要当前文档属于工作区，或先保存文档；也可配置绝对路径');
    return vscode.Uri.joinPath(base, file.replace(/\\/g, '/'));
}

/**
 * 读取当前文档的文件头模板：外部UTF-8文件 > 内联字符串 > 内置模板。
 * @param {object} vscode VS Code API；外部文件通过workspace.fs读取，支持工作区文件系统。
 * @param {object} document 当前编辑文档，用于资源配置与相对路径解析。
 * @returns {Promise<string>} 保留内部空行、统一为LF并保证末尾换行的模板；不解释字面反斜杠转义。
 * @throws {Error} 配置文件无法读取、不是UTF-8或模板为空时拒绝插入，不静默回退。
 */
async function loadHeaderTemplate(vscode, document) {
    const config = vscode.workspace.getConfiguration('svtools', document.uri);
    const file = config.get('headerTemplateFile', '').trim();
    let template;
    let source = 'svtools.headerTemplate';
    if (file) {
        source = file;
        try {
            const uri = templateUri(vscode, document, file);
            source = uri.fsPath || uri.toString();
            const bytes = await vscode.workspace.fs.readFile(uri);
            template = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (error) {
            throw new Error(`无法读取UTF-8文件头模板 ${source}：${error.message}`);
        }
    } else {
        template = config.get('headerTemplate', '');
        if (!template) {
            source = path.resolve(__dirname, '..', '..', 'templates', 'header_template.txt');
            template = await fs.readFile(source, 'utf8');
        }
    }
    template = template.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!template.trim()) throw new Error(`文件头模板为空：${source}`);
    // 行注释模板不能与原文件第一行相连；内部空白和已有末尾空行保持不变。
    return template.endsWith('\n') ? template : template + '\n';
}

module.exports = { loadHeaderTemplate };
