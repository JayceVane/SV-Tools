'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseProjectVersion, projectVersion, vivadoVersion, same } = require('../src/vivado/version');

test('从 XPR 头部注释解析创建工具版本', () => {
    assert.equal(parseProjectVersion('<?xml version="1.0"?>\n<!-- Product Version: Vivado v2022.1.2 (64-bit) -->'), '2022.1.2');
    assert.equal(parseProjectVersion('<!-- Product Version: Vivado v2023.2 (64-bit) -->'), '2023.2');
    assert.equal(parseProjectVersion('<Project Version="7"/>'), undefined);
    assert.equal(parseProjectVersion(''), undefined);
});

test('版本比对要求完全一致', () => {
    assert.equal(same('2022.1.2', '2022.1.2'), true);
    assert.equal(same('2022.1', '2022.1.2'), false);
    assert.equal(same('2022.1.2', '2022.1'), false);
    assert.equal(same(undefined, '2022.1'), false);
    assert.equal(same('2022.1', undefined), false);
});

test('projectVersion 读取同大小、同时间戳的 XPR 更新', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-version-'));
    const file = path.join(directory, 'demo.xpr');
    const timestamp = new Date('2024-01-01T00:00:00Z');
    try {
        await fs.writeFile(file, '<!-- Product Version: Vivado v2023.2 (64-bit) -->\n<Project/>');
        await fs.utimes(file, timestamp, timestamp);
        assert.equal(await projectVersion(file), '2023.2');
        await fs.writeFile(file, '<!-- Product Version: Vivado v2024.1 (64-bit) -->\n<Project/>');
        await fs.utimes(file, timestamp, timestamp);
        assert.equal(await projectVersion(file), '2024.1');
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('版本核验失败时不启动 Vivado 会话', async () => {
    const { createVivadoSessions } = require('../src/vivado/session');
    const calls = [];
    const sessions = createVivadoSessions({ verify: async (xpr, binDir) => { calls.push([xpr, binDir]); return false; } });
    try {
        const result = await sessions.run({ binDir: 'C:/vivado/bin', xpr: 'C:/proj/demo.xpr', task: {},
            directory: os.tmpdir(), scriptPath: 'unused.tcl' });
        assert.equal(result.ok, false);
        assert.match(result.error, /版本/u);
        assert.deepEqual(calls, [['C:/proj/demo.xpr', 'C:/vivado/bin']]);
    } finally {
        await sessions.dispose();
    }
});

test('Windows 安装路径含空格时仍能探测 Vivado 版本', { skip: process.platform !== 'win32' }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools Vivado & Tools-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(path.join(directory, 'vivado.bat'), '@echo off\r\nif "%~1"=="-version" echo Vivado v2022.1.2\r\n');
    assert.equal(await vivadoVersion(directory), '2022.1.2');
});

test('外部文件变化会重开工程，失败的写入会丢弃已加载状态', async t => {
    const { createVivadoSessions, VivadoSession } = require('../src/vivado/session');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'svtools-session-'));
    const xpr = path.join(directory, 'demo.xpr'), xci = path.join(directory, 'value.xci');
    await fs.writeFile(xpr, 'project');
    await fs.writeFile(xci, 'initial');
    let starts = 0, opens = 0, closes = 0;
    t.mock.method(VivadoSession.prototype, 'start', function () { starts++; this.child = { exitCode: null }; });
    t.mock.method(VivadoSession.prototype, 'exec', async function (lines) {
        const command = lines.join('\n');
        if (command.includes('open_project')) {
            opens++;
            assert.equal(command.includes('close_project; '), this.xpr === xpr);
        }
        if (command.includes('external-during-read.tcl')) await fs.writeFile(xci, 'updated again by another process');
        return { code: command.includes('failed.tcl') ? 1 : 0, output: '', message: '' };
    });
    t.mock.method(VivadoSession.prototype, 'close', async function () { closes++; this.child = null; this.xpr = null; });
    const sessions = createVivadoSessions({ idleMs: 0 });
    t.after(async () => { await sessions.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
    const run = (scriptPath = 'read.tcl', readOnly = true) => sessions.run({
        binDir: directory, xpr, directory, scriptPath, readOnly, watch: [xci]
    });
    await run();
    await run();
    assert.equal(opens, 1);
    await fs.writeFile(xci, 'external save');
    await run();
    assert.equal(opens, 2);
    assert.equal(starts, 1, '文件变更只重载工程，复用工具进程');
    await run('external-during-read.tcl');
    await run();
    assert.equal(opens, 3, '读取期间的外部写入在下次读取时重载');
    assert.equal((await run('failed.tcl')).ok, false);
    assert.equal(closes, 0, '失败的读取保留会话');
    assert.equal((await run('failed.tcl', false)).ok, false);
    assert.equal(closes, 1);
    await run();
    assert.equal(starts, 2);
    assert.equal(opens, 4);
});
