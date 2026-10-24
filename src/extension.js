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
const { activateIverilog } = require('./toolchains/iverilog');
const { activateWaveViewer } = require('./waveform');
const { activateCircuitViewer } = require('./circuit');
const { activateVivado } = require('./vivado');

const { createNativeLoader } = require('./native-loader');
const { createFormatter } = require('./editor/formatting');
const { createEditorCommands } = require('./editor/commands');
const { createSourceCatalog } = require('./workspace/source-catalog');
const { createProjectSourceProvider } = require('./workspace/project-sources');
const { createWorkspaceSourceIndex } = require('./workspace/sources');
const { createLanguageProviders } = require('./editor/language');
const nativeLoader = createNativeLoader();
let nativeLoadError = null;

function loadNativeModule() {
    try {
        const native = nativeLoader.load();
        nativeLoadError = null;
        return native;
    } catch (error) {
        nativeLoadError = error;
        console.error(error.message);
        return null;
    }
}

function reportNativeMissing() {
    vscode.window.showErrorMessage('SystemVerilog Tools: ' + nativeLoadError.message);
    return null;
}

/**
 * Activate the extension
 */
function activate(context) {
    console.log('SystemVerilog extension is now active!');

    const vivado = activateVivado(context);
    const sourceCatalog = createSourceCatalog({ vscode, getPreferred: createProjectSourceProvider({ vscode, projectSelection: vivado.projectSelection }) });
    const sourceIndex = createWorkspaceSourceIndex({ workspace: vscode.workspace, sourceCatalog });
    context.subscriptions.push(sourceCatalog, sourceCatalog.onDidChange(sourceIndex.invalidate), vivado.projectSelection.onDidChange(sourceCatalog.refreshContext));
    const dependencies = { vscode, loadNativeModule, reportNativeMissing, sourceCatalog };
    const { formatDocument } = createFormatter(dependencies);
    const languageProviders = createLanguageProviders(dependencies);
    const { provideDocumentSymbols, provideDefinition, provideCompletionItems, provideHover } = languageProviders;
    context.subscriptions.push({ dispose: languageProviders.dispose });
    const editorCommands = createEditorCommands(dependencies);
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
        context.subscriptions.push(
            vscode.languages.registerDocumentSymbolProvider(lang, { provideDocumentSymbols })
        );
        context.subscriptions.push(
            vscode.languages.registerDefinitionProvider(lang, { provideDefinition })
        );
        context.subscriptions.push(
            vscode.languages.registerCompletionItemProvider(lang, { provideCompletionItems }, '.', ':', '`', '$', '"', '/')
        );
        context.subscriptions.push(
            vscode.languages.registerHoverProvider(lang, { provideHover })
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

    const commands = [
        ['svtools.moduleInstantiation', editorCommands.generateModuleInstance],
        ['svtools.generateTestbench', editorCommands.generateTestbench],
        ['svtools.repeatCode', editorCommands.repeatCodeWithNumbers],
        ['svtools.alignCode', editorCommands.alignSelectedCode],
        ['svtools.insertHeader', editorCommands.insertHeaderTemplate]
    ];
    for (const [name, action] of commands) {
        context.subscriptions.push(vscode.commands.registerCommand(name, action));
    }

    // Icarus Verilog lint 与仿真（诊断、命令、状态栏）
    const waveViewer = activateWaveViewer(context, { sourceCatalog });
    activateIverilog(context, { waveViewer, scanWorkspaceSources: force => { if (force) sourceCatalog.invalidate(); return sourceIndex.scan(force); }, invalidateWorkspaceSources: sourceIndex.invalidate });

    // Vivado TCL 批处理运行与工程创建
    const circuit = activateCircuitViewer(context, { vivado, sourceCatalog });
    return { vivado, circuit, waveViewer };
}

/**
 * Deactivate the extension
 */
function deactivate() {
    // Native module doesn't need cleanup
    nativeLoader.reset();
    nativeLoadError = null;
}

module.exports = {
    activate,
    deactivate
};
