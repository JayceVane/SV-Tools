'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const { createToolTaskManager } = require('../src/toolchains/job');
const { processSucceeded } = require('../src/toolchains/result');
const { runYosysCircuit } = require('../src/circuit/yosys-runner');
const { fromYosys } = require('../src/circuit/adapters/yosys');
const { layoutModule } = require('../src/circuit/layout');

/** 使用本地工具复现 Yosys → netlistsvg → 独立模型 → ELK，全过程保留真实输入和日志。 */
async function main() {
    const { values } = parseArgs({ options: { yosys: { type: 'string', default: 'bundled' },
        frontend: { type: 'string', default: 'auto' }, out: { type: 'string', default: 'bin/circuit-validation' } } });
    const executable = /[\\/]/.test(values.yosys) ? path.resolve(values.yosys) : values.yosys;
    const parent = path.resolve(values.out);
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'run-'));
    const rtl = path.join(root, 'circuit.sv'), include = path.join(root, 'include space');
    await fs.mkdir(include);
    await fs.copyFile(path.join(__dirname, '..', 'test', 'fixtures', 'circuit-demo.sv'), rtl);
    await fs.writeFile(path.join(include, 'width.vh'), '`define CIRCUIT_WIDTH 8\n');
    const inputSha256 = createHash('sha256').update(await fs.readFile(rtl)).digest('hex');
    const manager = createToolTaskManager(), task = manager.start('circuit-verification');
    try {
        const output = await runYosysCircuit({ task, executable, frontend: values.frontend,
            sources: [rtl], top: 'circuit_demo', includeDirs: [include], defines: ['CIRCUIT_STEP=(1 + 2)'],
            sourceRoot: root, outputBase: path.join(root, 'tasks') });
        const svgPath = path.join(root, 'netlistsvg.svg');
        const rendered = await task.run(process.execPath, [require.resolve('netlistsvg/bin/netlistsvg.js'), output.filePath, '-o', svgPath],
            { cwd: root, stage: 'netlistsvg', timeoutMs: 60000 });
        assert.ok(processSucceeded(rendered), rendered.output || rendered.errorMessage);
        assert.match(await fs.readFile(svgPath, 'utf8'), /<svg\b/);
        const raw = JSON.parse(await fs.readFile(output.filePath, 'utf8'));
        const design = fromYosys(raw, { stage: 'rtl', sourceRoot: root });
        const top = design.modules.find(module => module.id === design.top);
        assert.ok(top.cells.some(cell => cell.moduleId));
        assert.ok(top.cells.some(cell => cell.kind === 'register'));
        assert.ok(top.cells.some(cell => cell.kind === 'memory'));
        const ports = new Map(top.ports.map(port => [port.name, port]));
        assert.equal(ports.get('ascending').upto, true);
        assert.equal(ports.get('ascending').offset, 2);
        assert.equal(ports.get('mirror').offset, 10);
        assert.deepEqual(ports.get('mirror').bits, ports.get('ascending').bits);
        const adders = Object.values(raw.modules).flatMap(module => Object.values(module.cells)).filter(cell => cell.type === '$add');
        assert.ok(adders.some(cell => /^0*11$/.test([...cell.connections.B].reverse().join(''))), '配置的宏表达式必须精确为3');
        const layouts = [];
        for (const module of design.modules) {
            const graph = await layoutModule(design, module.id);
            layouts.push({ id: module.id, name: module.name, width: graph.width, height: graph.height, ...graph.stats });
            await fs.writeFile(path.join(root, 'layout-' + layouts.length + '.json'), JSON.stringify(graph));
        }
        await fs.writeFile(path.join(root, 'circuit.model.json'), JSON.stringify(design, null, 2));
        const report = { root, inputSha256, engine: design.provenance, frontend: values.frontend, json: output.filePath,
            svgPath, netlistsvg: require('netlistsvg/package.json').version, elkjs: require('elkjs/package.json').version, layouts,
            checks: ['真实Yosys JSON与netlistsvg', '保留参数化层级', 'MUX/加法/异步复位寄存器/存储器',
                '升序和非零起点总线逐位连接', '空格include路径与宏表达式', '独立模型和真实ELK路由'], logPaths: task.logPaths };
        await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    } finally { await task.finish({ keepArtifacts: true }); await manager.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
