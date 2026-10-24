'use strict';

const childProcess = require('child_process');
const fs = require('node:fs');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { ProcessOutput } = require('./output');
const TERMINATION_GRACE_MS = 2000;

/** Windows 批处理参数引用；普通可执行文件直接使用 spawn 参数数组。 */
function cmdQuote(value) {
    const text = String(value);
    return /[\s"^&|<>()%!]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** 先固定 BAT 的绝对入口，避免 cmd 经 PATH 命中后仍按 cwd 计算脚本的 %~dp0。 */
function resolveBatchCommand(command, cwd, environment) {
    const root = path.resolve(cwd || process.cwd());
    const pathKey = Object.keys(environment).sort().find(name => name.toLowerCase() === 'path');
    const directories = /[\\/:]/.test(command) ? [root]
        : [root, ...String(pathKey ? environment[pathKey] || '' : '').split(';')];
    for (const directory of directories) {
        const unquoted = directory.startsWith('"') && directory.endsWith('"') ? directory.slice(1, -1) : directory;
        const candidate = path.resolve(root, unquoted, command);
        try { if (fs.statSync(candidate).isFile()) return candidate; }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    throw Object.assign(new Error('ENOENT: 未找到 Windows 批处理普通文件：' + command), { code: 'ENOENT' });
}

/** 启动 cmd 只解析固定变量名；第三方 BAT 内部的再次 CALL 由工具适配层处理。 */
function batchInvocation(command, args, environment, cwd) {
    const values = [command, ...args].map(String);
    if (values.some(value => /["\x00-\x1f]/.test(value))) {
        throw new TypeError('Windows 批处理路径或参数包含无法安全传递的引号或控制字符');
    }
    const env = { ...(environment || process.env) };
    values[0] = resolveBatchCommand(values[0], cwd, env);
    const prefix = 'SVTOOLS_BATCH_' + randomUUID().replace(/-/g, '').toUpperCase() + '_';
    const words = values.map((value, index) => {
        if (!value) return '""';
        const name = prefix + index;
        env[name] = value;
        return cmdQuote('%' + name + '%');
    });
    return { env, args: ['/d', '/v:off', '/s', '/c', '"' + words.join(' ') + '"'] };
}

/**
 * 终止工具进程树。Cygwin exec 更换 PID 时，可按父 PID 清理已知的包装子进程。
 * @param {import('child_process').ChildProcess} child
 * @param {{platform?: string, spawn?: typeof childProcess.spawn, wrappedProcessName?: string, onError?: (error: Error) => void}} [options]
 * @returns {void}
 */
function terminateProcessTree(child, options = {}) {
    if (!child) return;
    const platform = options.platform || process.platform;
    const spawn = options.spawn || childProcess.spawn;
    const report = error => {
        if (options.onError) options.onError(error);
        else console.error('终止工具进程失败：', error);
    };
    const killDirect = () => {
        try {
            if (child.kill('SIGKILL') === false && child.exitCode == null && child.signalCode == null) {
                report(new Error('工具进程拒绝终止：PID ' + child.pid));
            }
        } catch (error) { report(error); }
    };
    if (platform !== 'win32' || !child.pid) {
        killDirect();
        return;
    }
    const pid = Number(child.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
        report(new Error('无效的工具进程 PID：' + child.pid));
        return;
    }
    const launchCleanup = (command, args) => {
        try {
            const cleanup = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
            cleanup.once('error', error => { report(error); killDirect(); });
            cleanup.once('close', code => { if (code !== 0) killDirect(); });
        } catch (error) {
            report(error);
            killDirect();
        }
    };
    // 先提交按父 PID 的兜底，再终止父进程，避免 Cygwin 包装进程先退出失去关系。
    if (options.wrappedProcessName) {
        const name = options.wrappedProcessName;
        if (!/^[\w.-]+\.exe$/i.test(name)) {
            report(new Error('无效的包装进程名称：' + name));
        } else {
            launchCleanup('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                `Get-CimInstance Win32_Process -Filter "Name='${name}' AND ParentProcessId=${pid}" | ForEach-Object { taskkill /F /PID $_.ProcessId }`]);
        }
    }
    launchCleanup('taskkill', ['/pid', String(pid), '/T', '/F']);
}

/** 单次进程的取消、超时和完成状态；输出处理由 ProcessOutput 负责。 */
class ProcessRun {
    constructor(options) {
        this.options = options;
        this.spawn = options.spawn || childProcess.spawn;
        this.platform = options.platform || process.platform;
        this.startedAt = Date.now();
        this.child = null;
        this.output = null;
        this.timer = null;
        this.terminationTimer = null;
        this.finishing = false;
        this.settled = false;
        this.timedOut = false;
        this.stopped = false;
        this.aborted = false;
        this.errorMessage = null;
        this.abortListener = null;
        this.completion = new Promise(resolve => { this.resolveCompletion = resolve; });
    }
    async finish(code, errorMessage = null, signal = null) {
        if (this.finishing) return;
        this.finishing = true;
        if (!this.errorMessage && errorMessage) this.errorMessage = errorMessage;
        if (this.timer) clearTimeout(this.timer);
        if (this.terminationTimer) clearTimeout(this.terminationTimer);
        if (this.abortListener) this.options.signal.removeEventListener('abort', this.abortListener);
        let captured = { stdout: '', stderr: '', output: '', outputTruncated: false, lineTruncated: false, logPath: null, logError: null };
        try { if (this.output) captured = await this.output.finish(); }
        catch (error) { if (!this.errorMessage) this.errorMessage = error.message || String(error); }
        const failure = this.errorMessage || captured.errorMessage || null;
        this.settled = true;
        this.resolveCompletion({ ...captured, code: failure ? -1 : code, errorMessage: failure,
            timedOut: this.timedOut, elapsedMs: Date.now() - this.startedAt, signal, stopped: this.stopped, aborted: this.aborted });
    }
    fail(error) {
        if (this.finishing) return;
        if (!this.errorMessage) this.errorMessage = error.message || String(error);
        if (this.child) this.stop();
        else this.finish(-1);
    }
    reportTermination(error) {
        if (this.finishing) return;
        try {
            if (this.options.onTerminationError) this.options.onTerminationError(error);
            else console.error('终止工具进程失败：', error);
        } catch (callbackError) {
            if (!this.errorMessage) this.errorMessage = '终止回调失败：' + callbackError.message;
        }
        this.finish(-1, '终止工具进程失败：' + error.message);
    }
    stop() {
        if (this.finishing || this.stopped) return;
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        if (this.output) this.output.stopInput();
        if (!this.child) { this.finish(null); return; }
        terminateProcessTree(this.child, { platform: this.platform, spawn: this.spawn,
            wrappedProcessName: this.options.wrappedProcessName, onError: error => this.reportTermination(error) });
        if (!this.finishing) this.terminationTimer = setTimeout(() => {
            this.reportTermination(new Error('终止工具进程后未收到退出事件：PID ' + this.child.pid));
        }, TERMINATION_GRACE_MS);
    }
    abort() {
        if (this.finishing) return;
        if (!this.timedOut) this.aborted = true;
        this.stop();
    }
    start(command, args) {
        try {
            const signal = this.options.signal;
            if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new TypeError('signal 必须是 AbortSignal');
            if (signal && signal.aborted) { this.abort(); return; }
            const outputOptions = { ...this.options };
            if (outputOptions.logPath !== undefined && outputOptions.logPath !== null) {
                if (typeof outputOptions.logPath !== 'string' || !outputOptions.logPath.trim()) throw new TypeError('logPath 必须是非空路径');
                outputOptions.logPath = path.resolve(this.options.cwd || process.cwd(), outputOptions.logPath);
            }
            this.output = new ProcessOutput(outputOptions, { onFailure: error => queueMicrotask(() => this.fail(error)) });
            if (this.output.errorMessage) { this.finish(-1); return; }
            if (signal && signal.aborted) { this.abort(); return; }
            const spawnOptions = { cwd: this.options.cwd, env: this.options.env, windowsHide: true };
            if (this.platform === 'win32' && /\.(bat|cmd)$/i.test(command)) {
                const invocation = batchInvocation(command, args, spawnOptions.env, spawnOptions.cwd);
                this.child = this.spawn('cmd.exe', invocation.args, { ...spawnOptions, env: invocation.env, windowsVerbatimArguments: true });
            } else this.child = this.spawn(command, args, spawnOptions);
            this.output.bindStreams([this.child.stdout, this.child.stderr]);
            for (const [stream, isStderr] of [[this.child.stdout, false], [this.child.stderr, true]]) {
                if (!stream) continue;
                stream.on('data', chunk => this.output.write(isStderr, chunk));
                stream.on('error', error => this.fail(new Error((isStderr ? 'stderr' : 'stdout') + ' 读取失败：' + error.message)));
            }
            this.child.once('error', error => {
                // 启动失败没有 PID；运行中的错误需先终止进程，避免返回后工具仍存活。
                if (this.child.pid && this.child.exitCode == null && this.child.signalCode == null) this.fail(error);
                else this.finish(-1, error.message);
            });
            this.child.once('close', (code, receivedSignal) => this.finish(code, null, receivedSignal));
            if (signal) {
                this.abortListener = () => this.abort();
                signal.addEventListener('abort', this.abortListener, { once: true });
                if (signal.aborted) this.abort();
            }
            const timeoutMs = Number(this.options.timeoutMs || 0);
            if (timeoutMs > 0 && !this.stopped && !this.finishing) this.timer = setTimeout(() => {
                this.timedOut = true;
                try { if (this.options.onTimeout) this.options.onTimeout(); }
                catch (error) { this.fail(new Error('onTimeout 回调失败：' + error.message)); }
                this.stop();
            }, timeoutMs);
        } catch (error) { this.fail(error); }
    }
}

/**
 * 启动外部工具；摘要有界，完整日志以 wx 新建；取消后停止接收输出。
 * @param {string} command @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, signal?: AbortSignal, maxOutputChars?: number, maxLineChars?: number, logPath?: string, onStdout?: Function, onStderr?: Function, onLine?: (text: string, isStderr: boolean, meta: {truncated: boolean, droppedChars: number, final: boolean}) => void, onTimeout?: Function, onTerminationError?: Function, wrappedProcessName?: string, platform?: string, spawn?: typeof childProcess.spawn}} [options]
 * @returns {{child: import('child_process').ChildProcess|null, completion: Promise<object>, stop: () => void}}
 */
function startProcess(command, args, options = {}) {
    const run = new ProcessRun(options);
    run.start(command, args);
    return { child: run.child, completion: run.completion, stop: () => run.stop() };
}

/** @param {string} command @param {string[]} args @param {Parameters<typeof startProcess>[2]} [options] @returns {ReturnType<typeof startProcess>['completion']} */
function runProcess(command, args, options) { return startProcess(command, args, options).completion; }

module.exports = { cmdQuote, terminateProcessTree, startProcess, runProcess };
