'use strict';
// 兼容入口：语法与诊断规则独立，任务调度由引擎负责。
module.exports = { ...require('./xvlog-rules'), ...require('./xvlog-runner') };
