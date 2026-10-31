'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { result, fail, identity } = require('./protocol');
const { resolveContext } = require('./context');
const { directory } = require('./storage');
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
        if (runner) return { stdout: String(await runner({ script, scriptPath, runDirectory }) || ''), runDirectory, scriptPath, logs: [] };
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

async function status(input, { runner } = {}) {
    const { options, context, xpr } = await vivadoTarget(input);
    const { stdout, logs } = await execute(options, tclgen.buildVivadoStatusScript({ xprPath: xpr }), { runner });
    const [data] = markers(stdout);
    return result('vivado.status', { ...data, project: context.project }, context, [], artifactLogs(logs));
}

async function report(input, { runner } = {}) {
    const { options, context, xpr, run } = await vivadoTarget(input);
    const kind = input.kind || 'timing';
    if (!REPORT_DEFAULT_RUN[kind]) fail('INVALID_ARGUMENT', '报告类型必须为timing、utilization或drc');
    const selected = run || REPORT_DEFAULT_RUN[kind];
    if (kind === 'utilization') {
        const { stdout, logs } = await execute(options, tclgen.buildVivadoUtilizationScript({ xprPath: xpr, run: selected }), { runner });
        const text = String(stdout).split(/\r?\n/).filter(line => line.startsWith('SVTOOLS_UTIL')).map(line => line.slice('SVTOOLS_UTIL'.length).trimStart()).join('\n');
        if (!text) markers(stdout);
        return result('vivado.report', { kind, run: selected, summary: tclgen.parseUtilHierSummary(text), textBytes: Buffer.byteLength(text) }, context, [], artifactLogs(logs));
    }
    const script = kind === 'timing'
        ? tclgen.buildVivadoTimingScript({ xprPath: xpr, run: selected, maxPaths: input.maxPaths || 10 })
        : tclgen.buildVivadoDrcScript({ xprPath: xpr, run: selected });
    const { stdout, logs } = await execute(options, script, { runner });
    const [data] = markers(stdout);
    return result('vivado.report', { kind, ...data }, context, [], artifactLogs(logs));
}

/** 后台操作：launch_runs + wait_on_run（Vivado自有并发与队列），进度由任务状态承载。 */
async function run(input, { signal, onContext, onArtifacts } = {}) {
    const { options, context, xpr, run: selected } = await vivadoTarget(input);
    const target = selected || 'synth_1';
    const manager = createToolTaskManager({ onChange: task => onArtifacts?.(artifactLogs(task.logPaths)) });
    const job = manager.start('cli-vivado-run');
    const cancel = () => job.cancel('CLI请求取消');
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    try {
        await onContext?.(identity(context));
        const script = tclgen.buildLaunchRunScript({ xprPath: xpr, run: target, jobs: input.jobs || 4 });
        const { stdout, logs } = await execute(options, script, { task: job, timeoutMs: input.timeoutMs || options.timeoutMs });
        const line = String(stdout).split(/\r?\n/).find(value => value.startsWith('SVTOOLS_RUN_STATUS')) || '';
        const status = line.slice('SVTOOLS_RUN_STATUS'.length).trim();
        if (!status) markers(stdout);
        return result('vivado.run', { run: target, status: status || null }, context, [], artifactLogs(logs));
    } finally {
        signal?.removeEventListener('abort', cancel);
        await job.finish({ keepArtifacts: true }); await manager.dispose();
    }
}

module.exports = { status, report, run, locateVivado, vivadoTarget };
