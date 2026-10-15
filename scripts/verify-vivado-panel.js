'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseArgs } = require('node:util');
const { createToolTaskManager } = require('../src/toolchains/job');
const { runVivadoBatchTask } = require('../src/vivado/batch');
const { findVivadoBinDir, buildCreateProjectScript, buildAddFilesScript, buildMoveFileScript, buildSetTopScript, buildSimulateScript, tclQuote } = require('../src/vivado');
const { parseXpr, samePath } = require('../src/vivado/xpr');
const { elaborateWithXvlog } = require('../src/toolchains/xvlog');

/** 真实 Vivado 工程动作只写新建验收目录，不修改用户的 XPR 或源码。 */
async function main() {
    const { values } = parseArgs({ options: { vivado: { type: 'string' }, out: { type: 'string' }, part: { type: 'string' } } });
    if (!values.vivado) throw new Error('请提供 --vivado 安装路径');
    const parent = path.resolve(values.out || 'bin/vivado-panel-native'); await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'run-')), projectDir = path.join(root, 'project'), xpr = path.join(projectDir, 'panel.xpr');
    const topFile = path.join(root, 'design.sv'), leaf = path.join(root, 'leaf.sv'), extra = path.join(root, 'extra.sv'), tb = path.join(root, 'panel_tb.sv');
    await fs.writeFile(topFile, 'module unused; endmodule\nmodule selected; leaf u_leaf(); endmodule\n');
    await fs.writeFile(leaf, 'module leaf; endmodule\n'); await fs.writeFile(extra, 'module extra; endmodule\n');
    await fs.writeFile(tb, '`timescale 1ns/1ps\nmodule panel_tb; initial begin #1; $display("SVTOOLS_PANEL_NATIVE_SIM"); $finish; end endmodule\n');
    const bin = findVivadoBinDir(values.vivado), executable = path.join(bin, process.platform === 'win32' ? 'vivado.bat' : 'vivado');
    const manager = createToolTaskManager(), task = manager.start('native-panel'); await task.directory(path.join(root, '.svtools', 'tasks'), 'vivado');
    const report = { root, checks: [] };
    async function run(name, body) {
        const scriptPath = path.join(root, name + '.tcl'); await fs.writeFile(scriptPath, body);
        const result = await runVivadoBatchTask({ task, executable, args: ['-mode', 'batch', '-nojournal', '-nolog', '-source', scriptPath], cwd: root, scriptPath, timeoutMs: 120000 });
        assert.equal(result.status, 'success', name + ': ' + result.message); return result;
    }
    try {
        await run('create', buildCreateProjectScript({ name: 'panel', dir: projectDir, part: values.part || 'xc7z100ffg900-2', sources: [topFile, leaf], sims: [tb], constraints: [], top: 'selected', simTop: 'panel_tb' })
            + '\ncreate_fileset -simset sim_custom\nclose_project\n');
        assert.ok(parseXpr(xpr).sets.some(set => set.name === 'sim_custom')); report.checks.push('真实XPR创建与自定义仿真集');
        await run('manage', buildAddFilesScript(xpr, extra, 'sources_1', true)
            + buildMoveFileScript({ xprPath: xpr, file: extra, from: 'sources_1', to: 'sim_custom', isSv: true })
            + buildSetTopScript({ xprPath: xpr, fileset: 'sources_1', top: 'selected' }));
        const parsed = parseXpr(xpr);
        assert.ok(parsed.sets.find(set => set.name === 'sim_custom').files.some(file => samePath(file, extra)));
        assert.ok(!parsed.sets.find(set => set.name === 'sources_1').files.some(file => samePath(file, extra)));
        assert.equal(parsed.sets.find(set => set.name === 'sources_1').top, 'selected'); report.checks.push('真实加入/跨文件集移动/设置顶层与事实校验');
        const uri = { fsPath: topFile, scheme: 'file', toString: () => topFile }, document = { uri, languageId: 'systemverilog', isDirty: false, version: 1, getText: () => 'module unused; endmodule\nmodule selected; leaf u_leaf(); endmodule' };
        const result = await elaborateWithXvlog(document, { vscode: { workspace: { workspaceFolders: [{ uri: { fsPath: root } }], getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
            getConfiguration: () => ({ get: (name, fallback) => name === 'path' ? values.vivado : fallback }) } },
            top: 'selected', projectScope: { files: [topFile, leaf], modules: new Map([['selected', topFile], ['leaf', leaf]]), includePaths: [root] },
            channel: { appendLine: text => process.stdout.write(text + '\n') }, applyDiagnostics() {}, isVerilogDocument: () => true,
            scanWorkspaceSources: async () => { throw new Error('不应查询其它工程的索引'); } });
        assert.equal(result.status, 'success', result.message); report.checks.push('真实xelab使用指定第二个模块和当前工程成员');
        const simulation = await run('simulate', buildSimulateScript({ xprPath: xpr, top: 'panel_tb', file: tb, isSv: true, runtime: '', fileset: 'sim_custom' }));
        const simulationLog = path.join(projectDir, 'panel.sim', 'sim_custom', 'behav', 'xsim', 'simulate.log');
        assert.ok(simulation.stdout.includes('SVTOOLS_PANEL_NATIVE_SIM') || (await fs.readFile(simulationLog, 'utf8')).includes('SVTOOLS_PANEL_NATIVE_SIM'));
        assert.equal(parseXpr(xpr).sets.find(set => set.name === 'sim_custom').top, 'panel_tb'); report.checks.push('真实xsim在sim_custom运行到$finish');
    } finally { await task.finish(); await manager.dispose(); }
    const reportPath = path.join(root, 'report.json'); await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write('Vivado 面板真实动作验收通过：' + reportPath + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
