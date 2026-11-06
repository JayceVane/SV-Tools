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

`npm run cli -- <参数>` 也能调用。作为 Node 包链接后，入口名为 `svtools-agent`。从 4.2 起，Windows 独立格式化器的发布附件为 `svtools-format.exe`，批处理脚本升级时请更新可执行文件路径。

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

输入预算按类别独立，可在配置中用 `budget` 覆盖（单位 MiB，括号内为当前默认，待真实工程基准后定稿）：`textMiB`（64）文本总量、`textFileMiB`（8）单个文本、`initMiB`（64）初始化数据总量、`initFileMiB`（64）单个初始化文件、`binaryMiB`（2048）二进制输入总量、`binaryFileMiB`（2048）单个二进制、`cacheMiB`（8192）内容寻址缓存上限。二进制输入以流式复制并计算哈希，不占用文本预算；相同内容按哈希去重，只落一份缓存对象。缓存按最近成功构建的引用集合剪枝（构建目录保留最近 5 次，与磁盘总量分开管理）。

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
| `UNSUPPORTED_INCLUDE` | 宏 include 不在 M1 支持范围 | 改用双引号字面量 include，或在上下文外处理 |
| `SCAN_LIMIT`、`SOURCE_LIMIT` | 工作区或源码规模超出预算 | 缩小 `--workspace` 或用 `--project`/`--fileset` 收敛范围 |
| `TASK_LIMIT`、`TASK_RECORD_LIMIT` | 活动任务或任务记录达到上限 | 归档旧任务记录后重试 |
| `TASK_NOT_FOUND`、`INVALID_TASK_ID`、`LOG_NOT_FOUND` | 任务或日志序号不存在 | 检查 UUID 与 `--log-index` |
| `LOG_NOT_READY`、`ARTIFACT_EXPIRED` | 日志尚未生成或已被清理 | 先查 `task status`；历史日志不可恢复 |
| `VIVADO_SCRIPT_FAILED`、`VIVADO_EXEC_FAILED`、`VIVADO_NO_RESULT`、`VIVADO_RESULT_INVALID` | Vivado 脚本/进程失败、未执行到可输出阶段或结果不可解析 | 检查工程可打开与 run 阶段；不得当作空数据通过 |
| `VIVADO_RUN_FAILED` | run 状态为 ERROR/Failed/Aborted | 读日志定位失败阶段；不得当作完成 |
| `SNAPSHOT_UNSUPPORTED`、`VIVADO_CONTEXT_MISMATCH` | 工程存在尚不能隔离的依赖，或所选源文件集与run不符 | 按返回的文件/属性修正输入；不回退到未绑定的实时源码运行 |
| `ARTIFACT_INVALID` | 检查点已变化、越界或不可信 | 重新构建，不使用原来的输入绑定 |
| `SIGNAL_NOT_FOUND` | wave 信号名未命中或匹配多个信号 | 用 `data.candidates` 的完整层级路径重试；alias 共享 id 不算歧义 |
| `FILE_EXISTS` | 目标产物已存在且未加 `--force`（如布局导出） | 确认是否要覆盖；不要删除已有产物后重跑 |
| `VCD_PARSE`、`WAVE_FORMAT_UNSUPPORTED` | VCD 语法/编码损坏，或波形格式不受支持 | 修复重新仿真，或改用 VCD/FST；不得截断后继续 |
| `SERVICE_FAILED` | 未分类失败 | 读 `diagnostics` 与对应日志产物 |

## Vivado（M2）

`--project` 指向 `.xpr`；`--vivado`（安装根目录、bin 目录或 vivado.bat）或 CLI 配置中的 `vivado` 指定安装位置。

- `vivado status`：Vivado 版本、器件、sources/sim 两种 top、全部 run 的状态与进度。
- `vivado report timing|utilization|drc [--run synth_1|impl_1] [--max-paths n]`：
  - 默认 run：timing/drc 用 impl_1，utilization 用 synth_1；
  - `timing`：`paths[]`（name/startpoint/endpoint/slack/pathgroup/logic），数值为 JSON number，不可测属性为 `null`；
  - `utilization`：`summary[]` 分层行摘要与 `textBytes`；
  - `drc`：先执行本次 DRC 再读取违规对象，`checked=1`，`violations[]`（name/rule/severity）；
  - 报告优先打开该次隔离构建，附带 `runInfo`（id、状态、完成时间、revision、实际工程与工具版本）、`stale`/`staleInputs` 和 `configurationChanged`。源码、约束、top、器件、宏、include、文件属性或运行策略变化会使记录过期；没有可验证记录时 `stale=null`，不会把旧记录升级为当前证据。
  - 工程无法打开、run 阶段未完成或工具执行失败时分别返回 `VIVADO_SCRIPT_FAILED`、`VIVADO_EXEC_FAILED`，不以空数据代替未执行。
- `vivado run [--run synth_1|impl_1] [--jobs n]`：后台任务，用 `task status/logs/cancel` 管理。每轮从捕获的工程设置、源码、头文件与XDC建立独立副本并重新构建；实现run会先构建其综合依赖。只有明确完成且检查点通过校验时才写成功记录。运行前后复核原始输入，变化返回 `CONTEXT_CHANGED`；失败/取消不会继续引用上一次成功报告。

隔离构建位于 `.svtools/agent/vivado/builds/`，默认保留最近5次；原工程的run目录保持独立，`vivado status` 的 `agentRuns` 展示CLI构建。报告校验对应DCP的SHA-256，单份检查点上限512MiB；构建被清理返回 `ARTIFACT_EXPIRED`，检查点被替换返回 `ARTIFACT_INVALID`。输入、配置、源码副本映射与检查点身份记录在每轮 `manifest.json`，结果还提供完整 `inputFingerprint`，后台当前性判断包含初始化数据等非RTL输入。

当前隔离适配覆盖普通RTL、字面量include、显式数据文件、常规XDC与显式增量DCP。显式增量检查点（run 的 `IncrementalCheckpoint`，且 `AutoIncrementalCheckpoint` 不为 true）作为输入复制并流式计算 SHA-256，引用在隔离工程中重定位到不可变副本；run 输出的 DCP 只记入 `checkpoints`，不会混入 `inputs`，输入检查点条目带 `role=incremental-checkpoint`。无效、缺失或不存在的显式检查点分别返回 `SNAPSHOT_UNSUPPORTED`、`SOURCE_NOT_FOUND`，不会静默回退到完整重建。IP/BD、外部Tcl运行钩子、宏include及XDC中的动态外部读取暂返回 `SNAPSHOT_UNSUPPORTED`，不会声称这些依赖已被完整捕获。工具自动生成的增量缓存不复制，隔离副本的 `AutoIncrementalCheckpoint` 始终关闭。

没有Agent构建记录的既有工程仍可读取原run的报告，包括已有IP工程；此时返回 `stale=null`、`runInfo=null`，仅表示报告读取成功，不构成对当前源码的验证。输入隔离的限制针对新建可信构建绑定，不阻止已有报告查询。

`vivado run` 与 `vivado report` 的结果同时给出四个**互不合并**的证据轴：

- `execution`：工具是否真的跑完（run/status/runId/toolVersion）。`incremental` 单独记录增量事实：`requested`、`checkpoint`（sha256/size）、`applied`（本轮 runme 日志是否实际加载检查点）、`reused`（Cells 的 Current Reuse % 是否大于 0）、`directive`、`reuseMode`、`autoIncremental`、`reuse` 明细与 `evidence[]`；无法从日志确认时为 `null`，不把“请求了增量”当作“已复用”；
- `inputs`：输入是否被完整捕获（`completeness`、`fingerprint`、各类 `used`）；
- `regeneration`：能否由源配置重建（`source` 可重建；`artifact` 仅绑定产物；`unknown`）；
- `verification`：验证做到哪一步（`checks[]`、`acceptance`）。当前 `acceptance=false` 表示只有构建/检查，**不代表功能验证通过**。

Agent 不得把 `execution.success` 当作 `inputs.complete`，也不得把任一轴当作 `verification.acceptance`。

工程写操作：

- `project create --name <n> [--dir <d>] [--part <p>] [--top <t>] [--sim-top <t>]`：同名工程已存在时打开而非重建，返回 `created` 布尔与工程身份；
- `project add --source <file> [--source <file>...] [--target-fileset sources_1|constrs_1|sim_1]`：按扩展名推断目标文件集（`.xdc` → `constrs_1`，其余 `sources_1`），返回 `added`/`already` 绝对路径列表；文件不存在报 `SOURCE_NOT_FOUND`；
- `project set-top [--top <t>] [--sim-top <t>]`：分别写入 `sources_1`/`sim_1` 顶层，返回 `applied`。

三者返回的 `context` 是写操作完成后的重新解析结果，可直接作为后续命令的版本依据。

## 架构（M3，进行中）

```powershell
node src/cli/main.js design arch --workspace D:/project --top top
node src/cli/main.js design arch --workspace D:/project --top top --depth 1 --save arch-1
```

`design arch` 从已捕获文本建立隔离快照，字面量 include 改写到快照，源码位置映射回原文件；CLI 在返回/导出前复查上下文，变更时返回 `CONTEXT_CHANGED`。宏 include 返回 `UNSUPPORTED_INCLUDE`；未捕获的初始化数据不从实时工程补读。内置 Yosys 链接空模块：`read_verilog -sv` → `hierarchy -top <top>` → `proc` → `memory_collect` → `write_json`，不跑 `prep`/`opt`（避免优化掉未连接的实例）。只投影用户模块实例：顶层 `assign`/`always_ff`/存储产生的 `$` 单元不绘制为节点。架构图节点为顶层实例（空模块 blackbox 与已实现模块统一折叠为盒），顶层端口为边界节点（输入在左、输出在右），边为经顶层 `netnames` 合并的端口到端口总线连接；子模块内部实现与存储不入图。实例盒标签与端口位宽以实例参数覆盖后的连接为准；模块接口表保留声明默认值。模型是源级结构事实，不能当作综合、时序或功能验证证据。

`data` 关键字段：

- `schemaVersion`、`stage`（`source`）、`top{name,moduleId,file}`、`designId`、`modelSha256`（=`archSha256` 的明确映射）、`archSha256`、`contextRevision`、`sourceFiles[]{path,sha256}`（工作区源码/头文件的内容身份）；
- `modules[]`：架构用到的模块接口表，`id`、`name`（`$paramod\...` 还原为基础模块名+参数摘要）、`file`、`blackbox`、`empty`、`blackboxSource`（`yosys`|`structure`）、`parameters`、`ports[]{name,direction,width,source}`、`bundles[]`；
- `instances[]`：顶层实例表，`name`、`module`、`moduleId`、`implementation`（`blackbox`|`collapsed`）、`empty`、`blackboxSource`（`yosys`|`structure`）、`status`（`resolved`|`unresolved`）、`ports[]`、`bundles[]`、`source`；`implementation=blackbox` 既包括 Yosys blackbox 属性，也包括结构空模块（无 cells/processes/memories 且端口无别名/常量驱动，如 packed struct 端口的骨架模块），后者 `blackboxSource=structure`；纯 alias（`assign y=a`）、常量 assign、含 assign 表达式/always_ff 等逻辑的模块为 `collapsed`；
- `bundles[]`（模块/实例均含，additive，端口事实不变；**仅 opt-in 渲染使用**）：`name`、`prefix`、`direction`（`input`|`output`|`inout`）、`bits`、`members[]{name,width,direction}`。按端口名第一个 `_` 前的 token 建桶（如 `m`、`s0`、`s`、`ddr`），桶内先算公共前缀（去掉末尾 `_`）；**仅当前缀比桶键更长，或前缀与桶键等长且桶键长度≥2 时折叠**，否则桶内成员逐一保留为单成员端口（成员守恒）。因此 `m_axi_araddr`/`m_axi_rdata` 折叠为 `m_axi`，同桶的 `m_valid` 单独成束；`s0_*`/`m0_*`/`ddr_*` 正常折叠；单字母桶 `s_awaddr`/`s_wdata`（key=`s`，前缀=`s`）不折叠。成员方向混合时 `direction="inout"`；`clk_*`/`rst_*` 等时钟复位端口保持独立单成员，避免 `clk_sys`/`clk_pix` 误合并；
- `interfaces[]`：架构接口束，`id`、`from{kind,name}`、`to{kind,name}`、`direction`（`forward`|`bidirectional`|`connection`）、`bits`、`label`、`signals[]{name,width,direction}`、`fromPorts[]`/`toPorts[]`（端点实际端口名）。`connection` 表示共享网络相连，布局起点不代表电气驱动方向，其成员方向为 `unknown`，`bindings[]` 保存实际端口连接。已知方向的实例连接先合并双向对，再合并同源端口集合相同的扇出接口（`to.name` 用 `+` 连接多个实例）；实例↔边界按顶层端口前缀（如 `uart*`、`spi*`、`vin*`）聚合，`clk_in`/`rst_n_in`/`gpio` 等保留为独立束。`label` 优先取时钟/复位语义，其次成员信号公共前缀，否则用最多两个信号名摘要，长度不超过 48 字符；完整成员在 `signals[]` 与 SVG `<title>`；
- `unresolved[]`：工作区未声明的子模块，逐条带 `source`，不伪造端口表（图上为无端口盒，结构检查属 D2）；
- `graph`：`nodes[]`（`boundary` 顶层端口边界 / `instance` 实例盒，含 `label`、`ports`）、`edges[]`（`source`/`target`、`sourceNode`/`sourcePort`、`targetNode`/`targetPort`、`width`、`netNames`）与 `stats`（实例、边界、边与位宽统计、`depth`）；
- `checks[]`：结构诊断（见 `design check`），随架构数据一并返回并计入 `archSha256`；
- `limitations[]`：静态结构边界（未综合、不展开子层、IP/BD 等）。

`--depth` 当前固定按顶层实例投影（大于 1 尚未展开子层，在 `limitations[]` 说明）。`--save <name>` 把架构 JSON 写入 `.svtools/agent/design/<name>.json`，供后续 `design diff` 使用（同名快照直接覆盖）。实例间整体 inout 接口按共享网络生成 `direction=connection` 的架构连接，无须拆开成员；没有确定驱动方向的位仍计入 `graph.stats.ambiguousBits`，不当作电气方向已验证。Yosys 失败时保留 `.svtools/agent/design/runs/<uuid>` 任务目录作为日志 artifact，当前无自动淘汰。

`design scaffold --spec <json|file> [--out <dir>] [--force]` 按 schemaVersion=1 规格生成架构骨架（默认 `rtl/<top>.sv`）：`typedef struct packed {...} <type>_t;` 虚拟接口、只含 struct 端口的空模块、顶层 struct 总线 wire 与实例化连线。`--spec` 可为规格 JSON 文件路径（相对工作区解析）或内联 JSON（以 `{` 开头）；文件不存在返回 `INVALID_ARGUMENT` 并提示解析后的绝对路径。`--out` 必须是工作区内的目录（创建后按 realpath 复核，拒绝 symlink/junction 逃逸）；目标文件已存在且无 `--force` 时返回 `FILE_EXISTS`，`--out` 指向已有普通文件或非法路径返回 `INVALID_ARGUMENT`，写入失败返回 `DESIGN_FAILED`。主设备 `m_`/从设备 `s_` 命名是 Skill 建议而非门禁：不合建议时生成照常成功，并在 `data.suggestions[]` 返回 `{code:"PORT_NAMING",module,port,message}`，不产生 error diagnostics；其余规格问题返回 `INVALID_ARGUMENT`。规格结构：

默认接口级示例见 [architecture-interface-spec.json](../skills/svtools-design/assets/architecture-interface-spec.json)：每个模块用一个整体 inout packed struct 端口连接逻辑接口，成员内容和收发约定写入架构文档。需要按通道区分方向时，可参考 [architecture-spec.json](../skills/svtools-design/assets/architecture-spec.json)。`master/slave` 是接口角色，不等同于输出/输入。每个端口必须显式指定 `direction`，每个实例必须列出所有端口；显式 `null` 表示有意悬空并产生 `UNCONNECTED_PORT` 提示。生成前拒绝遗漏连接、已知方向的总线多驱动与无驱动输入；整体 inout 的成员方向不在这项检查范围内。

工作流：`design scaffold` 生成虚拟端口与空模块 → `design arch --top <top>` 检查结构 → `design render` 查看架构 → 按模块补充实现。时钟/复位独立声明，当前 scaffold 仅支持 struct 端口，板级顶层端口需要补充 RTL。架构图是源级结构事实，不得当作综合、时序或功能验证证据。

`design render` 用纯 Node 字符串生成自含 SVG（不依赖编辑器 DOM）：

```powershell
node src/cli/main.js design render --workspace D:/project --top top
node src/cli/main.js design render --workspace D:/project --top top --style presentation --out docs/arch --title "SoC 架构"
node src/cli/main.js design render --workspace D:/project --top top --fold-ports
node src/cli/main.js design render --workspace D:/project --top top --fold-ports --bundle-name s0=s0_axi --bundle-name m0=m0_axi
```

默认 `--style document`（黑白线稿，面向报告）：纯白背景、黑色描边、无彩色（黑白灰阶：#000/#111/#333/#fff/#f5f5f5 等 R=G=B）、无渐变/阴影；collapsed 实线 1.2px、blackbox 虚线（6,4）、unresolved 点线（2,3）并带文字角标；节点标题行浅灰底，端口/接口标签为黑色无衬线文本。`--style presentation`（别名 `ui`）保持电路视图深色展示主题，边界输入/输出/双向分别使用 theme input/output/inout 语义色。两种风格共用同一 ELK 布局坐标，仅替换配色与线型，并各自可确定性重渲染。

以 `graph.edges` 的真实端点绘制连线；只在成员落在同一显示端口时聚合，旧数据缺少信号边时回退到 `interfaces[]`。默认按接口粒度绘制：每个模块与边界接口表之间合成一个虚拟锚点和一条汇总线，原始 `ports[]` 和连接仍保存在 JSON。`--detail signals` 才使用逐行物理锚点；只有显式 `--fold-ports` 才把 blackbox 与 collapsed 实例按 `bundles[]` 折叠为虚拟接口端口：多成员束标签为 `<name>* (N bits)`、混合方向为菱形 inout，端口 `<title>` 列出全部成员名与位宽；`--bundle-name <prefix>=<display>` 仅与 `--fold-ports` 同时有效，用于覆盖显示名。虚拟端口仅改变展示，不改变 `ports[]`/`bundles[]` 或 RTL 事实，图例与 limitations 明确标注「前缀折叠展示，inout 仅为架构示意」。实例与边界盒带端口标签，同一个完整源端口的多目标连接经主干扇出（不同切片不合并）（`stats.junctions` 与 evidence `export.junctionCount`），接口标签为 `label (N bits)` 并保留完整成员名在 `<title>` 中。ELK layered 使用交叉最小化与直边优先布局，连线标签作为有尺寸的布局对象预留空间，层间距按标签与线路需要扩展；宽高比作为偏好，验收以节点/标签不重叠和真实端点为准。默认输出 `.svtools/agent/design/render/<top>-<archSha前8位>-<导出参数摘要>-<style>.svg`，`--out` 指定目录（与 scaffold 同一安全模型：必须是工作区内的目录，按 realpath 复核、拒绝 symlink/junction 逃逸，越界或非目录返回 `INVALID_ARGUMENT`，写入失败清理本轮创建的目录）；图例按画布宽度自动换行，画布高度随图例行数扩展。`data`/`artifacts[]` 返回 `{kind:"image",format:"svg",path,sha256,bytes,width,height}`。SVG 根内 `<metadata id="svtools-evidence">` 含 `designId`、`modelSha256`（`archSha256` 的明确映射）、`archSha256`、`contextRevision`、`top`、`sourceFiles[]{path,sha256}`、`layout.engine`、`export`（含 `style`、`junctionCount`、`bundled`、`bundleCount`），`design.render` 的 `data.evidence` 与之一致；节点与端口带 `data-model-id`；同一输入、同一 detail 和风格的两次渲染节点坐标与 SVG SHA-256 完全一致。文本均为可选中 `<text>`。

渲染预算：节点 2000、接口/连边 6000、端口 16384，超出返回 `DESIGN_LIMIT` 且不落盘。`--format svg|png`（默认 svg）：PNG 用内置 resvg（`bin/resvg.*.node`，随 VSIX 发布，无编辑器宿主）对同一份 SVG 做 2x 栅格化，`data` 返回 `scale`、像素尺寸与 `sourceSha256`（源 SVG 哈希）；栅格化组件缺失返回 `TOOL_NOT_FOUND`。中文依赖系统字体，文档建议先用 SVG。

同一前缀的一组顶层端口（例如 `ddr_addr`、`ddr_ba`、`ddr_dq`）默认合成一张边界接口表，列为信号、相对顶层的方向和位数。各行保留原始端口 ID 与方向缩写（`i` 输入、`o` 输出、`io` 双向；全词在悬停 `<title>`，避免箭头在左右两侧表中含义翻转），表外默认一条汇总线；时钟、复位和单成员信号继续独立显示。分组只来自完整名称前缀，不代表工具识别或验证了 DDR/AXI 协议。`stats.boundaryTables` 与 SVG 证据的 `boundaryTableCount` 给出表格数量，领域模型 `graph.nodes/edges` 保持原始事实。整体 inout struct 可作为架构虚拟接口，成员内容及收发约定由配套文档声明，不强制拆分请求响应。新模型的顶层 inout 同时记录逐端口 `interfaces[].bindings`，保证表内的双向行有精确锚点。`m_`/`s_` 名称可提示请求和响应放在相对的一侧，不改变端口的真实方向。

错误码：`AMBIGUOUS_MODULE`（工作区同名模块声明，`data.candidates[]` 给出全部 `{name,file,line}`，exit 2）、`MODULE_NOT_FOUND`（`--top` 未命中）、`DESIGN_LIMIT`（架构模块 4096、实例 20000、边 50000、结构诊断 5000；渲染节点 2000、接口 6000、端口 16384；超出不产出部分模型或半成品）、`TOOL_NOT_FOUND`（内置 Yosys 或 resvg 栅格化资源缺失）；单源文件 8 MiB 与源码总量属上下文预算，超限返回 `SOURCE_LIMIT`，不映射为 `DESIGN_LIMIT`；其余 Yosys/导出失败返回 `DESIGN_FAILED` 并附日志 artifact。

`design check --top <module>` 对同一架构数据做结构检查，逐条指认问题而不是只给位计数。诊断随 `design arch` 的 `data.checks[]` 一并返回，check 命令把它们提升为顶层 `diagnostics[]`：存在 error 级问题时 `status=failed` 且 exit 1（对齐 lint：检查完成但工程有结构错误），仅 warning 时 exit 0，`data.status` 为 `errors|warnings|clean`。诊断码与语义：

- `UNRESOLVED_MODULE`（error）：实例引用工作区未声明的子模块，按无端口盒展示；
- `UNDRIVEN_INPUT`（error）：input 端口未连接（悬空），或所在网络没有任何驱动（`netNames[]` 给出网络名）；
- `MULTI_DRIVER`（error）：同一网络被多个输出端口驱动，`drivers[]` 列出全部 `实例/端口`；
- `UNCONNECTED_PORT`（warning）：output/inout 端口未连接（常见有意悬空，不阻断）；
- `UNDRIVEN_OUTPUT`（warning）：顶层输出端口没有被任何实例驱动；
- `WIDTH_MISMATCH`（warning）：连接的网络窄于端口声明，其余位由工具隐式补常量（`connectedWidth`/`declaredWidth`/`implicitBits`）；宽 wire 连窄端口的截断在 Yosys 展开后不可见，不虚构报告。

网络分析只统计网络 bit：常量驱动（如 `.rst_n(1'b0)`）是值不是连接，不产生假边、假多驱动或假无驱动诊断。诊断带源码位置（`source{file,line,column}`，模块端口声明处）；同一源码的检查结果确定。结构检查不构成功能、时序或 CDC 验证。

`design diff --top <module> --baseline <save名|快照路径>` 比较基线快照与当前架构，报告补实现前后的结构差异。`--baseline` 先按 `design arch --save` 的快照名（`.svtools/agent/design/<name>.json`）解析，也接受工作区相对的快照文件路径；基线不存在、不是 schemaVersion=1/stage=source 快照或顶层与 `--top` 不一致均返回 `INVALID_ARGUMENT`。`data.diff` 按身份报告差异：实例按名称、模块与接口按归一化 id、顶层端口按名称、源文件按路径，各维度给出 `added/removed/changed`（`changed` 记录 `{field:{baseline,current}}`，端口按 `名称:方向:位宽` 签名比较）；空骨架（blackbox）变为已实现（collapsed）的实例单独列入 `implemented[]` 与 `summary.implementedInstances`。源码未变时 `data.status=unchanged`。diff 只报告差异，不判断好坏；基线身份（`name/path/archSha256`）随结果返回可追溯。

`design report --top <module> [--out <dir>] [--style document|presentation] [--title <t>]` 一次导出报告证据包（默认 `.svtools/agent/design/report/`）：同一架构的 `SVG`、`PNG`（2x 栅格化）、`architecture.json`（含 checks 的完整模型）、`architecture.md`（图 + 模块接口分配表 + 接口连接表 + 结构检查表 + 可追溯性）与 `report.json`（产物清单与哈希、导出参数、evidence）。Markdown 表格方向缩写与 SVG 边界接口表一致（端口 `i/o/io`；连接以端点 A 为视角 `o`/`io`/`bus`，`bus` 表示共享网络、成员方向未声明）。`--out` 与 render/scaffold 同一安全模型。结构存在 error 时报告仍生成（生成不等于结构合格），结论看 `data.checksSummary` 与 Markdown 检查表。

Agent 使用入口见 [SV Tools Skill](../skills/svtools-agent/SKILL.md)。架构建模（`design arch`）、架构图渲染（`design render`，SVG/PNG）、结构检查（`design check`）、架构比较（`design diff`）、报告证据包（`design report`）与波形查询（`wave` 命令族）已提供；MCP 尚未实现。按 `doctor.data.capabilities` 发现实际接口。

## 波形查询（M4）

```powershell
node src/cli/main.js wave signals --workspace D:/project --file sim/wave.vcd --query fifo --role output
node src/cli/main.js wave values --workspace D:/project --file sim/wave.vcd --signals tb.dut.q,tb.d --at 1250ns
node src/cli/main.js wave changes --workspace D:/project --file sim/wave.vcd --signals tb.dut.q --limit 200
node src/cli/main.js wave edges --workspace D:/project --file sim/wave.vcd --signal tb.dut.q --bit 0 --kind rise
node src/cli/main.js wave sample --workspace D:/project --file sim/wave.vcd --clock tb.clk --signals dut.q,model.q --where "dut.q != model.q"
node src/cli/main.js wave diff --workspace D:/project --file broken.vcd --against fixed.vcd --signals q
node src/cli/main.js wave export --workspace D:/project --file sim/wave.vcd --signals clk,q --out report --at 1250ns --format png
node src/cli/main.js wave export --workspace D:/project --file sim/wave.vcd --signals clk,q --from 100ns --to 200ns --at 125ns --format layout
```

所有命令都用 Rust（wellen）一次解析建立索引，不落盘缓存：实测 500 MiB/1463 万事件冷解析 353 ms，比原 JS 实现的缓存命中（211–290 ms 加载 + 5.7 s 首次解析）更快，因此 `.svtools/agent/wave/` 索引缓存已移除。解析期间文件变化返回 `SOURCE_CHANGED`；文件超过 2048 MiB 返回 `SOURCE_LIMIT`；格式不受支持或语法损坏返回 `WAVE_FORMAT_UNSUPPORTED`/`VCD_PARSE`。

时间输入接受裸整数 ticks 或带 `s/ms/us/ns/ps/fs` 单位的物理时间（物理单位要求 VCD 声明 timescale）；输出中的时刻一律为整数 tick 字符串（`t`、`from`、`to`、`next`），并列 `timescale` 与人类可读换算，浮点 JSON 不承载时标精度。信号名解析优先完整层级路径，其次唯一短名/后缀（同一 net 的 alias 共享 id，不算歧义），未命中或多个 id 歧义返回 `SIGNAL_NOT_FOUND` 并附 `candidates`。

- `wave signals`：信号清单（路径/短名/位宽/类型/变更计数），`--query` 子串、`--scope` 层级前缀、`--min-width/--max-width` 过滤；`--role input|output|inout|internal` 用工作区 RTL 做方向匹配（唯一层级匹配才标注，其余 unknown，附 `sourceRoleNote`）。
- `wave values --at`：时间点左闭取值，输出原始位串（`bits`，保留 X/Z）、位宽与解码值（≤64 位整数给 `value` 十六进制；整数类且宽度 2..=64、无 X/Z 时另给 `signed` 补码十进制）。
- `wave changes`：窗口内全保真跳变枚举（`--from/--to` 含起点，`(from,to]` 之外的完整窗口语义见 `next`），每信号 `limit`（≤10000）+ `total` + `next` 游标（下一页直接作 `--from`）。
- `wave edges`：`--kind any|rise|fall|x|z` 沿/未知态搜索；rise/fall 对向量信号需 `--bit`（LSB 起 0）位级投影，X 之后回到 1 不构成 rise；`--limit` 为命中数上限，超出时 `next` 续查。
- `wave sample`：按 `--clock` 的 `--clock-edge rise|fall|both` 沿采样多信号（时钟必须 1 位标量，X/Z 不构成沿）；`--where` 可重复且为 AND，条件为 `信号 op 字面量|信号`，op ∈ `==`/`!=`/`contains-x`/`contains-z`，字面量支持 `0b/0x/十进制/8'hA5`，右值唯一命中信号名时做信号对信号比较（首个数据不一致定位）；返回 `scannedEdges`/`matched`/`next`。
- `wave diff --against`：两份 VCD 同名信号（键为路径+向量 range）双指针对齐比较，默认全部交集或 `--signals` 子集；返回 `firstDiff`（首个差异时刻与双方值）、差异区间计数、`differingSignals` 与前 `--limit` 条差异；窗口事件总量超 200 万返回 `truncated=true`。
- `wave export`：时间窗波形图（document 黑白风格，无编辑器宿主；与插件导出共用同一渲染器）；`--at/--at-b` 画 A/B 游标（默认导出窗口首尾），`--format svg|png`（PNG 为 2x 内置 resvg 栅格化），`--out` 与 design render 同一目录安全模型；产物为 `artifacts[]`（SVG 必产，PNG 可选）。
- `wave stats`：多信号窗口统计（形态参考 pywellen `signal_get_statistics`）——每信号 `events`（折叠后事件数，与 changes 同口径）、`transitions`（终值实际跳变数，同值冗余不计）、`firstChange/lastChange`、`hasX/hasZ`、`windowRecords`；预算与分页同 glitches。`from=0` 时窗口首组的初值不算跳变。用于错误窗口分诊"谁最活跃、谁进入未知态"。
- `wave timeline`：多信号合并时间线（形态参考 pywellen `debug_build_timeline`）——只含终值跳变，按时间戳归组（同刻多信号变化同组返回，组内按路径排序），每条变化带 `before`（窗口首事件取窗口前一时刻终值，`from=0` 无前值为 null）；`--limit` 为返回组数上限（1..2000，默认 1000），`next` 是首个未返回组时刻、直接作下一页闭区间 `--from`，整查询预算统一截断保证不重不漏。
- `wave export --format csv`：数据矩阵导出（形态参考 pywellen `export_to_csv`）——行=窗口内任一信号终值跳变时刻，列=各信号该时刻终值位串（含 X/Z，证据口径；`from=0` 时首行前基线为空单元格）；行预算 10 万，超出 `truncated=true`；忽略游标参数，`--out` 与图像导出同一目录安全模型，产物计入 `artifacts[]`（kind `data`，含 sha256 与行数）。
- `wave export --format layout`：把 `--signals` 的声明身份（路径/范围/位宽）、`--from/--to` 时间窗与 A/B 游标写成 v1 `.svwave.json` 布局。省略 `--out` 时默认写波形同目录、以波形名命名（VCD/FST 去扩展名 + `.svwave.json`），波形本身须在工作区内，否则报 `INVALID_ARGUMENT`；查看器打开同名波形时自动套用，**至少一条声明可匹配才应用**，0 命中（同名巧合或声明已变化）静默保留默认视图，自动套用优先于上次会话的选择与游标。指定 `--out` 时仍受同一目录安全模型约束，但产物不会自动套用，需用查看器「加载布局」手动打开，`data.viewer` 会区分两种情形。`--title` 作文件名；同名文件已存在返回 `FILE_EXISTS`，加 `--force` 覆盖（覆盖前同样拒绝链接/别名目标）；产物计入 `artifacts[]`（kind `layout`，含 sha256 与 tracks 数）。声明重复导致无法唯一匹配的条目仍记为未匹配，不猜测。

波形查询返回原始位值与解码值，不改变或推断波形内容；密集区在 `changes` 中不降采样（与查看器像素窗口的 `dense` 标记不同）。失败日志解析取窗尚未实现，`--at` 时刻由调用者从仿真日志/断言提供。


## ΔCycle / 同一时间戳瞬态诊断

```powershell
node src/cli/main.js wave glitches --workspace D:/project --file sim/wave.vcd --signals tb.clk,tb.rst_n,tb.dut.o_empty --from 200ns --to 400ns --limit 100 --max-values 32
```

`doctor.data.capabilities` 包含 `wave.glitches`。该只读查询检查 VCD/FST 中实际记录的同刻多次变化，普通 `values/changes/edges/sample` 继续使用该时刻终值。`--signals` 必填；`--from/--to` 闭区间、可相等，要求安全整数 tick（或能准确换算的物理时间）；实数、字符串、event 返回 `INVALID_ARGUMENT`。

返回 `series[]`（path/width/windowRecords/scannedRecords/complete/next/stopReason/findings），每组 finding 包含 `t`、`before`、`settled`、`recordedChanges`、`effectiveTransitions`、`classification`（initialization/returning/settling）、`hasUnknown` 与 `sequence[{recordIndex,bits}]`。序号仅代表该信号该时刻的记录顺序，不是仿真调度区/真实 delta 编号，不能跨信号对齐，也不推导物理脉宽。

`--limit` 为每信号命中组上限 1..1000（默认 100）；`--max-values` 为每组返回条数 1..256（默认 32），超出时保留尾条并标 `sequenceTruncated`。整个查询最多扫描 200 万条、数字值译码预算 16 MiB，按完整同刻组消费预算。未完成时 `complete=false`、`truncated=true`、`matchedIsExact=false`；每信号 `next` 是下一页可直接使用的闭区间 `--from`，`stopReason` 为 result-limit/query-record-budget/query-decode-budget。整组超出译码预算时须调整对象或记录未覆盖，重复相同请求不会推进。

结果包含 `evidence.waveformSha256` 和文件字节数；查询和哈希期间变化返回 `SOURCE_CHANGED`。SHA-256 仅标识文件，`sourceBinding=unverified` 不证明当前 RTL 产生该波形，需由报告的实际仿真输入/命令/运行记录建立关联。

`semantics.recordingCompleteness=unknown`、`absenceProvesNoGlitches=false`、`acceptance=false` 明确证据边界：采集/转换可能折叠中间值。查询成功和零命中都不是功能、CDC、时序或物理无毛刺证明；有命中也不自动判 RTL 缺陷。模块验证报告必须包含该项的信号/窗口、扫描完整性、逐项处置、波形身份与限制，详见 [设计与验证交付约定](../skills/svtools-delivery/references/delivery.md)。

底层按信号原始事件索引读取，避免稳定值折叠抹掉记录证据：[wellen Signal API](https://docs.rs/wellen/0.25.7/wellen/struct.Signal.html)。


## 架构计划与模块交接

`design plan --spec` 生成架构报告和模块任务；`design tasks` 只读查询；`design claim/submit/return/review` 按 revision 和令牌变更；`design evidence` 校验当前候选的编译/仿真/ΔCycle 证据；`design plan-report --force` 更新同名 Markdown 报告。详细命令、输入格式与信任范围见 [设计工作流](DESIGN_WORKFLOW.md)。这些命令不自动执行仿真，不调用 Yosys/Vivado。插件原工程侧栏新增只读“设计进展”，通过 `svtools.design.planFile` 选择计划。
