'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createToolTaskManager } = require('../src/toolchains/job');
const { pruneTaskDirectories } = require('../src/toolchains/task-retention');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-retention-lifecycle-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('svtools-retention-lifecycle-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    return root;
}
async function exists(file) { try { await fs.stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function stamp(directory, index) { const time = new Date(Date.UTC(2026, 0, 1) + index * 10000); await fs.utimes(directory, time, time); }

test('清理扫描期间启动的新任务，不因旧保护名单缺席而失去输入', async t => {
    const root = await fixture(t), manager = createToolTaskManager({ retention: { keep: 0 } });
    const old = manager.start('old'), oldDir = await old.directory(root, 'xvlog');
    await old.finish({ keepArtifacts: true }); await stamp(oldDir, 0);
    const originalReadDir = fs.readdir; let resume, scanStarted;
    const gate = new Promise(resolve => { resume = resolve; });
    const started = new Promise(resolve => { scanStarted = resolve; });
    fs.readdir = async function (directory, ...args) {
        if (path.resolve(directory) === root) { scanStarted(); await gate; }
        return originalReadDir.call(this, directory, ...args);
    };
    const active = [];
    try {
        const pruning = pruneTaskDirectories(root, 'xvlog', 1, { protect: new Set() });
        await started;
        for (let index = 1; index <= 3; index++) {
            const task = manager.start('active-' + index), directory = await task.directory(root, 'xvlog');
            await fs.writeFile(path.join(directory, 'input.sv'), 'module active; endmodule'); await stamp(directory, index);
            active.push({ task, directory });
        }
        resume(); await pruning;
        for (const { task, directory } of active) {
            assert.equal(task.isCurrent(), true); assert.equal(await exists(path.join(directory, 'input.sv')), true);
        }
    } finally {
        fs.readdir = originalReadDir; resume();
        for (const { task } of active) await task.finish({ keepArtifacts: true });
        await manager.dispose();
    }
});

test('独立宿主进程的活动目录受保护，退出未交还的目录也不猜测为可删除', async t => {
    const root = await fixture(t), jobPath = require.resolve('../src/toolchains/job');
    const script = `const fs=require('node:fs/promises'),path=require('node:path');
const {createToolTaskManager}=require(process.argv[1]);
(async()=>{const manager=createToolTaskManager({retention:{keep:0}}),task=manager.start('active');
const directory=await task.directory(process.argv[2],'xvlog');
await fs.writeFile(path.join(directory,'input.sv'),'module active; endmodule');
process.send({directory}); process.on('message',async message=>{if(message==='exit')process.exit(0);});})().catch(error=>{console.error(error);process.exit(1)});`;
    const child = spawn(process.execPath, ['-e', script, jobPath, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', resolve));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
    const { directory } = await Promise.race([
        new Promise(resolve => child.once('message', resolve)),
        exited.then(code => { throw new Error('子宿主提前退出：' + code + '; ' + stderr); })
    ]);
    await stamp(directory, 0);
    const manager = createToolTaskManager({ retention: { keep: 1 } });
    try {
        for (let index = 1; index <= 3; index++) {
            const task = manager.start('finished-' + index), dir = await task.directory(root, 'xvlog');
            await task.finish({ keepArtifacts: true }); await stamp(dir, index);
        }
        await delay(60); await pruneTaskDirectories(root, 'xvlog', 1);
        assert.equal(await exists(path.join(directory, 'input.sv')), true, '另一进程仍拥有该目录');
        child.send('exit'); await exited;
        await pruneTaskDirectories(root, 'xvlog', 1);
        assert.equal(await exists(path.join(directory, 'input.sv')), true, '异常退出没有完成标记，保守跳过');
    } finally { await manager.dispose(); }
});

test('目录占用延续到使用者释放，AbortSignal和重复释放不会提前交还', async t => {
    const root = await fixture(t), manager = createToolTaskManager({ retention: { keep: 0 } });
    const first = manager.start('first'), firstDir = await first.directory(root, 'source');
    await fs.writeFile(path.join(firstDir, 'snapshot.sv'), 'module snapshot; endmodule');
    const controller = new AbortController(), hold = first.retainDirectories(controller.signal), secondHold = first.retainDirectories();
    await first.finish({ keepArtifacts: true }); await stamp(firstDir, 0);
    const newer = manager.start('newer'), newerDir = await newer.directory(root, 'source');
    await newer.finish({ keepArtifacts: true }); await stamp(newerDir, 1);
    await pruneTaskDirectories(root, 'source', 1);
    assert.equal(await exists(path.join(firstDir, 'snapshot.sv')), true);
    controller.abort(); await hold.dispose(); await hold.dispose();
    await pruneTaskDirectories(root, 'source', 1);
    assert.equal(await exists(path.join(firstDir, 'snapshot.sv')), true, '另一使用者未释放，重复释放不能减去它的占用');
    await secondHold.dispose(); await stamp(firstDir, 0);
    await pruneTaskDirectories(root, 'source', 1);
    assert.equal(await exists(firstDir), false);
    assert.throws(() => first.retainDirectories(), /取消|已结束/); await manager.dispose();
});

test('无归属标记、损坏标记及目录链接不参与递归清理', async t => {
    const root = await fixture(t), unknown = path.join(root, 'xvlog-legacy');
    await fs.mkdir(unknown); await fs.writeFile(path.join(unknown, 'important.sv'), 'legacy');
    const foreign = path.join(root, 'outside'); await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, 'keep.sv'), 'keep');
    try { await fs.symlink(foreign, path.join(root, 'xvlog-linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code !== 'EPERM') throw error; t.diagnostic('当前宿主没有目录链接权限，其余归属检查继续执行'); }
    const manager = createToolTaskManager({ retention: { keep: 0 } });
    const task = manager.start('finished'), dir = await task.directory(root, 'xvlog');
    await task.finish({ keepArtifacts: true });
    await fs.mkdir(path.join(root, 'xvlog-incomplete'));
    await fs.writeFile(path.join(root, 'xvlog-incomplete', '.svtools-task-complete.json'), '{');
    await stamp(unknown, 0); await stamp(dir, 1);
    await pruneTaskDirectories(root, 'xvlog', 1);
    assert.equal(await exists(path.join(unknown, 'important.sv')), true);
    assert.equal(await exists(path.join(foreign, 'keep.sv')), true);
    assert.equal(await exists(path.join(root, 'xvlog-incomplete')), true);
    await manager.dispose();
});

test('同一目录的并发淘汰串行完成，返回的实际删除路径不重复', async t => {
    const root = await fixture(t), manager = createToolTaskManager({ retention: { keep: 0 } });
    for (let index = 0; index < 6; index++) {
        const task = manager.start('finished-' + index), directory = await task.directory(root, 'xvlog');
        await task.finish({ keepArtifacts: true }); await stamp(directory, index);
    }
    const removed = (await Promise.all(Array.from({ length: 4 }, () => pruneTaskDirectories(root, 'xvlog', 2)))).flat();
    assert.equal(removed.length, 4); assert.equal(new Set(removed).size, 4);
    assert.equal((await fs.readdir(root)).length, 2); await manager.dispose();
});
