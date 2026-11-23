'use strict';

const en = {
    title: 'Project Overview', auto: 'Auto refresh', refresh: 'Refresh', folder: 'Project folder',
    loading: 'Loading project status…', refreshing: 'Refreshing…', busy: 'Vivado is running another task.',
    noProject: 'Select or create a Vivado project (.xpr).',
    versionError: 'The configured Vivado version could not be matched to the project.',
    noTool: 'Vivado was not found. Set svtools.vivado.path.',
    switched: 'The project has changed. Open the overview from the current project.',
    readFailed: 'Could not read project status.', openFailed: 'Could not open', overviewFailed: 'Could not open the project overview.',
    folderFailed: 'The system could not open the folder.',
    facts: 'Project information', part: 'Device', top: 'Top module', board: 'Board',
    stages: 'Current synthesis and implementation', synthesis: 'Synthesis', implementation: 'Implementation',
    timing: 'Timing', messages: 'Session messages', errors: 'Errors', warnings: 'Warnings',
    runs: 'Runs', run: 'Run', status: 'Status', progressTime: 'Progress / Time', artifacts: 'Artifacts',
    emptyRuns: 'No runs in this project.', emptyTiming: 'No timing results for the current run.',
    none: 'No current run', unknown: 'Unknown', failed: 'Failed', stopped: 'Stopped',
    queued: 'Queued', active: 'Running', complete: 'Complete', notStarted: 'Not started',
    stale: 'Out of date', current: 'Current run', waiting: 'Awaiting progress', progress: 'Run progress',
    log: 'Log', directory: 'Folder', openArtifact: 'Open {0} for {1}', runCount: '{0} runs', updated: 'Updated {0}',
    analysis: 'Design analysis', utilization: 'Utilization', power: 'Power', drc: 'DRC Violations',
    noUtilization: 'No utilization report for the current runs.',
    noPower: 'No power results for the current runs.',
    noDrc: 'No DRC report for the current runs.',
    report: 'Open report', reportFor: 'Open {0} report', generate: 'Generate missing reports',
    generating: 'Generating reports from the current checkpoint…', generationFailed: 'Could not generate the requested reports.',
    checkpointChanged: 'The run checkpoint changed. Refresh the overview and retry.',
    partial: 'Some reports could not be generated.',
    resources: { lut: 'LUT', ff: 'Flip-flops', bram: 'Block RAM', dsp: 'DSP', uram: 'UltraRAM', io: 'I/O' },
    used: '{0} of {1} used', totalPower: 'On-chip total', dynamic: 'Dynamic', static: 'Device static',
    confidence: 'Confidence', confidenceLevels: { low: 'Low', medium: 'Medium', high: 'High' },
    noViolations: 'No violations in this report.', violations: 'Total violations',
    severities: { errors: 'Errors', criticalWarnings: 'Critical warnings', warnings: 'Warnings', advisories: 'Advisories', other: 'Other' },
    phases: { synth: 'Post-synthesis', opt: 'Post-optimization', opted: 'Post-optimization', place: 'Post-placement',
        placed: 'Post-placement', physopt: 'Post-physical optimization', route: 'Post-route', routed: 'Post-route', postroute: 'Post-route', bitstream: 'Bitstream' }
};

const zh = {
    title: '工程概览', auto: '自动刷新', refresh: '刷新', folder: '工程目录',
    loading: '正在读取工程状态…', refreshing: '正在刷新…', busy: 'Vivado 正在执行其他任务。',
    noProject: '请先选择或创建 Vivado 工程（.xpr）。',
    versionError: '无法确认当前 Vivado 版本与工程匹配。',
    noTool: '未找到 Vivado，请设置 svtools.vivado.path。',
    switched: '工程已切换，请从当前工程重新打开概览。',
    readFailed: '读取工程状态失败。', openFailed: '无法打开', overviewFailed: '打开工程概览失败。',
    folderFailed: '系统未能打开目录。',
    facts: '工程信息', part: '器件', top: '顶层模块', board: '板卡',
    stages: '当前综合与布局布线', synthesis: '综合', implementation: '布局布线',
    timing: '时序', messages: '会话消息', errors: '错误', warnings: '警告',
    runs: '运行记录', run: '运行', status: '状态', progressTime: '进度 / 耗时', artifacts: '产物',
    emptyRuns: '当前工程还没有运行记录。', emptyTiming: '当前运行暂无时序结果。',
    none: '无当前运行', unknown: '状态未知', failed: '失败', stopped: '已停止',
    queued: '排队中', active: '运行中', complete: '已完成', notStarted: '未开始',
    stale: '待重跑', current: '当前运行', waiting: '等待进度', progress: '运行进度',
    log: '日志', directory: '目录', openArtifact: '打开 {1} 的{0}', runCount: '{0} 项', updated: '更新于 {0}',
    analysis: '设计分析', utilization: '资源利用率', power: '功耗', drc: 'DRC 违规',
    noUtilization: '当前运行暂无资源报告。',
    noPower: '当前运行暂无功耗结果。',
    noDrc: '当前运行暂无 DRC 报告。',
    report: '打开报告', reportFor: '打开{0}报告', generate: '生成缺失报告',
    generating: '正在从当前检查点生成报告…', generationFailed: '无法生成所需的报告。',
    checkpointChanged: '运行检查点已变化，请刷新概览后重试。',
    partial: '部分报告生成失败。',
    resources: { lut: 'LUT', ff: '触发器', bram: 'Block RAM', dsp: 'DSP', uram: 'UltraRAM', io: 'I/O' },
    used: '已用 {0} / {1}', totalPower: '片上总功耗', dynamic: '动态功耗', static: '器件静态功耗',
    confidence: '置信度', confidenceLevels: { low: '低', medium: '中', high: '高' },
    noViolations: '此报告未发现违规。', violations: '违规总数',
    severities: { errors: '错误', criticalWarnings: '严重警告', warnings: '警告', advisories: '提示', other: '其他' },
    phases: { synth: '综合后', opt: '优化后', opted: '优化后', place: '布局后', placed: '布局后',
        physopt: '物理优化后', route: '布线后', routed: '布线后', postroute: '布线后', bitstream: '比特流' }
};

function summaryStrings(language) {
    return /^zh\b/i.test(language || '') ? { locale: 'zh-CN', ...zh } : { locale: 'en', ...en };
}

module.exports = { summaryStrings };
