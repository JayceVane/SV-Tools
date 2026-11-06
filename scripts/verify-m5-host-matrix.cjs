'use strict';
// M5 批 3 收尾：把 5 个 verify-*-host.ps1 宿主验收 × 目标 IDE 聚合成 bin/m5-host-matrix.json。
// 可重跑：node scripts/verify-m5-host-matrix.cjs --ide "<名称>=<Code可执行路径>" [--ide ...]
//         [--iverilog <bin目录|exe>] [--cygwin <bin目录>] [--out <file>]
// 行字段取自各宿主的 host-report.json；app 用调用方标签（Qoder 内核自报 appName 为 Visual Studio Code，不可信）。
// 任一宿主失败或报告缺失 → 退出码 1，矩阵仍写盘以便排查。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { findIverilogBinDir } = require('../src/toolchains/iverilog');

const tool = path.resolve(__dirname, '..');
// 宿主名 → (ps1 脚本, 报告所在 bin 子目录, 附加参数)。报告目录约定由各 ps1 固化为 bin/<name>-host/run-*。
const HOSTS = [
    ['circuit', 'verify-circuit-host.ps1', 'circuit-host'],
    ['completion', 'verify-completion-host.ps1', 'completion-host'],
    ['project', 'verify-project-host.ps1', 'project-host'],
    ['vivado', 'verify-vivado-host.ps1', 'vivado-host'],
    ['waveform', 'verify-waveform-host.ps1', 'waveform-host'],
];
const HOST_TIMEOUT_MS = 300000;

// 宿主脚本是 UTF-8 无 BOM：Windows PowerShell 5.1 按 ANSI 代码页解析会把中文串读坏成 ParserError，
// 必须用 pwsh（默认 UTF-8）；未装 pwsh 时回退 powershell.exe 并在失败时提示该已知问题。
const SHELL = process.platform === 'win32' ? 'pwsh.exe' : 'powershell.exe';

function runHost(script, args) {
    return new Promise(resolve => {
        const started = Date.now();
        const child = spawn(SHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', path.join(tool, 'scripts', script), ...args], { cwd: tool, windowsHide: true });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, HOST_TIMEOUT_MS);
        child.once('error', error => { clearTimeout(timer); resolve({ ok: false, error: error.message, stdout, stderr, durationMs: Date.now() - started }); });
        child.once('close', code => { clearTimeout(timer); resolve({ ok: code === 0, exitCode: code, stdout, stderr, durationMs: Date.now() - started }); });
    });
}

/** 各宿主报告字段不统一（circuit/waveform 有 count、completion 有 passed/failed、project 只有 checks 数组）；
 * 到达报告即 ps1 退出码为 0；结构化缺 failed 的宿主以 0 计。 */
function rowFrom(host, app, run, report, at) {
    return { host, app, vscode: report.vscode || null,
        extension: report.extensionVersion || report.version || null,
        checks: report.count ?? (Array.isArray(report.checks) ? report.checks.length : null) ?? null,
        passed: Number.isFinite(report.passed) ? report.passed : null,
        failed: Number.isFinite(report.failed) ? report.failed : 0,
        run, at };
}

async function main() {
    const { values } = parseArgs({ options: {
        ide: { type: 'string', multiple: true }, out: { type: 'string' },
        iverilog: { type: 'string' }, cygwin: { type: 'string' } },
    });
    const ides = (values.ide || []).map(entry => {
        const separator = entry.indexOf('=');
        if (separator <= 0) throw new Error('--ide 需要 "<名称>=<可执行路径>"：' + entry);
        return { app: entry.slice(0, separator), codePath: entry.slice(separator + 1) };
    });
    if (!ides.length) throw new Error('至少需要一个 --ide "<名称>=<可执行路径>"');
    for (const { codePath } of ides) {
        try { if (!fs.statSync(codePath).isFile()) throw new Error('不是普通文件'); }
        catch { throw new Error('IDE 可执行路径不可用：' + codePath); }
    }
    // Icarus 可用时透传给补全宿主（ps1 写 run 内 tools.json，启用「真实接受参数补全后 Icarus 编译通过」子项）。
    const iverilogBin = findIverilogBinDir(values.iverilog);
    if (values.iverilog && !iverilogBin) throw new Error('--iverilog 指定的路径未找到 iverilog：' + values.iverilog);
    if (!iverilogBin) console.error('提示：未找到 Icarus，补全宿主将跳过 Icarus 编译子项（nativeSkipped=true，21/22 项）');
    const iverilogExe = iverilogBin && path.join(iverilogBin, process.platform === 'win32' ? 'iverilog.exe' : 'iverilog');
    const cygwinBin = values.cygwin || null;
    const rows = [], failures = [];
    for (const { app, codePath } of ides) {
        for (const [host, script, reportDir] of HOSTS) {
            const extra = host === 'completion' && iverilogExe ? ['-IcarusPath', iverilogExe, ...(cygwinBin ? ['-CygwinPath', cygwinBin] : [])] : [];
            const before = new Set(await fsp.readdir(path.join(tool, 'bin', reportDir), { withFileTypes: true })
                .catch(() => []).then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name)));
            const run = await runHost(script, ['-CodePath', codePath, ...extra]);
            const fresh = (await fsp.readdir(path.join(tool, 'bin', reportDir), { withFileTypes: true }))
                .filter(entry => entry.isDirectory() && !before.has(entry.name)).map(entry => entry.name).sort();
            const runName = fresh.at(-1);
            const reportPath = runName && path.join(tool, 'bin', reportDir, runName, 'host-report.json');
            if (!run.ok || !reportPath || !fs.existsSync(reportPath)) {
                failures.push({ host, app, exitCode: run.exitCode ?? null, error: run.error || null,
                    stderrTail: (run.stderr || run.stdout || '').slice(-600) });
                continue;
            }
            const report = JSON.parse(await fsp.readFile(reportPath, 'utf8'));
            const at = (await fsp.stat(reportPath)).mtime.toISOString();
            const row = rowFrom(host, app, runName, report, at);
            rows.push(row);
            if (row.failed > 0) failures.push({ host, app, failed: row.failed, run: runName });
            console.error(`[${row.failed ? 'FAIL' : 'ok'}] ${app} · ${host} · checks=${row.checks} failed=${row.failed} · ${run.durationMs}ms`);
        }
    }
    const matrix = { createdUtc: new Date().toISOString(), rows };
    const out = values.out ? path.resolve(tool, values.out) : path.join(tool, 'bin', 'm5-host-matrix.json');
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, JSON.stringify(matrix, null, 2) + '\n', 'utf8');
    console.error(`矩阵 ${rows.length} 行 → ${path.relative(tool, out)}；失败 ${failures.length}`);
    if (failures.length) {
        console.error(JSON.stringify(failures, null, 2));
        process.exitCode = 1;
    }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
