---
name: svtools-vivado
description: 使用 SV Tools CLI 管理 Vivado 工程、综合与实现运行、运行告警、时序/资源/功耗/DRC、IP Catalog 与 IP 参数、Block Design 结构和编辑。
---

# Vivado 工程、运行与资产

入口技能 `svtools-agent` 提供 CLI 调用约定。先用 `doctor` 确认当前安装支持所需命令，并用 `--project` 锁定目标 XPR。查询运行与报告时读[工程与运行命令](references/runs.md)。管理 IP 或编辑设计时读[资产命令与编辑规格](references/assets.md)。

- **查看原工程。** 先用 `vivado overview` 找到当前顶层综合和实现 run，按报告的 run 与阶段比较资源、Setup/Hold/Pulse Width、功耗和 DRC。用 `vivado messages --run <id> --severity critical-warning` 核对严重警告。按需用 `--query` 搜索消息 ID、步骤或正文，按 `nextOffset` 翻页，引用时保留 `file` 和 `line`。检查 `available`、`truncated` 和 `countsPartial` 后再总结条数。
- **核验一轮构建。** `vivado run` 启动隔离构建，使用 `task status/logs/cancel` 跟踪。用显式 `--run` 获取该轮 `vivado report timing|utilization|drc|power`，并检查 `runInfo`、`stale` 和产物。报告类型有各自默认 run，复杂工程优先从实际运行名选择。
- **管理 IP。** 用 `vivado ip catalog` 查完整 VLNV，用 `ip list/inspect` 找到工程里的文件、CONFIG 键、当前值和候选值。修改时用 `ip configure --spec` 提交 `key/before/value`，核对返回的实际值，再按需生成产物。
- **核验 Block Design。** 用 `vivado bd list/inspect` 获取文件、实例、信号和接口网络、地址段及 `stamp`。执行 `bd edit` 时使用该 `stamp` 作为 `--expect`，后续以新模型为准，再运行 `bd validate`。需要可重建交付件时使用 `bd export` 并记录 Tcl 产物。

建立或修改工程、IP、Block Design、生成产物会改变目标工程。用户只要求检查时使用读取和验证命令。原工程的概览、消息与隔离构建报告分别记录来源。只有对应 run 和检查有成功证据时才汇报通过。

## 四轴证据（互不合并）

运行与报告的结果分四个证据轴：`execution`（是否跑完）、`inputs`（输入是否完整捕获）、`regeneration`（能否由源重建）、`verification`（验证做到哪一步，`acceptance=false` 时不得称为功能验证通过）。

- `stale=true`：源码/约束在该 run 之后变化，必须先重跑再引用。
- `stale=null`：没有该 run 的记录，不能当作新鲜。
- `drc` 只有 `checked=1` 的结果才代表本次检查。
- `power` 引用总功耗、动态/静态功耗和置信度。组件的 `below` 表示检测阈值，引用为小于该值。
- `vivado run` 状态含 ERROR 时返回 `VIVADO_RUN_FAILED`；XSim 的运行错误与断言失败同样使任务失败，`ERROR` 关键字匹配大小写无关（`Error:` 也算），判定依据任务状态而非进程退出码。

交付报告引用 Vivado 结论时逐轴说明；与 `svtools-delivery` 的证据身份约定（源码/TB/约束哈希、命令与运行产物）配合使用。
