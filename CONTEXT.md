# Vivado任务目录统一保留与旧记录清理（2026-10-27）

当前分支`codex/fix-vivado-task-retention`，基线`d158cc2`，修复提交`f6c370b`。用户报告05_corelib的`.svtools/vivado/actions`与`tasks`越来越多。根因：每次动作先建未受控的`action-*`，日志再进该动作独有的`tasks`父目录，已有保留预算无法约束动作总数。

- 新增`vivado/script-task.js`，编辑器／面板提交生成描述，运行器先取得ToolTask所有权，在统一`.svtools/vivado/tasks/vivado-*`内写Tcl与完整日志；准备前后校验上下文并响应取消。用户Tcl保持原路径与cwd。最近记录整套保留，默认5轮，继续使用`svtools.tasks.retainedRuns`，0=关闭淘汰。没有改动通用完成协议，也没有新增清理依赖。
- 最终回归：语法283、golden44、Node764通过／12可选跳过、电路227通过、Local22通过／5可选跳过。57项任务／命令／工程树定向检查通过。最终包VS Code1.143.0与Qoder API1.106.3隔离宿主各11项通过。实际Vivado编译未运行，批处理使用测试替身并以真实Node子进程写完整日志验证同目录和保留行为。
- 交付`bin/private-dist/svtools-4.1.0-beta.4-local.17-win32-x64.vsix`，18,732,202字节，SHA256 `793fce3e26fcff37e34df0773ae283c0d3dc3701fda70878c0e4df3df3974887`。507项归档载荷一致、140项公开src脚本与当前源码一致，私有12项运行文件保持Local.16哈希。验收记录`bin/vivado-task-retention-delivery.json`，完整日志`bin/vivado-task-retention-local-build.log`。
- 用户明确选择“确认工具已停止后，仅保留最近5次并删除其余”。进程核验未发现Vivado/xsim/xelab/xvlog/xvhdl；对指定actions/tasks根生成全部文件指纹和删除计划，逐项核验边界／链接／变化后实际删除62份旧记录，释放1,023,971字节。actions由57减到5，tasks由10减到0；保留5份的全部文件指纹不变。它们是action-bJJpa5、action-MNYUhi、action-kp9oRf、action-Si2MxL、action-PH88US。
- 旧数据清理脚本、计划、报告、复核分别是`bin/vivado-legacy-cleanup.ps1`、`vivado-legacy-cleanup-plan.json`、`vivado-legacy-cleanup-report.json`、`vivado-legacy-cleanup-confirmation.json`，未纳入Git。这是明确授权的一次性清理，不代表自动清理可以删除无完成标记目录；留下的5份旧记录仍在actions，不迁移、不补写完成标记，新任务预算仅覆盖新受控记录。
- 用户随后追加`.svtools/tasks`，延续相同保留最近5次／删除其余的明确授权。只读盘点301份xvlog记录，仅5份有完成标记，没有源码快照类型或链接；核验无活动编译／仿真进程后，生成指纹清单并删除296份，保留最新5份全部指纹不变，释放190,916字节。通用自动保留机制本身已有实现，未修改该产品逻辑。剩余xvlog-pdKudP、xvlog-s8fPNI、xvlog-Kd31Sr、xvlog-NBgLRk、xvlog-1ihUpS，其中一份旧记录仍无完成标记，不伪造终态。脚本／计划／报告／复核位于`bin/general-task-cleanup*`；总交付JSON已增补该结果。

没有安装、推送、合并或发布；需用户安装Local.17后，后续运行才启用新布局。源码及交接均已保存，用法见`docs/TOOLCHAINS.md`，完整文件说明见`docs/VIVADO_TASK_RETENTION_FILES.md`，根因见`docs/bugs/logic-vivado-task-layout.md`。报告、波形和Vivado工程运行目录不在此次清理范围。当前没有必须完成的遗留工作。

以下为历史交接。

# 工程面板与Vivado流程区（2026-10-27）

当前分支`codex/feat-project-panel-polish`，基线`4cb76d1`，功能提交`6ad6dc9`。用户要求Vivado工程添加位置改作工具入口、文件树下方集中综合／实现等流程、增强树图标／展开控件／方向标记，并去除底部常驻静态分析说明。本轮已实现，保留已有静态追踪与私有工具链。

- `project/index.js`单一登记7项Vivado动作元数据，命令白名单与流程区共用。顶部“Vivado”展开文件树下方的流程区，综合／实现／Bitstream／停止为直接按钮，三类报告为锚定菜单；添加文件放在流程区，自管理工程保留顶部添加。仍调用原Vivado执行器，节点世代及工程身份校验保留。
- `view.js`结构、`style.css`主题布局、`icons.js`固定SVG路径分离；保持原字号，强化展开控件与右侧方向标记。文件夹名称可直接展开，文件和实例标签仍定位源码。主滚动区只滚动树，流程区可按工程收起／展开。分析说明默认隐藏，从“⋯”按需查看，实际错误状态仍可见。菜单锚定入口，支持方向键及Esc恢复焦点。
- 最终回归：语法281、golden44、Node757通过／12可选跳过、电路227通过、Local22通过／5可选跳过。最终包VS Code1.143.0和Qoder API1.106.3隔离宿主各11项通过；真实浏览器验证320px亮暗主题、240px窄布局、自管理切换、菜单位置／Esc、文件夹名称展开及按需提示，未见横向溢出、脚本或CSP错误。只验证命令路由，本轮没有执行实际Vivado综合任务。
- 交付`bin/private-dist/svtools-4.1.0-beta.4-local.16-win32-x64.vsix`，18,730,730字节，SHA256 `bf01c55bc521951a64702eb4f8fe81a5505ef3ea0c77f8dc353627b6c5364988`。506项归档载荷一致，139项公开src脚本匹配当前源码，样式／图标另有明确核对，自用12项运行文件保持Local.15哈希。打包日志`bin/project-panel-local-build.log`，包验证`bin/project-panel-package-verification.json`，交付总记录`bin/project-panel-delivery.json`。
- 视觉检查使用已有bundled Playwright及独立无头浏览器，不接管用户窗口。示例截图`docs/images/project-panel-light.png`和`project-panel-dark.png`已进入使用指南；它们使用真实Webview资源渲染，不代表真实工具任务状态。本次两个仅本地预览服务已精确关闭，没有新增依赖、安装扩展、推送、合并或发布。

后续可根据用户实际体验微调工具区密度；目前没有必须完成的工作。全部文件说明见`docs/V4_1_PROJECT_MANAGER_FILES.md`，用法见`docs/V4_1_PROJECT_MANAGER.md`。既有宏/generate静态分析限制不变。

以下为历史交接。

# 工程追踪上下文与默认自动模式（2026-10-27）

当前分支`codex/fix-project-trace-context`，基线`3b7169d`，修复提交`4302322`。用户在`sim/cdc/tb_cdc_hs_bits.sv`选择信号却收到adder的静态提示，并要求默认选择即追踪、可手动触发。根因是追踪入口无条件用综合top，读入TB不代表实例树包含TB。

- 新增`project/trace-context.js`集中选择文件集／候选根：仿真文件优先仿真top，设计文件优先综合top；核验目标模块路径、行号及实例可达性，不包含时回退所选模块。未知位宽不通过换根掩盖，工程top不修改。RTL模型索引一次解析，备选根独立建模和提示。
- 默认`svtools.project.traceTrigger=selection`，首次选中即可建模；300ms防抖、串行合并选择、旧选择不发布，已有匹配模型复用。工程“⋯”菜单切换`manual`，右键显式追踪仍保留实例选择。自动模式不弹框／抢焦点，侧边栏显示实际追踪根。清除失效结果同时释放固定状态，防止后续自动追踪被永久阻止。
- 最终回归：语法280、golden44、Node754通过／12可选跳过、电路227通过、Local22通过／5可选跳过。包中代码在隔离VS Code1.143.0与Qoder API1.106.3各11项通过，覆盖首次自动、手动、模型跟随、TB根、连续选择和工程切换。
- 对用户工程13个HDL输入只读验证：即使候选综合top为adder，TB中`i_clk_s`、`i_data_s`、`o_data_m`、`i_rst_n_m`、`l_data_s`正确追踪到TB与DUT的相应方向，输入哈希前后不变。报告`bin/project-trace-context-corelib-validation.json`。
- 最终交付`bin/private-dist/svtools-4.1.0-beta.4-local.15-win32-x64.vsix`，SHA256 `dfa9ef87d861375c7757b3ed7939b15ff5e1b362af7797edad459cd4786b2f50`，18,726,773字节。504项归档载荷与staging一致，138项公开src脚本与当前源码一致，自用12项运行文件保持Local.13哈希。`readme.md`／`changelog.md`由vsce改写相对链接，单独识别。验证`bin/project-trace-context-package-verification.json`，完整交付记录`bin/project-trace-context-delivery.json`，回归日志`bin/project-trace-context-local-build-final.log`。

本轮已提交全部产品修改，没有安装、推送、合并或发布。Local.14是补查固定状态问题前的中间构建，应使用Local.15。用法与完整文件说明见`docs/V4_1_PROJECT_MANAGER.md`和`docs/V4_1_PROJECT_MANAGER_FILES.md`；根因笔记`docs/bugs/logic-project-trace-top-context.md`。宏/generate/未知类型的静态展开限制仍保留；后续根据实际工程案例扩展明确合同。

以下为历史交接。

# 工程追踪静态RTL后端修复（2026-10-27）

当前分支`codex/fix-rtl-project-trace`，基线`a636f33`，修复提交`be6fdb2`。用户报告工程信号追踪因sfifo.sv编译单元timeunit报错，并要求不依赖Yosys。根因是原工程追踪将DesignSrcs全部include到同一编译单元，使后续文件的合法时间声明位于已有模块之后；没有修改用户RTL，也没有在本次改写电路生成包装器。

- 工程追踪默认使用独立`project/rtl-worker.js`，不启动Yosys/ELK、不创建工具任务或临时网表。`rtl-model.js`适配声明、已知参数、连续别名和明确实例，`rtl-expression.js`有界解析常量/直接位表达式，共用原跨层端口查询及源码快照核验。
- 支持非ANSI顺序端口、隐式命名/通配、字面include、升降序/切片/拼接/复制和参数覆盖。普通宏、生成块、未知类型/范围不展开，明确止步；多驱动、条件驱动及未解析实例阻止不安全的别名合并。静态结果不是完整SystemVerilog详细化证明。
- 最终回归：语法277、golden44、Node744通过／12跳过、电路227通过、Local22通过／5跳过。新增13项静态测试；最终包实际VS Code1.143.0/Qoder API1.106.3各8项通过，Yosys路径设为不存在且无网表目录。
- 新包`bin/private-dist/svtools-4.1.0-beta.4-local.13-win32-x64.vsix`，SHA256 `6a59819d225e65858c91911d512c85cbbd674baa049b6d5e349d32aa175142ee`。503项归档载荷/149项src脚本核对，私有12项运行文件保持原哈希；源码/包记录见`bin/project-rtl-package-verification.json`，全量日志`bin/project-rtl-local-build-final.log`。
- 对05_corelib的12个源文件（包含sfifo）只读验证adder静态追踪通过；存在生成/逻辑边界提示，不宣称完整网表。全部用户源文件字节哈希前后不变；报告`bin/project-rtl-corelib-validation-final.json`。

用法见`docs/V4_1_PROJECT_MANAGER.md`；根因增补在`docs/bugs/compat-yosys-systemverilog-frontend.md`。原Yosys/Vivado电路图入口及自用ModelSim保留。没有安装、推送、合并或发布。后续如扩展宏/generate，应建立独立的预处理/展开合同，不能用同名或单比特回退伪造确定性。

以下为历史交接。

# 4.1统一工程管理与多层透传交接（2026-10-27）

当前分支`codex/feat-project-signal-flow`，基线`6a6a170`，功能提交`148d9f0`。用户已确认单一工程侧边栏、顶部工程切换、文件／实例节点右侧角色标记，以及多层级信号透传；本轮已实现并验证。公开源码与自用ModelSim保持隔离，没有推送、合并、发布或安装。

- `src/project/`拥有统一选择与配置、工程成员、Worker内真实位连接追踪、快照失效、侧边栏投影与页面。沿用原视图ID并改为WebviewView，旧Vivado管理命令无界面复用，工程top电路入口仍保留。
- 新增16项工程测试。完整回归：golden44、Node731通过／12跳过、电路227通过；Local检查22通过／5跳过。包staging实际VS Code1.143.0和Qoder API1.106.3各8项宿主验收。
- 自用包`bin/private-dist/svtools-4.1.0-beta.4-local.11-win32-x64.vsix`，SHA256为`d0478ad79cc9a5acc0e3c3c46eb8059520d14aba4de028d006eff213893f6439`。全量日志`bin/project-local-build-final.log`，包内容验证`bin/project-package-verification.json`。
- 信号透传支持实际实例、父级／兄弟／子层级、改名和位重排，不按同名／同值常量连线，不跨过逻辑／寄存器／黑盒。跟随选中信号复用模型，固定不能阻止源码或工程变化的失效。切换工程释放Worker，返回后需重新追踪。
- 未详细化的实例页仍明确标注源码引用预览；工程追踪目前用Yosys，不宣称已有Vivado层级追踪适配。源码定位复核快照；尚未做人工鼠标及明暗主题视觉验收。

用法与配置见`docs/V4_1_PROJECT_MANAGER.md`，文件职责见`docs/V4_1_PROJECT_MANAGER_FILES.md`。下一步优先在实际工程试用目录跟随、实例选择和深层透传，再根据反馈完善视图交互；不自动扩大到穿越逻辑锥或跨会话持久化有效追踪。

以下为历史交接。

# 4.1严重缺陷审查交接（2026-10-27）

当前分支`codex/fix-v4.1-critical-audit`，基线`9e2b563`。用户要求先核验严重BUG；本轮重现并修复来源失效/刷新、VCD候选重绑和导出覆盖风险。完整风险表、证据、计数及产物信息保存在被忽略的`docs/private/V4_1_CRITICAL_AUDIT.md`和`bin/critical-audit-delivery.json`。

- 关闭标签不再跳过正文核验；已捕获输入增加按目录复用的磁盘监听，内容不变不误报，旧世代和关闭后事件被丢弃。Windows监听先规范长路径，避免8.3目录触发libuv断言。刷新重新取得已关闭的TextDocument，追踪起点复核当前正文。
- 同一电路观察项重新选择VCD候选时替换identifier code和位投影，保留探针ID并沿用旧响应拒绝规则。
- 布局只写JSON目标；图片与布局共享`workspace/export-target.js`，保存前拒绝链接、多重硬链接、非普通文件及源文件路径别名，防止路径文本不同却覆盖同一输入。
- 新增失败重现、回归及真实IDE审查脚本；格式化器异常输入字符保全扩大到本轮固定种子的6000次调用。具体计数和源码归档只在本地审查报告，不将其视为所有RTL语义或所有并发场景的证明。

本轮仅本地提交与Local安装包；私有ModelSim实现未改，不自动安装、推送、PR、合并或发布。下一步优先使用修复包做实际工程反馈；源码监视仍基于已捕获输入清单，未捕获头文件/任意宏依赖及多宿主同时写同一仿真目标尚需后续专项验证。

以下为历史交接。

# 4.1波形联动M4第二阶段交接（2026-10-26）

当前分支`codex/feat-circuit-cursor-values`，基线`502dc72`。已完成显式观察信号的A值标注、A/B精确读值与HDL下标差异；沿用人工确认映射，未增加同次构建证明。公开用法见`docs/WAVE_LINKS.md`，完整本地交付记录见被忽略的`docs/private/V4_1_M4_2.md`。

- `debug/cursor-values.js`拥有有界观察、游标快照和单查询泵，合并旧请求并原子发布A/B。复用原VCD Worker，区分X/Z、无事件、无匹配dump和未设置B，不触发网表生成或布局。
- `circuit/cursor-values-client.js`按真实模块、实例和位身份标注SVG，观察列表保留原上下文；相同锚点的多项标注错开。最多32项、合计4096位，不跨会话保存，图片导出仍为结构图。
- 游标只在存在观察者时订阅；普通行高、分组和排序保持原消息合同。新增VCD文件监视，外部改写立即清空读值，查询前后仍核对文件身份。根因记录见`docs/bugs/perf-cursor-broadcast-subscription.md`。
- 最终Local包通过完整公共回归和VS Code/Qoder解包宿主；Qoder实际设置A/B后核对整总线、切片及差异下标。计数、哈希、截图和源码归档仅保存在本地交付资料。
- 同期用户CDC源码报错已在隔离副本上确认：异步事件控制缺复位分支，应答同步链还需要回源域。原文件未改，修正版与真实Yosys验证记录在本地`bin/m42-cdc-diagnosis.json`，未进入公开仓库或安装包。

本轮仅本地提交和Local包，私有ModelSim实现未改，公开预览仍4.1.0-beta.4，稳定版仍4.0.0；没有安装、远程推送、合并或发布。下一步收集实际工程使用反馈，完善M4规模与交互验收，再决定4.1下一版预览发布。

以下为历史交接。

# 4.1波形联动M4第一阶段交接（2026-10-26）

当前分支`codex/feat-circuit-wave-link`。先以`e0b5d03`收拢波形时间范围导航，再完成显式DUT根实例映射、电路添加/定位波形和波形返回驱动/负载追踪。用法见`docs/WAVE_LINKS.md`，完整交付记录和文件清单保存在被忽略的`docs/private/V4_1_M4_1.md`与`docs/private/V4_1_M4_1_FILES.md`。

- `src/debug/`协调可信会话和有界声明索引；电路Worker复用真实拓扑，波形沿用压缩事件与逐位行。实际实例、范围方向及HDL下标共同校验，不凭同名猜测，不从同值常量反推信号。
- 人工根映射明确显示“未验证同次构建”；源码变化、刷新、关闭、VCD改写及重仿真撤销关联。挂起的选择器随来源失效取消，过期响应不能覆盖新视图。
- 最终Local安装包完成真实Icarus/Yosys、Vivado平坦名称、VS Code和Qoder双向联动及Qoder实际右键操作验收。详细计数、测量条件和产物哈希只保留在私有交付记录。
- 本轮仅本地提交和Local安装包；公开预览仍为4.1.0-beta.4，稳定版仍4.0.0，没有安装到日常IDE、远程推送、合并或发布。私有ModelSim源码没有修改，旧归档保留。

下一步为M4第二阶段：在已有映射上按需查询A游标值，随后增加A/B差异。需要区分未dump、无事件、X/Z和失效来源；不得移动游标就重建电路或布局。当前尚未实现电路上的值叠加。

以下为历史交接。

# 4.1信号追踪M3交接（2026-10-25）

当前分支`codex/feat-v4.1-signal-tracing`。M3已完成4.1.0-beta.4本地预览的完整回归、最终VSIX公开排除/字节校验、Qoder与VS Code解包宿主、真实Icarus重仿真和跨窗口目录保留验收。包含此前高扇出、视口、源码清单/快照及目录所有权修复。本轮不自动安装、推送、合并或发布，正式稳定版仍4.0.0，自用ModelSim包保持原状。

按用户要求，内部测量、路径、产物哈希与分阶段记录仅保留在被忽略的`docs/private/`和`bin/`；详见`docs/private/V4_1_M3.md`、`docs/private/V4_1_M3_FILES.md`与`bin/circuit-trace-m3-delivery.json`。安装包来源提交与后续仅涉及验收脚本/文档的提交分别记录，不修改既有归档。

下一步为M4波形联动：先做显式实例/信号映射与双向定位，再接A游标值和A/B差异。预览实际使用反馈待用户提供；当前没有M4实现或4.1正式远程发布。以下为历史交接，旧的“M3待进行”和浏览器受限状态不代表当前进度。

# 4.1信号追踪M2交接（历史）

用户要求“进入下一阶段”，沿用`codex/feat-v4.1-signal-tracing`完成M2。源码右键驱动/负载、原位局部投影、显式时序/实例端口边界、逐级展开/收起、32项历史、64个关注对象、视口锚点/恢复和源码快照验证已接通。扩展/native/CLI仍4.0.0，不准备4.1安装包、不推送或合并，私有ModelSim代码及local.8包保持。

- 源码身份联合编译前快照、工具模块位置、声明作用域、真实网络及实际实例；拒绝层级成员、局部遮蔽和证据不足的条件编译声明。Slang常缺单条netname位置，容错解析也可能误记赋值右侧变量，排查见`docs/bugs/logic-circuit-source-trace-identity.md`。
- `trace-source`/`source-snapshots`/`source-watch`负责来源；`trace-projection`只裁剪展示副本且按端口隔离常量；`trace-view`重放可信边界并复用ELK；`trace-controller`拥有导航状态；`trace-actions`/`trace-client`负责原始身份和控件。完整38文件清单`docs/V4_1_M2_FILES.md`。
- 验收：JS223文件；完整npm test为golden44/44、既有Node675通过/12环境可选跳过，另指定本机Qoder TextMate复验4/4，补验其中1项；最终电路214/214。完整日志`bin/circuit-trace-m2-full-tests.log`，收尾电路`bin/circuit-trace-m2-final-circuit.log`，收尾导航47/47为`bin/circuit-trace-m2-final-navigation.log`。
- 真实Qoder API1.106.3与VS Code1.143.0各6/6：源码q[2]进入、寄存器和组合展开、历史与收起、受验证位置、脏正文刷新及拒绝旧位置、负载命令。日志`bin/circuit-trace-m2-{qoder,code}-final.log`。使用隔离bin工作区，没有写用户RTL或用户配置。
- 合成2万独立反相器固定5次冷会话/5次预热/20次热布局，Worker+索引+查询+投影+ELK：冷P95 422.11ms、热P95 44.78ms、加载P95 308.26ms；局部1单元/3节点/2线，无截断，完整布局超既有预算。报告`bin/circuit-trace-view-benchmark/report.json`，不含工具生成/源码解析/SVG或鼠标帧率。
- Windows浏览器自动化因无法可靠确认当前URL而停止，实际明暗主题/鼠标视觉验收未完成；不要把宿主脚本或Fake DOM测试当作实际视觉验收。两个预览进程均已核对PID/脚本后关闭，没有改用户浏览器设置。
- `docs/V4_1_M2.md`记录范围与限制；相机只固定起点屏幕锚点，ELK可能移动其他节点，没有实现位置锁定或跨IDE重启追踪持久化。外部JSON和缺少源码快照的Vivado工程可图上追踪，但局部源码跳转禁用。编辑观察针对已打开输入文件，磁盘外部改动在跳转时核对。

下一步为M3：补实际明暗主题/鼠标视觉验收、扩充密集/高扇出及复杂源码公开夹具、复核发布范围并准备4.1安装包及解包复验。P1波形映射按M4，不在M2冒充完成。

以下为历史交接。

# 4.1信号追踪M1交接（2026-10-25）

用户授权开始4.1特性，当前分支`codex/feat-v4.1-signal-tracing`，沿用全部4.0维护修复；M1位级查询与Worker接口已完成，M2界面待开发。扩展、native、CLI仍4.0.0，没有4.1安装包或远程发布。

- 新增`src/circuit/topology.js`、`trace-semantics.js`、`trace.js`：模块局部位端点、真实方向、HDL范围、策略注册表、保守依赖、时序/实例/未知方向/多驱动/环路边界、有界LRU和单次查询状态。常量按端口位置隔离，不使用展示图合并结果推断电路。
- Worker新增`traceSignals`/`trace`；同时校验designId和新revision。相同JSON重载仍拒绝旧世代，关闭销毁索引与挂起请求；完整布局超预算的3,000单元模块仍可查询选定位。对外合同与精度含义见`docs/V4_1_M1.md`。
- 新增24项电路回归，含真实内置Slang/Yosys公开RTL；真实工具为重复实例生成专用模块，测试按实际moduleId跟踪，不按源码名称猜测。Vivado使用平坦导出合同夹具，当前未额外运行真实Vivado。公开夹具`test/fixtures/circuit-trace.sv`已明确纳入Git，目录通常被忽略。
- 验收：JS语法210文件、golden44/44、既有Node676通过/11可选跳过，电路194/194；真实Qoder API1.106.3现有电路宿主5/5。完整回归日志`bin/circuit-trace-full-regression.log`，最终电路`bin/circuit-trace-final-circuit-tests.log`，宿主`bin/circuit-trace-qoder-host.log`。
- 20,000独立反相器合成基准：80,000端口位引用、40,000网络位，索引45.93ms/堆增量27.60MiB，5次冷查询p95 41.59ms，100次热查询p95 0.0183ms。该测量只含同进程纯查询，不含Worker RPC、布局或SVG。预设目标全部通过；报告`bin/circuit-trace-benchmark/report.json`。
- 新核心模块最大圈复杂度12、无依赖环。静态AI检查将空对象实参误报为空函数，7项均经源码和运行验证裁决为假阳性，原始报告保留；审查记录`bin/circuit-trace-review-audit.json`。公开打包检查461文件/106960565 bytes，私有入口继续排除。
- M1交付、计划、架构和README已同步；源代码及验收汇总在`bin/circuit-trace-m1-delivery.json`。只保存本地提交，不推送或合并；私有ModelSim运行代码没有改动，local.8安装包和源码备份保留。

下一步：M2先完成局部投影与结果边界显示，再接源码/引脚入口、逐级展开及导航状态；依赖现有真实位映射与路径检查，随后执行P0真实IDE验收。

以下为历史交接。

# 自用ModelSim默认运行到结束（2026-10-25）

用户反馈波形默认只到1us，在完整调试器控制与默认到finish两个方案中，本轮实现默认到结束。当前分支`codex/fix-modelsim-run-until-finish`，保留此前格式化、高亮、仿真菜单及VCD目录修复；运行代码改动全部在已忽略的`src/private/modelsim`中。

- 协议层用唯一`DEFAULT_RUNTIME='all'`提供默认值，私有清单引用同一常量，runner取消两处1us回退。默认`run -all`直到`$finish`或事件队列自然结束；显式有限时长仍优先，已有手动1us设置需删除或改为all。
- 停止按钮及阶段实际耗时超时仍有效，默认120000ms，可按原配置调大；该值不是HDL仿真时间。未增加单步/暂停等交互调试器功能，也未修改用户设置。
- 新自用包`bin/private-dist/svtools-4.0.1-local.8-win32-x64.vsix`，464文件、18574437 bytes；SHA256为`ad48d0ee98f60b3ba6336d4ac7fff995161e539c7cdb7064ff083f665f53ad58`。实际归档清单默认all、私有运行文件及公共资源均与构建一致，公开发布门禁仍拒绝该私有包。
- 真实Questa专项17/17：未配置时运行到2.203us的finish，VCD保留1us后变化；显式时长、失败、取消、超时、fileList/include/ini保持。VCD末时间表示最后变化，不强求等于finish时间，结束时刻核对工具日志。
- 解包最终VSIX在真实Qoder API1.106.3宿主17/17，包含核心格式化/生成、菜单启动后默认2.204us的finish、有限100ns覆盖及删除覆盖恢复all、重复VCD与停止。完整回归golden44/44、Node676通过/11可选跳过、电路170/170，私有构建纯合同5通过/2实际工具组可选跳过。
- 报告`bin/modelsim-until-finish-package-verification.json`、`bin/modelsim-until-finish-acceptance-report.json`及modelsim-until-finish相关日志；私有源码与构建/验收脚本另存private-dist备份。公开版本仍4.0.0，未推送、合并、发布或安装到日常IDE。

以下为历史交接。

# 无基数常量高亮修复交接（2026-10-25）

用户反馈`'0`、`'1`的单引号未着色。原TextMate语法没有无基数无位宽常量规则，只有后面的十进制数字被着色。当前分支`codex/fix-unbased-literal-highlight`沿用已完成的自用格式化及仿真修复。

- 新增完整`'0/'1/'x/'X/'z/'Z`数字作用域及词法边界；宏定义数字也复用`#numbers`。保持字符串、注释、类型转换与赋值模式上下文。两个语言共用该语法，不改主题、格式化器或原生资源。
- 新增`test/highlighting_test.js`并纳入npm test：3项独立词法合同，加1项真实TextMate/Oniguruma合同；通过`SVTOOLS_EDITOR_APP_ROOT`复用已有编辑器库，无新增依赖。无编辑器的CI只跳过真实引擎项。
- 新包`bin/private-dist/svtools-4.0.1-local.7-win32-x64.vsix`，464文件、18574192 bytes；SHA256为`fe454433e8d55233fe1254919a49aee40dd1434517de78789f8d314ebf03271a`。最终包的语法及运行资源与源码字节一致；基于包内语法和Qoder实际引擎验证30个常量场景与5个保护上下文。
- 回归：JS语法203文件、golden44/44、Node676通过/11可选跳过、电路170/170、私有纯合同4通过/2实际工具组可选跳过；解包最终包的真实Qoder18/18，包含格式化、生成及真实Questa。验收脚本修正“用户样本必须产生变化”的前提，已格式化文件允许保持原样，公开非规整夹具继续证明格式化实际执行。
- 报告`bin/unbased-highlight-package-verification.json`、`bin/unbased-highlight-textmate-report.json`、`bin/unbased-highlight-acceptance-report.json`；私有源码备份见private-dist。根公开版本仍4.0.0，私有实现继续排除公开构建；只本地提交，不安装、推送、合并或发布。

以下为历史交接。

# 自用格式化修复交接（2026-10-25）

用户反馈Qoder中axis_if.sv格式化无效。自用清单将configuration变为分组数组，旧读取器只支持对象，readOption在NAPI调用前抛出TypeError。当前分支 `codex/fix-local-formatting`，保留此前统一仿真菜单及默认VCD目录修复。

- `src/configuration.js`在入口合并单组/多组properties，格式化、例化、测试台共用同一默认值来源；`src/editor/formatting.js`将配置及文本读取纳入原异常提示。未改格式化规则、字符守卫或Rust核心。
- 新增两个先失败再通过的回归，验证三类选项的两种清单结构、显式false/0/空值及全文/选区配置异常。私有构建增加组装后真实配置和NAPI核心门禁，私有宿主复用公开核心验收后再跑仿真。
- 新包 `bin/private-dist/svtools-4.0.1-local.6-win32-x64.vsix`，464文件、18573918 bytes，SHA256为`1ba9fea32c851fdc698b19fb639f2eda65d0016484ddb548cd7378d90a5ffb28`。最终ZIP与staging的460个文件字节一致，README/CHANGELOG由vsce处理，LICENSE按打包规则改名；运行资源及私有三文件与当前源码一致。
- 完整回归：JS语法202文件、golden44/44、Node672通过/11可选跳过、电路170/170；私有纯合同4通过/2实际工具组可选跳过。最终解包包在VS Code1.143与Qoder API1.106.3均18/18，覆盖核心格式化/生成、用户文件副本的全文/选区/保存格式化及真实Questa菜单、VCD、错误和停止。
- 原文件 `D:\Workspace\FPGA\05_corelib\src\interface\axis_if.sv`仅只读，11174 bytes，SHA256前后均为`25a8ba3082c866eeb83aec9f746b4e07d5413202bde079e3aa8eb746592176bf`。未将用户样本放入公开golden或安装包。
- 报告为 `bin/local-format-acceptance-report.json`及`bin/local-format-package-verification.json`；根因见 `docs/bugs/compat-grouped-configuration-defaults.md`。私有源码及本次修复另存private-dist备份；旧包保留。公开版本仍4.0.0，仅本地提交，不推送、合并或发布，也未自动安装到日常Qoder。

4.1信号追踪计划不变。以下为历史交接。

# 自用仿真菜单修复交接（2026-10-25）

用户反馈自用版本统一“仿真…”入口没有ModelSim/QuestaSim。根因是只接入了独立命令/状态栏，原统一菜单仍是两项固定数组；现改为会话内可注册引擎列表和快照派发。当前分支 `codex/fix-local-simulation-menu`，沿用前面的默认VCD目录修复。

- 公共`toolchains/simulation-engines.js`提供注册、注销、只读选项和选择派发，Vivado组合层只注册Icarus/Vivado。取消、未知或过期选项不回退执行其他引擎。
- 自用入口注册第三项ModelSim / QuestaSim，实际按钮仍为原`svtools.simulate.pick`，通过原独立命令启动。专用实现和配置继续Git忽略及公开构建排除。
- 最终包 `bin/private-dist/svtools-4.0.1-local.5-win32-x64.vsix`，464文件、18573366 bytes；SHA256为`bc3e0f3aa800bf64a41105208f4f85f4d7fed19e46778eaaac51b511db3c6f4b`。包内菜单与私有运行代码已与源码核对。
- 回归：目标30/30、golden44/44、Node670通过/11可选跳过、电路170/170；解包包实际VS Code1.143与Qoder API1.106.3均9/9，从真实菜单选择第三项后运行本机Questa并加载VCD。公共入口真实宿主3/3，列表仍为两项，没有私有命令注册。
- 根因及测试缺口见 `docs/bugs/logic-simulation-engine-menu.md`；详细记录和私有源码备份见bin下simulation-picker相关报告。旧VSIX保留，仅保存本地提交，不推送、合并或发布。

4.1信号追踪计划不变。以下为历史交接。

# 默认VCD目录交接（2026-10-24）

用户要求Icarus及自用ModelSim的默认VCD存放到`.svtools/vcd/`。当前分支 `codex/fix-default-vcd-directory`；公共版本号仍为4.0.0，自用交付更新为 `bin/private-dist/svtools-4.0.1-local.4-win32-x64.vsix`，不覆盖旧包。

- 公共`src/toolchains/waveform-paths.js`集中生成工作区根下的默认路径，无工作区时回退源码目录；源文件、Top和引擎共同区分，重复仿真保持稳定。
- Icarus使用vvp默认dumpfile参数，自动建目录，将固定目标纳入关闭/写入保护/发现；保留源码cwd和相对readmem。显式RTL `$dumpfile`及用户`-dumpfile=`优先，FST/LXT沿用原规则，不改写旧测试台。
- 自用适配器复用默认路径，任务工作库/WLF/日志仍在原独立目录。固定VCD开始覆盖时撤销旧成功记录，失败后的部分文件不会冒充上次成功波形；编译失败保留未覆盖的旧成功结果。实现继续Git忽略，公开包无专用入口。
- 已通过目标合同47/47、golden44/44、Node663通过/11可选跳过、电路170/170、自用15/15；实际VS Code中Icarus6项和解包自用包ModelSim7项通过，覆盖子目录readmem、100MiB旧波形、重复覆盖、错误与停止。
- 最终自用包463文件，SHA256为`2f9d5f4dc7df3b144e4ae238425736bd1b137082b428fc4212368305bdc66ea7`；包内默认路径及私有运行文件与当前源码一致。详细记录及源码备份见bin下vcd-path相关报告。

4.1信号追踪计划不变；未推送、合并或发布GitHub附件。以下为历史交接。

# 自用构建与发布隔离交接（2026-10-24）

用户要求增加仅供自用的ModelSim工具链，公开发布不包含此支持。专用源码位于Git忽略的 `src/private/modelsim/`，不进入公开入口或清单；自用构建在隔离staging叠加命令/配置和包装入口。当前分支 `codex/feat-local-toolchain`，公开版本仍为4.0.0，4.1信号追踪仍按下文计划推进。

- 自用交付：`bin/private-dist/svtools-4.0.1-local.2-win32-x64.vsix`，稳定核心4.0.0；支持vlog检查、批处理仿真、停止、诊断、VCD联动、显式sources/fileList、include/宏和ini复制。路径与用法见私有目录README；本机Questa2024.1已发现。
- 自用包462文件；公开验证包458文件，仍为47命令/63配置，专用命令及私有文件均为0。两种包的454个公共文件逐字节一致（清单/README为有意不同）。源码备份在private-dist，具体SHA和本机验收记录在bin下的local-modelsim相关报告。
- 验收：golden44/44、Node661通过/11可选跳过、电路170/170、发布隔离5项合同；10个真实Questa场景，以及解包自用包实际VS Code的6项完整操作通过。新增文件发现失效竞争已增加有界重试合同。未改Rust运行代码。
- 本机旧src-rust缓存曾被vsce文件表收集，已停止失败构建并仅清理本任务复制目录；原缓存保留。现在显式排除旧目录与根旧二进制，并在复制/压缩前及最终归档限制4096文件/256 MiB，根因见 `docs/bugs/compat-package-legacy-native-cache.md`。
- Git只保存公开构建隔离和交接文档；自用实现被忽略并另行备份。未推送、合并或上传安装包，现有4.0 Release及原worktree保留。

下一步：在日常RTL工程使用自用VSIX收集反馈；若启动4.1，先按 `docs/V4_1_PLAN.md` 完成M1的真实位级追踪查询。

# 4.1 开发计划交接（2026-10-24）

用户确认下一版本为4.1，主线是信号追踪：局部逻辑锥，并逐步打通源码、电路与波形。详细范围和验收见 `docs/V4_1_PLAN.md`，入口见 `docs/ROADMAP.md` 和 README。

- P0首版：源码/电路起点的驱动与负载追踪、位映射、时序边界、逐级展开、导航/关注对象与稳定布局、已有源码位置跳转。
- P1后续：电路/VCD显式实例映射和双向定位，A游标精确值及后续A/B差异；歧义或缺失不按名称猜测。
- Vivado IP管理排在其后；FSDB继续取消。当前只保存已确认的计划，尚未开始功能实现或提升版本号。
- 4.0.0已经发布为GitHub Latest，PR #11合入master；当前主工程 `D:\Workspace\FPGA\02_svtools` 已快进至 `3b6313e`，正式产物、运行资源及开发依赖已同步，可在本目录继续维护。下文限制原目录仍停留preview、仅在旧worktree开发等描述均为历史记录。
- 本次计划文档在当前目录的 `codex/docs-v4.1-plan` 分支保存，未自动推送、合并或发布。原电路worktree保留其本地产物、截图、验收记录和发布后交接提交。

下一步：从M1的公开RTL夹具、位级拓扑索引与可验证追踪查询开始，再接入M2界面；完整模块布局之前完成局部子图提取，保持已有模型容量预算和4.0回归。

以下为历史交接：

# 4.0 beta.11 VCD默认打开与仿真前关闭

2026-10-23：VCD关联改default，正常打开直接进入CustomEditor。新增registry追踪面板、退出中的worker和写入租约，
host/session重复dispose返回同一退出Promise。Icarus编译成功后发现字面dumpfile/include路径，关闭对应旧波形和文本标签，
等待worker退出才启动vvp；取消/失败/超时finally释放保护，随后按原配置载入新VCD。支持子目录产物，动态路径回退cwd和源码关联。
重点53/53、Node22波形23/23、Rust127/127；真实Qoder4/4含默认打开、子目录重写、文本标签和100MiB旧波形打开期间重仿真。
全量JS179、golden42/42、Node585通过1可选跳过、电路170/170。最终包457文件/441运行文件逐字节一致；包内真实Qoder生命周期4/4、既有波形宿主4/4。100MiB开始仿真时仍在加载已记录true；Icarus默认dump.vcd另已实际验证。安装包及逐文件清单见docs/V4_BETA11.md。保留原工程与旧VSIX，继续独立分支和草稿PR11，不自动合并或创建Release。

# 4.0 beta.10 多时钟域例化模板

2026-10-23：用户cdc_hs_bits的i_clk_b/i_rst_n_b被生成器错误连接至A域。解析器域识别正确，
get_port_mapping却将同类信号替换为列表首项；删除替换，逐端口原名连接。
共用实例的Testbench保留额外域信号声明，激励仍为骨架，额外域需按设计补充。
新增公开端口夹具及Rust/NAPI回归；旧版本5项失败，修复后6/6。Rust127/127，Node22相关20/20，
真实用户文件八端口校验且SHA不变，Icarus严禁隐式网线并检查两个域不同电平通过。
全量JS175、golden42/42、Node571通过1可选跳过、电路170/170。包455文件/439运行文件逐字节一致，包内Icarus和真实Qoder命令4/4通过，剪贴板已恢复。安装包与逐文件清单见docs/V4_BETA10.md。保持独立分支和草稿PR11，不合并或创建Release。

# 4.0 beta.9 跨行参数例化

2026-10-23：用户cdc_hs_bits中第一个cdc_1bit在分组注释后，参数右括号另起一行时漏对齐。
结构已识别实例，align_pending_instance却只用单行定位起点；改用完整代码后缀，复用识别式和词法掩码。
新增完整用户golden及Rust/NAPI正文选区回归，字符守卫不变，不修改RTL连接或重名。
Rust126/126、golden42/42、Node24/22格式化保全75/75，CLI/NAPI一致。全量JS174、Node565通过1可选跳过、电路170/170。最终包455文件/439运行文件逐字节一致，包内真实Qoder宿主全文/幂等/选区/对齐4/4；首次验收脚本CRLF比较错误已修正，同一产物复验通过。证据见docs/V4_BETA9.md。
继续独立分支、草稿PR11与唯一beta.9安装包，原工程与beta.8产物保留，不自动合并或创建Release。

# 4.0 beta.6 波形信号标记与逐位调试

2026-10-17：用户后续要求展开图标更大，三角独立20px、点击区同步放大，文字与行高不变；重新生成同版本beta.6 VSIX并更新验证及哈希。实现多选背景高亮、总线展开/收起和RTL角色图标。颜色六色/清除并随布局恢复，bit可独立选择/分组/排序；保持声明左右界及X/Z。派生位共用事件store，渲染缓存仅当前可见投影；精确位边沿直接读压缩载荷并自动续查。方向复用completion语法在worker有界匹配，alias逐路径分类；不打开源码文档或触发lint，未知不猜。保持独立worktree、草稿PR11和原工程，版本4.0.0-beta.6，公开Release仍beta.2。

新增交互、源匹配、压缩位查询、Canvas及取消回归；Node22相关112项通过。正式页面明暗主题、真实Pointer多选、切色不重查、bit边沿40ns、重载和收起已通过。100/500MiB语料的256bit展开、精确位边沿及续查通过。最终JS158、Golden40/40、Node543通过1可选跳过、电路169/169、Rust125/125通过；包445文件/429运行文件逐字节一致。解包后实际Qoder Node native ABI、VCD worker与20ns位边沿，以及Edge明暗真实Pointer验证通过。完整34文件清单与交付记录见docs/V4_BETA6.md。正式版目标4.0.0，未合并或新建Release。

# 4.0 beta.5 生成文件lint误报

2026-10-16：用户粘贴的32条诊断全部来自26个.svtools/circuit临时文件，owner为svtools-iverilog、source为xvlog；30条include缺失，另2条为验证夹具宏/语法级联。定义检索仅排除node_modules并调用openTextDocument，触发lintOnOpen；启动与配置变化还会重查缓存文档。新增共享路径判定与glob同源，覆盖发现、已打开补全、定义检索、工具入口及发布。生成文档skipped并清理其旧诊断；正常RTL和失败状态不变。

本轮4.0.0-beta.5本地交付，继续独立分支和草稿PR11，公开Release仍beta.2；用户工程、RTL和现有日志不写入。Node22相关57项通过，含启动/开/改/存/配置跳过及混合错误保留。JS154、Golden40/40、Node522通过1可选跳过、电路169/169、Rust125/125；最终包443文件/427运行文件逐字节一致。实际Qoder Node加载解包native ABI及32/32用户诊断分类通过。最终包、证据及完整24文件清单见docs/V4_BETA5.md；正式版目标4.0.0。

# 4.0 beta.4 电路选中高亮

2026-10-16：用户报告亮色主题选线后消失。旧beta.3解包页面注入白色/透明/背景同色focusBorder后实际点击复现，stroke为白色/透明/背景色，对比度1:1。根因是电路选中/悬停沿用IDE焦点边框变量，变量已定义时CSS fallback不生效。CSS增加独立diagramActive调色板，并同步线、端点、关联节点和总线位宽标签；保持位序、选择算法与线宽不变。

本轮4.0.0-beta.4本地交付，继续独立worktree和草稿PR11，原工程不变；公开Release仍为beta.2。本机正式页面交叉系统明暗偏好与6种主题/焦点色场景均通过，最低实测对比度5.93:1。JS154、Golden40/40、既有Node515通过1可选跳过、电路169/169、Rust125/125通过；最终包443文件/427运行文件逐字节一致。包内Qoder Node native ABI、CLI版本和正式页面12主题组合通过，选中总线4.2px/单比特2.7px保持。最终安装包、回归与完整清单见docs/V4_BETA4.md。后续继续真实IDE主题反馈，正式版目标4.0.0。

# 4.0 beta.3 总线拼接/拆分

2026-10-16：用户CDC例子显示全部细线，要求明确合并/分支位宽。真实Slang复现AD=[c:1,c:1]、D=[n:4,n:6]、Q=[n:6,n:5]，旧图6条线全为1bit。新增纯展示bus-routing层，D/Q和AD各有2bit主干，分支1b[0]/[1]，常量1b×2；详情保留逐位位置，不猜RTL声明范围。主干成员索引保持网络身份，分支高亮不扩散到其它位，普通端口局部高亮合同保留；节点标题文字轮廓避免反馈线穿字。

本轮采用4.0.0-beta.3，本地交付和草稿PR11继续同一独立分支；4.0.0-beta.2已公开发布。原工程未改，领域网表及位序未改，连接条计入展示预算。JS154、Golden40/40、既有Node515通过1可选跳过、电路169/169（新增15）、Rust125/125、Node22.20相关63/63通过。VSIX443文件/427运行文件逐字节一致；实际Qoder Node运行时编译/布局/native ABI与Edge155包内页面通过。最终包2000节点交互合同通过，单次数据不作加速承诺。回归、最终包与完整清单见docs/V4_BETA3.md。后续继续真实IDE反馈、复杂设计测量，正式版目标4.0.0。

# 4.0 beta.2 发布交接

2026-10-16：用户明确要求当前预览版本以4.0.0.beta2推送，正式版本使用4.0；采用通用SemVer写法4.0.0-beta.2，扩展/native/CLI和锁文件同步。此前4.1 alpha1–alpha9为历史开发编号，当前发布系列改为4.0。用户也已确认向JayceVane/SV-Tools推送和更新现有草稿PR11；先前性能文档补充提交af448da一并同步。开发继续在独立worktree的codex/feat-circuit-viewer，不合并或修改原工程。

本轮运行逻辑与alpha9一致。重建/CLI版本、JS152、Golden40/40、既有Node515通过1可选跳过、电路154/154、Rust125/125均通过。VSIX442文件/426运行文件逐字节一致，解包后实际Qoder Node编译/布局/native ABI及Edge155正式页面通过。Node22/24远程CI与GitHub预发布最终状态见docs/V4_BETA2.md中的链接；正式版目标4.0.0。保留旧preview.1及历史记录，不发布Marketplace。已有preview.1/4.1 alpha安装用户按SemVer需要手动VSIX替换。

# 4.1 alpha9 开发交接

2026-10-16：用户要求区分电路中的多比特总线与单比特线。单线1.3px、总线2.8px，选中/搜索分别2.7/4.2px；多比特端点加粗，顶层I/O显示实际位数，线段有空间时显示斜杠与数字并可点选网络。按bits长度决定，不按名称猜范围，不修改连接。文字轻轮廓衬底，紧凑/总览隐藏装饰但保留线宽。viewport纯几何共享标记Map给renderer和裁剪，容许ELK浮点误差、合并冗余共线点、网格避让节点/标题/其他标签，高倍率可见文字不会提前裁掉。

真实Slang/Yosys生成1/8/24/32位电路10节点/12连线，解包后实际Qoder Node24.15/Electron42.2编译/Worker/ELK及Native ABI通过；Edge155正式页面浅深主题、数字点击、无标记遮挡、紧凑/总览检查通过。电路154/154（新增7）、既有Node515通过1可选跳过、Golden40/40（20例）、Rust125/125，JS152文件；Node22.20修改相关46项通过。VSIX442文件、426运行文件逐字节一致。

同机2000节点/5994条32位线，各版本两次：alpha8首次绘制129.7/142.7ms，alpha9最终包252.9/224.3ms；活动DOM1539→1743（68个可见总线标记）。拖拽/缩放帧中位16.7ms/P95约16.8ms，选中处理中位alpha8为0.3/0.4ms，alpha9为0.4/0.4ms；两版仍有偶发长帧，见交付文档。新增装饰有初始化成本与运行波动，不作为新的性能提升或任意宿主60fps承诺。早期开发单次180.2ms保留但不计入最终包对照。命令scripts/benchmark-circuit-interaction.js增加--bus-width 1..64，默认仍1。

交付及完整22文件清单见docs/V4_1_ALPHA9.md。保持独立worktree和Draft PR11，原master为4.0 preview，不自动合并或发Release。Qoder使用Node运行时、浏览器使用正式页面，未声称完整IDE UI验收。后续继续真实IDE使用反馈和复杂设计优化。

# 4.1 alpha8 开发交接

2026-10-16：用户Aurora示例整文件格式化漏掉支持模块的drp_clk_in对齐。真实文件局部实例可对齐、全文不行；最小复现为generate内always→assign→含if的always后接实例。过程完成判定漏掉Generate上下文，最后always状态未清理，后续实例被吞入。只为合法Generate并发上下文补齐提交条件。另修选区按首个真实代码分类，忽略分组注释；完整实例复用format_code_segment，纯端口表沿用起始括号列对齐。赋值分支移除Rust regex不支持的前瞻，以共享词法掩码和原文捕获布局。字符保全守卫未放宽。

Rust125/125、Golden38/38、既有Node515通过1可选跳过、电路147/147；格式化NAPI/保全73项在Node24与22.20通过，Rustfmt三文件检查通过。用户原文件36端口左右括号各自同列，全文/完整例化/端口表选区幂等、字符守恒，注释原文与磁盘SHA256不变。Native与CLI stdout逐字节一致；解包alpha8在实际Qoder Node24.15/Electron42.2使用包内native复验通过。442文件/426运行文件逐字节校验。复制后的格式化结果在bin/formatter-alpha8-user-proof/，未写原文件。详细验证与完整17文件清单见docs/V4_1_ALPHA8.md。

保持独立worktree及Draft PR11，原master仍4.0 preview；不自动合并或发Release。本轮无UI改动，Qoder使用Node运行时验收而非完整IDE UI。后续继续实际使用反馈、真实IDE宿主验收；不要用扩大字符守卫的方式规避布局问题。

# 4.1 alpha7 开发交接

2026-10-16：用户sync_resetn截图暴露寄存器符号错误。只读重编译证明$aldff连接正确（D=1、AD=0、CLK_POLARITY=1、ALOAD_POLARITY=0）；问题为时钟三角固定左下、空心普通端点误导、极性和原始参数未传到展示层。新增register-symbol纯展示模块，已知Yosys字级单元解释参数；三角按CLK几何定位，低有效控制/下降沿时钟带空心气泡，普通端点用直线连接，未知极性问号，LATCH/SR/FF独立符号。补齐$adlatch归类。ELK连线到端口外边缘，不是命中中心，已修正两侧短线接点。

alpha7电路147/147、既有Node511通过1可选跳过、Golden38/38、Rust121/121，JS语法152文件。用户实际源只读生成6节点/5连线、哈希不变；解包后实际Qoder Node24.15.0/Electron42.2.0编译、Worker/ELK和原生formatText ABI通过，Edge155正式页面浅深主题与控制气泡选择通过。包442文件、426运行文件逐字节一致；性能基准2000节点/5994边保持视口挂载及按帧输入。完整数据/清单见docs/V4_1_ALPHA7.md。初次ABI探针误用n.format，改为实际导出的formatText后通过，属于验收脚本错误而非扩展故障。

继续独立worktree及Draft PR11，原master保持4.0 preview；尚未进行本轮完整IDE Webview宿主验收，不自动合并或创建Release。后续优先真实IDE UI、使用反馈及现有回归；Vivado/未知门级单元不按名称推断时序极性。

# 4.1 alpha6 开发交接

2026-10-16：用户先报Slang通用详细化失败（impl_t未限定/未引入包且字符串赋枚举），后将参数改为字符串，继续报half_adder未定义。alpha6默认空sources时由VS Code发现当前根SV/V，Worker复用现有语义解析收集模块/接口/包闭包，依赖先行、同名定义报错、literal include去重；显式列表保留顺序。选中脏依赖按编号独立快照，当前文件/依赖同名不覆盖。source-paths集中映射；摘要优先具体源码行列而非先到通用ERROR。真实公开枚举夹具通过三类失败、自动四文件源序、层级与8组完整真值表。用户当前字符串版full_adder在实际Qoder Node24.15/Electron42.2执行解包alpha6后默认自动选择half_adder+full_adder，8节点/两个半加器、原文件哈希不变。没有写用户RTL、配置、XPR。

JS150、Golden38/38、既有Node511通过1可选跳过、电路138/138、Rust121/121；VSIX441文件/425逐字节核验，包内原生ABI可加载。自动扫描4096文件/单文件2MiB/总32MiB、工作区真实路径范围；不展开宏/条件编译，不自动import或改参数。含include的脏依赖必须先保存，防止迁移后选择错误的同名头；已用真实工具证明原错误并有拒绝回归。完整IDE UI未复验。保持独立worktree和Draft PR11，不自动合入或发Release。详细交付与35文件清单见docs/V4_1_ALPHA6.md；后续优先实际IDE使用反馈及复杂预处理文件表支持。

# 4.1 alpha5 开发交接

2026-10-16：用户确认电路慢在拖拽、缩放和选择。alpha5加入共享拓扑/搜索/别名索引、静态视口包围盒树、屏外SVG移出活动DOM、低倍率细节控制。相机按rAF提交，滚轮复用视口几何；高亮只更新差集。保持对象身份、绘制顺序、网络连接和屏外搜索；换图/加载/取消/销毁清理帧，手动相机resize不重置。Edge155本机2000节点/5994边，缩放帧中位数alpha4两次250.3/280.9ms→31.2ms，选择处理2→0.3ms，活动SVG54646→1558；8%总览仍约62.5ms，有明确边界。最终包内复测281.0→31.2ms、选择2→0.3ms。实测JS143、Golden38/38、既有Node511通过1可选跳过、电路118/118、Rust121/121。437文件/421逐字节核验；Qoder真实运行时加载包内原生ABI通过。详细实测、检查与文件清单见docs/V4_1_ALPHA5.md。浏览器替代桥不算完整IDE宿主验收。继续独立worktree与Draft PR11，不自动合并或发Release；旧工程与用户RTL不变。后续先真实宿主和使用反馈，再评估逻辑锥、数据分页及全图绘制方案。

# 4.1 alpha4 开发交接

2026-10-16：用户含timeunit/timeprecision的RTL被旧默认前端拒绝。alpha4新增auto：内置固定Yosys使用Slang、外部沿用read_verilog -sv；显式配置保留。编译单元/模块内声明及未保存正文回归核对异步低有效复位、连接与源位置。错误摘要优先源位置ERROR，WASI提示留在完整日志。右上角Yosys/RTL右键当前文件Vivado/工程面板工程top保持alpha3策略。4.1继续独立worktree和Draft PR11，原master保持4.0 preview。实测电路110/110、既有Node511通过1可选跳过、Golden38/38、Rust121/121；用户实际Qoder CN IDE Node24.15.0/Electron42.2.0执行解包后auto编译原文件→Worker/ELK通过，原文件哈希不变。435文件/419逐字节核验。该验证不是完整UI宿主；交付及清单见docs/V4_1_ALPHA4.md。

# 4.1 alpha3 开发交接

2026-10-16：标题栏默认Yosys，RTL右键当前文件Vivado，工程面板工程top。用户报告的Synth8-439来自旧top的AutoDisabled/编译顺序；文件入口只读打开原工程，在任务目录另存排除run结果的副本，确认切换后重建副本top与顺序。具体ERROR优先于Tcl收尾，脚本路径和中文错误固定UTF-8。alpha2首次验收只覆盖同层级leaf，alpha3补上未引用模块及中文路径。实测公开Vivado未引用/中文路径与工程外拒绝通过，用户实际报错模块2单元/3端口、原XPR/源码SHA256不变；电路99/99、既有Node511通过1可选跳过、Golden38/38、Rust121/121。包435文件/419逐字节一致，实际Code.exe Node模式内置编译通过，UI宿主更新锁仍在。版本/完整清单见docs/V4_1_ALPHA3.md。4.1继续独立worktree和Draft PR11，原master保持4.0 preview；不自动合并或发Release。

# 4.1 开发交接

2026-10-16 alpha2：已修复 RTL 右键 URI 被当作 JSON、缺少 Yosys 的默认体验；新增固定 @yowasp/yosys 0.68.1207 的离线 WASM 后端。默认 `yosysPath=bundled`，可覆盖为外部路径；打包包含 WASM/share/许可，不包含 Python 或 npm runtime。编辑器标题栏 `fromVivadoFile` 选择当前文件模块 top，工程面板 `fromVivado` 保留工程 top。当前文件 Vivado 要求已保存的工程综合源，只用 `synth_design -rtl -top`，不保存或更改 XPR。

alpha2 实测：电路96/96（实际独立Node22/24二进制）、既有Node512项511通过1可选跳过、Golden38/38、Rust121/121；内置工具在Node22/24执行真实RTL流程；Node20无法加载该WASM，最低VS Code提高为1.106，CI覆盖22/24。较早Node22.15.1仍默认关闭exnref，纯Node基线22.20.0。此前npx调用实际仍用Node24，撤回旧Node16/20通过的记录。包内419个文件逐字节核对；解包后使用VS Code自身Node模式完成新网表→Worker→ELK与原生ABI，在当前用户D盘工作区以公开夹具验证源位置。真实Vivado的工程top=top、文件top=leaf结构不同，外部文件明确拒绝且工程文件SHA256均不变。交付见 `docs/V4_1_ALPHA2.md`。

真正UI宿主仍被VS Code安装器的vscode-updating互斥锁阻挡；alpha2 SDK尝试日志 `bin/circuit-alpha2-host.log`，不能将Electron-as-Node编译测试当作完整UI宿主通过。用户工程曾临时配置现有YoWASP启动器用于诊断；已仅移除本轮添加的覆盖设置，使安装alpha2后用默认内置引擎，其他原设置保留。未终止安装器、未绕过更新锁。PR #11 继续保留Draft；master仍为已发布4.0 preview。

2026-10-15 当前状态：4.0.0-preview.1 已经由 PR #10 合入 master（4cc1c737c74e442c76fc618fd90bf6b0e42fcd04），GitHub 预发布已公开，稳定 Latest 仍为 3.5。原目录 `D:\Workspace\FPGA\02_svtools` 保持此发布基线；已有私有 Rust 调试缓存保留。发布地址：https://github.com/JayceVane/SV-Tools/releases/tag/v4.0.0-preview.1 。

4.1.0-alpha1 位于独立 worktree `C:\Users\JayceVane\.codex\worktrees\svtools-circuit\02_svtools`，分支 `codex/feat-circuit-viewer`。已完成 Yosys JSON → netlistsvg 真实数据验证、独立模型、ELK.js + SVG 交互及 Vivado 同模型适配。Vivado 2022.1.2 真实只读工程验证通过；其首版视图为平坦 RTL 详细化。Yosys builtin/slang 两条实际流程均通过。操作与限制见 `docs/CIRCUIT.md`，交付记录见 `docs/V4_1_ALPHA1.md`。

本轮包含 75 项电路测试（Node 24通过；当时标注Node20的npx命令实际仍是Node24，此处撤回该兼容声明）、121 项 Rust 测试、既有功能回归及公开 RTL 夹具验收。真实浏览器验证明暗主题、参数化模块下钻、网络高亮、平移缩放与源位置；VS Code 独立宿主启动被本机更新锁阻止，未将浏览器替身计为真实宿主通过。复验入口 `scripts/verify-circuit-host.ps1`。

接下来：在 VS Code 更新结束后运行独立宿主验收；根据用户实用反馈完善电路交互，再评估逻辑锥和更大设计的局部加载。不得将 4.1 自动合入 master 或另发 Release。FSDB 仍取消，二维 mem 保留；Vivado IP 仍仅计划。

以下为 4.0 历史交接（版本与工程边界以上文为准）：

2026-10-15 发布交接：用户已授权将当前成果发布为 GitHub `4.0.0-preview.1`，通过 PR 合入原工程，并从合入基线独立开发下一版本。此授权替代下文“原目录只维护3.x”的历史边界；仍不得覆盖用户未提交内容。发布说明见 `docs/releases/v4.0.0-preview.1.md`。下一版本路线：Yosys JSON → netlistsvg 验证，独立电路模型，ELK.js + SVG 交互视图，Vivado 适配同一模型。

最后更新：2026-10-15。当前里程碑为本地 `4.0.0-alpha13`，分支 `codex/refactor-v4`。

## 完成内容

- alpha13：修复`if (...) begin`未走单行分号紧凑路径的问题；与always事件头共用词法屏蔽、平衡括号与紧凑规则，支持重复拼接/移位、多条件、else if及用户换行。
- inlineCompact=false保留条件空白，保护区/宏/转义标识符保留；alpha12字符保全不变。用户task增加golden，完整清单与根因见`docs/V4_ALPHA13.md`。

- alpha12：格式化只允许改变ASCII空格、Tab、CR、LF，其余字符的内容/数量/顺序必须一致；乱码、不完整语法和全部配置同样受约束，异常或不安全候选保留对应入口原文。
- Rust全文/普通段/兼容beautifier/选区对齐共享守卫；NAPI严格UTF-16保留孤立代理项，编辑器替换前独立复核。代码生成命令不受布局规则限制，无效UTF-8 CLI输入不写坏原文件或已有输出。
- 保全优先于声明拆分等改写正文的候选。旧赋值对齐lookahead正则仍是维护项，panic现由守卫捕获并保留原文；未扩大修复。完整清单与根因见 `docs/V4_ALPHA12.md` 及其中bug笔记。

- alpha11：目录和名称/A-B栏右边界可拖动并保存，取消回滚；双击/Home默认、方向键8px/Shift32px。保存请求宽度与有效clamp分离，恢复窗口保留用户设定。
- 主菜单272→232px、格式子菜单282→244px；49条字体声明保持，正文12px、行32px，完整操作与详情提示。新列几何/控制器分离，无新增依赖。
- 真实页面目录252→320px、名称270→350px，各请求一次窗口，values不重查；500px窗口恢复、二维mem边界和明暗菜单均通过。完整清单与验收见 `docs/V4_ALPHA11.md`。

- alpha10：按用户要求保持所有字号、字体、字距和图标尺寸，只收紧菜单标题、分区、页脚及菜单项留白；菜单项36→32px。
- 同一FP32上下文实测：主菜单380→325px，格式子菜单505→437px；宽度仍272/282px，正文12px。生产JS逻辑未改。
- 本轮验收、字体声明比对与完整清单见 `docs/V4_ALPHA10.md`。

- alpha9：右键菜单增加信号名称/位宽摘要、选择数量和当前格式徽标，整数/波形/浮点分区，分组线性图标与独立移除配色；明暗主题细化间距、圆角、阴影和焦点。
- 悬停展开90ms、切换收起150ms，跨入子菜单取消待收起任务；键盘/关闭取消定时器，向左展开时箭头反向。摘要按纯文本写入，长名称有完整提示。
- 本轮交付与修改清单见 `docs/V4_ALPHA9.md`。

- alpha8：Analog/real 行底边可直接拖动，默认100px、范围60–480px，保存恢复时校验高度；数字行维持38px。
- 多选排序增加浮动名称与数量、插入线、实时让位及180ms动画；边缘自动滚动，减少动态效果偏好直接归位。
- Pointer 捕获、Escape、失焦和取消统一处理；未完成手势恢复高度、选择和滚动，预览不逐帧查询或保存。
- 纯行几何 `row-layout.js`、手势 `row-gesture.js` 与绘制分离；共享真实控制器测试夹具，避免重复。
- alpha8 操作见 `docs/WAVEFORM.md`，验收、包核验和完整清单见 `docs/V4_ALPHA8.md`。

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

- alpha13：104个JS、golden38/38（19个样例）、Node510/510、Rust121/121；新增Rust4与Node7，针对性if合同11/11。native/CLI同步重建，原18个golden目标未改。
- 当前包`bin/svtools-4.0.0-alpha13.vsix`，83条目/79项逐字节一致、61个运行JS/CSS，106个中英文配置引用和公共JS/TS签名通过。SHA与实测见alpha13记录。

- alpha12：104个JS、golden36/36、Node503/503、Rust117/117；新增5项Rust、7项编辑器、20项真实native/CLI合同。固定14×6与变异64×6语料两轮守恒/幂等，正常排版仍生效，native/CLI同步重建。
- 当前包 `bin/svtools-4.0.0-alpha12.vsix`；日志、质量与包核验见alpha12交付记录。本轮不需要临时浏览器或预览服务。
- alpha12包83条目/79项逐字节一致、61个src运行JS/CSS；106个中英文配置引用及公共JS/TS签名通过。大小/SHA见`bin/alpha12-package-report.json`；本轮分支本地保存，未推送或发布。

- alpha11：102个JS、golden36/36、Node476/476；新增两栏合同28项，针对性74/74，native/CLI同步重建。49条字体声明与alpha10一致。
- 当前包 `bin/svtools-4.0.0-alpha11.vsix`；验收和明暗截图 `bin/waveform-acceptance/run-PFgZRR`，包核验见alpha11记录。
- alpha11包82条目/78项逐字节一致、60个src运行JS/CSS；106个中英文配置引用通过，大小与SHA见 `bin/alpha11-package-report.json`。本轮产物保留、临时浏览器和服务已关闭；分支本地保存，未推送或发布。

- alpha10：97个JS、golden36/36、Node448/448；native/CLI同步重建，76项包内文件逐字节一致。全部字体相关声明与ff45942/alpha9相同，浏览器测量和明暗截图通过。
- 当前包 `bin/svtools-4.0.0-alpha10.vsix`；报告与截图 `bin/waveform-acceptance/run-hk45QS`，临时浏览器和服务已关闭。

- alpha9：97个JS、golden36/36、Node448/448；新增4项菜单合同，针对性交互/手势/绘制46/46。native/CLI同步重建到alpha9，Rust实现未改。
- 真实浏览器与Worker验证明暗主题、格式分区、当前项、禁用提示、键盘End跳过禁用项、Esc恢复Canvas焦点，以及右侧边缘子菜单向左展开与反向箭头；无console警告/错误。
- alpha9历史包 `bin/svtools-4.0.0-alpha9.vsix`，80条目、76项逐字节一致；报告与截图在 `bin/waveform-acceptance/run-4aTFwu`。

- alpha8：97 个 JS、golden36/36、Node444/444；新增几何6、真实控制器手势14、Canvas3项。Rust实现未改，alpha7的112项测试基线保留；alpha8 native/CLI版本同步重建。
- 真实 Worker 与浏览器验证100→220px实时缩放、220→140px后Esc恢复、布局恢复、两条信号整体置顶及明暗主题；Canvas保持518px高，A/B及时间窗不变。
- 同可见集合排序前后 window=2、values=4、edge=0，没有新增查询。无console警告/错误；预览报告与截图在 `bin/waveform-acceptance/run-K0UTnZ`，缩放报告在 `run-kRRV2v`。
- alpha8历史包 `bin/svtools-4.0.0-alpha8.vsix`，80条目、76项逐字节一致，核验见alpha8记录。

- alpha7：92 个 JS、golden 36/36、Node 421/421、Rust 112/112；CLI/native 同步版本并重建，CLI 为 4.0.0-alpha7。
- alpha7 浮点测试包括 FP16/BF16 各 65536 编码、E3M4 256 编码穷举，FP64/FP32 独立 DataView 对照，TF32 双布局、NaN/X/Z/负零与无效容器。
- alpha7 真实浏览器与真实 VCD Worker 验收明暗主题、Shift 收缩、右键多选、混合位宽格式禁用、分组、状态恢复、二维 mem FP32 A/B、菜单键盘与边缘定位；无 console 警告/错误。
- 验收产物 `bin/waveform-acceptance/run-gbrTl4`；临时浏览器与 loopback 服务已关闭。
- alpha7 历史包 `bin/svtools-4.0.0-alpha7.vsix`；大小、SHA 与逐字节核验见 alpha7 记录。

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

1. 以 alpha13 VSIX 验证用户实际工程，保持字符保全最高优先级；独立修复旧选区赋值对齐的unsupported lookahead。
2. 单独处理GNU+inlineCompact=false从同行begin转换时的首轮/二轮缩进差异；本轮GNU条件回归使用GNU原有块布局，不代表样式转换已修复。
2. 用实际100–500MB RTL波形对照仿真/GTKWave，评估更多信号数和事件密度。
3. 下一轮统一 CompilePlan：源文件、include、宏、top、工作目录和引擎能力，避免 lint/仿真参数漂移。
4. 随后实现内容驱动的增量源码索引与有配置键的只读缓存；不要恢复共享可写 xsim.dir。
5. 审查4.0分支后走PR和发布流程，Marketplace使用其接受的预发行版本格式。


## 2026-10-21 beta.7

用户接受六项优化，继续独立codex/feat-circuit-viewer worktree，原工程未改。
实现隐藏位设置保留、分组收起与整体排序、.svwave.json布局复用、游标覆盖画布及模拟量统计缓存。
共享source-catalog和XPR成员适配注入四个消费者，实际仿真入口随自动波形打开传递。
真实Qoder补全22/22、波形3/3、电路5/5；首次扫描竞争和外部include缓存失效已修复并补联合回归。
新增2万独立信号/4000别名/长层级/密集跳变语料；100/500MiB继续验证。
VS Code主程序仍被vscode-updating锁阻止，不伪称通过；Qoder真实Webview与宿主已运行。
版本统一4.0.0-beta.7，新增package:preview门禁，禁止同号产物覆盖，记录干净commit和SHA256。
交付文档docs/V4_BETA7.md，产物与本机报告均在忽略bin中。后续继续完善4.0，经授权后再合并/发布。


## 2026-10-23 beta.8 图片导出

用户要求波形和电路导出，黑白文档风或当前主题。已接通两个工具栏入口、SVG/高清PNG和宿主保存服务。
波形独立查询AB区间，自动画幅，支持所选信号、派生位/浮点/模拟量/mem；电路导出当前模块完整布局，
不遗漏屏外节点或受现场LOD影响。共用graphics边界，未引入依赖或改变原工程。
真实Edge验证两主题/两风格/两格式，Qoder波形宿主4项与电路5项通过。Node22关键合同26项通过。
完整测试与产物SHA补在docs/V4_BETA8.md；beta7安装包保留，新交付版本4.0.0-beta.8。
后续可继续完善4.0，仅经用户授权合并/发布，不增加FSDB或IP管理范围。
