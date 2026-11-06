---
name: svtools-vivado
description: 使用 SV Tools CLI 管理 Vivado 工程与实现运行：工程创建/加文件/set-top、综合实现运行状态、时序/资源/DRC 结构化报告与四轴证据判定（execution/inputs/regeneration/verification）、stale 失效规则。
---

# Vivado 工程与运行（M2）

入口技能 `svtools-agent` 提供 CLI 调用约定与 `doctor` 能力发现；本技能覆盖 Vivado 域。

`project create/add/set-top` 管理工程（创建幂等、加文件报告 added/already、两种 top 分开设置）；`vivado status` 查版本/器件/tops/runs；`vivado report timing|utilization|drc` 取结构化报告（默认 run：timing/drc 用 impl_1，utilization 用 synth_1，可用 `--run` 覆盖）；`vivado run` 作为后台任务执行 launch_runs + wait_on_run。

报告阶段未完成时返回 `VIVADO_SCRIPT_FAILED`，这表示未执行，不是零错误；不要把空数组当作"无问题证据"。

## 四轴证据（互不合并）

运行与报告的结果分四个证据轴：`execution`（是否跑完）、`inputs`（输入是否完整捕获）、`regeneration`（能否由源重建）、`verification`（验证做到哪一步，`acceptance=false` 时不得称为功能验证通过）。

- `stale=true`：源码/约束在该 run 之后变化，必须先重跑再引用。
- `stale=null`：没有该 run 的记录，不能当作新鲜。
- `drc` 只有 `checked=1` 的结果才代表本次检查。
- `vivado run` 状态含 ERROR 时返回 `VIVADO_RUN_FAILED`。

交付报告引用 Vivado 结论时逐轴说明；与 `svtools-delivery` 的证据身份约定（源码/TB/约束哈希、命令与运行产物）配合使用。
