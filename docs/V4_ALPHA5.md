# 4.0.0-alpha5：工程管理面板修复

2026-10-13。4.0 开发在 `C:\Users\JayceVane\.codex\worktrees\svtools-v4\02_svtools`，
分支 `codex/refactor-v4`。原 `D:\Workspace\FPGA\02_svtools` 的 3.x 未修改。

## 使用

安装 `bin/svtools-4.0.0-alpha5.vsix` 并重载 VS Code 窗口；已有安装包不会随 worktree
源码变更自动更新。点击活动栏芯片图标进入工程管理。

- 标题栏“选择工程”列出工作区 .xpr，也可浏览工作区外的文件。显式选择持久化，面板
  与编辑器加入/移出/仿真命令使用同一工程。自动发现按固定顺序选择，并保持有效工程；
  不会因为新增文件悄悄切换。所选工程删除时显示原因，可重新选择。
- 工程根显示名称、路径和器件；各文件集按 XPR 的真实名称列出成员、数量与 top。
  单击文件或模块打开源码，单击工程根打开 .xpr。未加入的文件单独分组，右键加入
  直接使用该文件；文件集右键或标题栏也可选择文件加入。
- 文件成员与“层级预览”分开，预览按单元源码引用向下展开。仿真引用设计集源码时
  标为引用节点，可打开/详细化，管理成员需到实际文件集。注释、字符串、同文件另一
  模块的引用不会混入当前模块；循环、重复定义、缺失源码和超预算都有提示。
- “全部展开”使用真实父节点，稳定 ID 保持刷新前后的节点身份；一次最多展开 500
  分组，收起使用 VS Code 内置按钮。首次加载、手动刷新、XPR 与源码创建/更改/删除、
  保存和工作区变化均能更新数据；并发刷新合并为当前请求与最新待处理请求。
- 工程操作分组提供详细化、综合、报告、布局布线和 Bitstream。多个有 top 的仿真集
  会明确询问目标集；工程 xelab 使用实际 top 与该集/设计成员，无需修改默认 lint 引擎。
- 运行或选择/准备阶段显示忙碌状态，重复写操作与切换工程被拒绝；标题栏停止按实际
  xelab/Vivado 任务路由，取消选择器并阻止迟到对话框提交。过期节点不回退操作另一
  文件集，执行前重新检查工程/成员，写后按 XPR 事实确认结果。

管理命令每次写独立 `actions/action-*/` Tcl，报告每次写独立 `reports/<run>/report-*/`
目录，不覆写正在执行的脚本或打开旧报告。自定义 SimulationSrcs 名称贯穿设置 top、
compile order、custom Tcl 与 `launch_simulation -simset`。日志和产物保留策略沿用 alpha4。

## 数据与验收边界

XPR 读取支持完整 UTF-8 XML 1.0、属性顺序/空白/单双引号、标准实体与数值 Unicode，
普通相对路径以工程目录解析，兼容 $PPRDIR 和 file URL。半写/损坏 XML 明确报错并可
刷新恢复；不加载 DTD/外部实体，不进行完整 Vivado schema 校验，写入仍经官方 Tcl。

预览最多索引 3000 个源码文件，单文件 4MiB、累计 64MiB，8 路读取且单文件增长也有
流读取上限。层级深度 32、合计 5000 节点，达到限制只显示一条截断提示；实际文件
清单仍保留。工作区未加入文件枚举最多 2000，工程发现最多 1000。源码预览不替代
Vivado 对宏/generate/IP/参数的详细化；工程 xelab 的成员范围已限定，XPR 的完整宏、
IP/库、编译属性与运行配置尚未统一为 CompilePlan。常规运行仍使用 synth_1/impl_1。
工作区外工程的 GUI 改动可手动刷新；不依赖全工作区索引补入其它工程。

## 验证与交付

- 最终打包回归：70 个 JS 文件语法检查，golden 36/36，Node 300/300。
  新增 82 项：XPR 44，树/选择/模型 19，编辑器/面板命令 18，工程 xelab 停止 1。
  包括首次空读取、刷新/关闭竞态、节点身份、右键文件、多个工程/文件集、过期节点、
  GUI 改集/删目标集、共享忙碌、停止准备/浏览/编译、预览字节与高扇出节点硬预算。
- Rust 112/112；native/CLI 重新构建，CLI 报告 `svtools 4.0.0-alpha5`。
- 真实 VS Code 1.141.0：首次工程加载、刷新事件/稳定 ID、TreeView 展开、选择/上下文、
  损坏文件提示、修复恢复、删除选择后恢复、成员/层级/未加入文件共 8 项通过。
  使用独立用户/扩展/公开 fixture 工作区，隐藏启动，测试完成自动退出，没有安装到
  用户 IDE。最终报告 `bin/vivado-host/run-6fc9ce3cba92406c93d94e8e2419cff0/host-report.json`。
  IDE 自身有内置 agent proposal/channel 告警，未将宿主日志宣称为零 console 输出。
- 真实 Vivado 2022.1.2：创建 .xpr/自定义集、加入/跨集移动/设置 top 的事实校验、
  指定源文件第二个模块 `selected` 的 xvlog/xelab、sim_custom 的 xsim 跑到 $finish，
  共 4 项通过。所有写操作在新建公开验收目录，真实用户工程只读核对，未修改。
  报告 `bin/vivado-panel-native/run-w9HnnU/report.json`；完整阶段日志在相同目录下。
- 安装包 `bin/svtools-4.0.0-alpha5.vsix`，64 文件、2,109,015 bytes。
  SHA256：`170b5336da0f6db0795fa03672a9cec74cfb967e25486c75434cbbb796a3e2f8`。
  46 个运行 JS/CSS、扩展入口/native 与当前源码/构建逐字节匹配；无测试、日志、VCD、
  CLI、Rust 源码或开发依赖。包核验 `bin/toolchain-alpha5-package-check.json`。
- 静态扫描的严重项逐个人工检查：HTML placeholder、对象/字符串中的 `{}`、catch 中
  return 被占位启发式误判；没有实际占位函数。结构扫描仍标出组合入口回调汇总、XML
  解析状态分支和旧创建向导/OOC/报告的集中度，作为后续拆分约束保留，未隐藏原始报告。
  本轮独立审查发现的工程错集、全工作区依赖、无效预算和取消竞态均有对应修复与回归。

复现入口：`scripts/verify-vivado-host.ps1 -CodePath <Code.exe>` 与
`node scripts/verify-vivado-panel.js --vivado <安装目录>`；后者可通过 --part 指定可用器件。
常规合同的 batch 边界 mock 与真实厂商验收分开记录，不互相替代。最终日志为
`bin/vivado-alpha5-package.log`、`bin/vivado-alpha5-rust.log`、`bin/vivado-alpha5-host-final.log`、
`bin/vivado-alpha5-native.log`；静态原始报告在 `bin/vivado-alpha5-ai-scan.json` 和 risk.json。

Windows x64 的公开夹具验收不代替用户完整 IP/器件/多 run 工作流。波形/memory 保留
既有验收，本轮未重新测大 VCD；FSDB 保持取消。本版本仅本地提交和打包，未安装、
推送、合并或发布。

## 完整文件清单

相对路径以本 worktree 为根；构建/验收产物与 ENVIRONMENT.md 已忽略。

| 文件 | 本轮变更 |
|---|---|
| `.gitignore` | 纳入真实 VS Code 宿主验收脚本。 |
| `ARCHITECTURE.md` | 工程选择、模型、视图及管理动作边界与风险约束。 |
| `CHANGELOG.md` | alpha5 的行为、原因和影响范围。 |
| `CONTEXT.md` | 当前版本、验收和后续边界。 |
| `README.md` | 开发版本改为 alpha5。 |
| `docs/V4_ALPHA5.md` | 操作、边界、验收、安装包及文件清单。 |
| `docs/bugs/logic-vivado-tree-refresh-and-member-ownership.md` | 空树与成员归属的根因、定位和修复约束。 |
| `package.json` | 注册选择/停止、忙碌门禁、图标、测试及 alpha5 版本。 |
| `package-lock.json` | 同步根包版本。 |
| `package.nls.json` | 工程选择/停止英文标题。 |
| `package.nls.zh-cn.json` | 工程选择/停止中文标题。 |
| `src/extension.js` | 返回工程管理 API，供真实宿主验收与集成调用。 |
| `src/native/package.json` | 同步 native 包版本。 |
| `src/native/package-lock.json` | 同步 native 锁定版本。 |
| `src/native/Cargo.toml` | 同步 Rust/CLI 版本。 |
| `src/native/Cargo.lock` | 同步 Rust 锁定版本。 |
| `src/toolchains/iverilog-controller.js` | 明确工程 xelab top/成员范围，独立检查停止命令。 |
| `src/toolchains/xvlog-runner.js` | 显式工程文件/include/单元范围替代全工作区补编译。 |
| `src/vivado/chip.svg` | 活动栏使用可加载的芯片 SVG。 |
| `src/vivado/index.js` | 共享选择/busy，真实文件集与独立编辑器动作脚本、取消与状态清理。 |
| `src/vivado/projects.js` | 稳定发现、持久选择、外部工程与异步选择竞争处理。 |
| `src/vivado/tree-model.js` | 当前工程成员、按单元引用、引用身份、预览预算及提示。 |
| `src/vivado/projectTree.js` | 树事件/父节点/稳定 ID、合并刷新、命令核验与停止路由。 |
| `src/vivado/tclgen.js` | 仿真集参数贯穿 xsim，顶层扫描保护注释/字符串。 |
| `src/vivado/xpr.js` | 完整 XPR XML/实体/属性/路径读取与错误上下文。 |
| `src/workspace/sources.js` | 共享保护区屏蔽和设计单元原文区间，不改索引刷新策略。 |
| `scripts/verify-vivado-host.ps1` | 启动隔离的真实 VS Code 验收宿主。 |
| `scripts/verify-vivado-panel.js` | 新建真实 XPR 验收工程管理、xelab 和自定义仿真集。 |
| `test/toolchain_task_test.js` | 工程 xelab 显式 top/范围与检查停止合同。 |
| `test/vivado_commands_test.js` | 18 项编辑器/面板忙碌、真实集、脚本隔离与取消合同。 |
| `test/vivado_tree_test.js` | 19 项空树、选择、层级、预算、过期成员与多仿真集合同。 |
| `test/vivado_xpr_test.js` | 44 项 XPR 兼容、路径和损坏输入合同。 |
| `test/vscode_vivado_host.js` | 8 项真实 VS Code 工程管理宿主验收。 |
