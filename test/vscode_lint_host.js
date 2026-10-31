'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 隔离宿主内使用真实 Icarus 检查依赖失效、停止以及手动/自动去重。 */
async function run() {
    const extension = vscode.extensions.getExtension('JayceVane.svtools');
    await extension.activate();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath, checks = [];
    const config = vscode.workspace.getConfiguration('svtools.iverilog');
    for (const [name, value] of Object.entries({ path: 'D:/DevKit/iverilog/bin/iverilog.exe', cygwinPath: 'D:/DevKit/cygwin64/bin',
        lintOnOpen: false, lintOnChange: false, lintOnSave: false, lintDebounceMs: 600 })) await config.update(name, value, vscode.ConfigurationTarget.Workspace);
    const lint = vscode.workspace.getConfiguration('svtools.lint');
    await lint.update('engine', 'iverilog', vscode.ConfigurationTarget.Workspace);
    await lint.update('currentFileOnly', true, vscode.ConfigurationTarget.Workspace); await delay(200);
    const top = path.join(root, 'lint_top.sv'), child = path.join(root, 'lint_child.sv');
    const good = "module lint_child(output wire q); assign q = 1'b0; endmodule\n";
    const bad = 'module lint_child(output wire q); assign q = ; endmodule\n';
    await fs.writeFile(top, 'module lint_top; wire q; lint_child dut(.q(q)); endmodule\n'); await fs.writeFile(child, bad);
    const topDoc = await vscode.workspace.openTextDocument(top);
    await vscode.window.showTextDocument(topDoc);
    // 测试夹具刚创建，先让真实文件监视器交还创建事件，再开始验收。
    await delay(500);
    const manual = () => vscode.commands.executeCommand('svtools.iverilog.lint');
    const problems = file => vscode.languages.getDiagnostics(vscode.Uri.file(file)).filter(item => item.source?.includes('iverilog'));
    const isolated = await manual();
    assert.equal(isolated.status, 'failed', JSON.stringify(isolated)); assert.ok(isolated.totalErrorCount > 0);
    assert.equal(problems(child).length, 0); assert.ok(problems(top).length > 0);
    checks.push('真实Icarus依赖失败仍判failed，当前文件模式不把外部错误写入Problems');
    await lint.update('currentFileOnly', false, vscode.ConfigurationTarget.Workspace); await delay(120);
    assert.equal((await manual()).status, 'failed'); assert.ok(problems(child).length > 0);
    const childDoc = await vscode.workspace.openTextDocument(child);
    await vscode.window.showTextDocument(childDoc);
    const replace = async text => {
        const editor = await vscode.window.showTextDocument(childDoc);
        return editor.edit(edit => edit.replace(new vscode.Range(childDoc.positionAt(0), childDoc.positionAt(childDoc.getText().length)), text));
    };
    await replace(good); assert.equal(problems(child).length, 0);
    const childCheck = await manual(); assert.equal(childCheck.status, 'success', JSON.stringify(childCheck));
    assert.equal(await childDoc.save(), true);
    await vscode.window.showTextDocument(topDoc);
    const rootCheck = await manual(); assert.equal(rootCheck.status, 'success', JSON.stringify(rootCheck));
    checks.push('跨文件模式显示依赖错误，编辑依赖立即撤销旧诊断，保存后主模块真实编译通过');
    await vscode.window.showTextDocument(childDoc);
    await config.update('lintOnChange', true, vscode.ConfigurationTarget.Workspace); await delay(120);
    await replace(bad); await vscode.commands.executeCommand('svtools.lint.stop', childDoc); await delay(1000);
    assert.equal(problems(child).length, 0);
    assert.equal((await manual()).status, 'failed');
    checks.push('停止撤销600ms防抖，等待后不再出现自动诊断；手动检查仍能发现脏缓冲区语法错误');
    const taskDirs = async () => {
        try { return new Set((await fs.readdir(path.join(root, '.svtools/tasks'))).filter(name => name.startsWith('iverilog-lint-'))); }
        catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
    };
    const before = await taskDirs();
    await replace('module lint_child(output wire q); assign q = ( ; endmodule\n');
    assert.equal((await manual()).status, 'failed'); await delay(1000);
    const after = await taskDirs(); assert.equal([...after].filter(name => !before.has(name)).length, 1);
    checks.push('手动lint消费旧防抖，跨过原定时点后只产生一个真实编译任务目录');
    await config.update('lintOnChange', false, vscode.ConfigurationTarget.Workspace);
    const result = { version: extension.packageJSON.version, flavor: extension.packageJSON.svtoolsBuildFlavor || 'public', checks, count: checks.length };
    await fs.writeFile(path.join(root, '../lint-host-report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
module.exports = { run };
