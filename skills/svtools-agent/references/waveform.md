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
```

复验标准：修复后同一 `--where` 条件命中数为 0；`wave diff` 的 `firstDiff.t` 应落在注入缺陷开始传播的时钟沿，差异区间数与缺陷传播窗口一致。取证图必须有明确时间窗与游标时刻，不要导出全程波形冒充分析。

## 毛刺与异常沿定位剧本

适用：标志/控制信号出现窄脉冲或意外翻转，需判定「显示伪影 / 真实事件 / 设计缺陷」。提炼自异步 FIFO 空标志实战（完整判决见下）。

1. **定性真伪**：`wave changes` 拉疑点窗口内该信号的全部事件。查看器像素级毛刺在事件表里不存在；存在则逐条记 `(t, 值)`。同一时间戳多信号齐变时回原始 VCD 看桶内容（`awk` 按 `#时间戳` 切段），多字符符号 id 不能裸眼猜。
2. **定时钟沿**：按 timescale 把疑点时刻换算回各时钟域，判定落在哪个域的哪种沿（正/负/沿间）。非采样沿上的变化只能来自组合逻辑或异步复位，驱动面直接减半。
3. **沿前后快照**：`wave values --at <t-1>` 与 `--at <t>` 取比较方程两侧输入（指针/灰码/使能/复位），看哪边变了哪边保持；计数类用二进制值核对到笔。
4. **判责**：真实且正确 → 行为性毛刺（例：异步 FIFO 两 burst 之间的短真空窗口，宽度=TB 检查+复位+首写同步开销，正常）；真实且错误 → 回驱动 RTL 定位（例：`cdc_gray_bits` B 域同步链缺复位，复位窗口内 stale 灰码造成假非空，复位释放后两个采样沿内存在幻影读风险）。
5. **复验取证**：修复后同场景重新仿真，`wave diff --against` 对比，`firstDiff.t` 应落在复位/修复生效沿；无缺陷注入的纯行为解释也要给出指针级证据表（谁等于谁、何时追平）。

实战判决示例：`o_empty` 在 8658ns 拉高疑为毛刺 → 事件表证实真实事件；`r_wr_ptr` 自 2710ns 冻结于 128，`r_rd_ptr` 于 8658ns 恰计到 128 → 两格雷码相等 = 真空，行为正确；全仿真视图下 396ns 空窗呈细刺状属正常视觉。

## 能力边界

- 每次 CLI 操作独立持有并释放 Rust 会话，在该次操作内复用解析结果；没有落盘索引缓存。解析期间文件变化返回 `SOURCE_CHANGED`，修改波形后需重新查询。
- 失败日志自动解析取窗尚未实现：`--at/--from/--to` 时刻由调用者从仿真日志、断言或 TB 输出提供。
- `wave export` 只有 document 黑白风格（与插件导出共用同一渲染器）；`--out` 必须在工作区内。
- `wave diff` 比较同名信号（路径+向量 range 配对），窗口事件总量超 200 万标记 `truncated`，此时缩小窗口而不是外推结论。
- QuestaSim 会把含 generate 块的实例作用域重复倾倒，同一信号出现两个符号 id（如 `T` 与 `T!`），子实例信号按名查询报 SIGNAL_NOT_FOUND；改用测试台顶层别名（同一 net 共享 id）、`wave signals --query` 条目或原始 VCD 符号表定位。
- VCD↔源码/电路的实例映射与驱动锥联动尚未交付；沿驱动关系定位源码用 `design arch` 的连接事实与 `wave signals --role` 的 RTL 匹配组合完成。波形查询是数据事实，不构成功能验证结论；复验通过以同一规则再次仿真的结果为准。


编辑器设置 `svtools.waveform.convertVcdToFst` 默认关闭。开启后仅对成功仿真的本轮 VCD 进行内嵌转换，转换验证成功才删除源文件；失败/取消保留原 VCD。该设置不改变 CLI 只读查询的输入，不会在查询时转换用户文件。FST 与 VCD 使用相同查询命令；读取时以实际文件内容识别格式。
