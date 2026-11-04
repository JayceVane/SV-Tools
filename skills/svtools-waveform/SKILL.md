---
name: svtools-waveform
description: VCD/FST 波形调试与取证：信号清单与方向匹配、时间点取值（含符号数）、跳变/沿/同刻瞬态（glitches）/窗口统计（stats）/合并时间线（timeline）/时钟采样 where 定位、A-B 差异复验与图像/CSV 导出；含毛刺定位剧本。
---

# 波形调试与取证（M4）

入口技能 `svtools-agent` 提供 CLI 调用约定；执行波形调试前，先读取 [references/waveform.md](references/waveform.md)（查询约束、最小流程、毛刺定位剧本、ΔCycle 诊断与能力边界）。

仿真失败后先用 `wave signals --file <vcd> [--query|--role]` 找到 DUT 与参考模型信号（方向标注要求唯一 RTL 匹配），再从失败日志/断言时刻用 `wave values --at <ticks|时间>` 取现场值（整数类另有 `signed` 补码解码）。

- 定位首个数据不一致：`wave sample --clock <clk> --signals a,b --where "a != b"`（右值唯一命中信号名即为信号对信号比较；字面量支持 `0x/0b/8'hA5`，`contains-x/contains-z` 查未知态传播）。
- 枚举窗口跳变与沿：`wave changes/edges`（向量 rise/fall 需 `--bit`）；错误窗口分诊用 `wave stats`（谁最活跃/谁进入未知态），多信号同刻叙事用 `wave timeline`。
- 同刻瞬态取证：`wave glitches`（原始记录级，见 references 的 ΔCycle 诊断节；模块验证报告的必需项）。
- 修复复验：重跑仿真后 `wave diff --file broken.vcd --against fixed.vcd`——`firstDiff` 是首个行为分叉点，差异计数应与注入缺陷的传播窗口一致；修复有效时同一 `--where` 条件命中数应为 0。
- 取证交付：`wave export --signals ... --from --to --at [--format png|svg|csv]`（document 黑白风格图像带 A/B 游标；CSV 为终值位串矩阵，`--out` 须在工作区内）。

时间输出一律整数 tick 字符串；每次查询独立持有会话，没有落盘索引缓存，改文件后旧查询结果不得引用。失败日志自动解析取窗尚未实现，`--at` 时刻由调用者提供。

波形结论进入模块验证报告时，ΔCycle 排查与证据身份要求见 `svtools-delivery` 技能。
