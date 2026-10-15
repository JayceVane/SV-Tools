'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { buildYosysScript, buildSourceWrapper, runYosysCircuit } = require('../src/circuit/yosys-runner');
const { prepareSourceRequest, topCandidates } = require('../src/circuit/source-request');
const { insideRoots } = require('../src/circuit');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-circuit-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directories = new Map();
    const task = { async directory(base, kind) {
        const key = path.resolve(base) + kind;
        if (!directories.has(key)) { await fs.mkdir(base, { recursive: true }); directories.set(key, await fs.mkdtemp(path.join(base, kind + '-'))); }
        return directories.get(key);
    }, throwIfCancelled() {} };
    return { root, task };
}

test('Yosys 脚本按前端规则引用文件，顶层与目录选项不带多余引号', () => {
    const script = buildYosysScript({ sources: ['C:\\rtl space\\top.sv'], top: 'top',
        includeDirs: ['.svtools/includes/include0'], outputPath: 'C:\\out space\\top.json' });
    assert.match(script, /read_verilog -sv -I\.svtools\/includes\/include0 "C:\/rtl space\/top\.sv"/);
    assert.match(script, /\nprep -top top\n/);
    assert.match(script, /write_json "C:\/out space\/top\.json"/);
    const slang = buildYosysScript({ sources: ['tasks/input.sv'], top: 'top', outputPath: 'output.json', frontend: 'slang' });
    assert.match(slang, /read_slang --threads 1 --keep-hierarchy --top top tasks\/input\.sv/);
});

test('脚本拒绝命令注入、换行及未映射的危险目录参数', () => {
    for (const top of ['top; shell x', 'top\ncheck', 'top name']) {
        assert.throws(() => buildYosysScript({ sources: ['top.sv'], top, outputPath: 'out.json' }), /top/);
    }
    assert.throws(() => buildYosysScript({ sources: ['top.sv\ncheck'], top: 'top', outputPath: 'out.json' }), /无效字符/);
    assert.throws(() => buildYosysScript({ sources: ['top.sv'], top: 'top', includeDirs: ['x;check'], outputPath: 'out.json' }), /目录别名/);
});

test('宏正文通过 HDL wrapper 精确保留，引号和空格不当成脚本参数', () => {
    const wrapper = buildSourceWrapper({ sources: ['C:\\rtl space\\top.sv'], defines: ['WIDTH=(1 + 2)', 'MESSAGE="a b"', 'ENABLE'] });
    assert.equal(wrapper, '`define WIDTH (1 + 2)\n`define MESSAGE "a b"\n`define ENABLE\n`include "C:/rtl space/top.sv"\n');
    for (const define of ['X=1\n`include "other"', '1BAD=3', 'X=foo\\']) {
        assert.throws(() => buildSourceWrapper({ sources: ['x.sv'], defines: [define] }));
    }
});

test('Yosys 正常退出却缺少 JSON 时明确失败，不返回之前的网表', async t => {
    const { root, task } = await fixture(t);
    task.run = async () => ({ code: 0, logPath: 'tool.log' });
    await assert.rejects(runYosysCircuit({ task, executable: 'yosys', sources: ['top.sv'], top: 'top',
        outputBase: root, sourceRoot: root }), /未生成电路 JSON/);
});

test('Yosys ERROR、非零退出及日志失败不能伪装成功', async t => {
    for (const mode of ['semantic', 'exit', 'log']) {
        const { root, task } = await fixture(t);
        task.run = async (_, args, options) => {
            assert.equal(args[2], '-s');
            if (mode === 'semantic') options.onLine('ERROR: unsupported design');
            return { code: mode === 'exit' ? 1 : 0, logError: mode === 'log' ? 'disk full' : null, logPath: 'tool.log' };
        };
        await assert.rejects(runYosysCircuit({ task, executable: 'yosys', sources: ['top.sv'], top: 'top',
            outputBase: root, sourceRoot: root }), /Yosys 电路生成失败/);
    }
});

test('未保存 RTL 使用隔离快照并保留源文件与源序', async t => {
    const { root, task } = await fixture(t);
    const original = path.join(root, 'current.sv');
    await fs.writeFile(original, 'module disk; endmodule');
    const text = 'module edited; endmodule';
    const result = await prepareSourceRequest({ task, root, top: 'edited', outputBase: path.join(root, 'artifacts'),
        document: { uri: { fsPath: original }, isDirty: true, getText: () => text },
        config: { sources: ['pkg.sv', 'current.sv'], includeDirs: ['headers'], defines: ['WIDTH=8'] } });
    assert.equal(result.sources[0], path.join(root, 'pkg.sv'));
    assert.notEqual(result.sources[1], original);
    assert.equal(await fs.readFile(result.sources[1], 'utf8'), text);
    assert.equal(await fs.readFile(original, 'utf8'), 'module disk; endmodule');
    assert.equal(result.sourceMap[result.sources[1]], original);
    assert.deepEqual(result.includeDirs, [root, path.join(root, 'headers')]);
});

test('普通文件不写快照，顶层索引跳过注释、字符串、interface/package', async t => {
    const { root, task } = await fixture(t);
    const filePath = path.join(root, 'top.sv');
    const result = await prepareSourceRequest({ task, root, top: 'top', outputBase: root, config: {},
        document: { uri: { fsPath: filePath }, isDirty: false } });
    assert.deepEqual(result.sources, [filePath]);
    assert.deepEqual(result.sourceMap, {});
    const source = '// module fake;\ninterface bus; endinterface\npackage p; endpackage\nmodule top; string x="module hidden"; endmodule';
    assert.deepEqual(topCandidates(source).map(item => item.name), ['top']);
});

test('源码定位拒绝相邻前缀目录与上级路径', () => {
    const root = path.resolve('workspace');
    assert.equal(insideRoots(path.join(root, 'rtl', 'top.sv'), [root]), true);
    assert.equal(insideRoots(path.resolve(root, '..', 'workspace-other', 'top.sv'), [root]), false);
    assert.equal(insideRoots(path.resolve(root, '..', 'top.sv'), [root]), false);
});
