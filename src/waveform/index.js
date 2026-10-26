'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { bindWaveformPanel } = require('./host');
const { collectSourceContext } = require('./source-roles');
const { createImageFiles } = require('../graphics/image-files');
const { createLayoutFiles } = require('./layout-files');
const { createWaveformRegistry } = require('./registry');

/** 注册 VCD 自定义编辑器、仿真联动入口和文本/波形切换命令。 */
function activateWaveViewer(context, deps) {
    const vscode = deps?.vscode || require('vscode');
    const registry = createWaveformRegistry();
    context.subscriptions.push(registry);
    function attach(filePath, panel, sourceFile) {
        const key = path.resolve(filePath);
        registry.assertAvailable(key);
        sourceFile ||= registry.sourceFile(key);
        panel.webview.options = { enableScripts: true, localResourceRoots: [] };
        let registration;
        const base = bindWaveformPanel({ filePath: key, panel, channel: deps?.channel, imageFiles: createImageFiles({ vscode, sourcePath: key }), layoutFiles: createLayoutFiles({ vscode, filePath: key }),
            onCircuit:message=>message.type==='circuit-link'?registration?.configure():registration?.trace(message.key,message.direction),
            getSourceContext: () => collectSourceContext(vscode, key, deps?.sourceCatalog, sourceFile) });
        registration = deps?.waveLinks?.registerWave({file:key,label:()=>path.basename(key),
            snapshot:()=>base.getMetadata()?{id:key,revision:1}:null,metadata:async()=>{await base.loaded;return base.getMetadata();},
            async validate(){await base.loaded;const metadata=base.getMetadata();if(!metadata)throw new Error('VCD未成功加载或已经关闭');
                const stat=await fs.stat(key);if(!metadata.fileIdentity||stat.size!==metadata.fileIdentity.size||stat.mtimeMs!==metadata.fileIdentity.mtimeMs){registration.invalidate('VCD已变化，请重新打开并确认映射');throw new Error('VCD文件已变化，请关闭后重新打开并确认关联');}},
            notify:base.notifyLink,reveal:async request=>{panel.reveal();return base.revealSignals(request);} });
        const binding = {...base,configureCircuit:()=>registration?.configure(),traceCircuit:(key,direction)=>registration?.trace(key,direction),
            dispose(){registration?.dispose();return base.dispose();}};
        return registry.attach(key, panel, binding, sourceFile);
    }
    async function openWaveform(filePath, { sourceFile } = {}) {
        const key = path.resolve(filePath), existing = registry.get(key);
        if (existing) { existing.panel.reveal(); await existing.binding.loaded; return existing.binding; }
        const panel = vscode.window.createWebviewPanel('svtoolsWaveViewer', `波形 · ${path.basename(key)}`,
            vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
        const binding = attach(key, panel, sourceFile); await binding.loaded; return binding;
    }
    async function prepareForSimulation(options) {
        const lease = await registry.prepareForSimulation(options);
        try {
            const tabs = (vscode.window.tabGroups?.all || []).flatMap(group => group.tabs).filter(tab => {
                const uri = tab.input?.uri;
                return uri?.scheme === 'file' && /\.vcd$/i.test(uri.fsPath) && registry.isWriting(uri.fsPath);
            });
            if (tabs.length && !await vscode.window.tabGroups.close(tabs, true)) throw new Error('对应VCD标签未关闭，仿真未启动。');
            return lease;
        } catch (error) { lease.dispose(); throw error; }
    }
    function activeUri() {
        const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        const file = registry.activeFile();
        return tab?.input?.uri || (file && vscode.Uri.file(file)) || vscode.window.activeTextEditor?.document.uri;
    }
    context.subscriptions.push(vscode.window.registerCustomEditorProvider('svtoolsWaveViewer', {
        // 只读文档只持有 URI，worker 资源由面板绑定负责释放。
        async openCustomDocument(uri) { registry.assertAvailable(uri.fsPath); return { uri, dispose() {} }; },
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
    return { openWaveform, prepareForSimulation };
}
module.exports = { activateWaveViewer };
