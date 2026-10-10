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
 */
/**
 * Vivado 工程管理侧边栏：依赖层级文件树（类 Vivado Sources 视图）+ 右键管理。
 * - 数据源：.xpr（文件集成员/top，正则解析免启动 Vivado）+ 工作区设计单元索引
 *   （层级 = top 模块按实例化关系向下展开，词边界闭包）
 * - 右键：加入/移出工程、设综合/仿真 top、文件集间移动（src↔sim）、
 *   top 级 xelab 详细化、综合、布局布线、时序/综合/实现报告
 * - 写操作全部经 Vivado batch TCL（复用 runScript：状态栏转圈 + 停止按钮），
 *   完成后自动刷新树；.xpr 文件变化（含在 Vivado GUI 里的改动）也触发刷新
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { parseXpr, fileSetOf } = require('./xpr');
const { showReport } = require('./reportView');
const {
    buildAddFilesScript, buildRemoveFilesScript, buildSetTopScript, buildMoveFileScript,
    buildLaunchRunScript, buildRunReportsScript,
    parseUtilHierSummary, parseLogicLevelSummary
} = require('./tclgen');

const VERILOG_EXT = /\.(sv|v|svh|vh)$/i;
const CONSTRAINT_EXT = /\.(xdc|sdc|ucf)$/i;

/**
 * 激活工程树视图。
 * @param {import('vscode').ExtensionContext} context
 * @param {object} deps { findProjectXpr, runScript, log, out, scanWorkspaceSources }
 */
function activateProjectTree(context, deps) {
    const vscode = require('vscode');
    const { findProjectXpr, runScript, log, out, scanWorkspaceSources } = deps;

    /** @type {any} 树数据缓存（refresh 重建） */
    let roots = [];

    class VivadoTreeProvider {
        getTreeItem(element) { return element; }
        getChildren(element) {
            if (!element) return Promise.resolve(roots);
            return Promise.resolve(element.children || []);
        }
    }
    const tree = vscode.window.createTreeView('svtools.vivado.projectTree', {
        treeDataProvider: new VivadoTreeProvider(),
        showCollapseAll: true
    });
    context.subscriptions.push(tree);

    // ---------------- 数据构建 ----------------

    async function rebuild() {
        let xprPath = null;
        try { xprPath = await findProjectXpr(); } catch (err) { /* 无工程 */ }
        if (!xprPath) {
            roots = [infoItem('未找到 Vivado 工程（.xpr）—— 先运行 "Vivado: 创建工程" 或打开含 .xpr 的工作区')];
            return;
        }
        let parsed;
        try {
            parsed = parseXpr(xprPath);
        } catch (err) {
            roots = [infoItem('读取 .xpr 失败：' + err.message)];
            return;
        }

        let unitIndex = new Map();
        try { unitIndex = (await scanWorkspaceSources()).modules; } catch (err) { /* 索引不可用则无层级 */ }

        const srcSet = parsed.sets.find(s => s.type === 'DesignSrcs') || { name: 'sources_1', top: '', files: [] };
        const simSet = parsed.sets.find(s => s.type === 'SimulationSrcs') || { name: 'sim_1', top: '', files: [] };
        const constrFiles = (parsed.sets.find(s => s.type === 'Constrs') || { files: [] }).files;

        // 各文件集：top 层级树 + 不在层级里的文件平铺
        const srcTree = buildSetTree('设计源文件（' + srcSet.name + '）', srcSet, unitIndex, 'sources');
        const simTree = buildSetTree('仿真源文件（' + simSet.name + '）', simSet, unitIndex, 'sim');
        const cats = [srcTree, simTree];

        if (constrFiles.length) {
            cats.push(catItem('约束文件（constrs_1）', constrFiles.map(f => fileNode(f, 'constraint'))));
        }

        // 未加入工程的工作区源文件/约束（右键即可加入）
        const inPrj = new Set();
        for (const s of parsed.sets) for (const f of s.files) inPrj.add(path.normalize(f));
        const unadded = [];
        try {
            const uris = await vscode.workspace.findFiles('**/*.{sv,v,svh,vh,xdc}', '**/{.svtools,node_modules,prj}/**', 2000);
            for (const u of uris) {
                if (!inPrj.has(path.normalize(u.fsPath))) unadded.push(fileNode(u.fsPath, 'orphan'));
            }
        } catch (err) { /* 扫描失败跳过 */ }
        if (unadded.length) cats.push(catItem('未加入工程（' + unadded.length + '）', unadded));

        roots = cats;
    }

    function buildSetTree(label, set, unitIndex, kind) {
        const children = [];
        const claimed = new Set();
        if (set.top && unitIndex.get(set.top)) {
            const visited = new Set([set.top]);
            children.push(moduleNode(set.top, unitIndex, visited, claimed, true));
        }
        // 不在 top 层级下的文件平铺（库里单元未被引用 / 纯包含文件等）
        for (const f of set.files) {
            if (!claimed.has(path.normalize(f))) children.push(fileNode(f, kind === 'sim' ? 'simFile' : 'file'));
        }
        const it = catItem(label + (set.top ? ' · top: ' + set.top : ''), children);
        it.contextValue = 'setRoot';
        return it;
    }

    /** 模块层级节点：文件内引用到的工作区单元递归为子节点（环安全）。 */
    function moduleNode(name, unitIndex, visited, claimed, isTop) {
        const file = unitIndex.get(name);
        claimed.add(path.normalize(file));
        const children = [];
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch (err) { /* 读不了就没有子级 */ }
        for (const [unit, f] of unitIndex) {
            if (visited.has(unit) || path.normalize(f) === path.normalize(file)) continue;
            const re = new RegExp('\\b' + unit.replace(/[$]/g, '\\$') + '\\b');
            if (re.test(text)) {
                visited.add(unit);
                children.push(moduleNode(unit, unitIndex, visited, claimed, false));
            }
        }
        const it = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
        it.description = path.basename(file);
        it.tooltip = file + (isTop ? '（顶层）' : '');
        it.iconPath = new vscode.ThemeIcon(isTop ? 'rocket' : 'symbol-module');
        it.contextValue = isTop ? 'topModule' : 'module';
        it.command = { command: 'vscode.open', title: '打开', arguments: [vscode.Uri.file(file)] };
        it.nodeData = { kind: 'module', module: name, file, isTop };
        it.children = children;
        return it;
    }

    function fileNode(file, kind) {
        const it = new vscode.TreeItem(path.basename(file));
        it.description = vscode.workspace.asRelativePath(path.dirname(file));
        it.tooltip = file;
        it.iconPath = new vscode.ThemeIcon(
            kind === 'orphan' ? 'diff-add'
                : kind === 'constraint' ? 'gauge'
                    : kind === 'simFile' ? 'beaker' : 'file-code');
        it.contextValue = kind;
        it.command = { command: 'vscode.open', title: '打开', arguments: [vscode.Uri.file(file)] };
        it.nodeData = { kind, file };
        it.children = [];
        return it;
    }

    function catItem(label, children) {
        const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
        it.iconPath = new vscode.ThemeIcon('folder-library');
        it.contextValue = 'category';
        it.children = children;
        return it;
    }

    function infoItem(text) {
        const it = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon('info');
        it.children = [];
        return it;
    }

    async function refresh() {
        await rebuild();
        tree.message = undefined;
    }

    // .xpr 变化（含 Vivado GUI 侧改动）→ 防抖刷新
    let xprWatchDebounce = null;
    try {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.xpr');
        watcher.onDidChange(() => {
            clearTimeout(xprWatchDebounce);
            xprWatchDebounce = setTimeout(refresh, 800);
        });
        context.subscriptions.push(watcher);
    } catch (err) { /* watcher 不可用跳过 */ }

    // ---------------- 命令实现 ----------------

    async function currentXpr() {
        const xpr = await findProjectXpr();
        if (!xpr) vscode.window.showErrorMessage('未找到 Vivado 工程（.xpr）');
        return xpr;
    }

    /** 写操作通用流程：跑 tcl → 成功后刷新树。 */
    async function runTcl(name, body) {
        const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        if (!ws) { vscode.window.showErrorMessage('请先打开一个工作区'); return null; }
        const scriptPath = path.join(ws.uri.fsPath, '.svtools', 'vivado', name);
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
        fs.writeFileSync(scriptPath, body);
        const r = await runScript(scriptPath, { quiet: true });
        refresh();
        return r;
    }

    async function addFileToProject(nodeArg) {
        const xpr = await currentXpr(); if (!xpr) return;
        // 目标文件：右键未加入文件时直接用之；工具栏按钮则弹出工作区文件选择
        let file = nodeArg && nodeArg.file;
        if (!file) {
            let uris = [];
            try { uris = await vscode.workspace.findFiles('**/*.{sv,v,svh,vh,xdc}', '**/{.svtools,node_modules}/**', 2000); } catch (err) { }
            if (!uris.length) { vscode.window.showInformationMessage('工作区没有可加入的源文件/约束'); return; }
            const pick = await vscode.window.showQuickPick(
                uris.map(u => ({ label: path.basename(u.fsPath), description: vscode.workspace.asRelativePath(u.fsPath), fsPath: u.fsPath })),
                { placeHolder: '选择要加入工程的文件' });
            if (!pick) return;
            file = pick.fsPath;
        }
        const setPick = await vscode.window.showQuickPick(
            [
                { label: 'sources_1（RTL 源文件）', value: 'sources_1' },
                { label: 'sim_1（仿真/测试台）', value: 'sim_1' },
                { label: 'constrs_1（约束）', value: 'constrs_1' }
            ], { placeHolder: path.basename(file) + ' 加入哪个文件集' });
        if (!setPick) return;
        await runTcl('add_file.tcl', buildAddFilesScript(xpr, file, setPick.value, /\.sv(h)?$/i.test(file)));
        vscode.window.showInformationMessage(path.basename(file) + ' 已加入 ' + setPick.value);
    }

    async function removeFileFromProject(nodeArg) {
        const xpr = await currentXpr(); if (!xpr) return;
        const node = nodeArg && nodeArg.nodeData;
        if (!node || !node.file) return;
        let parsed;
        try { parsed = parseXpr(xpr); } catch (err) { vscode.window.showErrorMessage('读取 .xpr 失败'); return; }
        const from = fileSetOf(parsed, node.file) || 'sources_1';
        const r = await runTcl('remove_file.tcl', buildRemoveFilesScript(xpr, node.file, from));
        if (r && r.code === 0) vscode.window.showInformationMessage(path.basename(node.file) + ' 已从 ' + from + ' 移出工程');
    }

    async function setTop(nodeArg, fileset) {
        const xpr = await currentXpr(); if (!xpr) return;
        const node = nodeArg && nodeArg.nodeData;
        const mod = node && node.module;
        if (!mod) { vscode.window.showErrorMessage('请右键模块节点设置 top'); return; }
        await runTcl('set_top.tcl', buildSetTopScript({ xprPath: xpr, fileset, top: mod }));
        vscode.window.showInformationMessage(mod + ' 已设为 ' + fileset + ' 顶层');
    }

    async function moveFile(nodeArg, to) {
        const xpr = await currentXpr(); if (!xpr) return;
        const node = nodeArg && nodeArg.nodeData;
        if (!node || !node.file) return;
        let parsed;
        try { parsed = parseXpr(xpr); } catch (err) { vscode.window.showErrorMessage('读取 .xpr 失败'); return; }
        const from = fileSetOf(parsed, node.file);
        if (!from) { vscode.window.showErrorMessage(path.basename(node.file) + ' 不在工程中'); return; }
        if (from === to) { vscode.window.showInformationMessage('已在 ' + to + ' 中'); return; }
        await runTcl('move_file.tcl', buildMoveFileScript({
            xprPath: xpr, file: node.file, from, to, isSv: /\.sv(h)?$/i.test(node.file)
        }));
        vscode.window.showInformationMessage(path.basename(node.file) + '：' + from + ' → ' + to);
    }

    /** top 级 xelab 详细化：打开文件后复用现有 lint 详细化命令。 */
    async function elaborateTop(nodeArg) {
        const node = nodeArg && nodeArg.nodeData;
        if (!node || !node.file) return;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(node.file));
        await vscode.window.showTextDocument(doc);
        vscode.commands.executeCommand('svtools.xvlog.elaborate');
    }

    /** 综合 / 布局布线（impl 自动级联 synth）。 */
    async function launchRun(run, toStep, label) {
        const xpr = await currentXpr(); if (!xpr) return;
        vscode.window.showInformationMessage(label + '启动（状态栏可查看进度/停止）…');
        const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const scriptPath = path.join(ws ? ws.uri.fsPath : path.dirname(xpr), '.svtools', 'vivado', 'launch_run.tcl');
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
        fs.writeFileSync(scriptPath, buildLaunchRunScript({ xprPath: xpr, run, toStep }));
        const r = await runScript(scriptPath, { quiet: true });
        if (!r || r.code !== 0) {
            out.show(true);
            vscode.window.showErrorMessage(label + '失败（详见 Vivado 输出通道）');
            return;
        }
        vscode.window.showInformationMessage(label + '完成');
        log('[' + run + '] ' + label + '完成');
    }

    /** 报告：跑 tcl 生成 .rpt → webview 打开 + 摘要进通道。 */
    async function openRunReports(run) {
        const xpr = await currentXpr(); if (!xpr) return;
        const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const base = ws ? ws.uri.fsPath : path.dirname(xpr);
        const outDir = path.join(base, '.svtools', 'vivado', 'reports', run);
        const scriptPath = path.join(base, '.svtools', 'vivado', 'reports_' + run + '.tcl');
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(scriptPath, buildRunReportsScript({ xprPath: xpr, run, outDir }));
        const r = await runScript(scriptPath, { quiet: true });
        if (!r || r.code !== 0) {
            out.show(true);
            vscode.window.showErrorMessage(run + ' 报告生成失败——若 run 未完成请先运行综合/布局布线（详见输出通道）');
            return;
        }
        const files = run === 'synth_1'
            ? ['synth_utilization.rpt', 'synth_logic_levels.rpt']
            : ['timing_summary.rpt', 'impl_utilization.rpt'];
        for (const f of files) {
            const p = path.join(outDir, f);
            if (fs.existsSync(p)) showReport(vscode, vscode.Uri.file(p));
        }
        // 摘要进通道
        try {
            if (run === 'synth_1') {
                for (const s of parseUtilHierSummary(fs.readFileSync(path.join(outDir, 'synth_utilization.rpt'), 'utf8'))) log('[synth] ' + s);
                log('[synth] ' + parseLogicLevelSummary(fs.readFileSync(path.join(outDir, 'synth_logic_levels.rpt'), 'utf8')));
            } else {
                const ts = fs.readFileSync(path.join(outDir, 'timing_summary.rpt'), 'utf8');
                const m = ts.match(/^\|\s*(?:Design Timing Summary|WNS\(ns\)[^\n]*\|)\s*\n[^\n]*\n\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)/m);
                if (m) log('[impl] WNS ' + m[1] + 'ns | TNS ' + m[2] + 'ns | WHS ' + m[3] + 'ns | THS ' + m[4] + 'ns'
                    + (parseFloat(m[1]) >= 0 && parseFloat(m[3]) >= 0 ? '（时序满足）' : '（存在违例！）'));
            }
        } catch (err) { /* 摘要失败不影响打开报告 */ }
    }

    // ---------------- 注册 ----------------

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.vivado.tree.refresh', refresh),
        vscode.commands.registerCommand('svtools.vivado.tree.addFile', addFileToProject),
        vscode.commands.registerCommand('svtools.vivado.tree.removeFile', removeFileFromProject),
        vscode.commands.registerCommand('svtools.vivado.tree.setTopSynth', (n) => setTop(n, 'sources_1')),
        vscode.commands.registerCommand('svtools.vivado.tree.setTopSim', (n) => setTop(n, 'sim_1')),
        vscode.commands.registerCommand('svtools.vivado.tree.moveToSim', (n) => moveFile(n, 'sim_1')),
        vscode.commands.registerCommand('svtools.vivado.tree.moveToSources', (n) => moveFile(n, 'sources_1')),
        vscode.commands.registerCommand('svtools.vivado.tree.elaborate', elaborateTop),
        vscode.commands.registerCommand('svtools.vivado.tree.synthesize', () => launchRun('synth_1', null, '综合')),
        vscode.commands.registerCommand('svtools.vivado.tree.implement', () => launchRun('impl_1', 'route_design', '布局布线')),
        vscode.commands.registerCommand('svtools.vivado.tree.reportSynth', () => openRunReports('synth_1')),
        vscode.commands.registerCommand('svtools.vivado.tree.reportImpl', () => openRunReports('impl_1'))
    );

    refresh();
}

module.exports = { activateProjectTree };
