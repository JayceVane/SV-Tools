# 4.0 开发交接

最后更新：2026-10-14。当前里程碑为本地 `4.0.0-alpha7`，分支 `codex/refactor-v4`。

## 完成内容

- alpha7：显示格式归入子菜单，新增 FP64/FP32/TF32/BF16/FP16/FP8(E3M4)；二维 mem 共用浮点解码。
- E3M4 按用户确认采用偏置 3、全 1 指数表示 Inf/NaN。TF32 支持 19 位以及低 13 位为零的 32 位 RTL 容器约定，不代表 NVIDIA ABI，也不自动舍入 FP32。
- Shift 选择独立锚点，右键保留已选集合；混合位宽禁用不适用格式，支持命名/加入/解除分组与多行拖动。
- 菜单支持键盘、焦点恢复与屏幕边缘定位。数值取消矩形底色，随主题使用细轮廓，科学计数法缩略保留完整指数。
- 完整操作与编码见 `docs/WAVEFORM.md`，本轮文件清单和包核验见 `docs/V4_ALPHA7.md`。

- alpha6 重构标准补全：Verilog/SV 版本表、UVM 1.2/1800.2 官方公开目录、容错作用域与泛型成员解析、增量工程/include 索引、准确片段与替换区间。
- 覆盖 package/import、继承/可见性、TLM/factory、聚合类型、二维数组、覆盖率/约束/random、modport、命名连接及同文件类外实现。目录覆盖和语义边界分开，见 `docs/COMPLETION.md`。
- 补全交付完整清单、实测、包 SHA 和质量复核见 `docs/V4_ALPHA6.md`；历史记录继续保留。
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

- alpha7：92 个 JS、golden 36/36、Node 421/421、Rust 112/112；CLI/native 同步版本并重建，CLI 为 4.0.0-alpha7。
- alpha7 浮点测试包括 FP16/BF16 各 65536 编码、E3M4 256 编码穷举，FP64/FP32 独立 DataView 对照，TF32 双布局、NaN/X/Z/负零与无效容器。
- alpha7 真实浏览器与真实 VCD Worker 验收明暗主题、Shift 收缩、右键多选、混合位宽格式禁用、分组、状态恢复、二维 mem FP32 A/B、菜单键盘与边缘定位；无 console 警告/错误。
- 验收产物 `bin/waveform-acceptance/run-gbrTl4`；临时浏览器与 loopback 服务已关闭。
- 当前包 `bin/svtools-4.0.0-alpha7.vsix`；大小、SHA 与逐字节核验见 alpha7 记录。本轮未安装、推送、合并或发布。

- alpha6：85 个 JS、golden 36/36、Node 382/382、Rust 原 112 项集通过；CLI/native 重建到 alpha6。
- alpha6 真实 VS Code 1.141 宿主 22/22，接受补全后 Icarus 13 编译通过；外部 include 事件与未保存模型实测通过。
- alpha6 512 文件/十万行 Node provider 基准：冷索引 793ms、热 p95 9.53ms、单文件 3.90ms、脏文档 672ms；热请求零 I/O。此值不是 IDE 绘制延迟。
- alpha6 历史包 `bin/svtools-4.0.0-alpha6.vsix`，75 条目/2282176 字节，66 项字节一致性核验。
- alpha5 Rust 112/112；Rust 实现未改，alpha3 的 cargo check/fmt 检查继续保留。
- 最终 alpha5：70 个 JS 语法检查、golden 36/36、Node 300/300；包核验见 docs/V4_ALPHA5.md。
- alpha4 新增工具链合同 49：输出/日志 27，任务/编辑器边界 22；alpha5 新增 82 项工程管理/解析/停止合同。
- 波形合同 94：兼容解析 14、流式/存储 34、视图规则 22、宿主 11、memory 模型 8、memory 控制器 5。
- CLI 4.0.0-alpha5 重新构建并验证版本；alpha2 的 always 紧凑和幂等合同继续通过。
- alpha5 历史 VSIX：bin/svtools-4.0.0-alpha5.vsix；大小/SHA256/逐字节核验见 alpha5 交付记录。
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
继续由用户维护 3.x，分支和未提交状态以实时 Git 状态为准，不得复制或覆盖。全部开发写入本 worktree。
alpha1 本地提交869e4d1；alpha2 提交33ff207；alpha3 提交1cc5733；alpha4 提交7593816；alpha5 提交90e5168；alpha6 提交35770d3。
测试产生的临时浏览器服务器在交付前关闭，不作为运行依赖。

## 下一步

用户于 2026-10-14 确认：先完善当前版本，再增加新功能。Vivado IP 管理已写入 `docs/ROADMAP.md`，目前延期、未启动；待用户决定开始新功能后再实现。

1. 以 alpha7 VSIX 验证用户实际工程、多文件集、补全和浮点波形交互，优先修复实际使用反馈。
2. 用实际100–500MB RTL波形对照仿真/GTKWave，评估更多信号数和事件密度。
3. 下一轮统一 CompilePlan：源文件、include、宏、top、工作目录和引擎能力，避免 lint/仿真参数漂移。
4. 随后实现内容驱动的增量源码索引与有配置键的只读缓存；不要恢复共享可写 xsim.dir。
5. 审查4.0分支后走PR和发布流程，Marketplace使用其接受的预发行版本格式。
