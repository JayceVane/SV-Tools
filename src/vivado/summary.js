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
// Vivado 工程概览：项目信息、综合/实现 run 状态与消息计数（对应 GUI 的 Project Summary）。

const path = require('node:path');
const { rowsOf } = require('./asset-task');

/** 会话与批处理共用同一组查询；工程已打开，脚本只读取状态。 */
function query() {
    return [
        'sv_row project [sv_prop [current_project] NAME] [sv_prop [current_project] PART] ' +
        '[sv_prop [current_project] DIRECTORY] [sv_prop [current_fileset] TOP] ' +
        '[sv_prop [current_project] BOARD_PART]',
        'set synth ""; set impl ""',
        'catch { set synth [current_run -synthesis] }',
        'catch { set impl [current_run -implementation] }',
        'sv_row current_runs $synth $impl',
        'foreach fileset [get_filesets -quiet] { sv_row fileset $fileset [sv_prop $fileset FILESET_TYPE] }',
        'foreach run [get_runs -quiet] {',
        '    sv_row run $run [sv_prop $run STATUS] [sv_prop $run PROGRESS] [sv_prop $run STRATEGY] ' +
        '[sv_prop $run NEEDS_REFRESH] [sv_prop $run CURRENT_STEP] [sv_prop $run ELAPSED] ' +
        '[sv_prop $run STATS.WNS] [sv_prop $run STATS.TNS] [sv_prop $run STATS.WHS] [sv_prop $run STATS.THS] ' +
        '[sv_prop $run STATS.TOTAL_POWER] [sv_prop $run IS_IMPLEMENTATION] [sv_prop $run DIRECTORY] ' +
        '[sv_prop $run SRCSET] [sv_prop $run PARENT] [sv_prop $run IS_SYNTHESIS]',
        '}'
    ];
}

const numberOrNull = value => {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};
const flag = value => ['1', 'true'].includes(String(value || '').toLowerCase());

/** @param {Array<Array<string>>} rows @returns {{project:object,currentRuns:object,runs:object[]}} */
function parse(rows) {
    const [name, part, directory, top, board] = rowsOf(rows, 'project')[0] || [];
    const [synthesis, implementation] = rowsOf(rows, 'current_runs')[0] || [];
    const sources = new Map(rowsOf(rows, 'fileset'));
    const candidates = rowsOf(rows, 'run').map(([id, status, progress, strategy, needsRefresh, step, elapsed, wns, tns, whs, ths, power,
        impl, runDirectory, fileset, parent, synth]) => ({
        id, status: status || 'Unknown', progress: progress || '', strategy: strategy || '',
        needsRefresh: flag(needsRefresh), step: step || '', elapsed: elapsed || '',
        timing: { wns: numberOrNull(wns), tns: numberOrNull(tns), whs: numberOrNull(whs), ths: numberOrNull(ths) },
        power: numberOrNull(power), implementation: flag(impl), directory: runDirectory || '', fileset, parent, synth
    }));
    // IP and module out-of-context runs have a separate BlockSrcs fileset.
    const projectRuns = candidates.filter(run => {
        if (run.synth && !run.implementation && !flag(run.synth)) return false;
        const type = sources.get(run.fileset);
        return !type || type === 'DesignSrcs';
    });
    const projectIds = new Set(projectRuns.map(run => run.id));
    const runs = projectRuns.filter(run => !run.parent || projectIds.has(run.parent))
        .map(({ fileset, parent, synth, ...run }) => run);
    return {
        project: { name: name || '', part: part || '', directory: directory || '', top: top || '', board: board || '' },
        currentRuns: { synthesis, implementation },
        runs
    };
}

/** run 目录与日志路径，供面板打开日志；只拼接已验证的工程目录与 run 名。 */
function runPaths(project, xpr) {
    const runsDirectory = path.join(project.directory || path.dirname(xpr), path.basename(xpr, path.extname(xpr)) + '.runs');
    return Object.fromEntries((project.runs || []).map(run => {
        const directory = path.isAbsolute(run.directory || '') ? path.normalize(run.directory) : path.join(runsDirectory, run.id);
        return [run.id, { directory, log: path.join(directory, 'runme.log') }];
    }));
}

const ACTIVE = /queued|running/i;
const isActive = run => ACTIVE.test(run.status) || run.progress === 'Running';

module.exports = { query, parse, runPaths, isActive };
