'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const { createToolTaskManager } = require('../src/toolchains/job');
const { runVivadoBatchTask } = require('../src/vivado/batch');
const { tclUtf8Literal: tclQuote } = require('../src/circuit/vivado-export');
const { runVivadoCircuit } = require('../src/circuit/vivado-runner');
const { fromVivado } = require('../src/circuit/adapters/vivado');

/** @param {string} value 安装目录、bin 目录或可执行文件。 @returns {Promise<string>} 明确配置不存在时不回退其它版本。 */
async function resolveExecutable(value) {
    if (!value) throw new Error('用法：node scripts/verify-circuit-vivado.js --vivado <安装目录或可执行文件> [--out bin/vivado-circuit-validation] [--part xc7z100ffg900-2]');
    const candidate = path.resolve(value);
    const stat = await fs.stat(candidate);
    if (stat.isFile()) return candidate;
    if (!stat.isDirectory()) throw new Error('Vivado 路径必须是目录或可执行文件：' + candidate);
    const bin = path.basename(candidate).toLowerCase() === 'bin' ? candidate : path.join(candidate, 'bin');
    const executable = path.join(bin, process.platform === 'win32' ? 'vivado.bat' : 'vivado');
    if (!(await fs.stat(executable)).isFile()) throw new Error('未找到 Vivado 可执行文件：' + executable);
    return executable;
}

/** 记录项目树文件内容，验证只读导出没有修改 XPR 或用户工程文件。 */
async function snapshot(root) {
    const result = {};
    async function visit(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(file);
            else if (entry.isFile()) result[path.relative(root, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
        }
    }
    await visit(root); return result;
}

/** 公开小 RTL：跨实例、descending/ascending 总线、寄存器与加法均由真实 Vivado 生成。 */
async function main() {
    const { values } = parseArgs({ options: { vivado: { type: 'string' }, out: { type: 'string' }, part: { type: 'string', default: 'xc7z100ffg900-2' } } });
    const executable = await resolveExecutable(values.vivado);
    const parent = path.resolve(values.out || 'bin/vivado-circuit-validation'); await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'run-')), projectDir = path.join(root, 'project');
    const rtl = path.join(root, 'circuit.sv'), standalone = path.join(root, 'standalone.sv'), unreferenced = path.join(root, '独立 module.sv'), xpr = path.join(projectDir, 'circuit.xpr');
    await fs.writeFile(rtl, [
        'module leaf(input clk, input en, input [3:0] a, output reg [3:0] q);',
        "  always @(posedge clk) if (en) q <= a + 4'd1;",
        'endmodule',
        'module top(input clk, input en, input [3:0] a, input [2:5] ascending, output [3:0] q, output [2:5] mirror);',
        '  leaf u_leaf(.clk(clk), .en(en), .a(a), .q(q));',
        '  assign mirror = ascending;',
        'endmodule', ''
    ].join('\n'));
    await fs.writeFile(standalone, 'module standalone(input [1:0] a, input [1:0] b, output [1:0] sum); assign sum = a + b; endmodule\n');
    await fs.writeFile(unreferenced, 'module unreferenced(input [1:0] a, input [1:0] b, output [1:0] sum); assign sum = a + b; endmodule\n');
    const sourceBefore = await Promise.all([rtl, standalone, unreferenced].map(file => fs.readFile(file, 'utf8')));
    const manager = createToolTaskManager(), createTask = manager.start('create-circuit-fixture');
    await createTask.directory(path.join(root, 'tasks'), 'create');
    const scriptPath = path.join(root, 'create-project.tcl');
    await fs.writeFile(scriptPath, [
        'create_project circuit ' + tclQuote(projectDir) + ' -part ' + tclQuote(values.part),
        'add_files [list ' + tclQuote(rtl) + ' ' + tclQuote(unreferenced) + ']', 'set_property top top [current_fileset]',
        'update_compile_order -fileset sources_1', 'close_project', ''
    ].join('\n'));
    try {
        const created = await runVivadoBatchTask({ task: createTask, executable,
            args: ['-mode', 'batch', '-nojournal', '-nolog', '-source', scriptPath], cwd: root, scriptPath, timeoutMs: 120000 });
        assert.ok(created.ok, created.message);
    } finally { await createTask.finish({ keepArtifacts: true }); }
    const before = await snapshot(projectDir), task = manager.start('circuit-export');
    try {
        const exported = await runVivadoCircuit({ task, executable, projectPath: xpr, outputBase: path.join(root, 'tasks') });
        const raw = JSON.parse(await fs.readFile(exported.filePath, 'utf8'));
        const design = fromVivado(raw), module = design.modules[0];
        assert.equal(design.provenance.stage, 'elaborated-rtl'); assert.equal(module.attributes.view, 'flat');
        assert.ok(module.cells.some(cell => cell.kind === 'register'));
        const adder = module.cells.find(cell => cell.kind === 'arithmetic'); assert.ok(adder);
        assert.ok(module.cells.filter(cell => ['register', 'arithmetic'].includes(cell.kind)).every(cell => cell.name.startsWith('u_leaf/')));
        const ports = new Map(module.ports.map(port => [port.name, port]));
        assert.equal(ports.get('a').bits.length, 4); assert.equal(ports.get('ascending').upto, true);
        assert.equal(ports.get('ascending').offset, 2); assert.equal(ports.get('mirror').upto, true);
        // Vivado 在直通顶层端口间保留 IBUF/OBUF；验证真实路径而不假设其与 Yosys 结构相同。
        for (let i = 0; i < ports.get('ascending').bits.length; i++) {
            const input = module.cells.find(cell => cell.type === 'IBUF' && cell.ports.find(port => port.name === 'I')?.bits[0] === ports.get('ascending').bits[i]);
            const output = module.cells.find(cell => cell.type === 'OBUF' && cell.ports.find(port => port.name === 'O')?.bits[0] === ports.get('mirror').bits[i]);
            assert.ok(input); assert.ok(output);
            assert.deepEqual(input.ports.find(port => port.name === 'O').bits, output.ports.find(port => port.name === 'I').bits);
        }
        assert.deepEqual(adder.ports.find(port => port.name === 'I0').bits, ports.get('a').bits);
        assert.deepEqual(module.signals.find(signal => signal.name === 'u_leaf/a').bits, ports.get('a').bits);
        assert.deepEqual(module.signals.find(signal => signal.name === 'u_leaf/q').bits, ports.get('q').bits);
        for (const cell of module.cells.filter(cell => cell.kind === 'register')) {
            assert.deepEqual(cell.ports.find(port => port.name === 'C').bits, ports.get('clk').bits);
            assert.deepEqual(cell.ports.find(port => port.name === 'CE').bits, ports.get('en').bits);
            assert.ok(ports.get('q').bits.includes(cell.ports.find(port => port.name === 'Q').bits[0]));
            assert.ok(adder.ports.find(port => port.name === 'O').bits.includes(cell.ports.find(port => port.name === 'D').bits[0]));
        }
        assert.deepEqual(await snapshot(projectDir), before);
        await fs.writeFile(path.join(root, 'circuit.model.json'), JSON.stringify(design, null, 2));
        const selectedTops = [];
        for (const selection of [{ top: 'leaf', sourcePath: rtl, expectedPorts: ['a', 'clk', 'en', 'q'] },
            { top: 'unreferenced', sourcePath: unreferenced, expectedPorts: ['a', 'b', 'sum'] }]) {
            const selectedTask = manager.start('circuit-' + selection.top);
            try {
                const result = await runVivadoCircuit({ task: selectedTask, executable, projectPath: xpr, outputBase: path.join(root, 'tasks'),
                    top: selection.top, sourcePath: selection.sourcePath });
                const selectedRaw = JSON.parse(await fs.readFile(result.filePath, 'utf8'));
                const selected = fromVivado(selectedRaw), selectedModule = selected.modules[0];
                assert.equal(selected.top, selection.top);
                assert.deepEqual(selectedModule.ports.map(port => port.name).sort(), selection.expectedPorts);
                assert.ok(selectedModule.cells.some(cell => cell.kind === 'arithmetic'));
                assert.ok(selectedModule.cells.every(cell => !cell.name.startsWith('u_leaf/')));
                assert.deepEqual(await snapshot(projectDir), before);
                assert.deepEqual(await Promise.all([rtl, standalone, unreferenced].map(file => fs.readFile(file, 'utf8'))), sourceBefore);
                await fs.writeFile(path.join(root, selection.top + '.model.json'), JSON.stringify(selected, null, 2));
                selectedTops.push({ top: selected.top, filePath: result.filePath, sourcePath: selection.sourcePath,
                    cells: selectedModule.cells.length, ports: selectedModule.ports.length, logPaths: selectedTask.logPaths });
            } finally { await selectedTask.finish({ keepArtifacts: true }); }
        }
        const outsideTask = manager.start('circuit-outside-project');
        let rejectedSource;
        try {
            await assert.rejects(runVivadoCircuit({ task: outsideTask, executable, projectPath: xpr, outputBase: path.join(root, 'tasks'),
                top: 'standalone', sourcePath: standalone }), error => {
                assert.match(error.message, /当前文件不是工程综合源/);
                rejectedSource = { sourcePath: standalone, reason: error.message, logPaths: outsideTask.logPaths };
                return true;
            });
            assert.deepEqual(await snapshot(projectDir), before);
            assert.deepEqual(await Promise.all([rtl, standalone, unreferenced].map(file => fs.readFile(file, 'utf8'))), sourceBefore);
        } finally { await outsideTask.finish({ keepArtifacts: true }); }
        const report = { root, executable, part: values.part, engine: design.provenance, rawFile: exported.filePath, moduleCount: design.modules.length,
            top: design.top, cells: module.cells.length, ports: module.ports.length, selectedTops, rejectedSource,
            checks: ['真实只读RTL详细化', '跨层级segments真实连接', '加法/寄存器数据与时钟使能连接', 'descending/ascending总线LSB-first', '顶层直通IBUF/OBUF真实连接',
                '项目入口保持工程top', '当前工程成员文件使用leaf覆盖top', '旧top未引用且AutoDisabled的独立文件也能详细化', '工程外文件明确拒绝并提供加入工程或Yosys提示', '每次成功或失败后工程文件树SHA256及源文件内容未变'], logPaths: task.logPaths };
        await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    } finally { await task.finish({ keepArtifacts: true }); await manager.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
