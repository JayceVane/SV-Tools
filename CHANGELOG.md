# Changelog

All notable changes to the SystemVerilog VSCode Extension will be documented in this file.

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
