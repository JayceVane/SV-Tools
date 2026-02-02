# Changelog

All notable changes to the SystemVerilog VSCode Extension will be documented in this file.

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
