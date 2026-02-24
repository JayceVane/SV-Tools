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
 * and Verilog-Gadget plugin by yongchan jeon (poucotm@gmail.com)
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

/**
 * Generate module instantiation
 */
async function generateModuleInstance() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const document = editor.document;
    const text = document.getText();
    const config = vscode.workspace.getConfiguration('svGadget');

    const options = {
        inst_prefix: config.get('instPrefix', 'inst_'),
        reset: config.get('reset', []),
        clock: config.get('clock', []),
        include_declarations: config.get('includePortDeclarations', true)
    };

    try {
        const result = await daemon.sendRequest('module_inst', { text, options });
        if (result.success) {
            await vscode.env.clipboard.writeText(result.result);
            vscode.window.showInformationMessage(`Module instantiation copied to clipboard: ${result.module}`);
        } else {
            vscode.window.showErrorMessage(`Failed to generate module instance: ${result.error}`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Module instantiation failed: ${error.message}`);
    }
}

/**
 * Generate testbench
 */
async function generateTestbench() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const document = editor.document;
    const text = document.getText();
    const config = vscode.workspace.getConfiguration('svGadget');

    const options = {
        inst_prefix: config.get('instPrefix', 'inst_'),
        reset: config.get('reset', []),
        sreset: config.get('sreset', []),
        clock: config.get('clock', []),
        wave_type: config.get('waveType', 'fsdb'),
        task_init: config.get('taskInit', true),
        task_drive: config.get('taskDrive', true)
    };

    try {
        const result = await daemon.sendRequest('testbench_gen', { text, options });
        if (result.success) {
            // Create new untitled document with testbench code
            const doc = await vscode.workspace.openTextDocument({
                language: 'systemverilog',
                content: result.result
            });
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`Testbench generated for module: ${result.module}`);
        } else {
            vscode.window.showErrorMessage(`Failed to generate testbench: ${result.error}`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Testbench generation failed: ${error.message}`);
    }
}

/**
 * Repeat code with numbers
 */
async function repeatCodeWithNumbers() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const selection = editor.selection;
    const template = editor.document.getText(selection);

    // Ask user for range
    const rangeInput = await vscode.window.showInputBox({
        prompt: 'Enter range [from]~[to],[↓step],[→step]',
        placeHolder: '0~10',
        value: '0~10'
    });

    if (!rangeInput) {
        return;
    }

    try {
        // Parse range input
        const rangeMatch = rangeInput.match(/(-?\d+)\s*~\s*(-?\d+)/);
        if (!rangeMatch) {
            vscode.window.showErrorMessage('Invalid range format. Use: start~end[,row_step[,col_step]]');
            return;
        }

        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);

        const parts = rangeInput.split(',');
        const rowStep = parts.length > 1 ? parseInt(parts[1]) || 1 : 1;
        const colStep = parts.length > 2 ? parseInt(parts[2]) || 0 : 0;

        const options = {
            start,
            end,
            row_step: rowStep,
            col_step: colStep
        };

        // Check if {cb} placeholder is used
        if (template.includes('{cb}')) {
            const clipboardText = await vscode.env.clipboard.readText();
            options.clipboard_lines = clipboardText.split('\n').filter(l => l.trim());
        }

        const result = await daemon.sendRequest('repeat_code', { template, options });
        if (result.success) {
            await editor.edit(editBuilder => {
                editBuilder.replace(selection, result.result);
            });
        } else {
            vscode.window.showErrorMessage(`Failed to repeat code: ${result.error}`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Repeat code failed: ${error.message}`);
    }
}

/**
 * Align selected code (using verilog-beautifier)
 */
async function alignSelectedCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const selection = editor.selection;
    const text = editor.document.getText(selection);
    const config = vscode.workspace.getConfiguration('svAlign');

    const options = {
        nbSpace: config.get('tabSize', 4),
        useTab: config.get('useTab', false),
        indentSyle: config.get('indentStyle', '1tbs'),
        instAlignPort: config.get('instAlignPort', true),
        alignComma: config.get('alignComma', true)
    };

    try {
        const result = await daemon.sendRequest('format', { text, options });
        if (result.success) {
            await editor.edit(editBuilder => {
                editBuilder.replace(selection, result.result);
            });
        } else {
            vscode.window.showErrorMessage(`Failed to align code: ${result.error}`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Align code failed: ${error.message}`);
    }
}

/**
 * Insert header template
 */
async function insertHeaderTemplate() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const config = vscode.workspace.getConfiguration('svGadget');
    const headerTemplate = config.get('headerTemplate', getDefaultHeaderTemplate());
    const document = editor.document;

    const options = {
        tab_size: vscode.workspace.getConfiguration('editor', {}).get('tabSize', 4)
    };

    try {
        const result = await daemon.sendRequest('generate_header', {
            template: headerTemplate,
            file_name: document.fileName,
            options
        });

        if (result.success) {
            // Insert at the beginning of the document
            await editor.edit(editBuilder => {
                editBuilder.insert(new vscode.Position(0, 0), result.result);
            });
        } else {
            vscode.window.showErrorMessage(`Failed to generate header: ${result.error}`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Header insertion failed: ${error.message}`);
    }
}

/**
 * Get default header template
 */
function getDefaultHeaderTemplate() {
    return `// -----------------------------------------------------------------------------
// Module      : {FILE}
// Description : Module description
// Author      : Your Name
// Date        : {DATE} {TIME}
// -----------------------------------------------------------------------------
// Copyright (C) {YEAR} Your Company
// -----------------------------------------------------------------------------
// License     : Apache License 2.0
// -----------------------------------------------------------------------------
// History :
// {DATE} {TIME} : {FILE} - Created
// -----------------------------------------------------------------------------
// Notes :
// -----------------------------------------------------------------------------
`;
}

// Global daemon instance
let daemon = null;

/**
 * Activate the extension
 */
function activate(context) {
    console.log('SystemVerilog extension is now active!');

    // Create daemon instance
    daemon = new ProcessManager();

    // Register document formatting edit provider for both verilog and systemverilog
    const languages = ['verilog', 'systemverilog'];

    const provider = {
        async provideDocumentFormattingEdits(document) {
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

        async provideDocumentRangeFormattingEdits(document, range) {
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

    // Register formatter command
    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.formatDocument', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                vscode.commands.executeCommand('editor.action.formatDocument');
            }
        })
    );

    // Register Verilog-Gadget commands
    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.moduleInstantiation', generateModuleInstance)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.generateTestbench', generateTestbench)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.repeatCode', repeatCodeWithNumbers)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.alignCode', alignSelectedCode)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.insertHeader', insertHeaderTemplate)
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
