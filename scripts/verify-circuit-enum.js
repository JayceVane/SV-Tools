'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const hash = data => createHash('sha256').update(data).digest('hex');

/**
 * @param {{out?:string,extensionRoot?:string}} [options] 只在新建的独立夹具目录中编译和求值。
 * @returns {Promise<object>} 真实Slang错误、枚举层级、源位置与8组输入的完整验证报告。
 */
async function verifyEnumCircuit({ out = 'bin/circuit-enum-validation', extensionRoot = path.resolve(__dirname, '..') } = {}) {
    const load = file => require(path.join(extensionRoot, 'src', file));
    const { createToolTaskManager } = load('toolchains/job');
    const { prepareSourceRequest } = load('circuit/source-request');
    const { runYosysCircuit } = load('circuit/yosys-runner');
    const { CircuitSession } = load('circuit/session');
    const { createCircuitSourceResolver } = load('circuit/source-context');
    await fs.mkdir(out, { recursive: true });
    const root = await fs.mkdtemp(path.join(path.resolve(out), 'run-'));
    const pkg = path.join(root, 'package/corelib_pkg.sv'), half = path.join(root, 'rtl/half_adder.sv');
    const full = path.join(root, 'rtl/full_adder.sv'), top = path.join(root, 'rtl/top.sv');
    await fs.mkdir(path.dirname(pkg)); await fs.mkdir(path.dirname(full));
    const fixtures = path.join(__dirname, '../test/fixtures/circuit-enum');
    for (const file of [pkg, half, full, top]) await fs.copyFile(path.join(fixtures, path.basename(file)), file);
    const original = await fs.readFile(full, 'utf8'), before = hash(original);
    const manager = createToolTaskManager(), session = new CircuitSession(), failures = {};
    const outputBase = path.join(root, 'tasks');
    async function compile(name, sources, text, module = 'full_adder') {
        const task = manager.start(name);
        try {
            const file = module === 'top' ? top : full, live = text === undefined ? await fs.readFile(file, 'utf8') : text;
            const resolver = name === 'valid-enums' ? createCircuitSourceResolver({ vscode: { workspace: {
                findFiles: async () => [pkg, half, full, top].map(fsPath => ({ fsPath }))
            } } }) : undefined;
            const request = await prepareSourceRequest({ task, root, outputBase, top: module, config: { sources: resolver ? [] : sources },
                document: { uri: { fsPath: file }, isDirty: text !== undefined, getText: () => live }, resolveSources: resolver });
            return { task, request, generated: await runYosysCircuit({ ...request, task, outputBase }) };
        } catch (error) { await task.finish({ keepArtifacts: true }); throw error; }
    }
    async function expectFailure(name, sources, text, pattern) {
        await assert.rejects(compile(name, sources, text).then(async result => {
            await result.task.finish({ keepArtifacts: true }); return result;
        }), error => {
            assert.match(error.message, pattern); assert.ok(error.message.includes(full + ':'));
            assert.doesNotMatch(error.message, /see full log for details|ExperimentalWarning/);
            failures[name] = error.message; return true;
        });
        assert.equal(hash(await fs.readFile(full)), before);
    }
    let success;
    try {
        const unqualified = original.replaceAll('corelib_pkg::impl_t', 'impl_t').replaceAll('corelib_pkg::STRUCTURAL', '"STRUCTURAL"').replaceAll('corelib_pkg::FLAT', '"FLAT"');
        await expectFailure('undeclared-type', [], unqualified, /undeclared identifier 'impl_t'/);
        const wrongEnum = original.replaceAll('corelib_pkg::STRUCTURAL', '"STRUCTURAL"').replaceAll('corelib_pkg::FLAT', '"FLAT"');
        await expectFailure('string-as-enum', [pkg, half, full], wrongEnum, /enum|enumerat/i);
        await expectFailure('missing-half-adder', [pkg, full], undefined, /half_adder/);
        success = await compile('valid-enums', [pkg, half, full, top], undefined, 'top');
        const { task, request, generated } = success;
        const raw = JSON.parse(await fs.readFile(generated.filePath, 'utf8'));
        const rootCells = Object.values(raw.modules.top.cells);
        assert.equal(rootCells.length, 2); assert.notEqual(rootCells[0].type, rootCells[1].type);
        assert.ok(Object.values(raw.modules).some(module => Object.values(module.cells || {}).filter(cell => /^half_adder(?:\$|$)/.test(cell.type)).length === 2));
        const design = await session.request('load', { ...generated, sourceMap: request.sourceMap, top: 'top', stage: 'rtl' });
        const graph = await session.request('layout', { moduleId: design.top });
        assert.equal(graph.nodes.filter(node => node.kind === 'instance').length, 2);
        const location = await session.request('source', { moduleId: design.top }); assert.equal(path.resolve(location.path), top);
        const directory = path.dirname(generated.filePath), lines = ['read_json /task/circuit.json', 'hierarchy -top top', 'flatten', 'opt'];
        for (let value = 0; value < 8; value++) lines.push(`eval -set data ${value} -show structural -show flat`);
        await fs.writeFile(path.join(directory, 'verify.ys'), lines.join('\n') + '\n');
        const config = JSON.parse(await fs.readFile(path.join(directory, 'yosys-wasi.json'), 'utf8'));
        config.args[config.args.length - 1] = '/task/verify.ys';
        const configPath = path.join(directory, 'verify-wasi.json'); await fs.writeFile(configPath, JSON.stringify(config));
        const evaluated = await task.run(process.execPath, [path.join(extensionRoot, 'src/circuit/yosys-wasi.js'), configPath], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: root, stage: 'enum-eval', timeoutMs: 20000
        });
        assert.equal(evaluated.code, 0, evaluated.output);
        const values = [...evaluated.output.matchAll(/Eval result: \\(structural|flat) = 2'([01]{2})\./g)];
        assert.equal(values.length, 16, evaluated.output);
        for (let i = 0; i < 8; i++) {
            const expected = ((i & 1) + (i >> 1 & 1) + (i >> 2 & 1)).toString(2).padStart(2, '0');
            assert.equal(values[i * 2][2], expected); assert.equal(values[i * 2 + 1][2], expected);
        }
        assert.equal(hash(await fs.readFile(full)), before);
        const report = { root, runtime: process.versions, extensionVersion: require(path.join(extensionRoot, 'package.json')).version,
            failures, autoSources: request.sources.map(file => path.basename(file)), enumVariants: rootCells.map(cell => cell.type), graphNodes: graph.nodes.length, truthTableRows: 8,
            sourceUnchanged: true, sourceLocation: location, logs: task.logPaths, netlist: generated.filePath };
        await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); return report;
    } finally {
        session.dispose(); if (success) await success.task.finish({ keepArtifacts: true }); await manager.dispose();
    }
}
if (require.main === module) {
    const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    verifyEnumCircuit({ out: option('--out'), extensionRoot: option('--extension-root') && path.resolve(option('--extension-root')) })
        .then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { verifyEnumCircuit };
