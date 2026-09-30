# Changelog

All notable changes to the SystemVerilog VSCode Extension will be documented in this file.

## [3.4.6] - 2026-09-29

### Added
- **格式化规范 `docs/FORMAT_SPEC.md`**：格式化器唯一权威行为定义——术语（语句/块/容器）、11+2 个配置项、预处理/缩进/空行/对齐/单行保留全量规则、专项构造规则、golden 测试约定；实现与规范冲突先修实现对齐规范
- **单行/多行双轨对齐架构**：用户未换行的语句走单行对齐逻辑（紧凑），显式换行的走多行对齐逻辑（列对齐）
- **行内紧凑开关 `svtools.inlineCompact`**（默认开）：单行语句（系统任务调用、`else $error(...)`、单行模块例化、task 头等）词间空白折叠、括号/逗号/分号紧邻空格删除、只删不补；关闭则保持原有空格
- **行间紧凑开关 `svtools.blankCompact`**（默认开）：关闭为保持模式——不插入、不删除空行仅折叠，硬不变量"格式化不得新增空行"；为此格式化器内部空行伪影源头全部消除（声明组尾部换行、对齐多趟 split 尾空元素、行中 flush 种子空行、EOF 尾随换行）
- CLI 新增 `--no-inline-compact` / `--no-blank-compact`
- golden 格式化用例扩充至 14 个：新增 ex7（assign 多行拼接）、ex8（类/约束/covergroup）、ex9（interface/clocking/modport/SVA）、ex10（testbench/fork/mailbox/队列）、ex11（tb_top + 单/多行 constraint）、ex12（property/sequence 空格归一化）、ex13（单行紧凑），全部含幂等校验

### Fixed
- **空行规则统一裁决**（`blank_rules.rs`，spec §6）：块内（task/function/property/sequence/covergroup/clocking 体、begin/end、case、fork、constraint `{}`、多行括号续行）删除全部空行；块级边界保证 [1, max] 空行分隔；语句间保留折叠——替换原先依赖两处"事故性空行"（align_decl 尾部伪影 + flush 后种子空行）的不一致行为
- **单行写法保留**：单行 `constraint {...;}`、单行参数列表 `function new(bit [7:0] a = 0);`、单行模块例化保持单行不展开；用户显式换行才展开（constraint 内联 `}` 拆独立行、参数逐行对齐）。根因：preprocess 花括号深度跨行累计、行尾 `\}` 不在语句结束正则、task_func_param 无条件展开
- **sequence/property 块头与块体之间多出空行**（块头形似声明被分进 Decl 对齐）
- **property/sequence 体内空格归一化**：`property   p;` → `property p;`、`$rose(valid  )` → `$rose(valid)`、`|=>   wdata` → `|=> wdata`（只删不补，字符串/注释保护）
- **`end else if (...) begin` 的 else 落在第 0 列**（generate 链常见写法，buf_wrapper 三件套非幂等根因）；else 分支前不留空行
- **modport 列表续行中的 `clocking` 字样被误判为 clocking 块头**，上下文永不闭合导致后续空行整段被删
- **对齐分组空行敏感导致的幂等破坏**：空行曾把对齐组切断（空行缩进算 0），空行增删使两遍格式化算出不同列宽（sfp_dma_rx 的 dbg 声明组、reg_ctrl 的 case default 等 7 文件）——现对齐分组对空行透明，Decl 块不在空行切断
- **`$display("x", f());` 在 `repeat + wait fork` 后被从字符串闭合处断行**：string-end 处理器语句中途回收 line 所致；comment-block-end 同机理（属性 + 行中块注释的 `;` 甩到独立行）——中途回收收窄为仅整体 flush 时进行；`is_decl_line` 判定前剥离行中块注释
- **assign 多行拼接 `{` 破行空行**（issue #3 花括号变体）：闭合行 `};` 独占一行时不再被切断产生空行；悬空运算符判定改取最后一条非空行；未写完语句内部的空行残留自动清除（被旧版损坏的文件重新格式化即可自愈）
- **SystemVerilog 验证代码六处破坏修复**（用类/约束/covergroup/clocking/断言/fork 压测发现）：
  - `module m;` 无端口头部模块名被吞，且无名 Module 块吞掉后续声明行
  - 空 bw 捕获组幻影空格：无位宽用户类型声明多补一列（`class  c;` / `return  sum;`）
  - 限定类型（`pkg::type`）列宽不含 scope 前缀，名字与类型粘连（`pkt_tq`）、二次格式化吞行
  - 裸 `fork` 块被误判为模块实例（DOTALL 跨行匹配），整块被实例对齐重排；`join_none repeat()` 同理
  - `wait fork;` / `disable fork;` 不再推 fork 块状态
  - `covergroup with function sample(...)` 的采样头子句不再误推块状态；`clocking` 块体正确缩进
- 实测工程 120 文件幂等校验从 38 文件样本扩展：111/120 稳定（余 9 个为历史存量问题，见 spec 待办）

## [3.4.5] - 2026-09-28

### Fixed
- **格式化引擎按用户校对后的 golden 基准全面对齐**（`node test/golden_test.js` 7 用例 14 项全绿，含幂等；真实工程样例输出零漂移）：
  - **CRLF 输入产生伪空行**：preprocess 入口统一行尾归一——此前 `\r` 被语句拆分当作行内剩余内容，每条语句后多出空行，同一文件 LF/CRLF 输出不一致
  - **语句拆行规则**：单行 `begin ... end` 紧凑写法整行保留；`begin` 后同行有语句且本行无闭合 `end` 才断行；`endcase`/`end` 前有内容时断行（`end end` 拆两行）
  - **case 项对齐此前从未生效**：对齐正则含 `(?!:)` 前瞻，Rust regex 不支持导致整趟对齐被静默跳过；改为无前瞻正则 + 紧凑/规范双模式——同行多语句的紧凑风格保留（`4'd0:result<=x;`），一句一行时补运算符空格（`result <= x;`）
  - **续行空白压缩破坏既有对齐**：assign 对齐的非匹配行统一压缩空格，会把已对齐的 assign 组 / case 项 / 实例端口列填充压掉；现仅对破行表达式中间片段（行尾悬空运算符）压缩，完整语句行原样保留
  - **行续接（反斜杠结尾）被拆断**：宏 / 断言多行语句整行保留
  - **语句块内赋值列对齐**：for / if 体等语句块的 `<=`/`=` 操作符列对齐
  - **单行 for 头运算符空格规范化**：`for(int i=0;i<len;i++) sum+=data[i];` → `for(int i = 0; i < len; i++) sum += data[i];`
  - **modport 按方向拆行**：`modport master(output a,b,input c);` → `output a, b,` 与 `input c` 两行，逗号后补空格
  - **紧凑声明参与对齐**：`logic[ID_W-1:0] awid;`（类型与位宽间无空格、无初值）现参与声明对齐（位宽右对齐、名字/分号列）；带初值的保持原样
  - **interface 端口丢空格**：`axi_if.master axi` 不再被格式化成 `axi_if.masteraxi`
- golden 用例扩充至 7 个（新增 ex1.1 条件块展开、ex5 参数注释列对齐、ex6 声明对齐 / modport / interface 端口），全部含幂等校验；ex2 与 ex6 的 interface 输入段相同，target 已统一为对齐形式

## [3.4.4] - 2026-09-28

### Fixed
- **module/interface `#(...)` 参数列表三处严重破坏**（用户报告于 issue #3 后续反馈）：
  - **参数值错位/丢失**：参数对齐重建误输出"当前值与下一个参数值的字典序最小者"（`values[i].min(values[i+1])` 移植笔误）——`parameter BC = DATA_WIDTH>>3` 会变成 `= 0`、最后一个参数值变成空
  - **尾逗号丢失**：`parameter A = 16 ,// comment` 形态下补逗号判定被行尾注释遮挡，且逗号会被补到注释之后；现按去注释文本判定并插在注释之前
  - **同行多参数整体丢失**：`parameter ADDR_W=32,parameter ID_W=4` 同行写多个参数时，行首锚定的解析每行只识别第一个，其余参数在格式化后消失（ex2 的 `ID_W=4` 场景）；现已预拆行，全部保留
- **assign 表达式破行格式化后多出空行**（issue #3）：`assign x = (` 或行尾 `||` 等悬空运算符的破行不再被错误切断语句块

### Added
- **Golden 格式化测试基建**：`example/` 放格式化前输入、`example/target/` 放期望输出，`node test/golden_test.js` 自动比对 + 幂等双检；新增 issue #3 破行 assign、aurora 参数注释、interface 同行参数三个回归用例，后续新发现的格式化问题按此流程持续加用例

## [3.4.3] - 2026-09-28

### Added
- **Vivado TCL 集成与工程创建**
  - **TCL 脚本运行**：命令面板 "Vivado: 运行 TCL 脚本"（工作区内选择）或 `.tcl` 编辑器右键 "运行当前 TCL 脚本"；以 `vivado -mode batch -nolog -nojournal -source` 执行，输出流式进入独立通道，状态栏显示运行状态，支持停止（Windows 进程树终止）与超时（`timeoutMs`，默认不限时）
  - **工程创建向导**：工程名 → 工程目录 → 源文件多选（按工程结构模板预分类）→ **器件选型详情页（webview 单页：系列/封装/速度筛选下拉联动 + 搜索框输入即联想 + 器件表格可排序 + 选中详情条，双击或回车确定；首次经 `get_parts` 导出器件库并缓存，之后秒开）** → 顶层模块（工作区自动识别候选，被实例化的模块自动降权）；生成 `create_project` TCL 到 `.svtools/vivado/create_prj.tcl` 并可一键执行；工作区无源文件时可按模板创建目录骨架（`src/`、`sim/`、`prj/`）
  - **代码结构**：Vivado 能力按大项拆分为 `vivado/` 文件夹多模块（`index.js` 集成层 + `toolchain.js` 工具链定位 + `tclgen.js` TCL 生成 + `structure.js` 工程结构模板 + `parts.js` 器件库 + `scan.js` 工作区扫描），纯函数层不依赖 vscode 可独立单测；`require('./vivado')` 兼容不变
  - **工程结构模板**（`svtools.vivado.structure`，可完全自定义）：目录 glob 把文件划入 sources_1 / sim_1 / constrs_1 文件集与工程输出目录，默认 `src`/`rtl`→RTL、`sim`/`tb`→测试台（重叠时优先归 sim）、`constraints`/`xdc`/`*.xdc`→约束、工程目录 `prj`；未匹配文件以 tb_ 前缀启发兜底或手动勾选
  - Vivado 自动探测（配置 `svtools.vivado.path` → `XILINX_VIVADO` → `PATH` → 常见安装位置），Windows 经 `cmd /c` 逐参引号调用 `vivado.bat`（Node 24 安全限制），脚本相对路径以其所在目录为 cwd
  - **sv/v 标签页右上角按钮**：▶ 仿真按钮弹出引擎选择（Icarus Verilog / Vivado xsim，xsim 将当前文件模块自动置为 sim_1 顶层并补入缺失文件，`simRuntime` 默认空 = 跑到 `$finish`，可设具体时长如 1000ns）；工作区存在 Vivado 工程（.xpr）时额外显示 ⊕ 加入工程（左键添加 / 右键移除，文件集按结构模板预判可选），无工程时不显示；`.tcl` 标签页右上角 ▶ 直接运行当前脚本（右键按钮弹出工作区脚本选择）
  - runScript 返回 `Promise<{code, ms, issues}>` 结构化结果（供后续 AI Agent 工具复用）
- **配置与命令中文本地化**：设置界面（Settings）中的全部配置项标题/描述与命令面板命令标题支持中文（`package.nls.zh-cn.json`），VSCode 界面语言为中文时自动生效，英文界面保持英文
- **波形查看器**（3.4.3 测试期间迭代）：
  - **总线跳变改为 X 交叉**：陡峭对角交叉线替代六边形斜坡过渡，密集跳变不再有"波浪/曲线"视觉；填充改为整条带半透明一次铺满
  - **x/z 状态分色**：x 红（#ef5350）、z 深蓝（#7986cb），标量与总线一致，总线混合值含 x 优先红
  - **全名切换入口加到波形区底部工具栏**（Fit 旁"全名/简称"按钮，与信号树顶部按钮状态同步）——信号树面板收起时也能切换
  - **"全部显示"按钮仅在单独显示（solo）模式激活时出现**，平时不占位

### Fixed
- **工程创建向导崩溃**（cannot open …/create_prj.tcl）：脚本落盘改为 `writeFile` 直接写入——原先 `openTextDocument` 对尚不存在的文件直接抛错
- **xsim 仿真被 1000ns 截断**：`simRuntime` 默认改为空 = `run all` 跑到测试台 `$finish`（原固定 1000ns 提前截断；runtime 空串直接传 `{}` 会导致 tb.tcl 无 run 命令、一条激励都不跑）
- **timescale 单位变体兼容**：`parseTimescaleSeconds` 支持 VCD 标准的 `sec`/`msec`/`nsec` 等长写法（原只认短写法，遇长写法静默按 ns 假定导致刻度错 10^n 倍）；无法识别时标题区显式提示"按 ns 假定，刻度可能不准"

## [3.4.2] - 2026-09-26

### Added
- **Icarus Verilog 集成：语法检查与仿真验证**
  - **输入（防抖）/ 打开 / 保存 `.v` / `.sv` 文件时自动运行** `iverilog -tnull` lint，诊断进入 Problems 面板（可点击跳转、按行高亮）；未保存的缓冲区内容经临时文件参与检查，输出路径自动回映射到原文件
  - **跨文件模块解析**：工作区内所有含 Verilog 文件的目录自动加入 `-y`/`-I`（文件名=模块名约定）；模块名与文件名不一致时按工作区模块索引自动补编译定义文件（缺模块报错触发迭代重试，最多 3 轮），lint 与仿真均生效（`scanWorkspace` 可关闭）
  - **内置 VCD 波形查看器**：**双击 `.vcd` 直接以波形面板打开**（.vcd 默认编辑器），标签页右上角波形 ↔ 文本一键切换；仿真产生 `.vcd` 后自动打开波形面板（Canvas 渲染，零外部依赖）——信号树按 scope 层级缩进、单击折叠/展开层级、点击加/删波形行；**常量开关**（parameter 批量显示/隐藏，默认隐藏、显示时沉底带"(常量)"标签）；**右键信号二级菜单切换显示格式**（Hex / Bin / Dec 无符号 / SDec 有符号 / Analog 模拟量阶梯折线自动量程，x/z 断开，格式徽标与游标读值联动）；**模拟量行高拖拽**（行底边拖拽 24~240px）；**名称栏拖拽调序**（类似 Vivado，虚线箭头指示插入位，手动排序优先于分组/排序）；**全名/简称切换**（名称栏显示完整层级路径或短名，全名模式自动加宽名称栏）；**Shift 多选 + 右键分组**（Ctrl+点击单选加/减、Shift+点击范围多选，信号树与波形行统一；分组聚拢到第一个成员位置且其余行相对顺序不变，分组后原位输入组名，支持重命名/解除）；**双击层级单独显示该模块**（含子层级，"全部显示"退出并恢复原勾选）；**名称排序 / 按模块分组**；**边沿导航 + 边沿吸附**（点击自动吸附 8px 内最近跳变，◀ 沿 / 沿 ▶ 或 ←/→ 键跳沿并自动居中）；标量/总线/x-z 状态绘制、总线居中标签、游标读值、Ctrl+滚轮缩放、Fit 适配、拖拽平移、**滚轮方向区分（上下滚=滚动信号行，左右滚/Shift+滚轮=平移时间轴）**、刻度尺定位；视口窗口渲染模型，任意时间跨度（数十亿 ticks）流畅缩放，时间刻度尺按 `$timescale` 换算真实物理时间；`autoOpenWaveform` 可关闭，`waveViewer` 配置外部程序（如 GTKWave）时改走外部
  - 仿真编译失败且存在未解析模块时，输出通道给出 `simFiles` 配置提示
  - 每次 lint 在输出通道记录 `[lint] 文件 → N 错误, M 警告 (耗时)` 轨迹，自动触发是否生效一目了然
  - 一键仿真：状态栏 ▶ 按钮 / 命令面板 "Icarus Verilog: Run Simulation"，编译 + vvp 流式输出到独立通道，支持停止与超时自动终止
  - 多文件工程支持：`simFiles` glob 附加源文件、`simTop` 指定顶层、`includePaths` / `libraryPaths` 头文件与模块库目录
  - 仿真产生的 `.vcd` / `.fst` 波形自动检测并提示，可调起外部波形查看器（`waveViewer`）
  - 工具链自动探测（配置 → `IVERILOG_HOME` → `PATH` → 常见目录）；Cygwin 构建 iverilog 缺 `cygwin1.dll` 时自动定位同级 Cygwin 安装注入 PATH（`0xC0000135` 退出码 + DLL 目录启发式）
  - 语言标准自动选择（`.sv`→`-g2012`、`.v`→`-g2005`），`svtools.iverilog.standard` 可覆盖

### Fixed
- **波形查看器：总线信号被渲染成实心色块**——`drawBus` 形参错位导致填充色接收到行高数字、canvas 静默忽略赋值后停留在实心描边色，现已恢复半透明六边形总线带
- **波形区 Shift 多选与分组**——原先多选/分组只能在左侧信号树触发（波形行上 Shift+点击只放游标、分组项永不出现）；现在波形行同样支持 Shift+点击累积多选（名称栏浅蓝高亮反馈）、右键分组/批量改格式，普通点击清除多选
- 手动 lint 命令现在会清除缓存的工具链探测失败状态并强制重新探测，环境修复后无需重载窗口即可恢复自动 lint
- **波形面板折叠 bug**：折叠层级后该 scope 行被一并移除，导致无法再次展开（折叠顶层后整个列表清空）；现在折叠时保留 scope 行（▸ 指示），单击即可再展开

## [3.4.1] - 2026-08-15

### Fixed
- **Syntax Highlighting**: `always@(*)` 敏感列表不再被误判为属性 `(* ... *)` 的开始——原先从该行到文件结尾会全部被吞入属性作用域,`begin`/`end`/`assign`/`endmodule` 等关键字及所有标识符高亮错乱
- **Language Configuration**: 修复括号自动补齐失效——`contributes.languages` 缺少 `configuration` 字段,`language-configuration.json` 从未被 VS Code 加载,选中文字后输入 `(` 无法自动闭合

## [3.4.0] - 2026-07-24

### Added
- Tree-sitter 语法分析器:符号提取、语法高亮、上下文感知补全、悬停提示、跳转到定义
- 新增 `svtools.win32-x64-msvc.node` 原生模块与 CLI 二进制

## [3.3.2] - 2026-07-23

### Fixed
- **Formatter**: Fix extension host crash (panic: index out of bounds) when module parameter list contains comment lines (e.g. `//pragma translate_off`)

## [3.3.1] - 2026-07-23

### Fixed
- **Formatter**: `endmodule` no longer split into `end` + `module` when always block uses `if...begin...end` without `else`
- **Formatter**: Correct indentation after always block with `begin...end` — subsequent statements no longer over-indented
- **Formatter**: `rfind("end")` now uses word-boundary matching to avoid false matches on `endmodule`/`endtask`/`endfunction` etc.

## [3.2.16] - 2025-04-15

### Fixed
- **Module Instantiation**: Remove stray instance prefix from module type line when using parameters (`module_name #(...)` instead of `module_name u_ #(...)`)
- **Parameter Alignment**: Align parameter names in instance parameter list to longest name

## [3.2.15] - 2025-04-15

### Fixed
- **Semicolon Alignment**: Blank lines now separate independent alignment groups — non-contiguous assignment blocks align semicolons independently

## [3.2.14] - 2025-04-15

### Fixed
- **Port Alignment**: Use fixed column widths (direction/var/type/bw) instead of variable prefix length — lines without `reg`/`wire` now correctly preserve column space
- **Semicolon Alignment**: All lines now use unified rebuild output with `trim_end() + padding + ;`, fixing longest-line not being aligned

## [3.2.13] - 2025-04-15

### Changed
- Rewrote port alignment using Python-style prefix length calculation
- Testbench instantiation now uses `build_instance_code` for consistent formatting
- Fixed attribute `(* ... *)` block_state handling in beautifier

## [3.2.12] - 2025-04-15

### Fixed
- **Attribute Alignment**: Fixed `(* ... *)` attribute state management — residual `(` state after attribute end now properly popped
- **Semicolon Alignment**: Added `align_semicolons` function for always block assignment statements

## [3.2.11] - 2025-04-15

### Fixed
- **Beautifier**: Attribute ending now correctly pops residual `(` state from stack
- **Assign Alignment**: Rewrote `align_semicolons` — spaces padded before semicolon instead of after

## [3.2.10] - 2025-04-15

### Fixed
- **Decl Alignment**: Added `attr` capture group to declaration regex for `(* ... *)` attribute prefix support
- **Beautifier**: Fixed block_state for attribute lines — attribute text now stays in block for `align_decl` processing
- **Extension**: Fixed native module load path from `src-rust/` to root directory

## [3.2.9] - 2025-04-15

### Changed
- Simplified testbench init task — only contains `// TODO: add initialization logic` placeholder
- Reset polarity auto-detection: signals ending with `_n` are active-low
- Removed `task_init` function

## [3.2.8] - 2025-04-15

### Fixed
- Testbench instantiation uses `build_instance_code` with port alignment and comments
- Reset polarity auto-detection logic

## [3.2.5] - 2025-04-15

### Changed
- Changed default `instPrefix` from `inst_` to `u_`
- Configuration prefix unified to `svtools`

### Fixed
- Module instantiation port name/signal name alignment with three-column comment alignment
- Parser `psize` not reset causing bit-width inheritance issue
- Removed Python backend files from master branch

## [3.2.0] - 2025-04-01

### Added
- Enhanced Unicode support for comments in all languages

### Fixed
- Minor formatting edge cases

## [3.1.0] - 2025-03-15

### Added
- Improved testbench generation with better signal detection
- Enhanced module instantiation with configurable prefix

### Fixed
- Alignment issues with nested port declarations

## [3.0.0] - 2025-03-01

### BREAKING CHANGES
- **Rust Native Backend**: Complete rewrite using Rust with napi-rs
  - Removed Python dependency entirely
  - Native Node.js addon for maximum performance
  - No external runtime required

### Added
- Rust-based core engine with napi-rs bindings
- Native `.node` module for Windows (x64), Linux (x64), macOS (x64/arm64)
- Zero-dependency installation (no Python needed)

### Removed
- Python daemon process (`daemon.py`)
- `svtools.pythonPath` configuration option
- All Python source files from the extension package

### Changed
- Architecture: Python subprocess → Rust native module
- Startup time: Instant (no Python initialization)
- Memory footprint: Significantly reduced
- Distribution: Single `.node` file per platform

### Technical Details
- Core formatting logic ported to Rust
- Tokenizer rewritten with regex-based approach
- Parser restructured for better maintainability
- Code generation modules (testbench, module_inst, repeat, align, header) ported
- Build system: Cargo with napi-build

## [2.4.1] - 2025-02-24

### Fixed
- **Signal Declaration Spacing**: Fixed spacing in generated signal declarations
  - Added space between type (`reg`/`wire`) and bit specification (`[7:0]`)
  - Now generates: `reg [7:0] data_in;` instead of `reg[7:0] data_in;`
  - Properly formats: `reg clk;`, `wire valid;`

### Before/After
```
// Before:
reg[7:0] data_in;
wire[7:0] data_out;

// After:
reg [7:0] data_in;
wire [7:0] data_out;
```

## [2.4.0] - 2025-02-24

### Added
- **Port Declarations in Module Instantiation**: Enhanced module instantiation with automatic signal declarations
  - Input ports now generate `reg` declarations
  - Output ports now generate `wire` declarations
  - Inout ports now generate `wire` declarations
  - Each declaration on a separate line
  - Parameters generate `localparam` declarations
  - New configuration: `svtools.includePortDeclarations` (default: true)

### Example
```systemverilog
// Before (instantiation only):
my_module u_my_module (
    .clk (clk),
    .rst_n (rst_n),
    .data (data)
);

// After (with declarations):
// Signal declarations
localparam WIDTH = 8;
reg  clk;
reg  rst_n;
wire [7:0] data;

my_module u_my_module (
    .clk (clk),
    .rst_n (rst_n),
    .data (data)
);
```

## [2.3.0] - 2025-02-24

### Fixed
- **Daemon Import Error**: Fixed critical import issue preventing daemon from starting
  - Fixed syntax error in `vg_core.py` (extra closing bracket)
  - Fixed import path in `daemon.py` for `vg_core` module
  - Daemon now initializes successfully on startup

### Technical Details
- Removed duplicate `]` in function signature at line 347 of `vg_core.py`
- Changed import from `verilogutil.vg_core` to `vg_core` in `daemon.py`

## [2.2.0] - 2025-02-24

### Added
- **Module Instantiation**: Generate module instantiation code from module definition
  - New command: `svtools.moduleInstantiation`
  - Keyboard shortcut: `Ctrl+Shift+C` (Windows/Linux) / `Cmd+Shift+C` (macOS)
  - Automatically detects clock and reset signals
  - Copies instantiation code to clipboard

- **Testbench Generation**: Generate complete testbench from module definition
  - New command: `svtools.generateTestbench`
  - Keyboard shortcut: `Ctrl+Shift+T` (Windows/Linux) / `Cmd+Shift+T` (macOS)
  - Auto-generates clock and reset logic
  - Configurable waveform dump type (fsdb/vpd/shm/vcd)
  - Generates init and drive tasks

- **Code Repetition**: Repeat code with number formatting
  - New command: `svtools.repeatCode`
  - Keyboard shortcut: `Ctrl+F12` (Windows/Linux) / `Cmd+F12` (macOS)
  - Supports format placeholders: `{:d}`, `{0:03x}`, `{cb}`
  - Configurable row/column step increments

- **Code Alignment**: Align selected code using verilog-beautifier
  - New command: `svtools.alignCode`
  - Keyboard shortcut: `Ctrl+Shift+X` (Windows/Linux) / `Cmd+Shift+X` (macOS)
  - Supports port declarations, signal declarations, assignments, instance connections

- **File Header Insertion**: Insert standardized file headers
  - New command: `svtools.insertHeader`
  - Keyboard shortcut: `Ctrl+Shift+Insert` (Windows/Linux) / `Cmd+Shift+Insert` (macOS)
  - Template placeholders: `{FILE}`, `{DATE}`, `{TIME}`, `{YEAR}`, `{TABS}`
  - Customizable header template

### Changed
- **Plugin Rename**: Unified plugin name to "SystemVerilog Tools"
  - Package name: `sv-align` → `svtools`
  - All commands now use `svtools` prefix
  - All configurations now use `svtools` prefix
  - Command category: "SystemVerilog Tools"

- **Configuration Consolidation**: Merged all configuration under `svtools` prefix
  - `svAlign.*` → `svtools.*`
  - `svGadget.*` → `svtools.*`
  - Single unified configuration namespace

### Technical Details
- Added `vg_core.py` module with Verilog-Gadget functionality ported from Sublime Text
- Extended daemon.py with new JSON-RPC methods: `module_inst`, `testbench_gen`, `repeat_code`, `align_code`, `generate_header`
- Added header template in `templates/header_template.txt`
- Context menu submenu: `svtools.submenu` for productivity tools

## [2.0.5] - 2025-02-02

### Added
- **Maximum Consecutive Empty Lines Control**: New configurable option to control empty lines
  - New configuration: `svAlign.maxConsecutiveEmptyLines`
  - Default value: 1 (allow at most 1 consecutive empty line)
  - Range: 0-10 (0 = remove all empty lines)
  - Post-processing removes excessive empty lines after beautification
  - Provides fine-grained control over code spacing and readability

### Technical Details
- Added `postprocess_text()` method in daemon.py
- Processes formatted text to enforce empty line limits
- Runs after main beautification to ensure consistent formatting

## [2.0.4] - 2025-02-02

### Fixed
- **Always Keyword Support**: Fixed regex pattern to support all forms of `always` keyword
  - Traditional Verilog: `always @(posedge clk)`, `always @(*)`, `always @(a or b)`
  - SystemVerilog: `always_ff`, `always_comb`, `always_latch`
  - All forms now correctly merge `begin` to the same line in 1tbs mode

## [2.0.3] - 2025-02-02

### Fixed
- **Extended Keyword Support**: Added missing keywords for GNU-to-1tbs conversion
  - Added support for: `fork`, `repeat`, `while`, `do`, `foreach`
  - All common SystemVerilog control flow keywords now supported
  - Verified with comprehensive test suite

## [2.0.2] - 2025-02-02

### Added
- **GNU-to-1tbs Style Conversion**: Automatic preprocessing to convert GNU-formatted code to 1tbs style
  - When using `indentStyle: "1tbs"`, standalone `begin` statements are automatically merged to the previous line
  - Supports keywords: `always_ff`, `always_comb`, `always_latch`, `if`, `else`, `case`, `for`, `forever`, `task`, `function`, `interface`, `module`, `class`, `package`, `program`, `clocking`, `initial`, `final`, and more
  - Enables conversion of existing GNU-formatted code to 1tbs style without manual editing

### Fixed
- Fixed regex syntax error in preprocessing keyword patterns
- Added `else` keyword to 1tbs merging list

### Technical Details
- Preprocessing occurs before main beautification in the daemon
- Only active when `indentStyle` is set to `"1tbs"` (default)
- GNU style (`indentStyle: "gnu"`) is unaffected by preprocessing

## [2.0.1] - 2025-02-02

### Fixed
- **Critical**: Fixed default tabSize configuration not taking effect
  - Updated daemon default nbSpace from 3 to 4
  - Fixed daemon configuration update logic to respect user settings
  - Daemon now recreates beautifier instance on each format request with current options

### Changed
- Default tabSize changed from 3 to 4 spaces
- Configuration changes now take effect immediately without reloading window

## [2.0.0] - 2025-02-02

### Added
- **Performance**: Persistent Python daemon process for faster formatting
  - 87-93% performance improvement (from ~150ms to 10-30ms)
  - JSON-RPC protocol for efficient communication
  - Singleton VerilogBeautifier instance (no repeated module loading)

### Changed
- Architecture: Replaced subprocess spawning with daemon-based approach
- Removed temporary file I/O operations
- Improved resource management and cleanup

### Technical Details
- Daemon process starts once and stays running for the session
- Async formatting with proper timeout handling
- Automatic daemon restart on crashes
- Full UTF-8/Unicode support preserved

## [1.0.0] - 2025-02-02

### Added
- Initial release of VSCode extension
- Full UTF-8/Unicode support for comments (Chinese, Japanese, Korean, emoji, etc.)
- Automatic formatting for Verilog and SystemVerilog files
- Configurable formatting options
- Format on save support
- Format selection support

### Fixed
- **Critical**: Fixed Chinese/Unicode character encoding issues on Windows
  - Forced UTF-8 encoding in Python stdout/stderr
  - Set PYTHONIOENCODING environment variable
  - Ensured proper UTF-8 file I/O operations

### Technical Details
- Extension uses Python subprocess for formatting
- Core formatting logic from Sublime Text SystemVerilog plugin
- Zero modification to original beautifier code
