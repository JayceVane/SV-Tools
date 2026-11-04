# 波形查询与调试取证

用于「仿真失败 → 定位首个错误窗口 → 修复 → 复验 → 取证」。CLI 的 `wave` 命令族直接查询 VCD/FST 事件数据，返回原始位值与整数 tick 字符串；不要把完整波形或大窗口原始数据整段交给模型。

## 查询约束

`wave signals --scope tb.dut` 对 VCD/FST 均按真实作用域筛选，包含所选实例的子层级；别名保留各自声明路径。

- 信号用完整层级路径最稳（`tb.u_dut.q`）；短名只有唯一命中才有效，同一 net 的 alias（如 `tb.clk` 与 `tb.u_dut.clk`）共享 id，不算歧义。未命中与多 id 歧义都会返回 `SIGNAL_NOT_FOUND` 与候选列表，不要猜名字重试。
- 时间输入裸整数 ticks 或带单位物理时间（`1250ns`）；物理单位要求 VCD 声明 timescale。输出时刻一律是整数 tick 字符串，浮点 JSON 不承载 fs 精度。
- `--from/--to` 含起点；分页游标 `next` 直接作为下一页 `--from`，不会重复边界事件。
- X/Z 是真实状态：时钟经过 X 不构成沿，位级沿在 X 之后回到 1 不算 rise；`contains-x/contains-z` 用于查未知态传播，不是错误本身，需结合驱动关系判断。
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

## 能力边界

- 每次 CLI 操作独立持有并释放 Rust 会话，在该次操作内复用解析结果；没有落盘索引缓存。解析期间文件变化返回 `SOURCE_CHANGED`，修改波形后需重新查询。
- 失败日志自动解析取窗尚未实现：`--at/--from/--to` 时刻由调用者从仿真日志、断言或 TB 输出提供。
- `wave export` 只有 document 黑白风格（与插件导出共用同一渲染器）；`--out` 必须在工作区内。
- `wave diff` 比较同名信号（路径+向量 range 配对），窗口事件总量超 200 万标记 `truncated`，此时缩小窗口而不是外推结论。
- VCD↔源码/电路的实例映射与驱动锥联动尚未交付；沿驱动关系定位源码用 `design arch` 的连接事实与 `wave signals --role` 的 RTL 匹配组合完成。波形查询是数据事实，不构成功能验证结论；复验通过以同一规则再次仿真的结果为准。


编辑器设置 `svtools.waveform.convertVcdToFst` 默认关闭。开启后仅对成功仿真的本轮 VCD 进行内嵌转换，转换验证成功才删除源文件；失败/取消保留原 VCD。该设置不改变 CLI 只读查询的输入，不会在查询时转换用户文件。FST 与 VCD 使用相同查询命令；读取时以实际文件内容识别格式。
