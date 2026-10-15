'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** 在隔离 VS Code 扩展宿主验证真实 Webview 握手、Worker 和包内 ELK。 */
async function run() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.equal(path.basename(root), 'workspace');
    const extension = vscode.extensions.getExtension('JayceVane.svtools');
    const { circuit } = await extension.activate();
    assert.ok(circuit);
    const checks = [];
    const commands = await vscode.commands.getCommands();
    for (const command of ['open', 'fromSource', 'fromVivado', 'stop']) assert.ok(commands.includes('svtools.circuit.' + command));
    checks.push('真实扩展注册四个电路命令');
    const jsonPath = path.join(root, 'circuit.json');
    await fs.writeFile(jsonPath, JSON.stringify({ modules: { top: { ports: {
        a: { direction: 'input', bits: [2] }, y: { direction: 'output', bits: [2] }
    }, cells: {}, netnames: {} } } }));
    const binding = await circuit.openNetlist(vscode.Uri.file(jsonPath));
    try {
        const loaded = await binding.loaded;
        assert.ok(loaded.ok, loaded.error);
        assert.equal(loaded.design.provenance.engine, 'yosys');
        assert.equal(loaded.graph.edges.length, 1);
        assert.ok(loaded.graph.width > 0);
        checks.push('Webview nonce脚本真实握手并显示Worker/ELK数据');
    } finally { binding.dispose(); }
    await fs.writeFile(jsonPath, JSON.stringify({ schemaVersion: 1, engine: 'vivado', version: '2022.1',
        stage: 'elaborated-rtl', view: 'flat', top: 'top', ports: [], cells: [], signals: [] }));
    const imported = await circuit.openNetlist(vscode.Uri.file(jsonPath));
    try {
        const loaded = await imported.loaded;
        assert.ok(loaded.ok, loaded.error);
        assert.equal(loaded.design.provenance.hierarchy, 'flat');
        checks.push('真实宿主自动识别Vivado JSON与flat来源');
    } finally { imported.dispose(); }
    if (process.env.SVTOOLS_CIRCUIT_YOSYS) {
        const filePath = path.join(root, 'top.sv');
        const disk = 'module host_top(input wire a, output wire y);\nassign y = a;\nendmodule\n';
        await fs.writeFile(filePath, disk);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        const editor = await vscode.window.showTextDocument(document);
        await editor.edit(edit => edit.replace(new vscode.Range(1, 0, 1, document.lineAt(1).text.length), 'assign y = ~a;'));
        await vscode.workspace.getConfiguration('svtools.circuit', document.uri).update('yosysPath', process.env.SVTOOLS_CIRCUIT_YOSYS, vscode.ConfigurationTarget.Workspace);
        const rtl = await circuit.fromSource();
        try {
            const loaded = await rtl.loaded;
            assert.ok(loaded.ok, loaded.error);
            assert.equal(loaded.design.provenance.stage, 'rtl');
            assert.ok(loaded.graph.nodes.some(node => node.detail === '$not'));
            assert.equal(await fs.readFile(filePath, 'utf8'), disk);
            assert.equal(document.isDirty, true);
            checks.push('未保存正文真实生成电路，源码磁盘与脏文档保持原状态');
        } finally { rtl.dispose(); }
    }
    await fs.writeFile(path.join(root, '..', 'host-report.json'), JSON.stringify({
        vscode: vscode.version, extensionVersion: extension.packageJSON.version, extensionPath: extension.extensionPath,
        checks, count: checks.length
    }, null, 2));
}
module.exports = { run };
