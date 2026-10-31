# SV Tools CLI：4.2 M1 开发入口

M1 提供无 IDE 的基础服务，正式支持环境为 Windows x64、Node.js 22 及以上。当前正式扩展版本仍为 4.1.1；本页说明 4.2 开发分支的接口。工程文件集规则与插件共用，格式化复用 Rust 原生模块，Icarus 检查复用已有的进程、诊断和取消逻辑。MCP 适配留待后续按需接入。

## 准备与调用

在构建过的 SV Tools 仓库中运行：

```powershell
node src/cli/main.js doctor
node src/cli/main.js project list --workspace D:/project
node src/cli/main.js project inspect --workspace D:/project --project top.xpr --fileset sources_1
node src/cli/main.js format --workspace D:/project --file src/top.sv
node src/cli/main.js lint --workspace D:/project --file src/top.sv --top top
```

`doctor` 返回实际可用的格式化模块和 Icarus 路径/版本。缺少原生模块时，先按仓库构建方式运行 `npm ci`、`npm ci --prefix src/native`、`npm run build:native`；Icarus 需另行安装，可用 `--iverilog D:/tools/iverilog/bin` 指定。显式路径无效会报错，不会悄悄改用其他安装。

`npm run cli -- <参数>` 也能调用。作为 Node 包链接后，入口名为 `svtools-agent`。原有 `bin/svtools.exe` 的参数和行为保持兼容，直接用于批量格式化的脚本无需迁移。

## 工程上下文

`--workspace` 默认是进程当前目录，与编辑器当前文件无关。CLI 发现工作区的 XPR 和 `.svtools/projects/*.json`；存在多个工程时返回候选，必须用 `--project` 消除歧义。无工程时扫描工作区 HDL，排除 `.git`、`.svtools`、`.Xil`、依赖和构建目录。

默认使用唯一的设计文件集；`--fileset` 可明确选择仿真文件集。仿真文件集包含唯一设计文件集的源码；有多个候选设计文件集时拒绝猜测。`--file` 必须属于所选工程。Icarus 目标来自明确的文件/top、工程 top，或唯一静态模块声明；不使用编辑器中另一个工程的 top。

`project inspect` 返回文件的 SHA-256、设计单元和源码行号。静态清单不负责展开宏或生成分支。XPR 的 M1 适配提取文件集和 top，宏和 include 目录通过 CLI 配置提供；完整 Vivado 编译环境适配属于 M2。

可在工作区 `.svtools/cli.json` 保存配置，也可用 `--config` 指向其他严格 JSON 文件。命令行覆盖同名字段，数组整体替换：

```json
{
  "schemaVersion": 1,
  "project": "top.xpr",
  "fileset": "sources_1",
  "top": "top",
  "includeDirs": ["src/include"],
  "defines": ["SIM", "WIDTH=8"],
  "standard": "2012",
  "iverilog": "D:/tools/iverilog/bin",
  "timeoutMs": 60000,
  "format": {"tabSize": 4, "instAlignPort": true}
}
```

未知配置字段、无效类型和超预算会明确失败。CLI 不读取编辑器设置或未保存缓冲区。重复 `--include` 和 `--define` 可分别指定目录与宏。

## 格式化与检查

`format` 默认只返回最多 32768 字符的预览，不写源码。`--check` 在有格式差异时退出 1；`--write` 才会写入，并在替换前复核源码和工程身份。除普通空格、Tab、CR、LF 外，其余字符值、数量和顺序必须保持；不满足时拒绝写入。只接受严格 UTF-8 输入。

`lint` 使用 Icarus 的空目标编译/详细化检查，不运行仿真。依赖补入限于当前工程中唯一可确定的模块文件，package 在引用方之前编译。宏、条件分支和语法的最终结果来自实际编译器；不支持的 SystemVerilog 特性仍可能报错，不能将 Icarus 的通过等同于功能验证完成。

每轮从源码快照运行，结束时复核当前工程/源码哈希；有变化则返回 `CONTEXT_CHANGED`，保留日志。日志与 manifest 保存到 `.svtools/agent/runs/`，记录工具版本、参数、输入摘要和结果。支持双引号字面量 include，宏 include 暂明确拒绝；头文件须包含在工作区 HDL/头文件、工程成员或显式 include 目录中。无法收录的 include 交由编译器报告，不读取快照外的实时源码。

## 后台任务

```powershell
node src/cli/main.js task start lint --workspace D:/project --file src/top.sv --top top
node src/cli/main.js task list --workspace D:/project
node src/cli/main.js task status <task-id> --workspace D:/project
node src/cli/main.js task logs <task-id> --workspace D:/project --offset 0 --limit 16384
node src/cli/main.js task cancel <task-id> --workspace D:/project
```

`task start` 返回 UUID，调用进程退出后后台工作进程仍可运行。目前只注册 `lint` 后台操作。取消通过所属任务的请求传递给已有进程树终止逻辑，不根据历史 PID 杀进程。工作进程非正常退出且没有可信结果时标记 `lost`，不会推测为通过。状态依次为 `queued`、`starting`（进程已接管任务并取得租约）、`running`（工程/源码上下文已固定、工具执行中）与终态 `succeeded`/`failed`/`cancelled`/`lost`；进入 `running` 之前的失败不会伪装成已执行的检查。

同一工作区的 CLI 和使用任务目录的插件工具任务共享两个外部进程槽，排队也可取消；同一文件的 CLI 格式化写入互斥。当前最多 16 个活动后台任务、128 份任务记录。任务记录在 `.svtools/agent/tasks/`，完成运行目录默认保留最近 5 次；已清理的日志返回 `ARTIFACT_EXPIRED`。任务记录需另行归档清理，未知或未完成记录不自动删除。

`task status` 成功表示查询完成。原操作是否成功要看 `data.result.status`，并核对 `data.sourceCurrent === true`。`false` 表示源码已变化，`null` 表示无法确认；两者都不能作为当前源码的通过证据。历史结果保持原始结论和版本身份。

## JSON 与资源合同

除了 `--help`、`--version`，stdout 仅输出一份 JSON，完整工具日志独立保存。`--json` 可显式传入，默认行为相同：

```json
{
  "apiVersion": "1",
  "requestId": "UUID",
  "operation": "lint",
  "status": "success",
  "context": {"id": "工程身份", "revision": "源码与配置SHA-256", "workspace": "绝对路径", "project": null, "fileset": "workspace", "top": "top"},
  "diagnostics": [],
  "artifacts": [{"kind": "log", "path": "绝对日志路径"}],
  "data": {"ok": true}
}
```

| 退出码 | 含义 |
|---|---|
| 0 | 请求成功；任务查询仍需检查内层结果 |
| 1 | 工具检查失败或格式化有差异 |
| 2 | 参数、配置、输入或依赖不可用 |
| 3 | 操作取消 |
| 4 | 资源占用、启动超时或工程版本失效 |

文件/设计单元列表支持 `--offset`、`--limit`，单页最多 200 项；日志单次最多 65536 字节，`--log-index` 选择某个日志。`nextOffset` 指示后续页。源码最多 4096 份、单文件 8 MiB、合计 64 MiB；目录扫描最多 50000 项、32 层。不会把完整日志或未来的大 VCD 塞入一个 JSON 响应。

Agent 使用入口见 [SV Tools Skill](../skills/svtools-agent/SKILL.md)。Vivado 运行/报告、架构视图、波形查询以及 MCP 当前不属于已实现命令；按 `doctor.data.capabilities` 发现实际接口。
