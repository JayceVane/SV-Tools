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
 * 内置 VCD 波形查看器：解析 + webview 渲染。
 *
 * 模块分层：
 *  - parseVcd / buildSignalTree / parseTimescaleSeconds 为纯函数，不依赖 vscode，可独立单元测试；
 *  - activateWaveViewer() 负责 VSCode 集成（webview 面板、命令、与仿真联动）。
 *
 * 渲染采用视口窗口模型：canvas 固定为可视区大小，只绘制 [viewStart, viewStart+viewSpan]
 * 时间窗口内的变更（二分查找定位），任意时间跨度（如 1ns 下 245e9 ticks）均可缩放浏览。
 */

const fs = require('fs');
const path = require('path');
const { parseVcd } = require('./parser');
const { buildWaveformHtml } = require('./view');

/**
 * 激活 VCD 波形查看器：
 *  - openWaveform 命令（仿真自动打开走这里）；
 *  - CustomEditorProvider：.vcd 文件双击直接以波形面板打开（package.json priority=option）；
 *  - editor/title 切换命令：文本视图 ↔ 波形视图（package.json menus.editor/title）。
 * @param {vscode.ExtensionContext} context
 * @param {{channel: vscode.OutputChannel}} deps 与仿真模块共享的输出通道
 */
function activateWaveViewer(context, deps) {
    const vscode = require('vscode');
    const panels = new Map(); // vcd 文件路径 -> webviewPanel

    const ERROR_PAGE = (msg) => '<html><body style="font-family:sans-serif;color:#d4d4d4;' +
        'background:#1e1e1e;padding:24px;font-size:14px">VCD 打开失败：' +
        String(msg).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</body></html>';

    /**
     * 把面板与 VCD 文件绑定：解析、渲染 HTML、登记生命周期。
     * 命令式打开与 CustomEditorProvider 两条路径共用。
     */
    function attachPanel(vcdPath, panel) {
        const existing = panels.get(vcdPath);
        if (existing && existing !== panel) existing.dispose();
        panels.set(vcdPath, panel);
        panel.onDidDispose(() => {
            if (panels.get(vcdPath) === panel) panels.delete(vcdPath);
        }, null, context.subscriptions);

        let vcd;
        try {
            vcd = parseVcd(fs.readFileSync(vcdPath, 'utf8'));
        } catch (err) {
            panel.webview.html = ERROR_PAGE(err.message);
            return;
        }
        if (vcd.vars.length === 0) {
            panel.webview.html = ERROR_PAGE('该 VCD 文件中没有信号定义。');
            return;
        }
        panel.webview.html = buildWaveformHtml(vcd, {
            fileName: path.basename(vcdPath),
            timescale: vcd.timescale,
            cspSource: panel.webview.cspSource
        });
    }

    /**
     * 打开（或聚焦已打开的）波形面板。
     * @param {string} vcdPath VCD 文件绝对路径
     */
    async function openWaveform(vcdPath) {
        const existing = panels.get(vcdPath);
        if (existing) {
            existing.reveal();
            return;
        }
        if (!fs.existsSync(vcdPath)) {
            vscode.window.showWarningMessage(`文件不存在：${vcdPath}`);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'svtoolsWaveViewer',
            `波形 · ${path.basename(vcdPath)}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        attachPanel(vcdPath, panel);
    }

    // .vcd 双击直接打开波形（priority=option 使其成为 .vcd 默认编辑器）
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('svtoolsWaveViewer', {
            async openCustomDocument(uri) {
                return { uri, dispose() { } };
            },
            async resolveCustomEditor(document, panel) {
                panel.webview.options = { enableScripts: true, localResourceRoots: [] };
                attachPanel(document.uri.fsPath, panel);
            }
        }, { supportsMultipleEditorsPerDocument: false })
    );

    // editor/title 双向切换：取当前活动标签的 URI（文本或自定义编辑器均适用）
    function activeUri() {
        const editor = vscode.window.activeTextEditor;
        if (editor) return editor.document.uri;
        const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTab;
        const input = tab && tab.input;
        return (input && input.uri) ? input.uri : undefined;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.iverilog.waveformFromText', () => {
            const uri = activeUri();
            if (!uri) {
                vscode.window.showWarningMessage('没有打开的 VCD 文件。');
                return;
            }
            vscode.commands.executeCommand('vscode.openWith', uri, 'svtoolsWaveViewer');
        }),
        vscode.commands.registerCommand('svtools.iverilog.showText', () => {
            const uri = activeUri();
            if (!uri) return;
            vscode.commands.executeCommand('vscode.openWith', uri, 'default');
        }),
        vscode.commands.registerCommand('svtools.iverilog.openWaveform', async () => {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'VCD Waveform': ['vcd'], 'All Files': ['*'] }
            });
            if (picked && picked[0]) openWaveform(picked[0].fsPath);
        })
    );

    return { openWaveform };
}

module.exports = { activateWaveViewer };
