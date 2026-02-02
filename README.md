# SystemVerilog Align Formatter for VSCode

A Verilog/SystemVerilog formatter for Visual Studio Code, adapted from the Sublime Text SystemVerilog plugin.

## Features

- Automatic formatting of Verilog and SystemVerilog files
- **Full Unicode support** - Works correctly with Chinese, Japanese, Korean, and other UTF-8 encoded comments
- Alignment of:
  - Module port declarations
  - Signal/variable declarations
  - Module instance ports
  - Parameters
  - Assign statements
  - Case statements
  - Always blocks
- Configurable indentation style (spaces or tabs)
- Strip empty lines option
- One declaration/binding per line options

## Requirements

- [Python 3.6+](https://www.python.org/downloads/) installed and available in PATH
- Visual Studio Code 1.74.0 or higher

## Installation

### From Source

1. Clone or download this repository
2. Open VSCode
3. Press `F5` to open a new Extension Development Host window with the extension loaded
4. Or package the extension:
   ```bash
   cd vscode-extension
   npm install
   vsce package
   ```
   Then install the `.vsix` file in VSCode

### Manual Installation

1. Copy the `vscode-extension` folder to your VSCode extensions directory:
   - Windows: `%USERPROFILE%\.vscode\extensions`
   - Linux: `~/.vscode/extensions`
   - macOS: `~/.vscode/extensions`

2. Rename the folder to `sv-align`

## Usage

### Format on Save

Add to your VSCode `settings.json`:

```json
{
  "[verilog]": {
    "editor.formatOnSave": true
  },
  "[systemverilog]": {
    "editor.formatOnSave": true
  },
  "svAlign.pythonPath": "python"  // or "python3" on Linux/Mac
}
```

### Manual Formatting

- Windows/Linux: `Shift+Alt+F`
- macOS: `Shift+Option+F`
- Or right-click in editor and select "Format Document"

### Format Selection

Select a block of code and use the format command to format only the selection.

## Configuration

All settings are available under the `svAlign` section:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tabSize` | number | 3 | Number of spaces for indentation |
| `useTab` | boolean | false | Use tab for indentation |
| `oneBindPerLine` | boolean | true | One port binding per line in module instance |
| `oneDeclPerLine` | boolean | false | One signal declaration per line |
| `paramOneLine` | boolean | true | Keep parameters on one line if possible |
| `indentStyle` | string | "1tbs" | Indentation style ("1tbs" or "gnu") |
| `stripEmptyLine` | boolean | true | Strip empty lines |
| `instAlignPort` | boolean | true | Align instance ports |
| `ignoreTick` | boolean | true | Ignore preprocessor directives for indentation |
| `importSameLine` | boolean | false | Keep import on same line as module declaration |
| `alignComma` | boolean | true | Align comma/semicolon |

### Example Configuration

```json
{
  "svAlign.tabSize": 4,
  "svAlign.useTab": false,
  "svAlign.oneBindPerLine": true,
  "svAlign.oneDeclPerLine": false,
  "svAlign.paramOneLine": false,
  "svAlign.indentStyle": "1tbs",
  "svAlign.stripEmptyLine": true
}
```

## Custom Python Path

If Python is not in your system PATH, you can specify the path:

```json
{
  "svAlign.pythonPath": "C:\\Python39\\python.exe"
}
```

## Development

### Project Structure

```
vscode-extension/
├── extension.js           # VSCode extension entry point
├── package.json           # Extension manifest
├── python/               # Python formatter scripts
│   ├── formatter.py      # Main formatter wrapper
│   └── verilogutil/      # Core formatting logic
│       ├── verilog_beautifier.py
│       └── verilogutil.py
└── temp/                 # Temporary files (auto-created)
```

### Testing

1. Make changes to the code
2. Press `F5` to launch Extension Development Host
3. Open a Verilog/SystemVerilog file
4. Test the formatting

### Example

**Before formatting:**
```systemverilog
module test(
input clk, // 时钟信号
input rst_n, // 复位信号
output [7:0] data // 数据输出
);
logic [7:0] buffer;
assign data = buffer;
endmodule
```

**After formatting:**
```systemverilog
module test (
   input        clk    , // 时钟信号
   input        rst_n  , // 复位信号
   output logic [7:0] data  // 数据输出
);
   logic [7:0] buffer;

   assign data = buffer;

endmodule
```

### Debugging

1. Open VSCode with the extension sources
2. Set breakpoints in `extension.js` or `python/formatter.py`
3. Press `F5` to start debugging
4. Check the "Output" panel for error messages

## Credits

This VSCode extension adapts the formatting logic from the [Sublime Text SystemVerilog plugin](https://github.com/nicolas3d/SystemVerilog) by Nicolas Belmonte. All core formatting algorithms are preserved from the original implementation.

### Original Author
- **Nicolas Belmonte** - [Sublime Text SystemVerilog Plugin](https://github.com/nicolas3d/SystemVerilog)

### VSCode Extension
- **JayceVane** - [VSCode integration wrapper](https://github.com/JayceVane)
  - Email: [JayceVane@163.com](mailto:JayceVane@163.com)

## License

Copyright (c) 2025 JayceVane

Licensed under the [Apache License, Version 2.0](LICENSE). See the [NOTICE](NOTICE) file for information about third-party code.

This extension includes the core formatting logic from the Sublime Text SystemVerilog plugin, which is also licensed under the Apache License, Version 2.0.

### Summary

You may:
- ✅ Use this extension for commercial and personal projects
- ✅ Modify and distribute the code
- ✅ Sublicense the code

You must:
- ⚠️ Include the original copyright and license notice
- ⚠️ State any significant changes made to the files

For full terms, see the [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0).
