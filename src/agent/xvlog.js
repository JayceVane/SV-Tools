'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, result } = require('./protocol');
const { resolveContext } = require('./context');
const { directory } = require('./storage');
const { runProcess } = require('../toolchains/process');
const { processSucceeded } = require('../toolchains/result');
const { findVivadoBinDir, normalizeVivadoDir } = require('../vivado/toolchain');
const { firstModuleName } = require('../vivado/tclgen');

const exe = (dir, name) => path.join(dir, process.platform === 'win32' ? name + '.bat' : name);
const exists = file => fs.stat(file).then(stat => stat.isFile()).catch(() => false);
const tail = (text, limit = 6000) => { const value = String(text || ''); return value.length > limit ? value.slice(-limit) : value; };

function binDir(options) {
    const configured = options.vivado ? normalizeVivadoDir(path.resolve(options.workspace, options.vivado)) : '';
    const bin = findVivadoBinDir(configured);
    if (!bin) fail('VIVADO_NOT_FOUND', '未找到 Vivado（xvlog/xelab），请设置 --vivado 或配置中的 vivado');
    return bin;
}

function target(input, context, workspace) {
    const entry = input.file ? path.resolve(workspace, input.file) : context.files[0]?.path;
    if (!entry) fail('FILE_REQUIRED', '需要 --file 指定 HDL 入口文件');
    return entry;
}

function diagnosticsOf(output) {
    const items = [];
    const message = /^(ERROR|CRITICAL WARNING|WARNING):\s*(?:\[[^\]]*\]\s*)?(.*)$/u;
    for (const line of String(output || '').split(/\r?\n/)) {
        const parsed = message.exec(line.trim());
        if (!parsed) continue;
        const severity = parsed[1] === 'ERROR' ? 'error' : 'warning';
        const text = parsed[2].trim();
        const location = /(?:^|\s)([^\s:]+):(\d+)(?::(\d+))?\s*$/u.exec(text);
        items.push({ severity, message: text, file: location ? location[1] : null,
            line: location ? Number(location[2]) : null, column: location?.[3] ? Number(location[3]) : null });
        if (items.length >= 512) break;
    }
    return items;
}

async function prepare(input) {
    const resolved = await resolveContext(input), { options, context } = resolved;
    const entry = target(input, context, options.workspace);
    if (!(await exists(entry))) fail('SOURCE_NOT_FOUND', 'HDL 入口文件不存在：' + entry, { file: entry });
    const top = input.top || context.top || firstModuleName(await fs.readFile(entry, 'utf8'));
    if (!top) fail('INVALID_ARGUMENT', '无法推断顶层模块，请用 --top 指定');
    const files = [...new Set([entry, ...context.files.map(file => file.path)])];
    const includeDirs = [...new Set([path.dirname(entry), ...(context.includeDirs || []),
        ...(options.includeDirs || []).map(dir => path.resolve(options.workspace, dir))])];
    const defines = [...new Set([...(context.defines || []), ...(options.defines || [])])];
    return { options, context, entry, top, files, includeDirs, defines };
}

function compileArgs(prep, extra = []) {
    const sv = prep.files.some(file => /\.(?:sv|svh)$/iu.test(file)) ? ['-sv'] : [];
    return ['--nolog', ...sv, ...extra, ...prep.includeDirs.flatMap(dir => ['-i', dir]),
        ...prep.defines.flatMap(value => ['-d', value]), ...prep.files];
}

async function runFolder(options, label) {
    const base = await directory(options.workspace, 'runs');
    const name = label + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const dir = path.join(base, name);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

/** xvlog 语法/编译检查：返回诊断；有错误时状态为 failed。 */
async function lint(input, { signal } = {}) {
    const prep = await prepare(input), { options, context } = prep;
    const workDir = await runFolder(options, 'xvlog-lint');
    const run = await runProcess(exe(binDir(options), 'xvlog'), compileArgs(prep),
        { cwd: workDir, timeoutMs: options.timeoutMs, signal, logPath: path.join(workDir, 'xvlog.log') });
    const diagnostics = diagnosticsOf(run.stdout + '\n' + run.stderr);
    const failed = !processSucceeded(run) || diagnostics.some(item => item.severity === 'error');
    const response = result('lint', { engine: 'xvlog', top: prep.top, entry: prep.entry, files: prep.files,
        diagnostics, stdout: tail(run.stdout), exitCode: run.code ?? null }, context, diagnostics,
        [{ kind: 'log', path: path.join(workDir, 'xvlog.log') }]);
    response.status = failed ? 'failed' : 'success';
    return response;
}

/** xvlog 编译 + xelab 详细化；用于不跑仿真的设计检查。 */
async function elaborate(input, { signal } = {}) {
    const prep = await prepare(input), { options, context } = prep;
    const workDir = await runFolder(options, 'elaborate');
    const bin = binDir(options);
    const compile = await runProcess(exe(bin, 'xvlog'), compileArgs(prep),
        { cwd: workDir, timeoutMs: options.timeoutMs, signal, logPath: path.join(workDir, 'xvlog.log') });
    const diagnostics = diagnosticsOf(compile.stdout + '\n' + compile.stderr);
    if (!processSucceeded(compile) || diagnostics.some(item => item.severity === 'error')) {
        const response = result('elaborate', { top: prep.top, elaborated: false, stage: 'compile', diagnostics }, context, diagnostics,
            [{ kind: 'log', path: path.join(workDir, 'xvlog.log') }]);
        response.status = 'failed';
        return response;
    }
    const run = await runProcess(exe(bin, 'xelab'), ['--nolog', '-debug', 'typical', '-s', 'svtools_elab', prep.top],
        { cwd: workDir, timeoutMs: options.timeoutMs, signal, logPath: path.join(workDir, 'xelab.log') });
    const elaborated = processSucceeded(run);
    const response = result('elaborate', { top: prep.top, elaborated, snapshot: 'svtools_elab',
        diagnostics, stdout: tail(run.stdout), exitCode: run.code ?? null }, context, diagnostics,
        [{ kind: 'log', path: path.join(workDir, 'xvlog.log') }, { kind: 'log', path: path.join(workDir, 'xelab.log') }]);
    response.status = elaborated ? 'success' : 'failed';
    return response;
}

module.exports = { lint, elaborate };
