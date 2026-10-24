'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** 在隔离宿主验证配置落盘、文件读取、NAPI替换与编辑器事务，不修改用户设置或工程。 */
async function run() {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    assert.equal(path.basename(root), 'workspace');
    const extension = vscode.extensions.getExtension('JayceVane.svtools');
    await extension.activate();
    const checks = [];
    const properties = extension.packageJSON.contributes.configuration.properties;
    assert.equal(properties['svtools.headerTemplate'].editPresentation, 'multilineText');
    assert.equal(properties['svtools.headerTemplateFile'].scope, 'resource');
    checks.push('运行扩展注册多行设置控件及资源作用域文件配置');

    async function open(directory, name, eol = '\n') {
        const uri = vscode.Uri.file(path.join(directory, name));
        const source = `module demo;${eol}endmodule${eol}`;
        await fs.writeFile(uri.fsPath, source);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        return { uri, document, source };
    }
    const inline = await open(root, 'inline.sv');
    const config = vscode.workspace.getConfiguration('svtools', inline.uri);
    const target = vscode.ConfigurationTarget.WorkspaceFolder;
    const template = '// 中文 {FILE}\n// {DATE} {TIME}\n\n// C:\\new\\tools literal \\n';
    await config.update('headerTemplate', template, target);
    const settings = JSON.parse(await fs.readFile(path.join(root, '.vscode', 'settings.json'), 'utf8'));
    assert.equal(settings['svtools.headerTemplate'], template);
    assert.equal(vscode.workspace.getConfiguration('svtools', inline.uri).get('headerTemplate'), template);
    await vscode.commands.executeCommand('svtools.insertHeader');
    assert.match(inline.document.getText(), /^\/\/ 中文 inline\.sv\n\/\/ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n\n/);
    assert.ok(inline.document.getText().endsWith('// C:\\new\\tools literal \\n\n' + inline.source));
    assert.equal(await fs.readFile(inline.uri.fsPath, 'utf8'), inline.source);
    await vscode.commands.executeCommand('undo');
    assert.equal(inline.document.getText(), inline.source);
    checks.push('真实配置JSON往返保留多行/空行/字面转义，插入占位符正确，一次撤销恢复原文');

    const templateDir = path.join(root, 'templates');
    await fs.mkdir(templateDir);
    const templateFile = path.join(templateDir, '公司头.txt');
    await fs.writeFile(templateFile, '\uFEFF// external {FILE}\r\n// 中文模板');
    await config.update('headerTemplateFile', '${workspaceFolder}/templates/公司头.txt', target);
    const external = await open(root, 'external.sv', '\r\n');
    await vscode.commands.executeCommand('svtools.insertHeader');
    assert.equal(external.document.getText(), '// external external.sv\r\n// 中文模板\r\n' + external.source);
    assert.equal(await fs.readFile(external.uri.fsPath, 'utf8'), external.source);
    await vscode.commands.executeCommand('undo');
    assert.equal(external.document.getText(), external.source);
    checks.push('真实UTF-8 BOM/中文路径/CRLF外部模板优先于内联，补齐换行且匹配文档EOL');

    await fs.writeFile(templateFile, '// second {FILE}');
    await vscode.commands.executeCommand('svtools.insertHeader');
    assert.equal(external.document.getText(), '// second external.sv\r\n' + external.source);
    await vscode.commands.executeCommand('undo');
    checks.push('外部模板修改后下一次插入立即生效，无需重载');

    for (const [file, content] of [['missing.txt', null], ['empty.txt', ' \n\t'], ['bad.txt', Buffer.from([0xff, 0xfe, 0x61, 0])]]) {
        if (content !== null) await fs.writeFile(path.join(templateDir, file), content);
        await config.update('headerTemplateFile', `templates/${file}`, target);
        await vscode.commands.executeCommand('svtools.insertHeader');
        assert.equal(external.document.getText(), external.source);
        assert.equal(await fs.readFile(external.uri.fsPath, 'utf8'), external.source);
    }
    checks.push('文件缺失/空白/非法编码的真实命令不插入回退模板，不修改编辑器和磁盘');

    const secondRoot = vscode.workspace.workspaceFolders[1]?.uri.fsPath;
    assert.equal(path.basename(secondRoot), 'workspace-b');
    await fs.mkdir(path.join(secondRoot, 'templates'), { recursive: true });
    await fs.writeFile(templateFile, '// folder A {FILE}');
    await config.update('headerTemplateFile', 'templates/公司头.txt', target);
    const second = await open(secondRoot, 'second.sv');
    await fs.writeFile(path.join(secondRoot, 'templates', '公司头.txt'), '// folder B {FILE}');
    await vscode.workspace.getConfiguration('svtools', second.uri).update('headerTemplateFile', 'templates/公司头.txt', target);
    await vscode.commands.executeCommand('svtools.insertHeader');
    assert.equal(second.document.getText(), '// folder B second.sv\n' + second.source);
    await vscode.window.showTextDocument(external.document);
    await vscode.commands.executeCommand('svtools.insertHeader');
    assert.equal(external.document.getText(), '// folder A external.sv\r\n' + external.source);
    checks.push('真实多根工作区分别读取所属文件夹的配置和同名模板，不串用首个工作区');

    await fs.writeFile(path.join(root, '..', 'host-report.json'), JSON.stringify({
        vscode: vscode.version, appName: vscode.env.appName, node: process.versions.node,
        extensionVersion: extension.packageJSON.version, extensionPath: extension.extensionPath,
        count: checks.length, checks
    }, null, 2));
}
module.exports = { run };
