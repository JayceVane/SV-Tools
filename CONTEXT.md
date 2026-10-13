# 4.0 开发交接

最后更新：2026-10-13。当前里程碑为本地 `4.0.0-alpha5`，分支 `codex/refactor-v4`。

## 完成内容

- 独立 worktree：`C:\Users\JayceVane\.codex\worktrees\svtools-v4\02_svtools`。
- alpha1 完成格式化职责重构与扩展模块分离，见 `ARCHITECTURE.md` 和 `docs/V4_CHANGES.md`。
- alpha2 修复 always 显式事件头的多余水平空白；inlineCompact 关闭时保持原文。
- 波形采用单文件 Worker 流式解析、typed 分块及值压缩，页面按可见行/时间窗查询。
- 支持 A/B 游标 Δt、真实边沿导航、检索、进制、模拟量、排序分组及布局恢复。
- 密集区明确标记；原始读值和边沿查询不受显示降采样影响。关闭/取消释放 Worker。
- 同名总线切片按独立行标识保存，alias 仍共享事件数据；详情见 `docs/WAVEFORM.md`。
- alpha3 增加 VCD 存储器视图：字数组和两层索引矩阵，共享 A/B、分页、进制、地址定位、变化标记及单元加入波形。
- 真实 Icarus 会将某些二维数组展平，按文件实际索引展示；无法从缺少维度的 VCD 还原源码形状。
- FSDB 开发已按用户要求取消，没有新增转换器或 FSDB 编辑器入口。
- alpha4 工具链修复假成功，任务目录与取消覆盖所有阶段；按触发文档维护依赖诊断。
- 进程日志带背压落盘，摘要/单行/诊断/输出通道有预算；早期错误与依赖流式捕获。
- 编译/仿真失败不会自动打开旧或部分波形；不同资源配置探测的迟到结果不污染缓存。
- alpha5 修复异步工程树不发数据事件导致空面板；稳定 ID/父节点支持可靠刷新和展开。
- 工程选择成为面板/编辑器的共同来源；真实文件集成员、受保护源码区间和有界层级预览分工。
- 引用节点与成员分离，过期节点不回退修改另一文件集；写操作在执行前重新核对 XPR。
- 面板/编辑器共用忙碌与停止边界，独立 Tcl/报告目录；工程 xelab 使用实际 top 与所选集成员，自定义仿真集贯穿 xsim Tcl。
- 本轮交付和完整文件清单见 `docs/V4_ALPHA5.md`；工具链预算见 `docs/TOOLCHAINS.md`。
- alpha2/3 的波形与存储器交付记录继续保留。

## 验证

- alpha5 Rust 112/112；Rust 实现未改，alpha3 的 cargo check/fmt 检查继续保留。
- 最终 alpha5：70 个 JS 语法检查、golden 36/36、Node 300/300；包核验见 docs/V4_ALPHA5.md。
- alpha4 新增工具链合同 49：输出/日志 27，任务/编辑器边界 22；alpha5 新增 82 项工程管理/解析/停止合同。
- 波形合同 94：兼容解析 14、流式/存储 34、视图规则 22、宿主 11、memory 模型 8、memory 控制器 5。
- CLI 4.0.0-alpha5 重新构建并验证版本；alpha2 的 always 紧凑和幂等合同继续通过。
- 当前 VSIX：bin/svtools-4.0.0-alpha5.vsix；大小/SHA256/逐字节核验见 alpha5 交付记录。
- VSIX 的所有运行 JS/CSS 和 native 与构建逐字节一致，无 VCD/开发依赖/日志混入。
- 浏览器使用真实 Worker 查看 100 MiB 语料并验证百万事件缩放、500ns 跳转、精确边沿、65条信号；Canvas 保持视口大小。
- FIFO 生成语料验证明暗主题、A=585ns/B=620ns/Δt=35ns、模拟量、搜索与布局恢复，无 console 错误。
- alpha3 用真实 Icarus memory 语料验收矩阵、signed 值、X/Z、未 dump、游标、单元加入波形和明暗主题，无 console 错误。
- alpha4 真实 Icarus 编译/vvp/VCD、xvlog/xelab 验证成功；xvlog 依赖错误和 Vivado ERROR+exit0 均正确失败。报告 bin/toolchain-native-validation/run-roXGGr/report.json。
- alpha5 真实 VS Code 1.141 宿主 8 项工程面板合同通过；报告 bin/vivado-host/run-6fc9ce3cba92406c93d94e8e2419cff0/host-report.json。
- alpha5 真实 Vivado/XSim 4 项工程动作通过，含非首模块 top 与 sim_custom；报告 bin/vivado-panel-native/run-w9HnnU/report.json。

## 性能与限制

Windows Node 24.17.0，生成后热缓存，64 unique signals + alias（clock/256-bit bus/sparse controls/real）。
100 MiB 新加载 1.092s、RSS峰183.6MiB；旧加载4.006s、RSS峰1120MiB。
500 MiB 新加载5.329s、RSS峰485.4MiB，宿主最大额外延迟13.39ms。
16 id/1200px 视口含JSON序列化66.66ms/2.51MB。报告见 bin/vcd-benchmark/report.json。

默认每会话2GiB文件/512MiB compact store/256MiB Worker JS heap，查询响应32MiB。
事件密度影响内存，不保证所有同尺寸文件；超限明确报错。时间戳限非负安全整数。
真实 VS Code 宿主工程面板验收已完成，格式化/波形完整宿主交互和其它平台仍待实机验收；
公开夹具不代替完整用户工程/IP工作流。未推送或发布。阶段日志与仿真产物保留会积累磁盘占用；xvlog 只保留
同任务增量缓存，跨任务复用需内容/工具/配置键。FSDB 保持取消。

## 环境与开发边界

本机工具路径及命令见已忽略 ENVIRONMENT.md；原 `D:\Workspace\FPGA\02_svtools`
仍在 feat/3.5，保留原有 M src-rust/index.d.ts。全部开发写入本 worktree。
alpha1 本地提交869e4d1；alpha2 提交33ff207；alpha3 提交1cc5733；alpha4 提交7593816；alpha5 以 git log -1 为准。
测试产生的临时浏览器服务器在交付前关闭，不作为运行依赖。

## 下一步

1. 安装 alpha5 VSIX 并重载窗口，确认用户实际工程/IP/多文件集流程和波形交互。
2. 用实际100–500MB RTL波形对照仿真/GTKWave，评估更多信号数和事件密度。
3. 下一轮统一 CompilePlan：源文件、include、宏、top、工作目录和引擎能力，避免 lint/仿真参数漂移。
4. 随后实现内容驱动的增量源码索引与有配置键的只读缓存；不要恢复共享可写 xsim.dir。
5. 审查4.0分支后走PR和发布流程，Marketplace使用其接受的预发行版本格式。
