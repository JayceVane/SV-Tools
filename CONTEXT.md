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
