# 波形 CLI 参考

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
- `wave export --format layout`：把 `--signals` 的声明身份（路径/范围/位宽）、`--from/--to` 时间窗与 A/B 游标写成 v1 `.svwave.json` 布局。省略 `--out` 时默认写波形同目录、以波形名命名（VCD/FST 去扩展名 + `.svwave.json`），波形本身须在工作区内，否则报 `INVALID_ARGUMENT`；查看器打开同名波形时自动套用，**至少一条声明可匹配才应用**，0 命中（同名巧合或声明已变化）静默保留默认视图，自动套用优先于上次会话的选择与游标。实际文件位于波形同目录且同名时，`data.viewer` 提示自动套用。用 `--out` 改目录或用 `--title` 改名时，可在查看器用「加载布局」手动打开。`--title` 作文件名；同名文件已存在返回 `FILE_EXISTS`，加 `--force` 覆盖（覆盖前同样拒绝链接/别名目标）；产物计入 `artifacts[]`（kind `layout`，含 sha256 与 tracks 数）。声明重复导致无法唯一匹配的条目仍记为未匹配，不猜测。

波形查询返回原始位值与解码值，不改变或推断波形内容；密集区在 `changes` 中不降采样（与查看器像素窗口的 `dense` 标记不同）。失败日志解析取窗尚未实现，`--at` 时刻由调用者从仿真日志/断言提供。


## 同一时间戳的 ΔCycle 诊断

```powershell
node src/cli/main.js wave glitches --workspace D:/project --file sim/wave.vcd --signals tb.clk,tb.rst_n,tb.dut.o_empty --from 200ns --to 400ns --limit 100 --max-values 32
```

`doctor.data.capabilities` 包含 `wave.glitches`。该只读查询检查 VCD/FST 中实际记录的同刻多次变化，普通 `values/changes/edges/sample` 继续使用该时刻终值。`--signals` 必填；`--from/--to` 闭区间、可相等，要求安全整数 tick（或能准确换算的物理时间）；实数、字符串、event 返回 `INVALID_ARGUMENT`。

返回 `series[]`（path/width/windowRecords/scannedRecords/complete/next/stopReason/findings），每组 finding 包含 `t`、`before`、`settled`、`recordedChanges`、`effectiveTransitions`、`classification`（initialization/returning/settling）、`hasUnknown` 与 `sequence[{recordIndex,bits}]`。序号仅代表该信号该时刻的记录顺序，不是仿真调度区/真实 delta 编号，不能跨信号对齐，也不推导物理脉宽。

`--limit` 为每信号命中组上限 1..1000（默认 100）；`--max-values` 为每组返回条数 1..256（默认 32），超出时保留尾条并标 `sequenceTruncated`。整个查询最多扫描 200 万条、数字值译码预算 16 MiB，按完整同刻组消费预算。未完成时 `complete=false`、`truncated=true`、`matchedIsExact=false`；每信号 `next` 是下一页可直接使用的闭区间 `--from`，`stopReason` 为 result-limit/query-record-budget/query-decode-budget。整组超出译码预算时须调整对象或记录未覆盖，重复相同请求不会推进。

结果包含 `evidence.waveformSha256` 和文件字节数；查询和哈希期间变化返回 `SOURCE_CHANGED`。SHA-256 仅标识文件，`sourceBinding=unverified` 不证明当前 RTL 产生该波形，需由报告的实际仿真输入/命令/运行记录建立关联。

`semantics.recordingCompleteness=unknown`、`absenceProvesNoGlitches=false`、`acceptance=false` 明确证据边界：采集/转换可能折叠中间值。查询成功和零命中都不是功能、CDC、时序或物理无毛刺证明；有命中也不自动判 RTL 缺陷。模块验证报告必须包含该项的信号/窗口、扫描完整性、逐项处置、波形身份与限制，详见 [设计与验证交付约定](../../svtools-delivery/references/delivery.md)。

底层按信号原始事件索引读取，避免稳定值折叠抹掉记录证据：[wellen Signal API](https://docs.rs/wellen/0.25.7/wellen/struct.Signal.html)。

## 错误码与判定

| code | 含义 | Agent 应做 |
|---|---|---|
| `SIGNAL_NOT_FOUND` | wave 信号名未命中或匹配多个信号 | 用 `data.candidates` 的完整层级路径重试；alias 共享 id 不算歧义 |
| `VCD_PARSE`、`WAVE_FORMAT_UNSUPPORTED` | VCD 语法/编码损坏，或波形格式不受支持 | 修复重新仿真，或改用 VCD/FST；不得截断后继续 |
