'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseArgs } = require('node:util');
const { createToolTaskManager } = require('../src/toolchains/job');
const { createIcarusRunner } = require('../src/toolchains/iverilog-runner');
const { compileWithModuleResolution, buildCommonArgs, buildChildEnv } = require('../src/toolchains/iverilog');
const { lintWithXvlog, elaborateWithXvlog } = require('../src/toolchains/xvlog');
const { runVivadoBatchTask } = require('../src/vivado/batch');

/** 真实工具验收只在显式指定的安装路径运行，所有生成文件位于独立验收目录。 */
async function main() {
    const { values } = parseArgs({ options: Object.fromEntries(['iverilog', 'vvp', 'cygwin', 'vivado', 'out'].map(name => [name, { type: 'string' }])) });
    if (!values.iverilog && !values.vivado) throw new Error('请提供 --iverilog 或 --vivado 安装路径');
    const base = path.resolve(values.out || 'bin/toolchain-native-validation'); await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'run-'));
    const mainFile = path.join(root, 'native_tb.sv'), dependency = path.join(root, 'bad_dependency.sv');
    await fs.writeFile(mainFile, '`timescale 1ns/1ps\nmodule native_tb; reg clk=0; initial begin $dumpfile("native.vcd"); $dumpvars(0,native_tb); #1 clk=1; #1 $display("native simulation verified"); $finish; end endmodule\n');
    await fs.writeFile(dependency, 'module broken; wire x = ; endmodule\n');
    const uri = { fsPath: mainFile, scheme: 'file', toString: () => mainFile };
    const document = { uri, version: 1, languageId: 'systemverilog', isDirty: false, getText: () => require('node:fs').readFileSync(mainFile, 'utf8') };
    const report = { root, checks: [] }, channel = { appendLine: text => process.stdout.write(text + '\n') };
    const options = { standard: '2012', includePaths: [], libraryPaths: [], lintArgs: [], simFiles: [], simArgs: [], simTop: 'native_tb', simTimeoutMs: 10000 };
    const workspace = { workspaceFolders: [{ uri: { fsPath: root } }], getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
        getConfiguration: () => ({ get: (name, fallback) => options[name] ?? fallback }) };
    if (values.iverilog) {
        const manager = createToolTaskManager(), task = manager.start('simulation');
        const runner = createIcarusRunner({ workspace, channel, getConfig: () => workspace.getConfiguration(),
            scanSources: async () => ({ dirs: [], modules: new Map() }), buildCommonArgs, compile: compileWithModuleResolution,
            getToolchain: async () => ({ iverilog: path.resolve(values.iverilog), vvp: path.resolve(values.vvp || path.join(path.dirname(values.iverilog), process.platform === 'win32' ? 'vvp.exe' : 'vvp')),
                env: buildChildEnv(values.cygwin || null), cygwinDir: values.cygwin || null }),
            resolvePaths: dirs => dirs, expandFiles: async () => [], publish() {}, output: { append() {}, flush() {} },
            showWaveforms: async (task, waves) => assert.ok(waves.includes(path.join(root, 'native.vcd'))) });
        try {
            const result = await runner.simulate(task, document); assert.equal(result.status, 'success');
            assert.ok((await fs.readFile(result.logPath, 'utf8')).includes('native simulation verified'));
            report.checks.push({ name: 'Icarus compile + vvp + VCD', ...result });
        } finally { await task.finish({ keepArtifacts: true }); await manager.dispose(); }
    }
    if (values.vivado) {
        const findings = [], ctx = { vscode: { workspace }, channel, isVerilogDocument: () => true,
            applyDiagnostics: (document, entries) => findings.push(entries), scanWorkspaceSources: async () => ({ modules: new Map() }) };
        options.path = values.vivado;
        const valid = await elaborateWithXvlog(document, ctx); assert.equal(valid.status, 'success', valid.message);
        report.checks.push({ name: 'xvlog + xelab native', ...valid });
        options.currentFileOnly = false;
        const bad = await lintWithXvlog(document, { ...ctx, scanWorkspaceSources: async () => ({ modules: new Map([['broken', dependency]]) }) });
        assert.equal(bad.status, 'failed'); assert.equal(bad.errorCount, 0); assert.ok(bad.totalErrorCount > 0);
        report.checks.push({ name: 'xvlog dependency error blocks success', ...bad });
        const scriptPath = path.join(root, 'failure.tcl'); await fs.writeFile(scriptPath, 'puts "SVTOOLS_NATIVE_MARKER"\nputs "ERROR: intentional validation failure"\nexit 0\n');
        const manager = createToolTaskManager(), task = manager.start('vivado'); await task.directory(path.join(root, '.svtools', 'tasks'), 'vivado');
        const executable = path.join(require('../src/vivado/toolchain').findVivadoBinDir(values.vivado), process.platform === 'win32' ? 'vivado.bat' : 'vivado');
        try {
            const result = await runVivadoBatchTask({ task, executable, args: ['-mode', 'batch', '-nojournal', '-nolog', '-source', scriptPath], cwd: root, scriptPath, timeoutMs: 120000 });
            assert.equal(result.exitCode, 0); assert.equal(result.status, 'failed'); assert.match(result.stdout, /SVTOOLS_NATIVE_MARKER/);
            report.checks.push({ name: 'Vivado native ERROR with exit zero', ...result });
        } finally { await task.finish(); await manager.dispose(); }
    }
    const reportPath = path.join(root, 'report.json'); await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write('真实工具验收通过：' + reportPath + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
