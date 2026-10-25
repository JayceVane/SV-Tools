'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

/** 真实Qoder/VS Code里从源码命令进入追踪；源码和设置只写隔离验收工作区。 */
async function run() {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath, checks = [];
    assert.equal(path.basename(root), 'workspace');
    const extension = vscode.extensions.getExtension('JayceVane.svtools'); await extension.activate();
    const source = 'module trace_source(input logic clk, rst_n, input logic [3:0] data, mask, output logic [3:0] q, output wire observed);\n'
        + 'wire [3:0] gated = data & mask;\nwire [3:0] chosen = gated ^ {4{data[0]}};\n'
        + 'always @(posedge clk or negedge rst_n) begin if(!rst_n) q<=0; else q<=chosen; end\nassign observed=q[2];\nendmodule\n';
    const file = path.join(root, 'trace_source.sv'); await fs.writeFile(file, source);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file)), editor = await vscode.window.showTextDocument(document);
    const point = document.positionAt(source.lastIndexOf('q[2]') + 1); editor.selection = new vscode.Selection(point, point);
    const commands = await vscode.commands.getCommands();
    for (const name of ['traceDrivers', 'traceLoads']) assert.ok(commands.includes('svtools.circuit.' + name));
    const binding = await vscode.commands.executeCommand('svtools.circuit.traceDrivers', document.uri); assert.ok(binding);
    try {
        const loaded = await binding.loaded; assert.equal(loaded.ok, true, loaded.error);
        assert.ok(loaded.graph.trace); assert.deepEqual(loaded.graph.trace.origin.bits.map(bit => bit.index), [2]);
        assert.equal(loaded.graph.trace.direction, 'drivers');
        checks.push('真实源码右键命令从q[2]直接打开局部图，Webview/Worker/内置Yosys联动');
        const sequential = loaded.graph.trace.frontiers.find(frontier => frontier.reason === 'sequential'); assert.ok(sequential);
        const expanded = await binding.trace.expand(sequential.id); assert.equal(expanded.trace.branches.length, 1);
        const depth = expanded.trace.frontiers.find(frontier => frontier.kind === 'expand' && frontier.reason === 'depth'); assert.ok(depth);
        const next = await binding.trace.expand(depth.id); assert.equal(next.trace.branches.length, 2);
        checks.push('真实寄存器边界需显式跨越，继续展开数据/控制候选及组合分支');
        await binding.trace.go(-1); assert.equal(binding.getState().graph.trace.branches.length, 1);
        await binding.trace.go(1); assert.equal(binding.getState().graph.trace.branches.length, 2);
        await binding.trace.collapse(sequential.id); assert.equal(binding.getState().graph.trace.branches.length, 0);
        checks.push('前进返回恢复分支，收起时删除其后代');
        const origin = binding.getState().graph.trace.origin;
        const reveal = await binding.revealSource({ objectId: origin.objectId }); assert.equal(reveal.ok, true, reveal.error);
        assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, file);
        checks.push('同一生成快照的网络可以返回其实际源码声明');
        await editor.edit(edit => edit.insert(new vscode.Position(document.lineCount - 1, 0), '// unsaved edit\n'));
        const stale = await binding.revealSource({ objectId: origin.objectId }); assert.equal(stale.ok, false); assert.match(stale.error, /变化/);
        await binding.reload(); const refreshed = binding.getState(); assert.ok(refreshed.graph.trace);
        assert.notEqual(refreshed.design.revision, loaded.design.revision);
        const fresh = await binding.revealSource({ objectId: refreshed.graph.trace.origin.objectId }); assert.equal(fresh.ok, true, fresh.error);
        assert.equal(document.isDirty, true); assert.equal(await fs.readFile(file, 'utf8'), source);
        checks.push('源码修改拒绝旧位置，刷新后按脏正文重新生成并恢复定位，磁盘保持');
        const loadBinding = await vscode.commands.executeCommand('svtools.circuit.traceLoads', document.uri);
        assert.ok(loadBinding);
        try {
            const loadResult = await loadBinding.loaded; assert.equal(loadResult.ok, true, loadResult.error);
            assert.equal(loadResult.graph.trace.direction, 'loads');
            checks.push('追踪负载源码命令也可使用未保存快照直接打开局部图');
        } finally { loadBinding.dispose(); }
        await fs.writeFile(path.join(root, '..', 'host-report.json'), JSON.stringify({ vscode: vscode.version,
            version: extension.packageJSON.version, extensionPath: extension.extensionPath, checks, count: checks.length,
            graph: { nodes: refreshed.graph.nodes.length, edges: refreshed.graph.edges.length }, context: refreshed.graph.trace.context }, null, 2));
    } finally { binding.dispose(); }
}
module.exports = { run };
