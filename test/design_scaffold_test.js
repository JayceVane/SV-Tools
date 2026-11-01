'use strict';
// 设计骨架：schemaVersion=1 规格 → packed struct 接口 + 空模块 + 顶层连线；scaffold→arch 端到端。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli/main');

const FIXTURES = path.join(__dirname, 'fixtures', 'design', 'scaffold');
const VALID = path.join(FIXTURES, 'valid.json');
const NAMING = path.join(FIXTURES, 'naming.json');

/** @param {object} t 测试上下文。 @returns {Promise<string>} 临时工作区。 */
async function workspace(t) {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-scaffold-'));
    t.after(() => fsp.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('design scaffold 生成 packed struct 接口、空模块与顶层，并可被 design arch 读取', async t => {
    const directory = await workspace(t);
    const response = await run(['design', 'scaffold', '--workspace', directory, '--spec', VALID, '--out', 'rtl']);
    assert.equal(response.exitCode, 0);
    assert.equal(response.output.status, 'success');
    assert.equal(response.output.data.file, 'rtl/scaffold_top.sv');
    assert.equal(response.output.data.top, 'scaffold_top');
    assert.equal(response.output.data.instances, 2);
    const file = path.join(directory, 'rtl', 'scaffold_top.sv');
    assert.equal(fs.existsSync(file), true);
    const text = await fsp.readFile(file, 'utf8');
    assert.equal(text.includes('typedef struct packed'), true);
    assert.equal(text.includes('} axi4_lite_t;'), true);
    assert.equal(text.includes('module cpu ('), true);
    assert.equal(text.includes('output axi4_lite_t m_axi'), true);
    assert.equal(text.includes('module scaffold_top ();'), true);
    assert.equal(text.includes('axi4_lite_t m0;'), true);
    assert.equal(text.includes('.m_axi(m0)'), true);
    assert.equal(text.includes('always'), false);
    const arch = await run(['design', 'arch', '--workspace', directory, '--top', 'scaffold_top']);
    assert.equal(arch.exitCode, 0, JSON.stringify(arch.output.diagnostics));
    assert.deepEqual(arch.output.data.instances.map(item => item.name).sort(), ['u_cpu', 'u_mem']);
    assert.equal(arch.output.data.graph.edges.length > 0, true);
    assert.equal(arch.output.data.interfaces.length > 0, true);
    const doctor = await run(['doctor', '--workspace', directory]);
    assert.equal(doctor.exitCode, 0);
    assert.equal(doctor.output.data.capabilities.includes('design.scaffold'), true);
});

test('design scaffold 非 m_/s_ 命名仍成功，只返回 PORT_NAMING 建议', async t => {
    const directory = await workspace(t);
    const response = await run(['design', 'scaffold', '--workspace', directory, '--spec', NAMING, '--out', 'rtl']);
    assert.equal(response.exitCode, 0, JSON.stringify(response.output));
    assert.equal(response.output.status, 'success');
    assert.equal(response.output.diagnostics.length, 0);
    assert.equal(fs.existsSync(path.join(directory, 'rtl', 'bad_top.sv')), true);
    assert.equal(response.output.data.suggestions.length, 1);
    assert.equal(response.output.data.suggestions[0].code, 'PORT_NAMING');
    assert.equal(response.output.data.suggestions[0].port, 'axi');
    assert.match(response.output.data.suggestions[0].message, /建议主设备端口以 m_ 开头/);
});

test('design scaffold 已存在文件需 --force 覆盖', async t => {
    const directory = await workspace(t);
    const first = await run(['design', 'scaffold', '--workspace', directory, '--spec', VALID, '--out', 'rtl']);
    assert.equal(first.exitCode, 0);
    const file = path.join(directory, 'rtl', 'scaffold_top.sv');
    const before = await fsp.readFile(file, 'utf8');
    const exists = await run(['design', 'scaffold', '--workspace', directory, '--spec', VALID, '--out', 'rtl']);
    assert.equal(exists.exitCode, 2);
    assert.equal(exists.output.diagnostics[0].code, 'FILE_EXISTS');
    const forced = await run(['design', 'scaffold', '--workspace', directory, '--spec', VALID, '--out', 'rtl', '--force']);
    assert.equal(forced.exitCode, 0);
    assert.equal(await fsp.readFile(file, 'utf8'), before);
});

const BASE_SPEC = {
    schemaVersion: 1,
    interfaces: [{ type: 'axi4_lite', members: [{ name: 'awaddr', width: 32 }] }],
    buses: [{ name: 'm0', type: 'axi4_lite' }],
    modules: [{ name: 'cpu', ports: [{ name: 'm_axi', type: 'axi4_lite', role: 'master', direction: 'output' }] }],
    top: { name: 'soc_top', instances: [{ name: 'u_cpu', module: 'cpu', connections: { m_axi: 'm0' } }] }
};

/** @param {object} value @returns {object} 深拷贝。 */
function copy(value) {
    return JSON.parse(JSON.stringify(value));
}

/** @param {string} directory 工作区。 @param {object} spec 规格。 @param {string} [out] 输出目录。 @param {boolean} [force] 覆盖。 @returns {Promise<object>} CLI 结果。 */
function inlineScaffold(directory, spec, out = 'rtl', force = false) {
    const args = ['design', 'scaffold', '--workspace', directory, '--spec', JSON.stringify(spec), '--out', out];
    if (force) {
        args.push('--force');
    }
    return run(args);
}

test('design scaffold 支持以 { 开头的内联 JSON 规格', async t => {
    const directory = await workspace(t);
    const response = await inlineScaffold(directory, BASE_SPEC, 'rtl-inline');
    assert.equal(response.exitCode, 0, JSON.stringify(response.output.diagnostics));
    assert.equal(fs.existsSync(path.join(directory, 'rtl-inline', 'soc_top.sv')), true);
});

test('design scaffold 规格错误返回 INVALID_ARGUMENT 且不落盘', async t => {
    const directory = await workspace(t);
    const cases = [
        ['schemaVersion', { ...copy(BASE_SPEC), schemaVersion: 2 }],
        ['type', Object.assign(copy(BASE_SPEC), { interfaces: [{ type: 'bad-type', members: [{ name: 'awaddr', width: 32 }] }] })],
        ['width', Object.assign(copy(BASE_SPEC), { interfaces: [{ type: 'axi4_lite', members: [{ name: 'awaddr', width: 0 }] }] })],
        ['bus', Object.assign(copy(BASE_SPEC), { top: { name: 'soc_top', instances: [{ name: 'u_cpu', module: 'cpu', connections: { m_axi: 'missing' } }] } })],
        ['mismatch', (() => {
            const spec = copy(BASE_SPEC);
            spec.interfaces.push({ type: 'other_bus', members: [{ name: 'data', width: 8 }] });
            spec.buses.push({ name: 'other', type: 'other_bus' });
            spec.top.instances[0].connections = { m_axi: 'other' };
            return spec;
        })()]
    ];
    for (const [name, spec] of cases) {
        const response = await inlineScaffold(directory, spec, 'bad-' + name);
        assert.equal(response.exitCode, 2, name);
        assert.equal(response.output.status, 'failed', name);
        assert.equal(response.output.diagnostics[0].code, 'INVALID_ARGUMENT', name + ': ' + response.output.diagnostics[0].message);
        assert.equal(fs.existsSync(path.join(directory, 'bad-' + name, 'soc_top.sv')), false, name);
    }
});

test('design scaffold --out 越界、普通文件目标与目标目录返回稳定错误码', async t => {
    const directory = await workspace(t);
    const outside = await inlineScaffold(directory, BASE_SPEC, path.join(os.tmpdir(), 'svtools-scaffold-outside-' + process.pid));
    assert.equal(outside.exitCode, 2);
    assert.equal(outside.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    const parentEscape = await inlineScaffold(directory, BASE_SPEC, '../outside-' + process.pid);
    assert.equal(parentEscape.exitCode, 2);
    assert.equal(parentEscape.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    await fsp.writeFile(path.join(directory, 'blocked'), 'x');
    const blocked = await inlineScaffold(directory, BASE_SPEC, 'blocked');
    assert.equal(blocked.exitCode, 2);
    assert.equal(blocked.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    await fsp.mkdir(path.join(directory, 'rtl', 'soc_top.sv'), { recursive: true });
    const directoryTarget = await inlineScaffold(directory, BASE_SPEC, 'rtl');
    assert.equal(directoryTarget.exitCode, 2);
    assert.equal(directoryTarget.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    const unrepresentable = await inlineScaffold(directory, BASE_SPEC, 'x'.repeat(300));
    assert.equal(unrepresentable.exitCode, 2);
    assert.equal(unrepresentable.output.diagnostics[0].code, 'DESIGN_FAILED');
});

test('design scaffold 拒绝 junction 目录逃逸', async t => {
    const directory = await workspace(t);
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-scaffold-link-'));
    t.after(() => fsp.rm(outside, { recursive: true, force: true }));
    try {
        await fsp.symlink(outside, path.join(directory, 'escape'), 'junction');
    } catch (error) {
        t.skip('当前环境不支持创建 junction：' + error.code);
        return;
    }
    const escaped = await inlineScaffold(directory, BASE_SPEC, path.join('escape', 'rtl'));
    assert.equal(escaped.exitCode, 2);
    assert.equal(escaped.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    assert.equal(fs.existsSync(path.join(outside, 'rtl', 'soc_top.sv')), false);
    assert.equal(fs.existsSync(path.join(outside, 'rtl')), false);
    const nested = await inlineScaffold(directory, BASE_SPEC, path.join('escape', 'nested', 'rtl'));
    assert.equal(nested.exitCode, 2);
    assert.equal(nested.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    assert.equal(fs.existsSync(path.join(outside, 'nested')), false);
});

test('design scaffold 拒绝覆盖符号链接目标', async t => {
    const directory = await workspace(t);
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'svtools-scaffold-file-link-'));
    t.after(() => fsp.rm(outside, { recursive: true, force: true }));
    const target = path.join(outside, 'target.sv');
    await fsp.writeFile(target, 'original');
    await fsp.mkdir(path.join(directory, 'rtl'), { recursive: true });
    try {
        await fsp.symlink(target, path.join(directory, 'rtl', 'soc_top.sv'), 'file');
    } catch (error) {
        t.skip('当前环境不支持文件 symlink：' + error.code);
        return;
    }
    const linked = await inlineScaffold(directory, BASE_SPEC, 'rtl', true);
    assert.equal(linked.exitCode, 2);
    assert.equal(linked.output.diagnostics[0].code, 'INVALID_ARGUMENT');
    assert.equal(await fsp.readFile(target, 'utf8'), 'original');
});
