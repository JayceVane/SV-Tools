'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { runProcess, startProcess } = require('../src/toolchains/process');
const { ProcessOutput, DEFAULT_OUTPUT_CHARS, MAX_CAPTURE_CHARS } = require('../src/toolchains/output');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const runNode = (source, options = {}) => runProcess(process.execPath, ['-e', source], { timeoutMs: 5000, ...options });
async function directory(t) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'svtools-process-output-'));
    t.after(async () => {
        for (const entry of await fs.promises.readdir(dir)) await fs.promises.unlink(path.join(dir, entry));
        await fs.promises.rmdir(dir);
    });
    return dir;
}
function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
    return child;
}

test('默认 stdout/stderr/交错 output 分别有界，流式回调仍收到全文', async () => {
    let stdoutChars = 0;
    let stderrChars = 0;
    const result = await runNode('process.stdout.write("a".repeat(300000)+"stdout-tail\\n"); process.stderr.write("b".repeat(300000)+"stderr-tail\\n");', {
        onStdout: text => { stdoutChars += text.length; }, onStderr: text => { stderrChars += text.length; }
    });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.length <= DEFAULT_OUTPUT_CHARS);
    assert.ok(result.stderr.length <= DEFAULT_OUTPUT_CHARS);
    assert.ok(result.output.length <= DEFAULT_OUTPUT_CHARS);
    assert.ok(result.stdout.endsWith('stdout-tail\n'));
    assert.ok(result.stderr.endsWith('stderr-tail\n'));
    assert.equal(stdoutChars, 300012);
    assert.equal(stderrChars, 300012);
    assert.equal(result.outputTruncated, true);
    assert.equal(result.logPath, null);
    assert.equal(result.logError, null);
});

test('真实 UTF-8 verbose 超摘要预算时完整交错日志仍逐字相同，并在 completion 前关闭', async t => {
    const dir = await directory(t);
    const logPath = path.join(dir, 'full.log');
    const received = [];
    const source = 'process.stdout.write("中文🚀\\n".repeat(10000)); setTimeout(() => process.stderr.write("ERROR:中文尾部\\n"), 25);';
    const result = await runNode(source, { logPath, maxOutputChars: 64,
        onStdout: text => received.push(text), onStderr: text => received.push(text) });
    assert.equal(result.code, 0, result.errorMessage);
    assert.equal(result.logPath, logPath);
    assert.equal(result.logError, null);
    assert.equal(result.outputTruncated, true);
    const log = await fs.promises.readFile(logPath, 'utf8');
    assert.equal(log, received.join(''));
    assert.equal(log.split('中文🚀\n').length - 1, 10000);
    assert.ok(log.includes('ERROR:中文尾部\n'));
    assert.equal(log.includes('\uFFFD'), false);
    assert.equal(result.stdout.includes('\uFFFD'), false);
    assert.ok(result.stdout.length <= 64);
});

test('极小摘要不截开 UTF-16 surrogate pair，完整日志保留 UTF-8 字符', async t => {
    const dir = await directory(t);
    const result = await runNode('process.stdout.write("🚀🚀");', { maxOutputChars: 3, logPath: path.join(dir, 'emoji.log') });
    assert.equal(result.stdout, '🚀');
    assert.equal(result.output, '🚀');
    assert.equal(await fs.promises.readFile(result.logPath, 'utf8'), '🚀🚀');
    assert.equal(result.outputTruncated, true);
});

test('逐行解析跨 UTF-8 chunk、CRLF 与独立 CR，EOF 没有换行也交付 final 行', async () => {
    const lines = [];
    const source = 'process.stdout.write(Buffer.from([0xe4,0xb8])); setTimeout(()=>{process.stdout.write(Buffer.from([0xad]));process.stdout.write("first\\r");},10); setTimeout(()=>{process.stdout.write("\\nsecond\\nprogress\\r");process.stderr.write("ERROR:no-newline");},30);';
    const result = await runNode(source, { onLine: (text, isStderr, meta) => lines.push({ text, isStderr, meta }) });
    assert.equal(result.code, 0);
    assert.deepEqual(lines.filter(line => !line.isStderr).map(line => line.text), ['中first', 'second', 'progress']);
    assert.deepEqual(lines.filter(line => line.isStderr).map(line => [line.text, line.meta.final]), [['ERROR:no-newline', true]]);
    assert.ok(lines.every(line => !line.meta.truncated && line.meta.droppedChars === 0));
    assert.equal(result.lineTruncated, false);
});

test('超长 ERROR 行保留头尾和显式截断，诊断不得声称完整', async () => {
    const lines = [];
    const result = await runNode('process.stderr.write("ERROR:starting-"+"x".repeat(200000)+"-ERROR:tail\\n");', {
        maxLineChars: 64, maxOutputChars: 4096, onLine: (text, isStderr, meta) => lines.push({ text, isStderr, meta })
    });
    assert.equal(result.code, 0);
    assert.equal(result.errorMessage, null);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].text.length <= 64);
    assert.ok(lines[0].text.startsWith('ERROR:starting-'));
    assert.ok(lines[0].text.endsWith('-ERROR:tail'));
    assert.match(lines[0].text, /输出行截断/);
    assert.equal(lines[0].isStderr, true);
    assert.equal(lines[0].meta.truncated, true);
    assert.ok(lines[0].meta.droppedChars > 199000);
    assert.equal(result.lineTruncated, true);
    assert.equal(result.outputTruncated, true);
});

for (const [name, value] of [['maxOutputChars', 0], ['maxOutputChars', Infinity], ['maxOutputChars', 1.5], ['maxOutputChars', MAX_CAPTURE_CHARS + 1], ['maxLineChars', -1], ['maxLineChars', MAX_CAPTURE_CHARS + 1]]) {
    test('非法收集预算不启动进程：' + name + '=' + value, async () => {
        let spawned = false;
        const result = await runProcess('unused', [], { [name]: value, spawn: () => { spawned = true; return fakeChild(); } });
        assert.equal(spawned, false);
        assert.equal(result.code, -1);
        assert.match(result.errorMessage, new RegExp(name));
    });
}

test('pre-aborted 不 spawn，也不创建日志', async t => {
    const dir = await directory(t);
    const logPath = path.join(dir, 'never-created.log');
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const run = startProcess('unused', [], { signal: controller.signal, logPath, spawn: () => { calls++; return fakeChild(); } });
    const result = await run.completion;
    assert.equal(calls, 0);
    assert.equal(run.child, null);
    assert.equal(result.aborted, true);
    assert.equal(result.stopped, true);
    assert.equal(result.timedOut, false);
    assert.equal(fs.existsSync(logPath), false);
});

test('真实挂起进程中途 abort 终止进程并等待已接收日志 flush', { timeout: 6000 }, async t => {
    const dir = await directory(t);
    const controller = new AbortController();
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const run = startProcess(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000);'], {
        signal: controller.signal, logPath: path.join(dir, 'cancel.log'), onStdout: () => ready()
    });
    await started;
    controller.abort();
    run.stop();
    const result = await run.completion;
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.stopped, true);
    assert.equal(result.logError, null);
    assert.equal(await fs.promises.readFile(result.logPath, 'utf8'), 'ready\n');
    assert.ok(result.elapsedMs < 4000);
});

test('取消后 late data 不再进入摘要、日志或调用方回调', async t => {
    const dir = await directory(t);
    const child = fakeChild();
    const controller = new AbortController();
    const calls = [];
    const lines = [];
    const run = startProcess('mock', [], { platform: 'linux', signal: controller.signal,
        logPath: path.join(dir, 'late.log'), spawn: () => child,
        onStdout: text => calls.push(text), onLine: text => lines.push(text) });
    child.stdout.emit('data', Buffer.from('accepted\n'));
    controller.abort();
    for (let index = 0; index < 50; index++) child.stdout.emit('data', Buffer.from('late-data\n'));
    const result = await run.completion;
    assert.equal(result.stdout, 'accepted\n');
    assert.deepEqual(calls, ['accepted\n']);
    assert.deepEqual(lines, ['accepted']);
    assert.equal(await fs.promises.readFile(result.logPath, 'utf8'), 'accepted\n');
    assert.equal(result.aborted, true);
});

test('spawn 回调内部发生 abort 的竞态不会留下返回的 child', async () => {
    const controller = new AbortController();
    const child = fakeChild();
    let kills = 0;
    child.kill = () => { kills++; queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
    const run = startProcess('mock', [], { platform: 'linux', signal: controller.signal, spawn: () => { controller.abort(); return child; } });
    const result = await run.completion;
    assert.equal(result.aborted, true);
    assert.equal(kills, 1);
});

test('正常完成移除 abort 订阅，后续 abort 不再触发终止', async () => {
    const controller = new AbortController();
    let additions = 0;
    let removals = 0;
    const signal = { get aborted() { return controller.signal.aborted; },
        addEventListener(...args) { additions++; controller.signal.addEventListener(...args); },
        removeEventListener(...args) { removals++; controller.signal.removeEventListener(...args); } };
    const result = await runNode('process.stdout.write("done");', { signal });
    assert.equal(result.code, 0);
    assert.equal(additions, 1);
    assert.equal(removals, 1);
    controller.abort();
    assert.equal(result.aborted, false);
});

test('timeout 与用户 abort 区分，即使 timeout 回调 abort controller', { timeout: 6000 }, async () => {
    const controller = new AbortController();
    const result = await runNode('process.stdout.write("waiting");setInterval(()=>{},1000);', {
        timeoutMs: 300, signal: controller.signal, onTimeout: () => controller.abort()
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, false);
    assert.equal(result.stopped, true);
});

test('wx 日志不覆盖已有文件，失败停止进程并报告 logError/errorMessage', { timeout: 6000 }, async t => {
    const dir = await directory(t);
    const logPath = path.join(dir, 'existing.log');
    await fs.promises.writeFile(logPath, 'original');
    const run = startProcess(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { logPath });
    const result = await run.completion;
    assert.equal(result.code, -1);
    assert.equal(result.stopped, true);
    assert.match(result.logError, /EEXIST/);
    assert.match(result.errorMessage, /日志写入失败/);
    assert.equal(await fs.promises.readFile(logPath, 'utf8'), 'original');
    assert.ok(run.child.exitCode !== null || run.child.signalCode !== null);
});

test('不能创建日志时报告路径错误并停止 child，不悄悄丢日志', { timeout: 6000 }, async t => {
    const dir = await directory(t);
    const logPath = path.join(dir, 'missing-directory', 'tool.log');
    const result = await runNode('setInterval(()=>{},1000);', { logPath });
    assert.equal(result.code, -1);
    assert.match(result.logError, /ENOENT/);
    assert.ok(result.errorMessage.includes(logPath));
    assert.equal(result.stopped, true);
    assert.equal(result.timedOut, false);
});

test('启动失败仍完成日志收尾，返回的 logPath 可立即读取', async t => {
    const dir = await directory(t);
    const logPath = path.join(dir, 'spawn-fail.log');
    const result = await runProcess('svtools-never-existing-command', [], { logPath });
    assert.equal(result.code, -1);
    assert.match(result.errorMessage, /ENOENT/);
    assert.equal(result.logError, null);
    assert.equal(await fs.promises.readFile(logPath, 'utf8'), '');
});

test('慢 writer 背压暂停两个 pipe，drain 后恢复并 flush 全部交错输出', async () => {
    const chunks = [];
    const writer = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); setTimeout(callback, 25); } });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const collector = new ProcessOutput({ logPath: 'virtual.log' }, { createLogStream: () => writer, onFailure: error => { throw error; } });
    collector.bindStreams([stdout, stderr]);
    stdout.on('data', chunk => collector.write(false, chunk));
    stderr.on('data', chunk => collector.write(true, chunk));
    stdout.write('out-中文\n');
    stderr.write('err-🚀\n');
    assert.equal(stdout.isPaused(), true);
    assert.equal(stderr.isPaused(), true);
    await delay(100);
    assert.equal(stdout.isPaused(), false);
    assert.equal(stderr.isPaused(), false);
    const result = await collector.finish();
    assert.equal(result.logError, null);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'out-中文\nerr-🚀\n');
    assert.equal(writer.closed, true);
});

test('writer 中途失败保留已收到摘要，日志不完整明确失败', async () => {
    const failures = [];
    const writer = new Writable({ write(chunk, encoding, callback) { setTimeout(() => callback(new Error('disk full')), 5); } });
    const collector = new ProcessOutput({ logPath: 'virtual.log' }, { createLogStream: () => writer, onFailure: error => failures.push(error.message) });
    collector.write(false, Buffer.from('accepted before disk failure\n'));
    const result = await collector.finish();
    assert.equal(result.stdout, 'accepted before disk failure\n');
    assert.equal(result.logError, 'disk full');
    assert.match(result.errorMessage, /日志写入失败/);
    assert.equal(failures.length, 1);
});

test('writer 提前 close 不被当成完整日志', async () => {
    const writer = new Writable({ write(chunk, encoding, callback) { this.destroy(); callback(); } });
    const collector = new ProcessOutput({ logPath: 'virtual.log' }, { createLogStream: () => writer, onFailure: () => {} });
    collector.write(false, Buffer.from('hello'));
    const result = await collector.finish();
    assert.match(result.logError, /flush 前关闭/);
});

test('onLine 抛错被转成进程失败，不能崩溃宿主或虚报解析成功', { timeout: 6000 }, async () => {
    const result = await runNode('process.stdout.write("line\\n");setInterval(()=>{},1000);', { onLine: () => { throw new Error('broken parser'); } });
    assert.equal(result.code, -1);
    assert.match(result.errorMessage, /onLine.*broken parser/);
    assert.equal(result.stopped, true);
});

test('日志 flush 挂起时有界失败，不返回虚假的日志成功', { timeout: 7500 }, async () => {
    const writer = new Writable({ write() {} });
    const collector = new ProcessOutput({ logPath: 'virtual.log' }, { createLogStream: () => writer, onFailure: () => {} });
    collector.write(false, Buffer.from('queued'));
    const startedAt = Date.now();
    const result = await collector.finish();
    assert.match(result.logError, /flush 超过 5000ms/);
    assert.ok(Date.now() - startedAt >= 4900);
    assert.ok(Date.now() - startedAt < 7000);
});

for (const source of ['child', 'stdout']) {
    test('运行中的 ' + source + ' error 终止 child 并保留故障结果', async () => {
        const child = fakeChild();
        child.pid = 123;
        let kills = 0;
        child.kill = () => { kills++; queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
        const run = startProcess('mock', [], { platform: 'linux', spawn: () => child });
        (source === 'child' ? child : child.stdout).emit('error', new Error('runtime read failure'));
        const result = await run.completion;
        assert.equal(result.code, -1);
        assert.equal(result.stopped, true);
        assert.equal(kills, 1);
        assert.match(result.errorMessage, /runtime read failure/);
    });
}