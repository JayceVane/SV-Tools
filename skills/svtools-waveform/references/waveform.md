# 波形查询与调试取证

用于「仿真失败 → 定位首个错误窗口 → 修复 → 复验 → 取证」。CLI 的 `wave` 命令族直接查询 VCD/FST 事件数据，返回原始位值与整数 tick 字符串；不要把完整波形或大窗口原始数据整段交给模型。

## 查询约束

`wave signals --scope tb.dut` 对 VCD/FST 均按真实作用域筛选，包含所选实例的子层级；别名保留各自声明路径。

- 信号用完整层级路径最稳（`tb.u_dut.q`）；短名只有唯一命中才有效，同一 net 的 alias（如 `tb.clk` 与 `tb.u_dut.clk`）共享 id，不算歧义。未命中与多 id 歧义都会返回 `SIGNAL_NOT_FOUND` 与候选列表，不要猜名字重试。
- 时间输入裸整数 ticks 或带单位物理时间（`1250ns`）；物理单位要求 VCD 声明 timescale。输出时刻一律是整数 tick 字符串，浮点 JSON 不承载 fs 精度。
- `--from/--to` 含起点；分页游标 `next` 直接作为下一页 `--from`，不会重复边界事件。
- X/Z 是真实状态：时钟经过 X 不构成沿，位级沿在 X 之后回到 1 不算 rise；`contains-x/contains-z` 用于查未知态传播，不是错误本身，需结合驱动关系判断。
- 同一时间戳内的多次值变化（仿真器倾倒的ΔCycle 中间值，如同一 `#t` 下 0→1→0）按**终值**折叠展示与查询；对照原始 VCD 文本会看到中间值，以桶内末条为准，不要据此判显示错误。
- `--where` 支持信号对字面量与信号对信号比较（右值唯一命中信号名时自动切换）；多条 `--where` 为 AND。期望值应来自 TB/参考模型/协议规则，不得为了命中而放宽条件。

## 最小流程

```text
node <svtools-root>/src/cli/main.js wave signals --workspace <ws> --file sim/wave.vcd --query <关键词>
node <svtools-root>/src/cli/main.js wave sample --workspace <ws> --file sim/wave.vcd --clock tb.clk --signals dut.q,model.q --where "dut.q != model.q"
node <svtools-root>/src/cli/main.js wave values --workspace <ws> --file sim/wave.vcd --signals dut.q,dut.stage --at <首命中 tick>
node <svtools-root>/src/cli/main.js wave diff --workspace <ws> --file broken.vcd --against fixed.vcd --signals q
node <svtools-root>/src/cli/main.js wave export --workspace <ws> --file sim/wave.vcd --signals clk,q,model.q --out report --from <t1> --to <t2> --at <错误时刻> --format png
node <svtools-root>/src/cli/main.js wave export --workspace <ws> --file sim/wave.vcd --signals clk,q --from <t1> --to <t2> --at <错误时刻> --format layout
```

复验标准：修复后同一 `--where` 条件命中数为 0；`wave diff` 的 `firstDiff.t` 应落在注入缺陷开始传播的时钟沿，差异区间数与缺陷传播窗口一致。取证图必须有明确时间窗与游标时刻，不要导出全程波形冒充分析。

## 毛刺与异常沿定位剧本

适用：标志/控制信号出现窄脉冲或意外翻转，需判定「显示伪影 / 真实事件 / 设计缺陷」。提炼自异步 FIFO 空标志实战（完整判决见下）。

1. **分别检查稳定事件与同刻瞬态**：`wave changes` 给出疑点窗口的时间戳终值，`wave glitches` 给出已记录的同刻多次变化、前值与终值。不能因稳定事件表没有变化就断言“只是显示伪影”；录制过程可能已折叠中间值。保存两类结果，记录范围与证据限制。
2. **定时钟沿**：按 timescale 把疑点时刻换算回各时钟域，判定落在哪个域的哪种沿（正/负/沿间）。非采样沿上的变化只能来自组合逻辑或异步复位，驱动面直接减半。
3. **沿前后快照**：`wave values --at <t-1>` 与 `--at <t>` 取比较方程两侧输入（指针/灰码/使能/复位），看哪边变了哪边保持；计数类用二进制值核对到笔。
4. **判责**：真实且正确 → 行为性毛刺（例：异步 FIFO 两 burst 之间的短真空窗口，宽度=TB 检查+复位+首写同步开销，正常）；真实且错误 → 回驱动 RTL 定位（例：`cdc_gray_bits` B 域同步链缺复位，复位窗口内 stale 灰码造成假非空，复位释放后两个采样沿内存在幻影读风险）。
5. **复验取证**：修复后同场景重新仿真，`wave diff --against` 对比，`firstDiff.t` 应落在复位/修复生效沿；无缺陷注入的纯行为解释也要给出指针级证据表（谁等于谁、何时追平）。

实战判决示例：`o_empty` 在 8658ns 拉高疑为毛刺 → 事件表证实真实事件；`r_wr_ptr` 自 2710ns 冻结于 128，`r_rd_ptr` 于 8658ns 恰计到 128 → 两格雷码相等 = 真空，行为正确；全仿真视图下 396ns 空窗呈细刺状属正常视觉。

## 能力边界

- 每次 CLI 操作独立持有并释放 Rust 会话，在该次操作内复用解析结果；没有落盘索引缓存。解析期间文件变化返回 `SOURCE_CHANGED`，修改波形后需重新查询。
- 失败日志自动解析取窗尚未实现：`--at/--from/--to` 时刻由调用者从仿真日志、断言或 TB 输出提供。
- `wave export` 只有 document 黑白风格（与插件导出共用同一渲染器）；`--out` 必须在工作区内，只有 `--format layout` 可省略并默认写波形同目录。
- `wave export --format layout` 生成 v1 `.svwave.json`：信号声明身份 + 时间窗 + A/B 游标，供查看器复用，不含波形数据、不构成功能验证证据。省略 `--out` 时以波形名命名，打开同名 VCD/FST 会自动套用（至少一条声明命中才应用；0 命中静默保留默认视图，会覆盖上次会话状态）；文件缺失/损坏/超预算静默跳过。已有同名文件需 `--force` 覆盖；指定 `--out` 的布局需手动「加载布局」。
- `wave diff` 比较同名信号（路径+向量 range 配对），窗口事件总量超 200 万标记 `truncated`，此时缩小窗口而不是外推结论。
- QuestaSim 会把含 generate 块的实例作用域重复倾倒，同一信号出现两个符号 id（如 `T` 与 `T!`），子实例信号按名查询报 SIGNAL_NOT_FOUND；改用测试台顶层别名（同一 net 共享 id）、`wave signals --query` 条目或原始 VCD 符号表定位。
- VCD↔源码/电路的实例映射与驱动锥联动尚未交付；沿驱动关系定位源码用 `design arch` 的连接事实与 `wave signals --role` 的 RTL 匹配组合完成。波形查询是数据事实，不构成功能验证结论；复验通过以同一规则再次仿真的结果为准。


编辑器设置 `svtools.waveform.convertVcdToFst` 默认关闭。开启后仅对成功仿真的本轮 VCD 进行内嵌转换，转换验证成功才删除源文件；失败/取消保留原 VCD。默认覆盖同名 FST（`convertVcdToFstOverwrite`，原子替换），关闭后新输出用递增编号。该设置不改变 CLI 只读查询的输入，不会在查询时转换用户文件。FST 与 VCD 使用相同查询命令；读取时以实际文件内容识别格式。


## ΔCycle 记录诊断：wave glitches

```text
node <svtools-root>/src/cli/main.js wave glitches --workspace <ws> --file sim/wave.vcd --signals tb.clk,tb.rst_n,tb.dut.o_empty --from 200ns --to 400ns --limit 100 --max-values 32
```

检查数字信号，返回 `series[].findings`：`t`、`before`、`settled`、`recordedChanges`、`effectiveTransitions`、`sequence[{recordIndex,bits}]` 和 `hasUnknown`。`classification` 为 initialization（无前值的初始化活动）、returning（瞬态后回到前值）或 settling（多次变化后终值改变）。`recordIndex` 只是该信号该时刻的记录顺序，不是实际 delta cycle，也不能跨信号对齐。

`complete` 表示所选记录是否扫描完；每信号 `next` 可直接作为下一页闭区间 `--from`，完整同刻组不拆页。每信号最多返回 `--limit`（1..1000，默认 100）组；每组最多 `--max-values`（1..256，默认 32）条，截断时保留尾条真实序号并标 `sequenceTruncated`。命中数量在未完整扫描时只是下界（`matchedIsExact=false`）。单查询最多扫描 200 万条、译码预算 16 MiB；`stopReason` 明示结果数量/扫描/译码预算，超限不得记“无毛刺”。实数、字符串、event 不作电平毛刺判断。

`evidence.waveformSha256` 标识实际波形文件；`sourceBinding=unverified` 表示 CLI 没有证明它来自当前 RTL/某次运行，报告须结合实际仿真输入和日志建立关联。文件变化则拒绝结果。`semantics` 明确记录完整性未知、没有真实调度区编号/跨信号 delta 顺序/物理脉宽、查询不提供功能验收结论。

即使 FST 或转换产物无命中，也不能声称从未发生过中间变化；采集/转换可能已经折叠它们。同刻瞬态、实际非零宽度窄脉冲与物理器件毛刺需要分别判断。模块验证报告中的必需项与处置方式见 svtools-delivery 技能（[delivery.md](../../svtools-delivery/references/delivery.md)）。
