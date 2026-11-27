# SV Tools 通用 CLI 参考

## 调用与工具

```powershell
node src/cli/main.js doctor
node src/cli/main.js project list --workspace D:/project
node src/cli/main.js project inspect --workspace D:/project --project top.xpr --fileset sources_1
node src/cli/main.js format --workspace D:/project --file src/top.sv
node src/cli/main.js lint --workspace D:/project --file src/top.sv --top top
```

`doctor` 返回实际可用的格式化模块和 Icarus 路径/版本。缺少原生模块时，先按仓库构建方式运行 `npm ci`、`npm ci --prefix src/native`、`npm run build:native`；Icarus 需另行安装，可用 `--iverilog D:/tools/iverilog/bin` 指定。显式路径无效会报错，不会悄悄改用其他安装。

`npm run cli -- <参数>` 也能调用。作为 Node 包链接后，入口名为 `svtools-agent`。从 4.2 起，Windows 独立格式化器的发布附件为 `svtools-format.exe`，批处理脚本升级时请更新可执行文件路径。

## 工程上下文

`--workspace` 默认是进程当前目录，与编辑器当前文件无关。CLI 发现工作区的 XPR 和 `.svtools/projects/*.json`；存在多个工程时返回候选，必须用 `--project` 消除歧义。编辑器工程树里的"选择工程"和"刷新"只是编辑器状态，CLI 一律用 `--project` 显式指定，不跟随编辑器的活动工程。无工程时扫描工作区 HDL，排除 `.git`、`.svtools`、`.Xil`、依赖和构建目录。

默认使用唯一的设计文件集；`--fileset` 可明确选择仿真文件集。仿真文件集包含唯一设计文件集的源码；有多个候选设计文件集时拒绝猜测。`--file` 必须属于所选工程。Icarus 目标来自明确的文件/top、工程 top，或唯一静态模块声明；不使用编辑器中另一个工程的 top。

`project inspect` 返回文件的 SHA-256、设计单元和源码行号。静态清单不负责展开宏或生成分支。XPR 提供文件集、top 与可解析的宏和 include 目录。CLI 配置可以补充工程上下文。

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

输入预算按类别独立，可在配置中用 `budget` 覆盖（单位 MiB，括号内为默认值）：`textMiB`（64）文本总量、`textFileMiB`（8）单个文本、`initMiB`（64）初始化数据总量、`initFileMiB`（64）单个初始化文件、`binaryMiB`（2048）二进制输入总量、`binaryFileMiB`（2048）单个二进制、`cacheMiB`（8192）内容寻址缓存上限。二进制输入以流式复制并计算哈希，不占用文本预算；相同内容按哈希去重，只落一份缓存对象。缓存按最近成功构建的引用集合剪枝（构建目录保留最近 5 次，与磁盘总量分开管理）。

## 格式化与检查

`format` 默认只返回最多 32768 字符的预览，不写源码。`--check` 在有格式差异时退出 1；`--write` 才会写入，并在替换前复核源码和工程身份。除普通空格、Tab、CR、LF 外，其余字符值、数量和顺序必须保持；不满足时拒绝写入。只接受严格 UTF-8 输入。

`lint` 使用 Icarus 的空目标编译/详细化检查，不运行仿真。依赖补入限于当前工程中唯一可确定的模块文件，package 在引用方之前编译。宏、条件分支和语法的最终结果来自实际编译器；不支持的 SystemVerilog 特性仍可能报错，不能将 Icarus 的通过等同于功能验证完成。`--engine xvlog` 改用 Vivado 的 `xvlog`：返回带 file/line/column 的 `diagnostics[]`，有编译错误时结果为 `failed`，仍然不运行仿真。

每轮从源码快照运行，结束时复核当前工程/源码哈希；有变化则返回 `CONTEXT_CHANGED`，保留日志。日志与 manifest 保存到 `.svtools/agent/runs/`，记录工具版本、参数、输入摘要和结果。支持双引号字面量 include，宏 include 暂明确拒绝；头文件须包含在工作区 HDL/头文件、工程成员或显式 include 目录中。无法收录的 include 交由编译器报告，不读取快照外的实时源码。

## 仿真、详细化与生成

```powershell
node src/cli/main.js simulate --workspace D:/project --file tb/tb_top.sv --top tb_top --engine iverilog
node src/cli/main.js simulate --project top.xpr --file tb/tb_top.sv --top tb_top --engine xsim
node src/cli/main.js elaborate --workspace D:/project --file src/top.sv --top top
node src/cli/main.js rtl instantiate --workspace D:/project --file src/top.sv --out src/inst.sv
node src/cli/main.js rtl testbench --workspace D:/project --file src/top.sv --out tb/tb_top.sv
node src/cli/main.js circuit trace --workspace D:/project --file src/top.sv --top top --signal mid --direction loads --depth 2
```

`simulate` 依次编译、详细化并运行 testbench。`--engine iverilog` 使用 Icarus（注入其 Cygwin 运行环境），`--engine xsim` 使用 xvlog/xelab/xsim。`--source` 补充源文件，`--include`/`--define`/`--standard` 覆盖上下文。返回编译/详细化/运行日志、波形路径（VCD/FST 或 xsim 产物）和 `workDir`；编译、详细化、运行失败分别返回 `SIM_COMPILE_FAILED`、`SIM_ELABORATE_FAILED`、`SIM_FAILED`。

`elaborate` 只做 xvlog + xelab 的静态详细化，没有快速/完整之分：编辑器里的「顶层详细化」与「详细化」在 CLI 是同一条命令。`rtl` 复用扩展的原生生成器（需要 `bin/svtools.<platform>.node`），默认不修改源码，只有 `--out` 才写文件。`circuit trace` 用静态 RTL 网表追踪顶层模块内信号的 drivers/loads，输出 `nets/cells/selections/boundaries`；子模块内部信号需要层次路径，当前只解析顶层模块。

## 后台任务

```powershell
node src/cli/main.js task start lint --workspace D:/project --file src/top.sv --top top
node src/cli/main.js task list --workspace D:/project
node src/cli/main.js task status <task-id> --workspace D:/project
node src/cli/main.js task logs <task-id> --workspace D:/project --offset 0 --limit 16384
node src/cli/main.js task cancel <task-id> --workspace D:/project
```

`task start` 返回 UUID，调用进程退出后后台工作进程仍可运行。`task start lint` 和 `vivado run` 可启动后台操作。取消通过所属任务的请求传递给已有进程树终止逻辑，不根据历史 PID 杀进程。工作进程非正常退出且没有可信结果时标记 `lost`，不会推测为通过。状态依次为 `queued`、`starting`（进程已接管任务并取得租约）、`running`（工程/源码上下文已固定、工具执行中）与终态 `succeeded`/`failed`/`cancelled`/`lost`；进入 `running` 之前的失败不会伪装成已执行的检查。

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

文件/设计单元列表支持 `--offset`、`--limit`，单页最多 200 项；日志单次最多 65536 字节，`--log-index` 选择某个日志。`nextOffset` 指示后续页。源码最多 4096 份、单文件 8 MiB、合计 64 MiB；目录扫描最多 50000 项、32 层。不会把完整日志或大体量波形 塞入一个 JSON 响应。

## 错误码与判定

失败响应的 `diagnostics[0].code` 是稳定判定依据；`message` 只供人读，不要用文本匹配分支。

| code | 含义 | Agent 应做 |
|---|---|---|
| `INVALID_ARGUMENT`、`CONFIG_INVALID`、`INVALID_WORKSPACE` | 参数、配置或工作区不合法 | 修正输入后重试，不要猜测替代值 |
| `AMBIGUOUS_PROJECT`、`AMBIGUOUS_FILESET`、`AMBIGUOUS_SOURCESET`、`AMBIGUOUS_TOP` | 存在多个合法上下文 | 用返回的 `candidates` 显式指定；不要借用其他工程或编辑器的选择 |
| `FILE_NOT_IN_CONTEXT`、`SOURCE_NOT_FOUND` | 目标文件不属于所选工程/文件集，或源文件不存在 | 先确认 `project`/`fileset` 与路径，再重试 |
| `TOOL_NOT_FOUND`、`TOOL_UNAVAILABLE`、`VIVADO_NOT_FOUND` | 依赖缺失或无法启动 | 未执行，不是失败结论；安装或指定路径后重跑 |
| `CONTEXT_CHANGED` | 源码/配置在本轮期间变化，结果失效 | 重新运行；旧结果不得作为当前证据 |
| `FORMAT_INVARIANT`、`UNSAFE_PATH`、`SOURCE_CHANGED` | 写入被安全规则拒绝 | 不要绕过或手工拼接写入 |
| `RESOURCE_BUSY`、`WORKER_START_TIMEOUT` | 资源被占用或后台启动超时 | 稍后重试；先检查是否有未清理的并发任务 |
| `UNSUPPORTED_INCLUDE` | 宏 include 超出源码快照支持范围 | 改用双引号字面量 include，或在上下文外处理 |
| `SCAN_LIMIT`、`SOURCE_LIMIT` | 工作区或源码规模超出预算 | 缩小 `--workspace` 或用 `--project`/`--fileset` 收敛范围 |
| `TASK_LIMIT`、`TASK_RECORD_LIMIT` | 活动任务或任务记录达到上限 | 归档旧任务记录后重试 |
| `TASK_NOT_FOUND`、`INVALID_TASK_ID`、`LOG_NOT_FOUND` | 任务或日志序号不存在 | 检查 UUID 与 `--log-index` |
| `LOG_NOT_READY`、`ARTIFACT_EXPIRED` | 日志尚未生成或已被清理 | 先查 `task status`；历史日志不可恢复 |
| `FILE_EXISTS` | 目标产物已存在且未加 `--force`（如布局导出） | 确认是否要覆盖；不要删除已有产物后重跑 |
| `SERVICE_FAILED` | 未分类失败 | 读 `diagnostics` 与对应日志产物 |
