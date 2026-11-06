# M5 批 2 验证记录：FIFO / 多时钟试点

2026-11-05，Windows x64，Node.js 24.17.0，Icarus Verilog 13.0 (stable)。基线 `5ba3d9b`。记录覆盖批 2 范围（满空/并发/背压/单双边复位/公共沿），不宣称 4.2 发行验收完成。

## 受控试点（仓库内，可重跑）

```powershell
node scripts/verify-fifo-workflow.cjs --iverilog <icarus-bin>
```

设计侧为参数化灰码指针异步 FIFO（20ns/36ns 时钟对，LCM=180 周期性公共沿；复位联动异步断言）。验证侧 TB 持有独立数组队列 oracle：写提交=写沿采样 `en&&!full`，读提交=读沿采样 `en&&!empty`，逐读比对值与顺序；复位生效时按设计意图丢弃在途数据。`en_rd` 在单边读复位场景中**全程保持 1**（不做幸运避开）。

缺陷注入 `-DFIFO_DEFECT_NO_SYNC_RESET`：B 域灰码同步链不接复位（即 05_corelib `cdc_gray_bits` 同款缺陷）。

| 场景 | 仿真退出 | 判定 |
| --- | ---: | --- |
| baseline（背压满/排空/240 周期并发随机/单边读复位短脉冲/单边写复位/双边复位/公共沿全程） | 0 | `TC_PASS verified=220 fullEvents=1 emptyEvents=5 phantom=0` → 核验通过 |
| 注入缺陷（同一 TB、同一 oracle） | 0* | `PHANTOM_READ t=3069000`、`DATA_MISMATCH got=193 want=0`、`FALSE_NONEMPTY` → 验证失败，核验拒绝 |
| 退回修复后按原条件重跑 | 0 | `TC_PASS verified=220 … phantom=0` → 复验通过 |

*注错场景 vvp 退出码为 0（TB 以 `$display("TC_FAIL")` 计错而非 `$fatal`），判定取自 TC_FAIL 计数与工作流 `verification=failed`——证据合同以用例状态而非进程退出码为准。

危险窗口的机理：联动复位异步断言使源侧灰码寄存器立即清零，无复位的同步链要等 2 个读沿才被自然冲刷；**短于该冲刷的复位脉冲内释放**，链条仍挂旧灰码，`o_empty` 假 0，释放后首个读沿即幻影读。修复（链条随 B 域复位异步清零）不存在该窗口。

ΔCycle 检查对 `o_empty/o_full/i_rst_n_rd/i_rst_n_wr` 全窗口完整扫描：Icarus dumper 不倾倒同刻中间值，命中为 0（`recordingCompleteness=unknown`，仅说明该文件无记录）；QuestaSim 会倾倒 ΔCycle 中间值的场景由下节真机试点覆盖。

## 真机试点（05_corelib，QuestaSim→Icarus 对照）

标本：`D:\Workspace\FPGA\05_corelib` 的 `afifo`（tb_afifo，DEPTH=128，写 20ns/读 36ns，与受控试点同时钟对）。

- **修复前（QuestaSim 2024.1 波形，已有档案）**：`o_empty` 在单边读复位窗口 8856–8910ns 出现 54ns 假非空（`r_rd_ptr` 已异步清零而无复位的同步链仍持旧灰码）；270ns 公共沿处另有同刻 0→1→0 瞬态（组合比较器两侧同拍更新的正常收敛，非缺陷）。
- **修复（用户库 `src/cdc/cdc_gray_bits.sv`）**：B 域两级同步链补 `i_rst_n_b` 异步清零（此前该复位仅 REG_OUT=1 分支使用，afifo 配 REG_OUT=0）。该修复由用户库自行管理提交。
- **修复后（Icarus 13.0 重跑 tb_afifo）**：`err_cnt=0`；`o_empty` 全程 6 次跳变（234ns→0、9234ns→1、9630ns→0、27414ns→1、27882ns→0、45882ns→1），**所有复位窗口内保持 1、无假非空下陷**；`o_full` 306 次跳变无 X；`wave glitches` 对 `o_empty/o_full` 完整扫描 0 命中。

## 结论与剩余

批 2 通过：受控试点以确定性的危险窗口证明"无复位同步链"缺陷可被独立 oracle 捕获且修复后按原条件复验通过；真机标本的修复消除了复位窗口假非空。允许的组合瞬态（公共沿收敛）在两份记录中均被识别为非缺陷并留档。单 Agent 分阶段执行，多 Agent 独立性未在本批验证。剩余：批 3（真实 Vivado 闭环、四端到端场景、真实宿主验收、兼容矩阵）与发行机械。
