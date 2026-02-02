# VSCode Extension Project Structure

```
vscode-extension/
├── .vscode/
│   ├── launch.json          # Debug configurations
│   └── tasks.json           # Build tasks
├── python/
│   ├── formatter.py         # Main formatter entry point
│   └── verilogutil/         # Core formatting logic
│       ├── __init__.py
│       ├── verilog_beautifier.py
│       └── verilogutil.py
├── temp/                    # Temporary files (auto-created)
├── .gitignore
├── example.sv               # Example SystemVerilog file
├── extension.js             # VSCode extension entry point
├── language-configuration.json
├── package.json             # Extension manifest
└── README.md                # User documentation
```

## Quick Start

### Method 1: Development Mode (F5)

1. Open the `vscode-extension` folder in VSCode
2. Press `F5` to launch a new Extension Development Host window
3. In the new window, open `example.sv` or any `.sv`/`.v` file
4. Format with `Shift+Alt+F` (Windows/Linux) or `Shift+Option+F` (Mac)

### Method 2: Install from Source

1. Install Node.js dependencies (optional, for packaging only):
   ```bash
   cd vscode-extension
   npm install
   ```

2. Package the extension:
   ```bash
   npm install -g vsce
   vsce package
   ```

3. Install the `.vsix` file:
   - In VSCode: Extensions → ... → Install from VSIX
   - Or command line: `code --install-extension sv-align-1.0.0.vsix`

### Method 3: Manual Installation

1. Copy the entire `vscode-extension` folder to:
   - Windows: `%USERPROFILE%\.vscode\extensions\sv-align`
   - Linux/Mac: `~/.vscode/extensions/sv-align`

2. Restart VSCode

## Configuration

Add to your VSCode `settings.json`:

```json
{
  "[verilog]": {
    "editor.formatOnSave": true
  },
  "[systemverilog]": {
    "editor.formatOnSave": true
  },
  "svAlign.pythonPath": "python"  // or "python3"
}
```

## Troubleshooting

### Python not found

If you see "Python not found" error:

1. Make sure Python 3.6+ is installed
2. Check it's in your system PATH
3. Or specify the path in settings:
   ```json
   {
     "svAlign.pythonPath": "C:\\Python39\\python.exe"
   }
   ```

### Formatting not working

1. Open the Output panel in VSCode (View → Output)
2. Select "SystemVerilog Align Formatter" from the dropdown
3. Check for error messages
4. Ensure the file has `.sv`, `.svh`, `.v`, or `.vh` extension

### Debug mode

1. Open `vscode-extension` folder in VSCode
2. Set breakpoints in `extension.js` or `python/formatter.py`
3. Press `F5` to start debugging
4. Check the Debug Console for output

## Development Notes

- The extension uses Python subprocess to execute the formatter
- Original formatting logic from Sublime Text is preserved in `verilog_beautifier.py`
- No modification needed to the core Python code
- VSCode handles the editor integration and configuration
