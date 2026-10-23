'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { runProcess, startProcess, terminateProcessTree } = require('../src/toolchains/process');
const { nativeArtifactName, createNativeLoader } = require('../src/native-loader');

/** 以真实 Node 子进程验证公共 runner，不依赖 FPGA 工具安装。 */
function runNode(source, args = [], options = {}) {
    return runProcess(process.execPath, ['-e', source, '--', ...args], { timeoutMs: 3000, ...options });
}

test('runner 直接传递参数并保留非零退出码、stdout 和 stderr', async () => {
    const argument = '路径 with space & (literal)';
    const result = await runNode('process.stdout.write(process.argv[1]); process.stderr.write("compile failed"); process.exitCode = 7;', [argument]);
    assert.equal(result.code, 7);
    assert.equal(result.stdout, argument);
    assert.equal(result.stderr, 'compile failed');
    assert.ok(result.output.includes(argument));
    assert.ok(result.output.includes('compile failed'));
    assert.equal(result.errorMessage, null);
    assert.equal(result.timedOut, false);
});

test('runner 流式回调不会破坏跨 chunk 的 UTF-8 字符', async () => {
    const chunks = [];
    const source = 'process.stdout.write(Buffer.from([0xe4,0xb8,0xad,0xe6])); setTimeout(() => process.stdout.write(Buffer.from([0x96,0x87])), 30);';
    const result = await runNode(source, [], { onStdout: chunk => chunks.push(chunk) });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '中文');
    assert.equal(chunks.join(''), '中文');
    assert.equal(result.stdout.includes('\uFFFD'), false);
});

test('runner 将 cwd 和环境交给子进程', async () => {
    const cwd = path.resolve(__dirname, '..');
    const result = await runNode('process.stdout.write(JSON.stringify([process.cwd(),process.env.SVTOOLS_CONTRACT_VALUE]));', [], {
        cwd,
        env: { ...process.env, SVTOOLS_CONTRACT_VALUE: 'v4 中文' }
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), [cwd, 'v4 中文']);
});

test('runner 超时会完成调用，并保留已输出日志', { timeout: 5000 }, async () => {
    let timeoutCount = 0;
    // Windows CI繁忙时，真实Node启动可能超过超时；这里显式保证日志先于超时到达。
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
    const result = await runProcess('mock-tool', [], {
        platform: 'linux',
        spawn: () => { queueMicrotask(() => child.stdout.write('ready')); return child; },
        timeoutMs: 20,
        onTimeout: () => { timeoutCount++; }
    });
    assert.equal(result.stdout, 'ready');
    assert.equal(result.timedOut, true);
    assert.equal(result.stopped, true);
    assert.equal(timeoutCount, 1);
    assert.ok(result.elapsedMs < 4000);
});

test('runner 真实子进程超时包含启动阶段，不要求超时前已输出', { timeout: 5000 }, async () => {
    const result = await runNode('setInterval(() => {}, 1000);', [], { timeoutMs: 50 });
    assert.equal(result.timedOut, true);
    assert.equal(result.stopped, true);
    assert.ok(result.elapsedMs < 4000);
});

test('runner 手动停止幂等，并与超时区分', { timeout: 5000 }, async () => {
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const job = startProcess(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);'], {
        timeoutMs: 3000,
        onStdout: () => resolveReady()
    });
    await ready;
    job.stop();
    job.stop();
    const result = await job.completion;
    assert.equal(result.stdout, 'ready');
    assert.equal(result.stopped, true);
    assert.equal(result.timedOut, false);
    job.stop();
});

test('runner 启动失败返回错误上下文，调用不会挂起', async () => {
    const result = await runProcess('svtools-contract-missing-executable', [], { timeoutMs: 1000 });
    assert.equal(result.code, -1);
    assert.match(result.errorMessage, /svtools-contract-missing-executable|ENOENT/);
    assert.equal(result.timedOut, false);
});

test('runner 同步 spawn 异常也完成 promise', async () => {
    const result = await runProcess('tool', [], { spawn: () => { throw new Error('spawn contract failure'); } });
    assert.equal(result.code, -1);
    assert.equal(result.errorMessage, 'spawn contract failure');
});

test('Windows 批处理经 cmd 启动，并对带空格路径完整引用', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'svtools batch adapter '));
    t.after(() => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('svtools batch adapter '));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const batch = path.join(directory, 'vivado tool.bat'), script = path.join(directory, 'work project', 'run.tcl');
    fs.writeFileSync(batch, '@echo off\r\n');
    const launches = [];
    const spawn = (command, args, options) => {
        launches.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
    };
    const result = await runProcess(batch, ['-source', script], { platform: 'win32', spawn });
    assert.equal(result.code, 0);
    assert.equal(launches[0].command, 'cmd.exe');
    assert.deepEqual(launches[0].args.slice(0, 4), ['/d', '/v:off', '/s', '/c']);
    const names = [...launches[0].args[4].matchAll(/%([A-Z0-9_]+)%/g)].map(match => match[1]);
    assert.equal(names.length, 3);
    assert.deepEqual(names.map(name => launches[0].options.env[name]), [batch, '-source', script]);
    assert.equal(launches[0].options.windowsHide, true);
});

test('终止非 Windows 进程使用 SIGKILL，清理失败提供上下文', () => {
    const signals = [];
    terminateProcessTree({ kill: signal => signals.push(signal) }, { platform: 'linux' });
    assert.deepEqual(signals, ['SIGKILL']);
    const failures = [];
    terminateProcessTree({ kill: () => { throw new Error('permission denied'); } }, {
        platform: 'linux', onError: error => failures.push(error.message)
    });
    assert.deepEqual(failures, ['permission denied']);
});

test('原生模块按显式平台和 libc 选择产物，未知平台明确报错', () => {
    assert.equal(nativeArtifactName('win32', 'x64'), 'svtools.win32-x64-msvc.node');
    assert.equal(nativeArtifactName('darwin', 'arm64'), 'svtools.darwin-arm64.node');
    assert.equal(nativeArtifactName('linux', 'x64', 'gnu'), 'svtools.linux-x64-gnu.node');
    assert.equal(nativeArtifactName('linux', 'arm64', 'musl'), 'svtools.linux-arm64-musl.node');
    assert.throws(() => nativeArtifactName('unknown', 'x64'), /unknown\/x64/);
});

test('原生加载器惰性加载和缓存，reset 后可重新加载', () => {
    let loadCount = 0;
    const module = { formatText: () => '' };
    const loader = createNativeLoader({ rootDir: __dirname, platform: 'win32', arch: 'x64', existsSync: () => true,
        requireModule: () => { loadCount++; return module; } });
    assert.equal(loadCount, 0);
    assert.equal(loader.load(), module);
    assert.equal(loader.load(), module);
    assert.equal(loadCount, 1);
    loader.reset();
    assert.equal(loader.load(), module);
    assert.equal(loadCount, 2);
});

test('原生加载器缺少产物时指出路径和构建操作', () => {
    const loader = createNativeLoader({ rootDir: __dirname, platform: 'win32', arch: 'x64', existsSync: () => false });
    assert.throws(() => loader.load(), error => error.message.includes(loader.modulePath) && error.message.includes('npm run build:native'));
});

test('原生加载失败保留原始异常，方便区分 ABI 错误', () => {
    const cause = new Error('ABI mismatch');
    const loader = createNativeLoader({ rootDir: __dirname, platform: 'win32', arch: 'x64', existsSync: () => true,
        requireModule: () => { throw cause; } });
    assert.throws(() => loader.load(), error => error.cause === cause && /ABI mismatch/.test(error.message));
});

const { buildFormatOptions, buildModuleOptions, buildTestbenchOptions } = require('../src/configuration');

/** 模拟 VS Code get：缺省值和显式 false/0 必须区分。 */
function configuration(overrides = {}) {
    return { get: (name, fallback) => Object.hasOwn(overrides, name) ? overrides[name] : fallback };
}

test('编辑器选项适配保留 false、零和负值，并映射 tabSize', () => {
    const options = buildFormatOptions(configuration({ tabSize: 2, useTab: true, inlineCompact: false,
        blankCompact: false, maxConsecutiveEmptyLines: -1, portNameGap: 0 }));
    assert.equal(options.nbSpace, 2);
    assert.equal(options.useTab, true);
    assert.equal(options.inlineCompact, false);
    assert.equal(options.blankCompact, false);
    assert.equal(options.maxConsecutiveEmptyLines, -1);
    assert.equal(options.portNameGap, 0);
    assert.equal(options.reindentOnly, false);
    assert.equal(Object.hasOwn(options, 'tabSize'), false);
});

test('编辑器默认值来自扩展清单，格式化与生成器适配保持一致', () => {
    const defaults = require('../package.json').contributes.configuration.properties;
    const format = buildFormatOptions(configuration());
    const module = buildModuleOptions(configuration());
    const testbench = buildTestbenchOptions(configuration());
    assert.equal(format.nbSpace, defaults['svtools.tabSize'].default);
    assert.equal(format.indentStyle, defaults['svtools.indentStyle'].default);
    assert.equal(format.portNameGap, defaults['svtools.portNameGap'].default);
    assert.equal(module.instPrefix, defaults['svtools.instPrefix'].default);
    assert.deepEqual(module.reset, testbench.reset);
    assert.equal(testbench.waveType, defaults['svtools.waveType'].default);
});

test('生成器选项映射声明开关、时钟及复位配置', () => {
    const config = configuration({ instPrefix: 'dut_', includePortDeclarations: false,
        reset: ['rst_n'], sreset: ['rst'], clock: ['clock'], taskInit: false, taskDrive: false });
    assert.deepEqual(buildModuleOptions(config), { instPrefix: 'dut_', reset: ['rst_n'], includeDeclarations: false });
    const testbench = buildTestbenchOptions(config);
    assert.deepEqual(testbench.clock, ['clock']);
    assert.deepEqual(testbench.sreset, ['rst']);
    assert.equal(testbench.taskInit, false);
    assert.equal(testbench.taskDrive, false);
});


const fs = require('node:fs');
const os = require('node:os');

test('真实 Windows BAT 的路径和参数含空格时仍能执行', { skip: process.platform !== 'win32' }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'svtools v4 contract '));
    const batchPath = path.join(directory, 'tool with spaces.bat');
    try {
        fs.writeFileSync(batchPath, '@echo off\r\necho %~1\r\nexit /b 7\r\n');
        const result = await runProcess(batchPath, ['argument with spaces'], { timeoutMs: 3000 });
        assert.equal(result.code, 7, result.output);
        assert.equal(result.stdout.trim(), 'argument with spaces');
        assert.equal(result.stderr, '');
        assert.equal(result.timedOut, false);
    } finally {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('svtools v4 contract '));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

for (const failure of ['throw', 'false']) {
    test(`runner 超时后 kill=${failure} 时完成调用并报告终止错误`, { timeout: 3000 }, async () => {
        const errors = [];
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
            if (failure === 'throw') throw new Error('permission denied');
            return false;
        };
        const result = await runProcess('mock-tool', [], { platform: 'linux', spawn: () => child,
            timeoutMs: 10, onTerminationError: error => errors.push(error) });
        assert.equal(result.code, -1);
        assert.equal(result.timedOut, true);
        assert.equal(result.stopped, true);
        assert.equal(errors.length, 1);
        assert.equal(typeof result.errorMessage, 'string');
        assert.ok(result.errorMessage.length > 0);
        assert.ok(result.elapsedMs < 2000);
    });
}

test('runner 停止后未收到 close 事件时有界完成，保留已有日志', { timeout: 4000 }, async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const spawn = () => {
        queueMicrotask(() => child.stdout.write('last log'));
        return child;
    };
    const result = await runProcess('mock-tool', [], { platform: 'linux', spawn, timeoutMs: 10 });
    assert.equal(result.code, -1);
    assert.equal(result.stdout, 'last log');
    assert.equal(result.timedOut, true);
    assert.equal(result.stopped, true);
    assert.equal(typeof result.errorMessage, 'string');
    assert.ok(result.errorMessage.length > 0);
    assert.ok(result.elapsedMs < 3500);
});


test('真实 Windows BAT 的路径和参数含百分号与元字符时逐字保留', { skip: process.platform !== 'win32' }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'svtools batch literal '));
    t.after(() => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('svtools batch literal '));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const batch = path.join(directory, 'tool %SVTOOLS_BATCH_PROBE% & (literal)!.cmd');
    fs.writeFileSync(batch, '@echo off\r\nsetlocal DisableDelayedExpansion\r\necho ARG1="%~1"\r\necho ARG2="%~2"\r\necho ARG3="%~3"\r\nexit /b 7\r\n');
    const values = ['path with space & (literal) %SVTOOLS_BATCH_PROBE% ! ^ | < >', '100% %UNKNOWN_BATCH_PROBE% !literal!', ''];
    const result = await runProcess(batch, values, { timeoutMs: 5000, env: { ...process.env, SVTOOLS_BATCH_PROBE: 'EXPANDED' } });
    assert.equal(result.code, 7, result.output + '\n' + result.errorMessage);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), values.map((value, i) => `ARG${i + 1}="${value}"`));
});

test('Windows BAT 无法安全表示的引号及控制字符在启动前明确拒绝', async () => {
    let launches = 0;
    for (const value of ['quoted"argument', 'line\nbreak', 'carriage\rreturn', 'nul\0value']) {
        const result = await runProcess('tool.bat', [value], { platform: 'win32', spawn() { launches++; throw Error('不应启动'); } });
        assert.equal(result.code, -1);
        assert.match(result.errorMessage, /批处理.*(?:引号|控制字符)/);
    }
    assert.equal(launches, 0);
});


test('真实 Windows PATH 批处理的 %~dp0 指向工具目录，命令与参数特殊字符原样保留', { skip: process.platform !== 'win32' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svtools batch path '));
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('svtools batch path '));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const tools = path.join(root, 'tool folder %SVTOOLS_PATH_PROBE% !literal!'), cwd = path.join(root, 'other cwd');
    fs.mkdirSync(tools); fs.mkdirSync(cwd);
    const batch = path.join(tools, 'sibling probe.cmd');
    fs.writeFileSync(path.join(tools, 'sibling.txt'), 'SVTOOLS_SIBLING_OK\r\n');
    fs.writeFileSync(batch, '@echo off\r\nsetlocal DisableDelayedExpansion\r\nif not exist "%~dp0sibling.txt" exit /b 37\r\ntype "%~dp0sibling.txt"\r\necho ARG1="%~1"\r\necho ARG2="%~2"\r\nexit /b 0\r\n');
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    environment.SVTOOLS_PATH_PROBE = 'EXPANDED';
    const values = ['literal %SVTOOLS_PATH_PROBE% ! & (argument)', ''];
    for (const [command, directory] of [[path.basename(batch), tools], [batch, tools], [path.relative(cwd, batch), tools], [path.basename(batch), path.relative(cwd, tools)]]) {
        const result = await runProcess(command, values, { cwd, env: { ...environment, PaTh: '"' + directory + '";' + path.dirname(process.env.ComSpec || path.join(process.env.SystemRoot, 'System32', 'cmd.exe')) }, timeoutMs: 5000 });
        assert.equal(result.code, 0, command + ': ' + result.output + '\n' + result.errorMessage);
        assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['SVTOOLS_SIBLING_OK', `ARG1="${values[0]}"`, 'ARG2=""']);
    }
});

test('真实 Windows BAT 解析优先 cwd 再按调用环境 PATH 顺序查普通文件，缺失明确失败', { skip: process.platform !== 'win32' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svtools batch search '));
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('svtools batch search '));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const cwd = path.join(root, 'cwd'), first = path.join(root, 'first'), second = path.join(root, 'second');
    for (const [directory, name] of [[cwd, 'CWD'], [first, 'FIRST'], [second, 'SECOND']]) {
        fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'sibling.txt'), name + '\r\n');
        fs.writeFileSync(path.join(directory, 'priority.cmd'), '@echo off\r\ntype "%~dp0sibling.txt"\r\nexit /b 0\r\n');
    }
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    const options = { cwd, env: { ...environment, Path: first + ';' + second + ';' + path.dirname(process.env.ComSpec || path.join(process.env.SystemRoot, 'System32', 'cmd.exe')) }, timeoutMs: 5000 };
    assert.equal((await runProcess('priority.cmd', [], options)).stdout.trim(), 'CWD');
    fs.renameSync(path.join(cwd, 'priority.cmd'), path.join(cwd, 'original.cmd')); fs.mkdirSync(path.join(cwd, 'priority.cmd'));
    assert.equal((await runProcess('priority.cmd', [], options)).stdout.trim(), 'FIRST');
    const missing = await runProcess('svtools-unique-missing-batch.cmd', [], options);
    assert.equal(missing.code, -1); assert.match(missing.errorMessage, /ENOENT.*svtools-unique-missing-batch\.cmd/);
    const directory = await runProcess(path.join(cwd, 'priority.cmd'), [], options);
    assert.equal(directory.code, -1); assert.match(directory.errorMessage, /ENOENT|普通文件/);
});
