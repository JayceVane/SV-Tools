'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { createToolTaskManager } = require('../src/toolchains/job');
const { prepareVivadoScript } = require('../src/vivado/script-task');
async function fixture(t, keep = 2) {
    const root = await fs.mkdtemp(path.resolve('bin/vivado-layout-'));
    const manager = createToolTaskManager({ retention: { keep } });
    const workspace = { getWorkspaceFolder: () => ({ uri: { fsPath: root } }) };
    t.after(async () => {
        manager.cancelAll();
        for (const job of [...manager.tasks])
            await job.finish({ keepArtifacts: true });
        await manager.dispose();
        assert.equal(path.dirname(root), path.resolve('bin'));
        assert.ok(path.basename(root).startsWith('vivado-layout-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    return { root, manager, workspace, uri: file => ({ fsPath: file }) };
}
const input = (root, name = 'simulate.tcl') => ({ anchor: path.join(root, 'project', 'design.xpr'), name, body: 'puts simulation\n' });
test('生成Tcl与完整日志位于同一受控目录，完成后保留可复查输入', async (t) => {
    const f = await fixture(t), job = f.manager.start('vivado');
    try {
        const prepared = await prepareVivadoScript(job, input(f.root), { workspace: f.workspace, uri: f.uri });
        assert.equal(path.dirname(prepared.directory), path.join(f.root, '.svtools', 'vivado', 'tasks'));
        assert.match(path.basename(prepared.directory), /^vivado-/);
        assert.equal(path.dirname(prepared.scriptPath), prepared.directory);
        const result = await job.run(process.execPath, ['-e', 'console.log("task log")'], { stage: 'vivado', cwd: prepared.cwd });
        assert.equal(result.code, 0);
        assert.equal(path.dirname(result.logPath), prepared.directory);
        await job.finish({ keepArtifacts: true });
        assert.equal(await fs.readFile(prepared.scriptPath, 'utf8'), 'puts simulation\n');
        assert.match(await fs.readFile(result.logPath, 'utf8'), /task log/);
        await fs.stat(path.join(prepared.directory, '.svtools-task-complete.json'));
    }
    finally {
        await job.finish({ keepArtifacts: true });
    }
});
test('不同仿真/工程操作共用保留预算，结束后仅保留最近两份任务', async (t) => {
    const f = await fixture(t), runs = [];
    for (let index = 0; index < 7; index++) {
        const job = f.manager.start('vivado');
        try {
            const prepared = await prepareVivadoScript(job, input(f.root, index % 2 ? 'add_file.tcl' : 'simulate.tcl'), { workspace: f.workspace, uri: f.uri });
            runs.push(prepared.directory);
        }
        finally {
            await job.finish({ keepArtifacts: true });
        }
    }
    const directories = await fs.readdir(path.join(f.root, '.svtools', 'vivado', 'tasks'));
    assert.equal(directories.length, 2);
    assert.deepEqual(new Set(directories), new Set(runs.slice(-2).map(file => path.basename(file))));
    await assert.rejects(fs.stat(path.join(f.root, '.svtools', 'vivado', 'actions')), { code: 'ENOENT' });
});
test('原有Tcl不移动或改写，cwd仍为脚本目录，任务日志归属工作区', async (t) => {
    const f = await fixture(t), file = path.join(f.root, 'scripts', 'user.tcl');
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, 'puts user\n');
    const job = f.manager.start('vivado');
    try {
        const prepared = await prepareVivadoScript(job, file, { workspace: f.workspace, uri: f.uri });
        assert.equal(prepared.scriptPath, file);
        assert.equal(prepared.cwd, path.dirname(file));
        assert.equal(path.dirname(prepared.directory), path.join(f.root, '.svtools', 'vivado', 'tasks'));
    }
    finally {
        await job.finish({ keepArtifacts: true });
    }
    assert.equal(await fs.readFile(file, 'utf8'), 'puts user\n');
});
test('生成前校验/取消拒绝创建目录，生成后再次校验上下文且不允许路径越界', async (t) => {
    const f = await fixture(t), job = f.manager.start('vivado');
    await assert.rejects(prepareVivadoScript(job, { ...input(f.root), name: '../outside.tcl' }, { workspace: f.workspace, uri: f.uri }), /脚本名/);
    await assert.rejects(prepareVivadoScript(job, { ...input(f.root), validate: async () => {
            throw new Error('工程切换');
        } }, { workspace: f.workspace, uri: f.uri }), /工程切换/);
    await assert.rejects(fs.stat(path.join(f.root, '.svtools')), { code: 'ENOENT' });
    let validations = 0;
    await assert.rejects(prepareVivadoScript(job, { ...input(f.root), validate: async () => {
            if (++validations === 2) {
                throw new Error('成员变化');
            }
        } }, { workspace: f.workspace, uri: f.uri }), /成员变化/);
    assert.equal(validations, 2);
    await job.finish({ keepArtifacts: true });
});
test('关闭自动淘汰时仍发布完成标记，工作区外脚本采用所在目录', async (t) => {
    const f = await fixture(t, 0);
    for (let index = 0; index < 4; index++) {
        const job = f.manager.start('vivado');
        try {
            const prepared = await prepareVivadoScript(job, input(f.root), { workspace: { getWorkspaceFolder: () => undefined }, uri: f.uri });
            assert.equal(path.dirname(prepared.directory), path.join(f.root, 'project', '.svtools', 'vivado', 'tasks'));
        }
        finally {
            await job.finish({ keepArtifacts: true });
        }
    }
    assert.equal((await fs.readdir(path.join(f.root, 'project', '.svtools', 'vivado', 'tasks'))).length, 4);
});
