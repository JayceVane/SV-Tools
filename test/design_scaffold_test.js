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

test('design scaffold 违反主/从命名约定返回 NAMING_VIOLATION 且不落盘', async t => {
    const directory = await workspace(t);
    const response = await run(['design', 'scaffold', '--workspace', directory, '--spec', NAMING, '--out', 'rtl']);
    assert.equal(response.exitCode, 2);
    assert.equal(response.output.status, 'failed');
    assert.equal(response.output.diagnostics[0].code, 'NAMING_VIOLATION');
    assert.equal(fs.existsSync(path.join(directory, 'rtl', 'bad_top.sv')), false);
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
