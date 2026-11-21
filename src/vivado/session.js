'use strict';

/**
 * Copyright (c) 2025 JayceVane (JayceVane@163.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// 常驻 Vivado Tcl 会话：启动一次、打开工程一次，后续动作只 source 脚本。
// 批处理每次动作都要重新启动 Vivado 并打开工程（约 10-20 秒），面板里每次点击都付这笔开销。

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { batchInvocation, terminateProcessTree } = require('../toolchains/process');
const { extractVivadoIssues } = require('./tclgen');

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;
const CLOSE_GRACE_MS = 5000;
const DONE = 'SVTOOLS_SESSION_DONE';
const MESSAGE = 'SVTOOLS_SESSION_MSG';

/** Tcl 花括号字面量；路径只作为取值传递，不参与 Tcl 解析。 */
function brace(value) {
    const text = String(value);
    if (/[{}]/.test(text)) throw new Error('Tcl 路径包含无法安全传递的花括号：' + text);
    return '{' + text + '}';
}

/** 把脚本返回值压成一行，避免与哨兵行的解析相互干扰。 */
const flatten = variable => 'string map [list \\n " " \\r " "] $' + variable;

class VivadoSession {
    constructor({ binDir, executable, cwd, idleMs, log }) {
        this.binDir = binDir;
        this.executable = executable;
        this.cwd = cwd;
        this.idleMs = idleMs;
        this.log = log || (() => {});
        this.child = null;
        this.buffer = '';
        this.seq = 0;
        this.xpr = null;
        this.stamps = new Map();
        this.doomed = false;
        this.idleTimer = null;
    }

    get alive() { return Boolean(this.child && this.child.exitCode == null && !this.doomed); }

    start() {
        if (this.alive) return;
        if (this.child) this.kill();
        const args = ['-mode', 'tcl', '-nolog', '-nojournal', '-notrace'];
        const options = { cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
        if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(this.executable)) {
            const invocation = batchInvocation(this.executable, args, { ...process.env }, this.cwd);
            this.child = spawn('cmd.exe', invocation.args, { ...options, env: invocation.env, windowsVerbatimArguments: true });
        } else {
            this.child = spawn(this.executable, args, options);
        }
        this.child.stdout.setEncoding('utf8');
        this.child.stderr.setEncoding('utf8');
        this.child.stdin.on('error', () => { this.doomed = true; });
        this.child.stdout.on('data', text => { this.buffer = (this.buffer + text).slice(-MAX_CAPTURE_CHARS); });
        this.child.stderr.on('data', text => { this.buffer = (this.buffer + text).slice(-MAX_CAPTURE_CHARS); });
        this.child.once('error', () => { this.doomed = true; });
        this.child.once('close', () => { this.doomed = true; });
        this.log('[vivado] 会话启动：' + this.executable);
    }

    /**
     * 发送一组 Tcl 语句；调用方必须自行设置 ::svtools_rc 与 ::svtools_msg。
     * @param {string[]} lines @param {{timeoutMs?:number,signal?:AbortSignal}} [options]
     */
    async exec(lines, { timeoutMs = 0, signal } = {}) {
        if (signal?.aborted) throw Object.assign(new Error('Vivado 操作已取消'), { code: 'TOOL_CANCELLED' });
        if (!this.alive) this.start();
        const id = ++this.seq, marker = DONE + '_' + id, messageMarker = MESSAGE + '_' + id;
        const body = [
            ...lines,
            'set ::svtools_flat [' + flatten('::svtools_msg') + ']',
            'puts [format "%s %s" ' + messageMarker + ' $::svtools_flat]',
            'puts "' + marker + ' $::svtools_rc"'
        ].join('\n') + '\n';
        this.buffer = '';
        const started = Date.now();
        this.log('[vivado] 会话命令 #' + id);
        try { this.child.stdin.write(body); }
        catch (error) { this.doomed = true; throw new Error('Vivado 会话无法接收命令：' + error.message); }
        const captured = await this.wait(marker, { timeoutMs, signal });
        const elapsed = Date.now() - started;
        const at = captured.indexOf(marker);
        const text = captured.slice(0, at), rest = captured.slice(at);
        const code = Number((new RegExp('^' + marker + '\\s+(\\d+)').exec(rest) || [])[1]);
        const messageLine = new RegExp('^' + messageMarker + ' ?(.*)$', 'm').exec(text);
        return {
            output: text.split(/\r?\n/).filter(line => !line.startsWith(messageMarker)).join('\n'),
            code: Number.isInteger(code) ? code : 1,
            message: messageLine ? messageLine[1].trim().replace(/\\n/g, '\n').replace(/\\r/g, '') : '',
            ms: elapsed
        };
    }

    wait(marker, { timeoutMs, signal }) {
        return new Promise((resolve, reject) => {
            const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
            let settled = false;
            const stop = () => { clearInterval(poll); if (signal) signal.removeEventListener('abort', onAbort); };
            const finish = (error, value) => {
                if (settled) return;
                settled = true; stop();
                if (error) { this.doomed = true; this.kill(); reject(error); } else resolve(value);
            };
            const check = () => {
                if (this.buffer.includes(marker)) finish(null, this.buffer);
                else if (!this.alive) finish(new Error('Vivado 会话意外退出'));
                else if (deadline && Date.now() > deadline) finish(Object.assign(new Error('Vivado 会话执行超时'), { code: 'TOOL_TIMEOUT' }));
            };
            const onAbort = () => finish(Object.assign(new Error('Vivado 操作已取消'), { code: 'TOOL_CANCELLED' }));
            const poll = setInterval(check, 25);
            if (signal) {
                if (signal.aborted) return onAbort();
                signal.addEventListener('abort', onAbort, { once: true });
            }
            check();
        });
    }

    /** 打开工程；重复调用同一工程直接复用已加载状态。 */
    async openProject(xpr, stamp) {
        if (this.xpr === xpr && this.alive) return;
        if (this.xpr && this.xpr !== xpr) {
            await this.exec(['catch {close_project -quiet}', 'set ::svtools_rc 0', 'set ::svtools_msg ""']).catch(() => {});
            this.xpr = null;
        }
        const result = await this.exec([
            'set ::svtools_rc [catch {open_project ' + brace(xpr) + '} ::svtools_msg]'
        ]);
        if (result.code !== 0) throw new Error('无法打开 Vivado 工程：' + (result.message || '未知错误'));
        this.xpr = xpr;
        this.stamps = new Map(stamp ? [[xpr, stamp]] : []);
    }

    touch() {
        clearTimeout(this.idleTimer);
        if (!this.idleMs) return;
        this.idleTimer = setTimeout(() => { void this.close('空闲退出'); }, this.idleMs);
        this.idleTimer.unref?.();
    }

    async close(reason) {
        clearTimeout(this.idleTimer);
        if (!this.alive) return;
        this.doomed = true;
        const child = this.child;
        try { child.stdin.write('catch {close_project -quiet}\nexit\n'); } catch (error) { /* 已退出 */ }
        await new Promise(resolve => {
            const timer = setTimeout(() => { this.kill(); resolve(); }, CLOSE_GRACE_MS);
            child.once('close', () => { clearTimeout(timer); resolve(); });
        });
        this.child = null; this.xpr = null;
        this.log('[vivado] 会话关闭：' + reason);
    }

    kill() {
        if (this.child) {
            try { terminateProcessTree(this.child); } catch (error) { /* 已退出 */ }
        }
        this.child = null; this.xpr = null;
    }
}

async function stampOf(file) {
    try { const stat = await fs.stat(file); return stat.size + ':' + stat.mtimeMs; }
    catch (error) { return 'missing'; }
}

/**
 * 单实例会话：同一时间只服务一个工程，动作串行执行。
 * @param {{log?:Function, idleMs?:number, platform?:string}} [options]
 */
function createVivadoSessions({ log = () => {}, idleMs = DEFAULT_IDLE_MS, platform = process.platform } = {}) {
    let session = null, queue = Promise.resolve();
    const executable = binDir => path.join(binDir, platform === 'win32' ? 'vivado.bat' : 'vivado');

    async function ensure(binDir, xpr) {
        if (session && session.binDir !== binDir) { await session.close('切换 Vivado 安装'); session = null; }
        if (!session || !session.alive) {
            session = new VivadoSession({ binDir, executable: executable(binDir), cwd: path.dirname(xpr), idleMs, log });
            session.start();
        }
        session.touch();
        return session;
    }

    /** 外部改动会使命存工程状态过期；比对上次动作后的文件戳。 */
    async function stale(current, files) {
        for (const file of files || []) {
            const saved = current.stamps.get(file);
            if (saved !== undefined && saved !== await stampOf(file)) return true;
        }
        return false;
    }

    async function run({ binDir, xpr, task, directory, scriptPath, name, timeoutMs = 0, watch = [], onOutput }) {
        const signal = task?.signal;
        const work = async () => {
            if (signal?.aborted) throw Object.assign(new Error('Vivado 操作已取消'), { code: 'TOOL_CANCELLED' });
            const current = await ensure(binDir, xpr);
            const xprStamp = await stampOf(xpr);
            if (current.xpr !== xpr || await stale(current, [xpr, ...watch])) {
                await current.openProject(xpr, xprStamp);
            }
            const started = Date.now();
            let result;
            try {
                result = await current.exec([
                    'cd ' + brace(directory),
                    'set ::svtools_rc [catch {source -notrace -encoding utf-8 ' + brace(scriptPath) + '} ::svtools_msg]'
                ], { timeoutMs, signal });
            } catch (error) {
                current.kill();
                if (error.code === 'TOOL_CANCELLED') return { ok: false, status: 'cancelled', code: null, exitCode: null,
                    ms: Date.now() - started, error: error.message, issues: [], stdout: '', logPath: null };
                throw error;
            } finally {
                current.touch();
            }
            const logPath = path.join(directory, String(name || 'action').replace(/[^a-z0-9_.-]/gi, '_') + '.session.log');
            await fs.writeFile(logPath, result.output, 'utf8').catch(() => {});
            onOutput?.(result.output);
            for (const file of [xpr, ...watch]) current.stamps.set(file, await stampOf(file));
            current.stamps.set(xpr, await stampOf(xpr));
            const issues = result.output.split(/\r?\n/).flatMap(line => extractVivadoIssues(line))
                .map(issue => ({ level: issue.level, text: issue.text }));
            const ok = result.code === 0;
            return {
                ok, status: ok ? 'success' : 'failed', code: ok ? 0 : -1, exitCode: result.code,
                ms: Date.now() - started, error: ok ? null : (result.message || issues.filter(i => i.level === 'ERROR').map(i => i.text).join('\n') || 'Vivado 执行失败'),
                message: ok ? 'Vivado 已完成' : result.message || 'Vivado 执行失败',
                issues, stdout: result.output, logPath
            };
        };
        const pending = queue.then(work);
        queue = pending.catch(() => {});
        return pending;
    }

    async function closeAll(reason = '切换到批处理任务') {
        // 与 run() 共用队列：已排队的读取先完成，避免关闭中的会话读到半截输出。
        const work = async () => {
            if (!session) return;
            const current = session; session = null;
            const closing = current.close(reason).catch(error => log('[vivado] 关闭会话失败：' + error.message));
            // 扩展停用不等优雅退出，超时直接结束进程树，避免残留 Vivado 进程占用工程。
            await Promise.race([closing, new Promise(resolve => setTimeout(resolve, 3000))]);
            if (current.alive) current.kill();
        };
        const pending = queue.then(work);
        queue = pending.catch(() => {});
        return pending;
    }

    async function dispose() {
        await closeAll('扩展停用');
    }

    return { run, closeAll, dispose, get active() { return Boolean(session && session.alive); } };
}

module.exports = { createVivadoSessions, VivadoSession, DEFAULT_IDLE_MS };
