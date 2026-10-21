'use strict';
const path = require('node:path');
const { bindWaveformPanel } = require('./host');
const { collectSourceContext } = require('./source-roles');
const { createLayoutFiles } = require('./layout-files');

/** 注册 VCD 自定义编辑器、仿真联动入口和文本/波形切换命令。 */
function activateWaveViewer(context, deps) {
    const vscode = deps?.vscode || require('vscode');
    const panels = new Map();
    function attach(filePath, panel, sourceFile) {
        const key = path.resolve(filePath), existing = panels.get(key);
        if (existing && existing !== panel) existing.dispose();
        panels.set(key, panel);
        panel.webview.options = { enableScripts: true, localResourceRoots: [] };
        panel.onDidDispose(() => { if (panels.get(key) === panel) panels.delete(key); });
        const binding = bindWaveformPanel({ filePath: key, panel, channel: deps?.channel, layoutFiles: createLayoutFiles({ vscode, filePath: key }), getSourceContext: () => collectSourceContext(vscode, key, deps?.sourceCatalog, sourceFile) });
        context.subscriptions.push(binding);
        return binding;
    }
    async function openWaveform(filePath, { sourceFile } = {}) {
        const key = path.resolve(filePath), existing = panels.get(key);
        if (existing) { existing.reveal(); return; }
        const panel = vscode.window.createWebviewPanel('svtoolsWaveViewer', `波形 · ${path.basename(key)}`,
            vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
        const binding = attach(key, panel, sourceFile); await binding.loaded; return binding;
    }
    function activeUri() {
        const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        return tab?.input?.uri || vscode.window.activeTextEditor?.document.uri;
    }
    context.subscriptions.push(vscode.window.registerCustomEditorProvider('svtoolsWaveViewer', {
        // 只读文档只持有 URI，worker 资源由面板绑定负责释放。
        async openCustomDocument(uri) { return { uri, dispose() {} }; },
        async resolveCustomEditor(document, panel) { await attach(document.uri.fsPath, panel).loaded; }
    }, { supportsMultipleEditorsPerDocument: false }));
    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.iverilog.waveformFromText', () => {
            const uri = activeUri();
            if (!uri) { vscode.window.showWarningMessage('没有打开的 VCD 文件。'); return; }
            return vscode.commands.executeCommand('vscode.openWith', uri, 'svtoolsWaveViewer');
        }),
        vscode.commands.registerCommand('svtools.iverilog.showText', () => {
            const uri = activeUri();
            if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, 'default');
        }),
        vscode.commands.registerCommand('svtools.iverilog.openWaveform', async () => {
            const picked = await vscode.window.showOpenDialog({ canSelectMany: false,
                filters: { 'VCD Waveform': ['vcd'], 'All Files': ['*'] } });
            if (picked?.[0]) await openWaveform(picked[0].fsPath);
        })
    );
    return { openWaveform };
}
module.exports = { activateWaveViewer };
