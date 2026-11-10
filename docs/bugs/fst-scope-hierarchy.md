# FST 层级筛选为空与仿真入口只认 VCD

识别特征：FST 已成功加载、信号路径带模块前缀，但层级下拉框只有“全部层级”。原生 `waveOpen` 返回 `scopes: []`，变量也没有可验证的 `scopeId`。相同设计的 VCD 则正常。

根因已由真实 FST 复现：元数据只调用 VCD 文本头解析器，而 FST 没有该文本头；wellen 的真实层级没有投影到共用元数据。现在 FST 直接遍历 ScopeRef，记录真实父下标、空实例和变量所属作用域。实例名含点时仍是单个真实节点，不通过字符串切分推测父级；VCD 保留原声明表以兼容重复作用域和数组声明。

同时核验了 Icarus 仿真入口：产物快照已能发现 FST，但自动打开、文件选择、默认文件关联及文本标签关闭条件只接受 `.vcd`，默认路径预测也仍为 `dump.vcd`。现在查看器入口接受 VCD/FST，仿真前保护 `dump.fst` 及无后缀输出的补后缀候选，完成后自动打开新 FST。FST 保留原输出位置。

本机 Icarus 实测 `-fst`、`-fst-speed`、`-fst-space` 均默认输出 `dump.fst`；`-dumpfile=capture` 补成 `capture.fst`；显式格式参数按最后一个生效。工具链测试覆盖参数及环境变量选择 FST。

回归：`test/wave_service_test.js` 使用 `test/fixtures/waveform/hierarchy.sv` 生成的真实 FST/VCD，经原生模块和 worker 进入真实 client，验证三层实例、含点名称、空实例、面板下拉和 CLI scope 筛选。新回归在旧原生模块上失败。仿真路径与自动打开见 `test/toolchain_task_test.js`，默认文件关联见 `test/waveform_host_test.js`。


## 转换保真补测：逐位 dump 与纯事件尾时域

VCD → FST 交叉测试进一步确认两个读取边界：wellen 对乱序逐位声明贪心合并，FST 没有 VCD 原声明表，原实现无法重新展开，`tb.data[5]` 等查询出现 `SIGNAL_NOT_FOUND`；只含 event 的文件末尾 `#20` 没有值变化时，FST header 的 end_time 为 20，但最后一个事件在 5，原实现只取时间表尾导致视图缩成 5。

现在复用已有 fst-reader 补读 FST 原始 packed 位声明，沿用共用的按实际 msb/lsb 展开；普通 mem[addr] 不按名字猜成总线。FST 最大时间使用 header 与时间表尾的较大值，不重复 event 来伪造尾部事件。逐位声明统计提前建表，避免对每条变量重新扫描整张声明表。

`test/waveform_conversion_test.js` 通过独立 writer/reader 复现并覆盖乱序、非零位号、纯事件尾时域，以及显式 dumpoff/on 的 X/Z。57 项转换、CLI 查询与 worker 会话相关测试通过；完整回归结果以本次交付为准。
