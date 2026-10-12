'use strict';

const childProcess = require('child_process');
const { StringDecoder } = require('string_decoder');
const TERMINATION_GRACE_MS = 2000;

/** Windows 批处理参数引用；普通可执行文件直接使用 spawn 参数数组。 */
function cmdQuote(value) {
    const text = String(value);
    return /[\s"^&|<>()%!]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
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

/**
 * 启动工具并统一管理 UTF-8 输出、超时和完成状态。读取模块不启动进程。
 * @param {string} command 工具路径（支持 Windows .bat/.cmd）
 * @param {string[]} args 各引擎自行构造的参数
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, onStdout?: (text: string) => void, onStderr?: (text: string) => void, onTimeout?: () => void, onTerminationError?: (error: Error) => void, wrappedProcessName?: string, platform?: string, spawn?: typeof childProcess.spawn}} [options]
 * @returns {{child: import('child_process').ChildProcess|null, completion: Promise<{code: number|null, stdout: string, stderr: string, output: string, errorMessage: string|null, timedOut: boolean, elapsedMs: number, signal: string|null, stopped: boolean}>, stop: () => void}}
 */
function startProcess(command, args, options = {}) {
    const spawn = options.spawn || childProcess.spawn;
    const platform = options.platform || process.platform;
    const startedAt = Date.now();
    let child = null;
    let timer = null;
    let terminationTimer = null;
    let settled = false;
    let timedOut = false;
    let stopped = false;
    let stdout = '';
    let stderr = '';
    let output = '';
    let resolveCompletion;
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const feed = (isStderr, text) => {
        if (!text) return;
        output += text;
        if (isStderr) stderr += text;
        else stdout += text;
        const callback = isStderr ? options.onStderr : options.onStdout;
        if (callback) callback(text);
    };
    const finish = (code, errorMessage = null, signal = null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (terminationTimer) clearTimeout(terminationTimer);
        feed(false, stdoutDecoder.end());
        feed(true, stderrDecoder.end());
        resolveCompletion({ code, stdout, stderr, output, errorMessage, timedOut,
            elapsedMs: Date.now() - startedAt, signal, stopped });
    };
    const stop = () => {
        if (settled || stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        terminateProcessTree(child, { platform, spawn,
            wrappedProcessName: options.wrappedProcessName,
            onError: error => {
                if (options.onTerminationError) options.onTerminationError(error);
                else console.error('终止工具进程失败：', error);
                finish(-1, '终止工具进程失败：' + error.message);
            }
        });
        if (!settled) {
            terminationTimer = setTimeout(() => {
                const error = new Error('终止工具进程后未收到退出事件：PID ' + (child && child.pid));
                if (options.onTerminationError) options.onTerminationError(error);
                finish(-1, error.message);
            }, TERMINATION_GRACE_MS);
        }
    };
    try {
        const spawnOptions = { cwd: options.cwd, env: options.env, windowsHide: true };
        if (platform === 'win32' && /\.(bat|cmd)$/i.test(command)) {
            // /s 会剥掉首尾一对引号；外层引号保护含空格的可执行路径。
            const line = '"' + [command, ...args].map(cmdQuote).join(' ') + '"';
            child = spawn('cmd.exe', ['/d', '/s', '/c', line], { ...spawnOptions, windowsVerbatimArguments: true });
        } else {
            child = spawn(command, args, spawnOptions);
        }
        if (child.stdout) {
            child.stdout.on('data', data => feed(false, stdoutDecoder.write(data)));
            child.stdout.on('error', error => { stop(); finish(-1, error.message); });
        }
        if (child.stderr) {
            child.stderr.on('data', data => feed(true, stderrDecoder.write(data)));
            child.stderr.on('error', error => { stop(); finish(-1, error.message); });
        }
        child.once('error', error => finish(-1, error.message));
        child.once('close', (code, signal) => finish(code, null, signal));
        const timeoutMs = Number(options.timeoutMs || 0);
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                if (options.onTimeout) options.onTimeout();
                stop();
            }, timeoutMs);
        }
    } catch (error) {
        finish(-1, error.message);
    }
    return { child, completion, stop };
}

/** @param {string} command @param {string[]} args @param {Parameters<typeof startProcess>[2]} [options] @returns {ReturnType<typeof startProcess>['completion']} */
function runProcess(command, args, options) {
    return startProcess(command, args, options).completion;
}

module.exports = { cmdQuote, terminateProcessTree, startProcess, runProcess };
