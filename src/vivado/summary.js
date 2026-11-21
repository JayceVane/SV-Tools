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
        '[sv_prop [current_project] DIRECTORY] [sv_prop [get_filesets -quiet sources_1] TOP] ' +
        '[sv_prop [current_project] BOARD_PART]',
        'foreach run [get_runs -quiet] {',
        '    sv_row run $run [sv_prop $run STATUS] [sv_prop $run PROGRESS] [sv_prop $run STRATEGY] ' +
        '[sv_prop $run NEEDS_REFRESH] [sv_prop $run CURRENT_STEP] [sv_prop $run ELAPSED] ' +
        '[sv_prop $run STATS.WNS] [sv_prop $run STATS.TNS] [sv_prop $run STATS.WHS] [sv_prop $run STATS.THS] ' +
        '[sv_prop $run STATS.TOTAL_POWER] [sv_prop $run IS_IMPLEMENTATION]',
        '}',
        'sv_row messages [get_msg_config -severity ERROR -count] [get_msg_config -severity WARNING -count]'
    ];
}

const numberOrNull = value => {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};
const flag = value => ['1', 'true'].includes(String(value || '').toLowerCase());

/** @param {Array<Array<string>>} rows @returns {{project:object,runs:object[],messages:object}} */
function parse(rows) {
    const [name, part, directory, top, board] = rowsOf(rows, 'project')[0] || [];
    const runs = rowsOf(rows, 'run').map(([id, status, progress, strategy, needsRefresh, step, elapsed, wns, tns, whs, ths, power, implementation]) => ({
        id, status: status || 'Unknown', progress: progress || '', strategy: strategy || '',
        needsRefresh: flag(needsRefresh), step: step || '', elapsed: elapsed || '',
        timing: { wns: numberOrNull(wns), tns: numberOrNull(tns), whs: numberOrNull(whs), ths: numberOrNull(ths) },
        power: numberOrNull(power), implementation: flag(implementation)
    }));
    const [errors, warnings] = rowsOf(rows, 'messages')[0] || [];
    return {
        project: { name: name || '', part: part || '', directory: directory || '', top: top || '', board: board || '' },
        runs,
        messages: { errors: Number(errors || 0), warnings: Number(warnings || 0) }
    };
}

/** run 目录与日志路径，供面板打开日志；只拼接已验证的工程目录与 run 名。 */
function runPaths(project, xpr) {
    const runsDirectory = path.join(project.directory || path.dirname(xpr), path.basename(xpr, path.extname(xpr)) + '.runs');
    return Object.fromEntries((project.runs || []).map(run => [run.id, {
        directory: path.join(runsDirectory, run.id),
        log: path.join(runsDirectory, run.id, 'runme.log')
    }]));
}

const ACTIVE = /queued|running/i;
const isActive = run => ACTIVE.test(run.status) || run.progress === 'Running';

module.exports = { query, parse, runPaths, isActive };
