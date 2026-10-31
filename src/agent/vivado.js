'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { result, fail, identity } = require('./protocol');
const { resolveContext, readOptions, hash } = require('./context');
const { directory, writeJson, readJson } = require('./storage');
const { findVivadoBinDir, normalizeVivadoDir, buildBatchArgs } = require('../vivado/toolchain');
const { runVivadoBatchTask } = require('../vivado/batch');
const { createToolTaskManager } = require('../toolchains/job');
const tclgen = require('../vivado/tclgen');

const RUN_NAME = /^(?:synth|impl)_\d+$/;
/** 报告类型到默认run：时序与DRC需要实现后的真实数据，资源报告综合后即可用。 */
const REPORT_DEFAULT_RUN = { timing: 'impl_1', utilization: 'synth_1', drc: 'impl_1' };

async function locateVivado(options) {
    const bin = options.vivado ? normalizeVivadoDir(path.resolve(options.workspace, options.vivado)) : findVivadoBinDir('');
    const executable = bin && path.join(bin, process.platform === 'win32' ? 'vivado.bat' : 'vivado');
    const stat = executable ? await fs.stat(executable).catch(() => null) : null;
    if (!stat?.isFile()) fail('VIVADO_NOT_FOUND', '未找到Vivado安装，请设置--vivado或CLI配置中的vivado（bin目录/安装根/vivado.bat）', { configured: options.vivado || null });
    return executable;
}

/** Vivado操作必须绑定明确的.xpr工程；工作区模式没有可推断的工程身份。 */
async function vivadoTarget(input) {
    const { options, context } = await resolveContext(input);
    if (!context.project || context.project.kind !== 'vivado') fail('VIVADO_PROJECT_REQUIRED', 'Vivado操作要求--project指向.xpr工程', { project: options.project || null });
    const run = options.run || null;
    if (run && !RUN_NAME.test(run)) fail('INVALID_ARGUMENT', 'run名称必须形如synth_1或impl_1');
    return { options, context, xpr: context.project.path, run };
}

/** 脚本写入独立运行目录执行；runner可注入，便于无Vivado环境验证解析与错误语义。 */
async function execute(options, script, { task, timeoutMs, runner } = {}) {
    const manager = task ? null : createToolTaskManager({});
    const job = task || manager.start('cli-vivado');
    try {
        const base = await directory(options.workspace, 'runs');
        const runDirectory = await job.directory(base, 'vivado');
        const scriptPath = path.join(runDirectory, 'script.tcl');
        await fs.writeFile(scriptPath, script, { encoding: 'utf8', flag: 'wx' });
        if (runner) {
            const produced = await runner({ script, scriptPath, runDirectory });
            const stdout = typeof produced === 'string' ? produced : String(produced?.stdout ?? '');
            const exitCode = typeof produced === 'string' ? 0 : Number(produced?.exitCode ?? 0);
            return { summary: { ok: exitCode === 0, exitCode, message: exitCode === 0 ? null : '注入runner退出码' + exitCode, issues: [] }, stdout, runDirectory, scriptPath, logs: [] };
        }
        const executable = await locateVivado(options);
        const summary = await runVivadoBatchTask({ task: job, executable, args: buildBatchArgs(scriptPath), cwd: runDirectory, scriptPath,
            timeoutMs: timeoutMs || options.timeoutMs });
        return { summary, stdout: summary.stdout || '', runDirectory, scriptPath, logs: job.logPaths };
    } finally {
        if (!task) { await job.finish({ keepArtifacts: true }); await manager.dispose(); }
    }
}

/** 错误marker优先于结果marker，避免把失败脚本解析成空数据。 */
function markers(stdout) {
    const lines = String(stdout || '').split(/\r?\n/);
    const error = lines.filter(line => line.startsWith('SVTOOLS_ERROR')).map(line => line.slice('SVTOOLS_ERROR'.length).trim()).filter(Boolean).pop();
    if (error) fail('VIVADO_SCRIPT_FAILED', 'Vivado脚本执行失败：' + error);
    const parsed = [];
    for (const text of lines.filter(line => line.startsWith('SVTOOLS_JSON')).map(line => line.slice('SVTOOLS_JSON'.length).trim()).filter(Boolean)) {
        try { parsed.push(JSON.parse(text)); }
        catch (cause) { fail('VIVADO_RESULT_INVALID', 'Vivado返回的结构化结果无法解析：' + cause.message); }
    }
    if (!parsed.length) fail('VIVADO_NO_RESULT', 'Vivado未返回结构化结果；请确认工程可打开且所需阶段已完成', { markers: lines.filter(line => line.startsWith('SVTOOLS_')).slice(0, 5) });
    return parsed;
}

function artifactLogs(logs) { return logs.map(file => ({ kind: 'log', path: file })); }

function tclErrorLine(stdout) {
    const line = String(stdout || '').split(/\r?\n/).find(value => value.startsWith('SVTOOLS_TCL_ERROR'));
    return line ? line.slice('SVTOOLS_TCL_ERROR'.length).trim() : null;
}
/** 运行器summary.ok/exitCode与Tcl错误都参与判定：只看marker会把失败执行当成功。 */
function ensureSucceeded(summary, stdout) {
    if (!summary) return;
    const tclError = tclErrorLine(stdout);
    if (summary.ok && !tclError) return;
    if (tclError) fail('VIVADO_SCRIPT_FAILED', 'Vivado脚本执行失败：' + tclError, { exitCode: summary.exitCode ?? null });
    fail('VIVADO_EXEC_FAILED', summary.message || 'Vivado执行未成功', { exitCode: summary.exitCode ?? null, issues: (summary.issues || []).slice(0, 5) });
}
/** run完成时的输入快照：报告只能对这份快照的源码与约束负责。 */
function inputSnapshot(context) {
    return { files: (context.files || []).map(entry => ({ path: entry.path, sha256: entry.sha256 })),
        constraints: (context.constraints || []).map(entry => ({ path: entry.path, sha256: entry.sha256 })) };
}
function manifestFile(base, xpr, run) { return path.join(base, hash(xpr).slice(0, 16) + '-' + run + '.json'); }
function changedInputs(recorded, current) {
    const currentMap = new Map([...(current.files || []), ...(current.constraints || [])].map(entry => [entry.path, entry.sha256]));
    const recordedMap = new Map([...(recorded.files || []), ...(recorded.constraints || [])].map(entry => [entry.path, entry.sha256]));
    const changed = [];
    for (const [file, sha] of currentMap) if (recordedMap.get(file) !== sha) changed.push(file);
    for (const file of recordedMap.keys()) if (!currentMap.has(file)) changed.push(file);
    return [...new Set(changed)];
}
/** 报告与run输入绑定：没有记录时 stale=null（未知），有记录时按当前源码/约束判定过期。 */
async function runBinding(options, xpr, run, context) {
    const base = await directory(options.workspace, 'vivado', 'manifests');
    let manifest = null;
    try { manifest = await readJson(manifestFile(base, xpr, run)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!manifest) return { runInfo: null, stale: null, staleInputs: [] };
    const staleInputs = changedInputs(manifest.inputs || {}, inputSnapshot(context));
    return { runInfo: { status: manifest.status || null, completedAt: manifest.completedAt || null, revision: manifest.context?.revision || null }, stale: staleInputs.length > 0, staleInputs };
}

/** 工程写操作：Tcl错误与未完成都要显式失败；不能只凭退出码或日志尾部判定成功。 */
function lifecycle(stdout, summary) {
    ensureSucceeded(summary, stdout);
    const lines = String(stdout || '').split(/\r?\n/);
    if (!lines.some(line => line.startsWith('SVTOOLS_DONE'))) fail('VIVADO_SCRIPT_FAILED', (summary && summary.message) || 'Vivado脚本未正常结束', { markers: lines.filter(line => line.startsWith('SVTOOLS_')).slice(0, 5) });
    return lines;
}
/** batch运行器的stdout同时含marker集合与完整输出，同一marker会出现两次；按值去重保留首次顺序。 */
function tagged(lines, prefix) { return [...new Set(lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).trim()).filter(Boolean))]; }

async function createProject(input, { runner } = {}) {
    const { options } = await readOptions(input);
    const name = input.name;
    if (!name || !/^[A-Za-z_][\w.-]{0,63}$/.test(name)) fail('INVALID_ARGUMENT', '工程名必须以字母或下划线开头，且不超过64字符');
    const dir = path.resolve(options.workspace, input.dir || '.');
    const xpr = path.join(dir, name + '.xpr');
    const existed = !!(await fs.stat(xpr).catch(() => null));
    const script = tclgen.buildCreateProjectScript({ name, dir, part: input.part || '', sources: [], sims: [], constraints: [], top: input.top || '', simTop: input.simTop || '' });
    const { stdout, summary, logs } = await execute(options, script, { runner });
    const lines = String(stdout || '').split(/\r?\n/);
    const tclError = lines.find(line => line.startsWith('SVTOOLS_TCL_ERROR'));
    if (tclError) fail('VIVADO_SCRIPT_FAILED', 'Vivado脚本执行失败：' + tclError.slice('SVTOOLS_TCL_ERROR'.length).trim());
    // 创建脚本以 PROJECT_READY 作为完成信号（它不走 wrapProjectScript 的 DONE 约定）。
    if (!lines.some(line => line.startsWith('SVTOOLS_PROJECT_READY'))) fail('VIVADO_SCRIPT_FAILED', (summary && summary.message) || 'Vivado未报告工程就绪', { markers: lines.filter(line => line.startsWith('SVTOOLS_')).slice(0, 5) });
    const stat = await fs.stat(xpr).catch(() => null);
    if (!stat?.isFile()) fail('VIVADO_NO_RESULT', '工程文件未生成：' + xpr, { xpr });
    const resolved = await resolveContext({ workspace: options.workspace, project: xpr });
    return result('project.create', { project: resolved.context.project, created: !existed, part: input.part || null, top: input.top || null, simTop: input.simTop || null }, resolved.context, [], artifactLogs(logs));
}

async function addFiles(input, { runner } = {}) {
    const { options, xpr } = await vivadoTarget(input);
    const sources = (input.sources || []).map(file => path.resolve(options.workspace, file));
    if (!sources.length) fail('FILE_REQUIRED', 'project add 需要至少一个 --source');
    for (const file of sources) {
        const stat = await fs.stat(file).catch(() => null);
        if (!stat?.isFile()) fail('SOURCE_NOT_FOUND', '源文件不存在：' + file, { file });
    }
    // --target-fileset 与上下文的 --fileset 分开，避免"选择哪个文件集加入"和"用哪个文件集作上下文"混为一谈。
    const fileset = input.filesetTarget || (sources.every(file => /\.xdc$/i.test(file)) ? 'constrs_1' : 'sources_1');
    if (!['sources_1', 'constrs_1', 'sim_1'].includes(fileset)) fail('INVALID_ARGUMENT', '目标文件集必须为sources_1、constrs_1或sim_1');
    const { stdout, summary, logs } = await execute(options, tclgen.buildAddFilesBatchScript({ xprPath: xpr, files: sources, fileset }), { runner });
    const lines = lifecycle(stdout, summary);
    const resolved = await resolveContext({ ...options, project: xpr });
    return result('project.add', { fileset, added: tagged(lines, 'SVTOOLS_ADDED'), already: tagged(lines, 'SVTOOLS_ALREADY_IN') }, resolved.context, [], artifactLogs(logs));
}

async function setTop(input, { runner } = {}) {
    const { options, xpr } = await vivadoTarget(input);
    if (!input.top && !input.simTop) fail('INVALID_ARGUMENT', 'project set-top 需要 --top 或 --sim-top');
    const applied = [];
    for (const [fileset, value] of [['sources_1', input.top], ['sim_1', input.simTop]]) {
        if (!value) continue;
        const { stdout, summary } = await execute(options, tclgen.buildSetTopScript({ xprPath: xpr, fileset, top: value }), { runner });
        for (const top of tagged(lifecycle(stdout, summary), 'SVTOOLS_TOP_SET')) applied.push({ fileset, top });
    }
    const resolved = await resolveContext({ ...options, project: xpr });
    return result('project.set-top', { applied }, resolved.context, []);
}


async function status(input, { runner } = {}) {
    const { options, context, xpr } = await vivadoTarget(input);
    const { stdout, summary, logs } = await execute(options, tclgen.buildVivadoStatusScript({ xprPath: xpr }), { runner });
    ensureSucceeded(summary, stdout);
    const [data] = markers(stdout);
    return result('vivado.status', { ...data, project: context.project }, context, [], artifactLogs(logs));
}

async function report(input, { runner } = {}) {
    const { options, context, xpr, run } = await vivadoTarget(input);
    const kind = input.kind || 'timing';
    if (!REPORT_DEFAULT_RUN[kind]) fail('INVALID_ARGUMENT', '报告类型必须为timing、utilization或drc');
    const selected = run || REPORT_DEFAULT_RUN[kind];
    const binding = async () => runBinding(options, xpr, selected, context);
    if (kind === 'utilization') {
        const { stdout, summary: utilSummary, logs } = await execute(options, tclgen.buildVivadoUtilizationScript({ xprPath: xpr, run: selected }), { runner });
        ensureSucceeded(utilSummary, stdout);
        // batch stdout 同时含 marker 集合与完整日志，整表会出现两遍；按行去重后解析。
        const text = [...new Set(String(stdout).split(/\r?\n/).filter(line => line.startsWith('SVTOOLS_UTIL')).map(line => line.slice('SVTOOLS_UTIL'.length).trimStart()))].join('\n');
        if (!text) markers(stdout);
        return result('vivado.report', { kind, run: selected, summary: tclgen.parseUtilHierSummary(text), textBytes: Buffer.byteLength(text), ...(await binding()) }, context, [], artifactLogs(logs));
    }
    const script = kind === 'timing'
        ? tclgen.buildVivadoTimingScript({ xprPath: xpr, run: selected, maxPaths: input.maxPaths || 10 })
        : tclgen.buildVivadoDrcScript({ xprPath: xpr, run: selected });
    const { stdout, summary: reportSummary, logs } = await execute(options, script, { runner });
    ensureSucceeded(reportSummary, stdout);
    const [data] = markers(stdout);
    return result('vivado.report', { kind, ...data, ...(await binding()) }, context, [], artifactLogs(logs));
}

/** 后台操作：launch_runs + wait_on_run（Vivado自有并发与队列），进度由任务状态承载。 */
async function run(input, { signal, onContext, onArtifacts, runner } = {}) {
    const { options, context, xpr, run: selected } = await vivadoTarget(input);
    const target = selected || 'synth_1';
    // 排队请求携带启动时的 revision；工程/源码已变化时不能拿旧上下文跑新任务。
    if (input.expectedRevision && input.expectedRevision !== context.revision) fail('CONTEXT_CHANGED', '任务启动前工程或源码已经变化，本轮结果失效', {}, 4);
    const manager = createToolTaskManager({ onChange: task => onArtifacts?.(artifactLogs(task.logPaths)) });
    const job = manager.start('cli-vivado-run');
    const cancel = () => job.cancel('CLI请求取消');
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    try {
        await onContext?.(identity(context));
        // CLI 的 run 是显式"现在运行"：先 reset，已完成的 run 才会真正重跑。
        const script = tclgen.buildLaunchRunScript({ xprPath: xpr, run: target, jobs: input.jobs || 4, reset: true });
        const { stdout, summary: runSummary, logs } = await execute(options, script, { task: job, timeoutMs: input.timeoutMs || options.timeoutMs, runner });
        // 取消优先于失败：中止的进程没有完成记录，不能报成脚本失败。
        if (signal?.aborted || job.signal?.aborted) fail('TOOL_CANCELLED', 'Vivado运行已取消', { run: target, artifacts: artifactLogs(logs) }, 3);
        const lines = lifecycle(stdout, runSummary);
        const line = lines.find(value => value.startsWith('SVTOOLS_RUN_STATUS')) || '';
        const status = line.slice('SVTOOLS_RUN_STATUS'.length).trim();
        if (!status) fail('VIVADO_NO_RESULT', 'Vivado未返回run状态');
        if (/\b(?:ERROR|Failed|Aborted)\b/i.test(status) && !/Complete/i.test(status)) fail('VIVADO_RUN_FAILED', 'Vivado运行未成功：' + status, { run: target, status }, 1);
        const manifest = { run: target, status, completedAt: new Date().toISOString(), context: identity(context), inputs: inputSnapshot(context) };
        await writeJson(manifestFile(await directory(options.workspace, 'vivado', 'manifests'), xpr, target), manifest);
        return result('vivado.run', { run: target, status }, context, [], artifactLogs(logs));
    } finally {
        signal?.removeEventListener('abort', cancel);
        await job.finish({ keepArtifacts: true }); await manager.dispose();
    }
}

module.exports = { status, report, run, createProject, addFiles, setTop, locateVivado, vivadoTarget };
