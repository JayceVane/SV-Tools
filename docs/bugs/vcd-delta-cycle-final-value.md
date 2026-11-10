# VCD 同一时间戳多次变化被显示成持续电平

识别特征：波形中某信号在 T 时刻拉高后长期保持，但比较方程两侧输入（如 `empty = gray(rd)==gray(wr_sync)`）明显不满足；`wave changes` 在同一 `t` 返回两条**值相同**的事件，`wave values` 在其后任意时刻返回Δ脉冲的首值。原始 VCD 里同一 `#T` 桶内该信号有两次变化（如 `16` 后 `06`）。QuestaSim 会倾倒仿真ΔCycle 中间值，且当两个时钟域的沿重合（如 20ns/36ns 在 LCM=180ns 对齐点）时组合比较器天然产生同刻 0→1→0 瞬态。

根因：wellen 把同一时间戳的多次变化存为同一 `DataOffset` 组（`elements>1`，注释明示 delta cycles 语义），组末才是该时刻稳定值；本项目所有查询原先调用 `get_value_at(&offset, 0)` 恒取组内**第一条**（Δ中间值）。于是 `values/changes/edges/sample/window/diff/edge` 与 `changeCount` 全部口径漂移：脉冲值被当成时刻终值，`changes` 对重复时间索引各解析一次又都得到首值（表现为两条相同事件），`edges` 还会伪造 rise/fall 沿。

修复：九处取值统一改为 `get_value_at(&offset, offset.elements.saturating_sub(1))`；`changes_for` 与 diff 的 `event_series` 对折叠后完全相同的相邻同刻条目 `dedup()`；`count_signal_events` 流式按"与前一个 TimeTableIdx 不同"计数。展示、采样与查询从此一律为"该时刻稳定值"语义，与 GTKWave 一致。

回归：`test/wave_service_test.js`「ΔCycle：同一时间戳多次变化折叠为终值，不产生幻影沿与虚高计数」——`#100 1!`+`#100 0!` 断言 changes 仅含终值 0、values@100/150/199 为 0、rise 沿只在 200、changeCount=3。真实语料：QuestaSim tb_afifo 的 `o_empty` 在 270ns（读写时钟公共沿）有 0→1→0 瞬态，修复前查看器把它显示成从 270ns 持续高电平到 8856ns，与 gray 不相等的事实矛盾；修复后 234ns–8658ns 全程正确为低。
