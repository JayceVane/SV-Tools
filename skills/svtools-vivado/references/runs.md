# Vivado 工程与运行 CLI

`--project` 指向 `.xpr`；`--vivado`（安装根目录、bin 目录或 vivado.bat）或 CLI 配置中的 `vivado` 指定安装位置。

- `vivado status`：Vivado 版本、器件、sources/sim 两种 top、全部 run 的状态与进度。
- `vivado report timing|utilization|drc|power [--run <id>] [--max-paths n]`：
  - timing、DRC 和 power 默认使用 `impl_1`，utilization 默认使用 `synth_1`。以工程实际运行名覆盖默认值。
  - `timing`：`paths[]`（name/startpoint/endpoint/slack/pathgroup/logic），数值为 JSON number，不可测属性为 `null`；
  - `utilization`：`summary[]` 分层行摘要与 `textBytes`；
  - `drc`：先执行本次 DRC 再读取违规对象，`checked=1`，`violations[]`（name/rule/severity）；
  - `power`：从选定运行的检查点执行 `report_power`，返回 `power`（总量 `total`、动态 `dynamic`、静态 `static`、`confidence` 和组件 `components[]`，单位 W）。组件只报告阈值时给出 `below`，原始报告路径随 `artifacts` 返回。`source` 区分 `project` 原工程和 `agent-build` 隔离构建。
  - 报告优先打开该次隔离构建，附带 `runInfo`（id、状态、完成时间、revision、实际工程与工具版本）、`stale`/`staleInputs` 和 `configurationChanged`。源码、约束、top、器件、宏、include、文件属性或运行策略变化会使记录过期；没有可验证记录时 `stale=null`，不会把旧记录升级为当前证据。
  - 工程无法打开、run 阶段未完成或工具执行失败时分别返回 `VIVADO_SCRIPT_FAILED`、`VIVADO_EXEC_FAILED`，不以空数据代替未执行。
- `vivado run [--run synth_1|impl_1] [--jobs n] [--bitstream]`：后台任务，用 `task status/logs/cancel` 管理。`--bitstream` 需要 `impl_*` run（默认 `impl_1`），以 `-to_step write_bitstream` 启动，并在证据 `verification.checks` 中记录 `bitstream`。每轮从捕获的工程设置、源码、头文件与XDC建立独立副本并重新构建；实现run会先构建其综合依赖。只有明确完成且检查点通过校验时才写成功记录。运行前后复核原始输入，变化返回 `CONTEXT_CHANGED`；失败/取消不会继续引用上一次成功报告。

隔离构建位于 `.svtools/agent/vivado/builds/`，默认保留最近5次；原工程的run目录保持独立，`vivado status` 的 `agentRuns` 展示CLI构建。报告校验对应DCP的SHA-256，单份检查点上限512MiB；构建被清理返回 `ARTIFACT_EXPIRED`，检查点被替换返回 `ARTIFACT_INVALID`。输入、配置、源码副本映射与检查点身份记录在每轮 `manifest.json`，结果还提供完整 `inputFingerprint`，后台当前性判断包含初始化数据等非RTL输入。

当前隔离适配覆盖普通RTL、字面量include、显式数据文件、常规XDC与显式增量DCP。显式增量检查点（run 的 `IncrementalCheckpoint`，且 `AutoIncrementalCheckpoint` 不为 true）作为输入复制并流式计算 SHA-256，引用在隔离工程中重定位到不可变副本；run 输出的 DCP 只记入 `checkpoints`，不会混入 `inputs`，输入检查点条目带 `role=incremental-checkpoint`。无效、缺失或不存在的显式检查点分别返回 `SNAPSHOT_UNSUPPORTED`、`SOURCE_NOT_FOUND`，不会静默回退到完整重建。IP/BD、外部Tcl运行钩子、宏include及XDC中的动态外部读取暂返回 `SNAPSHOT_UNSUPPORTED`，不会声称这些依赖已被完整捕获。工具自动生成的增量缓存不复制，隔离副本的 `AutoIncrementalCheckpoint` 始终关闭。

没有Agent构建记录的既有工程仍可读取原run的报告，包括已有IP工程；此时返回 `stale=null`、`runInfo=null`，仅表示报告读取成功，不构成对当前源码的验证。输入隔离的限制针对新建可信构建绑定，不阻止已有报告查询。

`vivado run` 与 `vivado report` 的结果同时给出四个**互不合并**的证据轴：

- `execution`：工具是否真的跑完（run/status/runId/toolVersion）。`incremental` 单独记录增量事实：`requested`、`checkpoint`（sha256/size）、`applied`（本轮 runme 日志是否实际加载检查点）、`reused`（Cells 的 Current Reuse % 是否大于 0）、`directive`、`reuseMode`、`autoIncremental`、`reuse` 明细与 `evidence[]`；无法从日志确认时为 `null`，不把“请求了增量”当作“已复用”；
- `inputs`：输入是否被完整捕获（`completeness`、`fingerprint`、各类 `used`）；
- `regeneration`：能否由源配置重建（`source` 可重建；`artifact` 仅绑定产物；`unknown`）；
- `verification`：验证做到哪一步（`checks[]`、`acceptance`）。当前 `acceptance=false` 表示只有构建/检查，**不代表功能验证通过**。

Agent 不得把 `execution.success` 当作 `inputs.complete`，也不得把任一轴当作 `verification.acceptance`。

- `vivado tcl --file <script> [--cwd <dir>]`：在独立批处理进程中执行任意 Tcl，不打开也不保存工程，除非脚本自行 `open_project`。返回退出码和完整日志；非零退出返回 `VIVADO_EXEC_FAILED`。这类脚本的副作用由脚本自身负责。

## 原工程概览与消息

- `vivado overview` 返回当前综合/实现 run、顶层运行状态和 `runMessages`。现有报告按 `reports.utilization.synthesis/implementation`、`reports.timing/power/drc` 返回，并标注运行名、阶段和文件。时序数据包含报告中可取得的 Setup、Hold、Pulse Width 指标。缺失报告时该项缺省。查询使用原工程现有产物，报告的 `stale` 取自 Vivado 运行状态。
- `vivado messages [--run <id>] [--severity error|critical-warning|warning|info|status] [--query <text>] [--offset n] [--limit n]` 读取原工程顶层 run 的 `runme.log`。每条含 `id`、`step`、`text`、`file` 和原日志 `line`。默认每页 50 条，可指定 1 至 200 条并用 `nextOffset` 续查。未选 run 时查询全部顶层 run。无日志时 `available=false`。超出索引预算时 `truncated=true`，只统计了文件前部时 `countsPartial=true`。


## 错误码与判定

| code | 含义 | Agent 应做 |
|---|---|---|
| `VIVADO_SCRIPT_FAILED`、`VIVADO_EXEC_FAILED`、`VIVADO_NO_RESULT`、`VIVADO_RESULT_INVALID` | Vivado 脚本/进程失败、未执行到可输出阶段或结果不可解析 | 检查工程可打开与 run 阶段；不得当作空数据通过 |
| `VIVADO_RUN_FAILED` | run 状态为 ERROR/Failed/Aborted | 读日志定位失败阶段；不得当作完成 |
| `SNAPSHOT_UNSUPPORTED`、`VIVADO_CONTEXT_MISMATCH` | 工程存在尚不能隔离的依赖，或所选源文件集与run不符 | 按返回的文件/属性修正输入；不回退到未绑定的实时源码运行 |
| `ARTIFACT_INVALID` | 检查点已变化、越界或不可信 | 重新构建，不使用原来的输入绑定 |
