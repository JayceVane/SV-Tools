---
name: svtools-agent
description: 使用 SV Tools CLI 在无 IDE 环境中查询 RTL 工程与源码身份、格式化 Verilog/SystemVerilog、运行 Icarus 检查并管理后台任务。适用于通过 SV Tools 完成 RTL 修改后的工程级基础验证。
---

# SV Tools Agent

将 `<svtools-root>` 替换为已构建的 SV Tools 目录，以 `node <svtools-root>/src/cli/main.js` 调用；已链接的 Node 包也提供 `svtools-agent`。CLI 的 `--workspace` 明确指向用户的 RTL 工作区，不能把工具安装目录当作被检查工程。

先运行 `doctor --workspace <rtl-workspace>` 查看 `data.capabilities` 和实际工具可用性。缺依赖是未执行，不是零错误通过。当前 CLI 提供工程查询与写操作、格式化、Icarus 检查、后台任务与 Vivado 工程/运行/报告（M2）；架构建模（design arch）已提供，架构 SVG 导出已提供（document 默认黑白线稿 / presentation 可选）；PNG 需栅格化宿主，当前返回 EXPORT_UNSUPPORTED；波形查询与 MCP 尚未实现，不要编造。IP/BD、外部 Tcl 钩子与动态 XDC 读取暂不支持，遇到 SNAPSHOT_UNSUPPORTED 按未支持处理并停止。

用 `project list`、`project inspect` 确认工程、文件集、top 与文件摘要。歧义时使用返回候选补充 `--project`、`--fileset`、`--file`、`--top`；不要借用另一个工程或编辑器的活动 top。根据任务读取必要的分页，不必一次枚举全部源码。

格式化默认预览；检查格式用 `format --file <path> --check`。需要实际修改时使用 `--write`，然后复验。CLI 强制非空白字符保全，不绕过它提交不安全的输出。

RTL 修改后运行 `lint --file <path> --top <module>`。这属于编译/详细化检查，不能代替功能仿真、时序或 CDC 验证。使用结果中的源码位置定位问题，并保留原始日志和 manifest 引用，不因没有解析到诊断就声称检查通过。

Vivado 工程（M2）：`project create/add/set-top` 管理工程（创建幂等、加文件报告 added/already、两种 top 分开设置）；`vivado status` 查版本/器件/tops/runs；`vivado report timing|utilization|drc` 取结构化报告（默认 run：timing/drc 用 impl_1，utilization 用 synth_1，可用 `--run` 覆盖）；`vivado run` 作为后台任务执行 launch_runs + wait_on_run。报告阶段未完成时返回 `VIVADO_SCRIPT_FAILED`，这表示未执行，不是零错误；不要把空数组当作“无问题证据”。运行与报告的结果分四个互不合并的证据轴：`execution`（是否跑完）、`inputs`（输入是否完整捕获）、`regeneration`（能否由源重建）、`verification`（验证做到哪一步，`acceptance=false` 时不得称为功能验证通过）。报告的 `stale=true` 表示源码/约束在该 run 之后变化，必须先重跑再引用；`stale=null` 表示没有该 run 的记录，不能当作新鲜。`drc` 只有 `checked=1` 的结果才代表本次检查。`vivado run` 状态含 ERROR 时返回 `VIVADO_RUN_FAILED`。

架构建模（M3，进行中）：`design arch --top <module>` 用内置 Yosys（`read_verilog -sv` + `hierarchy` + `proc` + `memory_collect`，不跑 `prep`/`opt`）把顶层用户模块实例投影为架构节点、顶层端口为边界，并把信号级连接聚合为接口束（`interfaces[]`：双向合并、同源多目标扇出合并、边界按 `uart*`/`spi*` 等前缀聚合；标签优先时钟/复位语义与信号公共前缀，否则用信号名摘要）；`instances[].ports` 保留完整端口，`bundles[]` 给出可选的前缀折叠结果。空模块自动成为 blackbox，已实现模块统一折叠为盒，子模块内部实现与存储不入图。`--depth` 当前固定按顶层投影，`--save <name>` 落盘到 `.svtools/agent/design/`。`design render --top <module> [--out <dir>] [--style document|presentation] [--fold-ports] [--bundle-name <prefix=display>]` 用纯 Node 生成自含 SVG 架构图：**默认按 RTL 端口事实绘制**，仅 `--fold-ports` 时按虚拟接口端口折叠（`--bundle-name` 仅与它同时有效）；写报告用默认 `document`（黑白线稿），演示用 `presentation`（深色主题，别名 `ui`）；ELK 布局 aspectRatio≈1.5，含 evidence 元数据、junctionCount/bundleCount 与 `data-model-id`，同一输入同一风格渲染确定。架构图优先看 RTL 端口事实；需要更粗粒度示意时用 `--fold-ports`。`--format png` 需要栅格化宿主，缺失时返回 `EXPORT_UNSUPPORTED`。架构图是源级结构事实，不得当作综合、时序或功能验证证据；`design check/diff` 尚未实现。

架构骨架约定（`design scaffold`）：优先用 **packed struct 虚拟接口**（如 `axi4_lite_t m_axi`），不要用 SV interface——Yosys 会把 interface 摊平成 `m0.addr` 等端口，架构图难以聚合。主设备端口建议用 `m_` 前缀、从设备建议用 `s_` 前缀，时钟/复位建议 `clk_*`/`rst_*`；这些只是 Skill 建议，程序不强制，scaffold 会在 `data.suggestions[]` 给 `PORT_NAMING` 提示但不阻断生成。空模块只声明端口、体内不写实现；顶层只声明 struct 总线 wire 并例化连线。推荐工作流：`design scaffold --spec <json|file>` → 补空模块实现 → `design arch --top <top>` → `design render`（默认 RTL 端口事实，`--fold-ports` 看虚拟接口）。目标文件已存在需 `--force`；`--out` 必须在工作区内（拒绝 symlink/junction 逃逸）。架构图仍是源级结构事实，不得当作综合、时序证据。

耗时操作可用 `task start lint`，保存返回的 UUID，再通过 `task status`、`task logs`、`task cancel` 管理。查询命令退出 0 只表示查询成功；检查 `data.result.status` 与 `data.sourceCurrent`。源码变化后重新验证，`CONTEXT_CHANGED`、`lost`、缺失结果或未知当前性都不能作为当前交付的通过证据。

报告实际运行的命令、工程/源码版本、工具版本、结论和仍未验证的部分。原始日志按需分页读取，避免将整份日志交给模型。

需要配置字段、退出码、分页、include 边界或安装说明时，读取工具目录的 `docs/CLI.md`；用 `--help` 核对当前版本命令。
