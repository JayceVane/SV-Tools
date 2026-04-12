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
const path = require('path');

// Load native module
let svtools = null;

function loadNativeModule() {
    if (svtools) return svtools;
    
    try {
        // Try to load the native module
        const modulePath = path.join(__dirname, 'src-rust', 'svtools.win32-x64-msvc.node');
        svtools = require(modulePath);
        console.log('svtools native module loaded successfully');
        return svtools;
    } catch (err) {
        console.error('Failed to load svtools native module:', err);
        return null;
    }
}

/**
 * Format Verilog/SystemVerilog code using native module
 */
async function formatDocument(document, range = null) {
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return null;
    }

    const config = vscode.workspace.getConfiguration('svAlign');

    // Get the document text
    const text = document.getText(range);

    // Get configuration options (camelCase for napi-rs auto-conversion)
    const options = {
        indentStyle: config.get('indentStyle', '1tbs'),
        useTab: config.get('useTab', false),
        nbSpace: config.get('tabSize', 4),
        maxConsecutiveEmptyLines: config.get('maxConsecutiveEmptyLines', 1),
        reindentOnly: false,
        ignoreTick: config.get('ignoreTick', true),
        oneDeclPerLine: config.get('oneDeclPerLine', false),
        oneBindPerLine: config.get('oneBindPerLine', true),
        alignComma: config.get('alignComma', true),
        paramOneLine: config.get('paramOneLine', true),
        importSameLine: config.get('importSameLine', false),
        instAlignPort: config.get('instAlignPort', true)
    };

    try {
        const formattedText = native.formatText(text, options);
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
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const document = editor.document;
    const text = document.getText();
    const config = vscode.workspace.getConfiguration('svtools');

    const options = {
        instPrefix: config.get('instPrefix', 'inst_'),
        reset: config.get('reset', []),
        includeDeclarations: config.get('includePortDeclarations', true)
    };

    try {
        const result = native.generateModuleInst(text, options);
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
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const document = editor.document;
    const text = document.getText();
    const config = vscode.workspace.getConfiguration('svtools');

    const options = {
        instPrefix: config.get('instPrefix', 'inst_'),
        reset: config.get('reset', []),
        sreset: config.get('sreset', []),
        clock: config.get('clock', ['clk']),
        waveType: config.get('waveType', 'fsdb'),
        taskInit: config.get('taskInit', true),
        taskDrive: config.get('taskDrive', true)
    };

    try {
        const result = native.generateTestbench(text, options);
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
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return;
    }

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
            rowStep,
            colStep,
            clipboardLines: []
        };

        // Check if {cb} placeholder is used
        if (template.includes('{cb}')) {
            const clipboardText = await vscode.env.clipboard.readText();
            options.clipboardLines = clipboardText.split('\n').filter(l => l.trim());
        }

        const result = native.repeatCode(template, options);
        await editor.edit(editBuilder => {
            editBuilder.replace(selection, result);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Repeat code failed: ${error.message}`);
    }
}

/**
 * Align selected code
 */
async function alignSelectedCode() {
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const selection = editor.selection;
    const text = editor.document.getText(selection);
    const config = vscode.workspace.getConfiguration('svAlign');

    try {
        const result = native.alignCode(text, config.get('tabSize', 4));
        await editor.edit(editBuilder => {
            editBuilder.replace(selection, result);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Align code failed: ${error.message}`);
    }
}

/**
 * Insert header template
 */
async function insertHeaderTemplate() {
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const config = vscode.workspace.getConfiguration('svtools');
    const headerTemplate = config.get('headerTemplate', getDefaultHeaderTemplate());
    const document = editor.document;

    const tabSize = vscode.workspace.getConfiguration('editor', {}).get('tabSize', 4);

    try {
        const result = native.generateHeader(headerTemplate, document.fileName, tabSize);
        // Insert at the beginning of the document
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), result);
        });
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

/**
 * Activate the extension
 */
function activate(context) {
    console.log('SystemVerilog extension is now active!');

    // Preload native module
    loadNativeModule();

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
    // Native module doesn't need cleanup
    svtools = null;
}

module.exports = {
    activate,
    deactivate
};
