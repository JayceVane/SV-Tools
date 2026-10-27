# Vivado任务目录修复变更清单

| 文件 | 改动 |
|---|---|
| `src/vivado/script-task.js` | 统一任务根、脚本生成／用户脚本适配、准备前后校验。 |
| `src/vivado/index.js` | 执行器统一拥有输入与日志，取消／失败交还目录，整套记录按既有预算淘汰。 |
| `src/vivado/projectTree.js` | 面板提交生成描述，取消独立action目录写入。 |
| `package.json` | 将任务布局回归加入全量测试。 |
| `test/vivado_task_layout_test.js` | 同目录脚本／日志、混合历史封顶、用户Tcl、取消与工作区外行为。 |
| `test/vivado_commands_test.js` | 实际命令接线的混合动作封顶、旧记录保护和准备期取消。 |
| `test/vivado_tree_test.js` | 更新面板与执行器的生成描述合同。 |
| `docs/TOOLCHAINS.md` | 新目录布局、保留设置及清理边界。 |
| `docs/bugs/logic-vivado-task-layout.md` | 根因、修复取舍与回归记录。 |
| `ARCHITECTURE.md` | 稳定历史根与单一任务所有权边界。 |
| `CHANGELOG.md` | 本轮行为变更。 |
| `CONTEXT.md` | 最终源码、安装包及验收交接。 |
| `docs/VIVADO_TASK_RETENTION_FILES.md` | 本变更清单。 |

本地验收产物（`bin/`下未纳入Git）：`vivado-task-retention-local-build.log`记录全量回归，
`vivado-task-retention-package-verification.json`记录安装包核对；
`vivado-legacy-cleanup.ps1`及对应计划／报告／确认JSON记录本轮用户授权的旧目录清理。
