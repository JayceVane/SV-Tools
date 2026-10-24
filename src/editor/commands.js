'use strict';

const { loadHeaderTemplate } = require('./header-template');
const { buildModuleOptions, buildTestbenchOptions } = require('../configuration');
const { preservesCharacters } = require('./format-safety');

/** @param {{vscode: object, loadNativeModule: () => object|null, reportNativeMissing: () => void}} deps @returns {object} 编辑器命令实现；由扩展入口统一注册。 */
function createEditorCommands({ vscode, loadNativeModule, reportNativeMissing }) {
    /**
     * Generate module instantiation
     */
    async function generateModuleInstance() {
        const native = loadNativeModule();
        if (!native) {
            reportNativeMissing();
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

        const options = buildModuleOptions(config);

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
            reportNativeMissing();
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

        const options = buildTestbenchOptions(config);

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
            reportNativeMissing();
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
            reportNativeMissing();
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        const selection = editor.selection;
        const text = editor.document.getText(selection);
        const config = vscode.workspace.getConfiguration('svtools');

        try {
            const result = native.alignCode(text, config.get('tabSize', 4));
            if (!preservesCharacters(text, result)) {
                console.warn('Alignment changed non-layout characters; original text preserved.');
                return;
            }
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
            reportNativeMissing();
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        const document = editor.document;
        const tabSize = vscode.workspace.getConfiguration('editor', document.uri).get('tabSize', 4);

        try {
            const headerTemplate = await loadHeaderTemplate(vscode, document);
            const result = native.generateHeader(headerTemplate, document.fileName, tabSize);
            // Insert at the beginning of the document
            await editor.edit(editBuilder => {
                editBuilder.insert(new vscode.Position(0, 0), result);
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Header insertion failed: ${error.message}`);
        }
    }

    return { generateModuleInstance, generateTestbench, repeatCodeWithNumbers, alignSelectedCode, insertHeaderTemplate };
}

module.exports = { createEditorCommands };
