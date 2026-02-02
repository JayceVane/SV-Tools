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
const ProcessManager = require('./processManager');

/**
 * Format Verilog/SystemVerilog code using Python daemon
 */
async function formatDocument(document, range = null) {
    const config = vscode.workspace.getConfiguration('svAlign');

    // Get the document text
    const text = document.getText(range);

    // Get configuration options
    const options = {
        nbSpace: config.get('tabSize', 4),
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
        alignComma: config.get('alignComma', true),
        maxConsecutiveEmptyLines: config.get('maxConsecutiveEmptyLines', 1)
    };

    try {
        // Use daemon for formatting
        const formattedText = await daemon.format(text, options);
        return formattedText;
    } catch (error) {
        vscode.window.showErrorMessage(`Formatting failed: ${error.message}`);
        console.error('Formatting error:', error);
        return null;
    }
}

// Global daemon instance
let daemon = null;

/**
 * Activate the extension
 */
function activate(context) {
    console.log('SystemVerilog Align Formatter is now active!');

    // Create daemon instance
    daemon = new ProcessManager();

    // Register document formatting edit provider for both verilog and systemverilog
    const languages = ['verilog', 'systemverilog'];

    const provider = {
        async provideDocumentFormattingEdits(document, options, token) {
            const fullRange = new vscode.Range(
                document.lineAt(0).range.start,
                document.lineAt(document.lineCount - 1).range.end
            );

            const formattedText = await formatDocument(document, fullRange);

            if (formattedText !== null) {
                return [vscode.TextEdit.replace(fullRange, formattedText)];
            }
            return [];
        },

        async provideDocumentRangeFormattingEdits(document, range, options, token) {
            const formattedText = await formatDocument(document, range);

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
function deactivate() {
    // Stop the daemon process
    if (daemon) {
        daemon.stop();
        daemon = null;
    }
}

module.exports = {
    activate,
    deactivate
};
