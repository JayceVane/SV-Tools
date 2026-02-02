/**
 * Copyright (c) 2025 JayceVane (JayceVane@163.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * This is a VSCode extension adapted from the Sublime Text SystemVerilog plugin
 * by Nicolas Belmonte (https://github.com/nicolas3d/SystemVerilog)
 */

const vscode = require('vscode');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Get Python executable path
 */
function getPythonPath() {
    const config = vscode.workspace.getConfiguration('svAlign');
    const customPython = config.get('pythonPath');
    if (customPython) {
        return customPython;
    }

    // Try common Python commands
    const pythonCommands = ['python', 'python3', 'py'];
    for (const cmd of pythonCommands) {
        try {
            execSync(`${cmd} --version`, { stdio: 'ignore' });
            return cmd;
        } catch (e) {
            // Continue to next command
        }
    }

    throw new Error('Python not found. Please install Python or configure svAlign.pythonPath');
}

/**
 * Format Verilog/SystemVerilog code using Python formatter
 */
function formatDocument(document, range = null) {
    const config = vscode.workspace.getConfiguration('svAlign');

    // Get the full document text
    const text = document.getText(range);

    // Create a temporary file
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempFile = path.join(tempDir, `temp_${Date.now()}.${document.languageId}`);

    try {
        // Write text to temporary file with UTF-8 encoding
        fs.writeFileSync(tempFile, text, { encoding: 'utf-8' });

        // Get configuration options
        const options = {
            nbSpace: config.get('tabSize', 3),
            useTab: config.get('useTab', false),
            oneBindPerLine: config.get('oneBindPerLine', true),
            oneDeclPerLine: config.get('oneDeclPerLine', false),
            paramOneLine: config.get('paramOneLine', true),
            indentSyle: config.get('indentStyle', '1tbs'),
            reindentOnly: false,
            stripEmptyLine: config.get('stripEmptyLine', true),
            instAlignPort: config.get('instAlignPort', true),
            ignoreTick: config.get('ignoreTick', true),
            importSameLine: config.get('importSameLine', false),
            alignComma: config.get('alignComma', true)
        };

        // Build Python command
        const pythonPath = getPythonPath();
        const formatterScript = path.join(__dirname, 'python', 'formatter.py');
        const optionsStr = JSON.stringify(options).replace(/"/g, '\\"');

        // Set PYTHONIOENCODING to ensure UTF-8 output from Python
        const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };

        const command = `"${pythonPath}" "${formatterScript}" "${tempFile}" "${optionsStr}"`;

        // Execute Python formatter with UTF-8 encoding
        const formattedText = execSync(command, {
            encoding: 'utf-8',
            env: env,
            shell: true,
            windowsHide: true
        });

        return formattedText;
    } catch (error) {
        vscode.window.showErrorMessage(`Formatting failed: ${error.message}`);
        console.error('Formatting error:', error);
        return null;
    } finally {
        // Clean up temporary file
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    }
}

/**
 * Activate the extension
 */
function activate(context) {
    console.log('SystemVerilog Align Formatter is now active!');

    // Register document formatting edit provider for both verilog and systemverilog
    const languages = ['verilog', 'systemverilog'];

    const provider = {
        provideDocumentFormattingEdits(document, options, token) {
            const fullRange = new vscode.Range(
                document.lineAt(0).range.start,
                document.lineAt(document.lineCount - 1).range.end
            );

            const formattedText = formatDocument(document, fullRange);

            if (formattedText !== null) {
                return [vscode.TextEdit.replace(fullRange, formattedText)];
            }
            return [];
        },

        provideDocumentRangeFormattingEdits(document, range, options, token) {
            const formattedText = formatDocument(document, range);

            if (formattedText !== null) {
                return [vscode.TextEdit.replace(range, formattedText)];
            }
            return [];
        }
    };

    // Register formatter for each language
    languages.forEach(lang => {
        context.subscriptions.push(
            vscode.languages.registerDocumentFormattingEditProvider(lang, provider)
        );
        context.subscriptions.push(
            vscode.languages.registerDocumentRangeFormattingEditProvider(lang, provider)
        );
    });

    // Register command for manual formatting
    context.subscriptions.push(
        vscode.commands.registerCommand('svAlign.formatDocument', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                vscode.commands.executeCommand('editor.action.formatDocument');
            }
        })
    );
}

/**
 * Deactivate the extension
 */
function deactivate() {}

module.exports = {
    activate,
    deactivate
};
