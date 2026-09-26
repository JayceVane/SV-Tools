# Changelog

All notable changes to the SystemVerilog VSCode Extension will be documented in this file.

## [3.4.3] - 2026-09-26

### Added
- **配置与命令中文本地化**：设置界面（Settings）中的全部配置项标题/描述与命令面板命令标题支持中文（`package.nls.zh-cn.json`），VSCode 界面语言为中文时自动生效，英文界面保持英文（51 条文案：38 项配置 + 12 个命令 + 配置节标题）

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
