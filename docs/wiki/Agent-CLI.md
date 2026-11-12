# Agent CLI 与 Skills（4.2）

用 Agent 或终端检查 RTL、生成架构图、读取波形并组织验证证据。Windows x64 用户从 [4.2.0 Release](https://github.com/JayceVane/SV-Tools/releases/tag/v4.2.0) 下载 Agent ZIP，需要 Node.js 22 或 24。

```powershell
Get-FileHash .\svtools-agent-v4.2.0-win32-x64.zip -Algorithm SHA256
Expand-Archive .\svtools-agent-v4.2.0-win32-x64.zip .\svtools-agent
Set-Location .\svtools-agent
.\svtools-agent.cmd doctor --workspace D:\rtl\demo
.\svtools-agent.cmd project inspect --workspace D:\rtl\demo
```

对照同一 Release 的 `SHA256SUMS.txt`。运行 `doctor` 后查看 `apiVersion`、`data.capabilities` 和 `data.tools`。Icarus 和 Vivado 由本机提供，缺少某一工具时仍可使用对应依赖已就绪的操作。

| 任务 | CLI 命令族 | Skill |
| --- | --- | --- |
| 工程、格式化、Lint 和后台任务 | `project`、`format`、`lint`、`task` | `svtools-agent` |
| 设计架构、结构检查和图文报告 | `design scaffold/arch/check/diff/report` | `svtools-design` |
| 计划、证据和交接 | `design plan/tasks/claim/submit/evidence/review/return` | `svtools-delivery` |
| Vivado 创建、综合和报告 | `project create/add/set-top`、`vivado` | `svtools-vivado` |
| VCD/FST 查询、统计和导出 | `wave` | `svtools-waveform` |

把需要的 `skills/svtools-*` 目录完整导入客户端，保留 `SKILL.md`、`references/` 和 `assets/`。从 `svtools-agent` 开始，并告诉 Agent 解压目录与 RTL 工作区。Agent 调用本地 CLI，终端也能运行相同命令。

```powershell
.\svtools-agent.cmd design report --workspace D:\rtl\demo --top top --out reports/design
.\svtools-agent.cmd wave values --workspace D:\rtl\demo --file sim/tb.fst --signals tb.clk,tb.dut.valid --at 1250ns
```

报告目录包含 Markdown、架构 JSON、SVG、PNG 和产物清单。任务型命令启动后，用 `task status <任务 ID>` 等待终态；仿真和综合结果要看状态、诊断和对应输入。详见 [CLI 合同](https://github.com/JayceVane/SV-Tools/blob/8b6836f4821b084036c6c8d14a35150e1168b64f/skills/svtools-agent/references/cli.md) 和 [架构与验证交接](https://github.com/JayceVane/SV-Tools/wiki/Design-Delivery)。
