'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || [])]);

/** 在独立 VS Code 用户目录与 fixture 工作区运行真实扩展宿主，不启动 Vivado 写用户工程。 */
async function run() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root && path.basename(root) === 'workspace', '需要独立的验收工作区');
    const extension = vscode.extensions.getExtension('JayceVane.svtools'); assert.ok(extension);
    const { vivado } = await extension.activate(); assert.ok(vivado.projectTree, '工程树必须完成注册');
    const panel = vivado.projectTree, checks = [];
    await panel.ready;
    const first = panel.getChildren()[0]; assert.equal(first.contextValue, 'project'); checks.push('首次异步加载可见工程');
    await vscode.commands.executeCommand('workbench.view.extension.svtools-vivado');
    let events = 0; const listener = panel.onDidChangeTreeData(() => { events++; });
    try {
        const ids = flatten(panel.getChildren()).map(node => node.id);
        await vscode.commands.executeCommand('svtools.vivado.tree.refresh'); assert.ok(events > 0);
        assert.deepEqual(flatten(panel.getChildren()).map(node => node.id), ids); checks.push('真实刷新事件与稳定ID');
        await vscode.commands.executeCommand('svtools.vivado.tree.expandAll'); checks.push('真实TreeView父节点与展开');
        const alternate = path.join(root, 'alternate.xpr'); await fs.copyFile(path.join(root, 'design.xpr'), alternate);
        await vivado.projectSelection.select(alternate); await vivado.refreshProjectContext(); await panel.refresh();
        assert.equal(panel.getChildren()[0].label, 'alternate'); checks.push('工程选择与编辑器上下文一致');
        await fs.writeFile(alternate, '<Project><FileSets>'); await panel.refresh();
        assert.match(panel.getChildren()[0].label, /读取工程失败/); checks.push('损坏XPR明确显示错误');
        await fs.copyFile(path.join(root, 'design.xpr'), alternate); await panel.refresh();
        assert.equal(panel.getChildren()[0].contextValue, 'project'); checks.push('修复XPR后刷新恢复');
        await fs.unlink(alternate); await panel.refresh(); assert.match(panel.getChildren()[0].label, /已不存在/);
        await vivado.projectSelection.select(path.join(root, 'design.xpr')); await vivado.refreshProjectContext(); await panel.refresh();
        assert.equal(panel.getChildren()[0].label, 'design'); checks.push('删除所选工程后可重新选择恢复');
        const nodes = flatten(panel.getChildren()); assert.ok(nodes.some(node => node.contextValue === 'orphan' && node.label === 'orphan.sv'));
        assert.ok(nodes.some(node => node.nodeData?.module === 'leaf')); checks.push('成员层级与未加入文件');
    } finally { listener.dispose(); }
    const report = { vscode: vscode.version, version: extension.packageJSON.version, checks };
    await fs.writeFile(path.join(root, '..', 'host-report.json'), JSON.stringify(report, null, 2));
    console.log('SVTOOLS_HOST_VALIDATED ' + JSON.stringify(report));
}
module.exports = { run };
