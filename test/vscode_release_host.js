"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const content = value => value.replace(/[ \t\r\n]/g, '');

/** 真实编辑器事务与NAPI联动；只写隔离验收工作区，不读写系统剪贴板。 */
async function run() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.equal(path.basename(root), 'workspace');
    const extension = vscode.extensions.getExtension('JayceVane.svtools');
    await extension.activate();
    const checks = [];
    async function open(name, source) {
        const uri = vscode.Uri.file(path.join(root, name));
        await fs.writeFile(uri.fsPath, source);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        editor.options = { tabSize: 4, insertSpaces: true };
        return { uri, document, editor };
    }
    const source = 'module audit(input logic [8 + +1:0] d, output logic [9:0] q);\n// 注释与字符应保持\nassign q=d;\nendmodule\n';
    const fixture = await open('release.sv', source);
    await vscode.commands.executeCommand('editor.action.formatDocument');
    const formatted = fixture.document.getText();
    assert.notEqual(formatted, source);
    assert.equal(content(formatted), content(source));
    assert.match(formatted, /8\s*\+\s+\+\s*1/);
    checks.push('真实编辑器格式化保留字符顺序及二元/一元运算符边界');
    await vscode.commands.executeCommand('editor.action.formatDocument');
    assert.equal(fixture.document.getText(), formatted);
    await vscode.commands.executeCommand('undo');
    assert.equal(fixture.document.getText(), source);
    assert.equal(await fs.readFile(fixture.uri.fsPath, 'utf8'), source);
    checks.push('格式化幂等、撤销恢复原文、磁盘源码不被后台覆盖');

    const garbage = '\u2603\u0000\u00a0\u200b\ud800\n? @ ] \\ "乱码\t';
    const dirty = await vscode.workspace.openTextDocument({ language: 'systemverilog', content: garbage });
    const accepted = dirty.getText();
    await vscode.window.showTextDocument(dirty);
    await vscode.commands.executeCommand('editor.action.formatDocument');
    assert.equal(content(dirty.getText()), content(accepted));
    checks.push('乱码缓冲区的实际编辑器内容保持非排版字符；宿主规范化与NAPI单独核验');

    const literal = 'module literal #(parameter LABEL="https://example.invalid/a;  b)")(input int d, output int q); assign q=d; endmodule\n';
    const generated = await open('literal.sv', literal);
    await vscode.commands.executeCommand('svtools.generateTestbench');
    const tb = vscode.window.activeTextEditor.document;
    assert.notEqual(tb.uri.toString(), generated.document.uri.toString());
    assert.ok(tb.isUntitled);
    assert.match(tb.getText(), /LABEL\s*=\s*"https:\/\/example\.invalid\/a;  b\)"/);
    assert.match(tb.getText(), /logic signed \[31:0\] d;/);
    assert.match(tb.getText(), /\$dumpvars\(0, tb_literal\)/);
    assert.doesNotMatch(tb.getText(), /posedge\s*\)|\$fsdbDump/);
    assert.equal(generated.document.getText(), literal);
    checks.push('真实命令在独立未命名页生成默认VCD骨架，字符串与整数位宽保持');

    const unsupported = await open('unsupported.sv', 'module unsupported(input logic [7:0] mem [0:3]); endmodule\n');
    const before = vscode.workspace.textDocuments.length;
    await vscode.commands.executeCommand('svtools.generateTestbench');
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), unsupported.document.uri.toString());
    assert.equal(vscode.workspace.textDocuments.length, before);
    assert.equal(unsupported.document.getText(), await fs.readFile(unsupported.uri.fsPath, 'utf8'));
    checks.push('不支持接口在真实命令入口拒绝生成，原页和磁盘保持');
    await fs.writeFile(path.join(root, '..', 'host-report.json'), JSON.stringify({
        vscode: vscode.version, appName: vscode.env.appName, node: process.versions.node,
        electron: process.versions.electron, extensionVersion: extension.packageJSON.version,
        extensionPath: extension.extensionPath, count: checks.length, checks
    }, null, 2));
}
module.exports = { run };
