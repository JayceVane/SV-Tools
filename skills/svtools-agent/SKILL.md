---
name: svtools-agent
description: 使用 SV Tools CLI 在无 IDE 环境中查询 RTL 工程与源码身份、格式化 Verilog/SystemVerilog、运行 Icarus 检查并管理后台任务。适用于通过 SV Tools 完成 RTL 修改后的工程级基础验证。
---

# SV Tools Agent

将 `<svtools-root>` 替换为已构建的 SV Tools 目录，以 `node <svtools-root>/src/cli/main.js` 调用；已链接的 Node 包也提供 `svtools-agent`。CLI 的 `--workspace` 明确指向用户的 RTL 工作区，不能把工具安装目录当作被检查工程。

先运行 `doctor --workspace <rtl-workspace>` 查看 `data.capabilities` 和实际工具可用性。缺依赖是未执行，不是零错误通过。M1 仅提供工程查询、格式化、Icarus 检查和后台任务；不要编造 Vivado、架构导出、波形查询或 MCP 命令。

用 `project list`、`project inspect` 确认工程、文件集、top 与文件摘要。歧义时使用返回候选补充 `--project`、`--fileset`、`--file`、`--top`；不要借用另一个工程或编辑器的活动 top。根据任务读取必要的分页，不必一次枚举全部源码。

格式化默认预览；检查格式用 `format --file <path> --check`。需要实际修改时使用 `--write`，然后复验。CLI 强制非空白字符保全，不绕过它提交不安全的输出。

RTL 修改后运行 `lint --file <path> --top <module>`。这属于编译/详细化检查，不能代替功能仿真、时序或 CDC 验证。使用结果中的源码位置定位问题，并保留原始日志和 manifest 引用，不因没有解析到诊断就声称检查通过。

Vivado 工程（M2）：`project create/add/set-top` 管理工程（创建幂等、加文件报告 added/already、两种 top 分开设置）；`vivado status` 查版本/器件/tops/runs；`vivado report timing|utilization|drc` 取结构化报告（默认 run：timing/drc 用 impl_1，utilization 用 synth_1，可用 `--run` 覆盖）；`vivado run` 作为后台任务执行 launch_runs + wait_on_run。报告阶段未完成时返回 `VIVADO_SCRIPT_FAILED`，这表示未执行，不是零错误；不要把空数组当作“无问题证据”。运行与报告的结果分四个互不合并的证据轴：`execution`（是否跑完）、`inputs`（输入是否完整捕获）、`regeneration`（能否由源重建）、`verification`（验证做到哪一步，`acceptance=false` 时不得称为功能验证通过）。报告的 `stale=true` 表示源码/约束在该 run 之后变化，必须先重跑再引用；`stale=null` 表示没有该 run 的记录，不能当作新鲜。`drc` 只有 `checked=1` 的结果才代表本次检查。`vivado run` 状态含 ERROR 时返回 `VIVADO_RUN_FAILED`。

耗时操作可用 `task start lint`，保存返回的 UUID，再通过 `task status`、`task logs`、`task cancel` 管理。查询命令退出 0 只表示查询成功；检查 `data.result.status` 与 `data.sourceCurrent`。源码变化后重新验证，`CONTEXT_CHANGED`、`lost`、缺失结果或未知当前性都不能作为当前交付的通过证据。

报告实际运行的命令、工程/源码版本、工具版本、结论和仍未验证的部分。原始日志按需分页读取，避免将整份日志交给模型。

需要配置字段、退出码、分页、include 边界或安装说明时，读取工具目录的 `docs/CLI.md`；用 `--help` 核对当前版本命令。
