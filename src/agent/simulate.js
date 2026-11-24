'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, result } = require('./protocol');
const { resolveContext } = require('./context');
const { directory } = require('./storage');
const { runProcess } = require('../toolchains/process');
const { processSucceeded } = require('../toolchains/result');
const iverilog = require('../toolchains/iverilog');
const { findVivadoBinDir, normalizeVivadoDir } = require('../vivado/toolchain');
const { firstModuleName } = require('../vivado/tclgen');

const exe = (dir, name) => path.join(dir, process.platform === 'win32' ? name + '.bat' : name);
const exeExact = (dir, name) => path.join(dir, process.platform === 'win32' ? name + '.exe' : name);
const exists = file => fs.stat(file).then(stat => stat.isFile()).catch(() => false);
const tail = (text, limit = 6000) => { const value = String(text || ''); return value.length > limit ? value.slice(-limit) : value; };
const optionDirs = (options, field) => (Array.isArray(options[field]) ? options[field] : []).map(dir => path.resolve(options.workspace, dir));

async function locateIcarus(options) {
    const configured = options.iverilog ? path.resolve(options.workspace, options.iverilog) : '';
    const bin = iverilog.findIverilogBinDir(configured);
    const compiler = bin && exeExact(bin, 'iverilog');
    const runner = bin && exeExact(bin, 'vvp');
    if (!compiler || !(await exists(compiler)) || !runner || !(await exists(runner))) {
        fail('TOOL_NOT_FOUND', '未找到 Icarus Verilog（iverilog/vvp），请设置 --iverilog 或配置中的 iverilog');
    }
    return { compiler, runner, env: iverilog.buildChildEnv(iverilog.findCygwinBinDir(options.cygwin, bin)) };
}

function inputFiles(options, context, entry) {
    const sources = (options.sources || []).map(file => path.resolve(options.workspace, file));
    return [...new Set([entry, ...sources, ...context.files.map(file => file.path)])];
}

function includeDirs(options, context, entry) {
    return [...new Set([path.dirname(entry), ...(context.includeDirs || []),
        ...optionDirs(options, 'includeDirs')])];
}

function defines(options, context) {
    return [...new Set([...(context.defines || []), ...(options.defines || [])])];
}

async function waveforms(directory) {
    const entries = await fs.readdir(directory).catch(() => []);
    return entries.filter(name => /\.(?:vcd|fst)$/iu.test(name)).sort().map(name => path.join(directory, name));
}

async function icarusSimulate({ options, context, entry, top, workDir, signal }) {
    const tool = await locateIcarus(options);
    const files = inputFiles(options, context, entry);
    for (const file of files) if (!(await exists(file))) fail('SOURCE_NOT_FOUND', '源文件不存在：' + file, { file });
    const vvp = path.join(workDir, 'sim.vvp');
    const args = iverilog.buildCommonArgs({
        fileName: entry, standard: options.standard || context.standard,
        includePaths: includeDirs(options, context, entry), libraryPaths: [],
        extraArgs: ['-o', vvp, '-s', top, ...defines(options, context).flatMap(value => ['-D', value])]
    });
    const compile = await runProcess(tool.compiler, [...args, ...files], {
        cwd: workDir, env: tool.env, timeoutMs: options.timeoutMs, signal, logPath: path.join(workDir, 'compile.log')
    });
    if (!processSucceeded(compile)) {
        fail('SIM_COMPILE_FAILED', 'Icarus 编译失败', { exitCode: compile.code ?? null, stdout: tail(compile.stdout), stderr: tail(compile.stderr) }, 1);
    }
    const simulation = await runProcess(tool.runner, [vvp], {
        cwd: workDir, env: tool.env, timeoutMs: options.timeoutMs, signal, logPath: path.join(workDir, 'simulation.log')
    });
    const filesOut = await waveforms(workDir);
    if (!processSucceeded(simulation)) {
        fail('SIM_FAILED', simulation.timedOut ? '仿真超时' : '仿真失败', { exitCode: simulation.code ?? null, stdout: tail(simulation.stdout), stderr: tail(simulation.stderr), waveforms: filesOut }, 1);
    }
    return { engine: 'iverilog', top, entry, vvp, waveforms: filesOut,
        compile: { exitCode: compile.code ?? 0, log: path.join(workDir, 'compile.log') },
        simulation: { exitCode: simulation.code ?? 0, log: path.join(workDir, 'simulation.log'), stdout: tail(simulation.stdout) } };
}

async function xsimSimulate({ options, context, entry, top, workDir, signal }) {
    const configured = options.vivado ? normalizeVivadoDir(path.resolve(options.workspace, options.vivado)) : '';
    const bin = findVivadoBinDir(configured);
    if (!bin) fail('VIVADO_NOT_FOUND', '未找到 Vivado（xvlog/xelab/xsim），请设置 --vivado 或配置中的 vivado');
    const xvlog = exe(bin, 'xvlog'), xelab = exe(bin, 'xelab'), xsim = exe(bin, 'xsim');
    for (const file of [xvlog, xelab, xsim]) if (!(await exists(file))) fail('TOOL_NOT_FOUND', 'Vivado XSim 工具不完整：' + file);
    const files = inputFiles(options, context, entry);
    for (const file of files) if (!(await exists(file))) fail('SOURCE_NOT_FOUND', '源文件不存在：' + file, { file });
    const sv = files.some(file => /\.(?:sv|svh)$/iu.test(file)) ? ['-sv'] : [];
    const compileArgs = ['--nolog', ...sv, ...includeDirs(options, context, entry).flatMap(dir => ['-i', dir]),
        ...defines(options, context).flatMap(value => ['-d', value]), ...files];
    const compile = await runProcess(xvlog, compileArgs, { cwd: workDir, timeoutMs: options.timeoutMs, signal, logPath: path.join(workDir, 'xvlog.log') });
    if (!processSucceeded(compile)) fail('SIM_COMPILE_FAILED', 'xvlog 编译失败', { exitCode: compile.code ?? null, stdout: tail(compile.stdout), stderr: tail(compile.stderr) }, 1);
    const snapshot = 'svtools_sim';
    const elaborate = await runProcess(xelab, ['--nolog', '-debug', 'typical', '-s', snapshot, top],
        { cwd: workDir, timeoutMs: options.timeoutMs, signal, logPath: path.join(workDir, 'xelab.log') });
    if (!processSucceeded(elaborate)) fail('SIM_ELABORATE_FAILED', 'xelab 详细化失败', { exitCode: elaborate.code ?? null, stdout: tail(elaborate.stdout), stderr: tail(elaborate.stderr) }, 1);
    const simulation = await runProcess(xsim, [snapshot, '-R', '--nolog'],
        { cwd: workDir, timeoutMs: options.timeoutMs, signal, logPath: path.join(workDir, 'xsim.log') });
    const filesOut = await waveforms(workDir);
    if (!processSucceeded(simulation)) {
        fail('SIM_FAILED', simulation.timedOut ? '仿真超时' : 'XSim 仿真失败', { exitCode: simulation.code ?? null, stdout: tail(simulation.stdout), stderr: tail(simulation.stderr), waveforms: filesOut }, 1);
    }
    return { engine: 'xsim', top, entry, snapshot, waveforms: filesOut,
        compile: { exitCode: compile.code ?? 0, log: path.join(workDir, 'xvlog.log') },
        elaborate: { exitCode: elaborate.code ?? 0, log: path.join(workDir, 'xelab.log') },
        simulation: { exitCode: simulation.code ?? 0, log: path.join(workDir, 'xsim.log'), stdout: tail(simulation.stdout) } };
}

/** 编译并运行 testbench；iverilog 产出 VCD/FST，xsim 产出 WLF/WDB，二者都返回日志与波形路径。 */
async function simulate(input, { signal } = {}) {
    const resolved = await resolveContext(input), { options, context } = resolved;
    const engine = input.engine || 'iverilog';
    if (!['iverilog', 'xsim'].includes(engine)) fail('INVALID_ARGUMENT', '--engine 必须为 iverilog 或 xsim');
    const entry = input.file ? path.resolve(options.workspace, input.file) : context.files[0]?.path;
    if (!entry) fail('FILE_REQUIRED', 'simulate 需要 --file <testbench>');
    if (!(await exists(entry))) fail('SOURCE_NOT_FOUND', '入口文件不存在：' + entry, { file: entry });
    const top = input.top || firstModuleName(await fs.readFile(entry, 'utf8'));
    if (!top) fail('INVALID_ARGUMENT', '无法从入口文件推断顶层模块，请用 --top 指定');
    const base = input.out ? path.resolve(options.workspace, input.out) : await directory(options.workspace, 'runs');
    const workDir = await mkdtemp(base);
    const runner = engine === 'xsim' ? xsimSimulate : icarusSimulate;
    const data = await runner({ options, context, entry, top, workDir, signal });
    const artifacts = [
        { kind: 'log', path: data.compile.log },
        ...(data.elaborate ? [{ kind: 'log', path: data.elaborate.log }] : []),
        { kind: 'log', path: data.simulation.log },
        ...data.waveforms.map(file => ({ kind: 'waveform', path: file }))
    ];
    return result('simulate', { ...data, workDir }, context, [], artifacts);
}

async function mkdtemp(base) {
    const name = 'simulate-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const dir = path.join(base, name);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

module.exports = { simulate };
