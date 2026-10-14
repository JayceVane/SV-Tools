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
 * - 树首固定「top 级操作」快捷区：xelab/综合/报告/布局布线/bitstream/时序报告
 *   一键触发，不需要定位到 top 模块右键
 * - 右键：加入/移出工程、设综合/仿真 top、文件集间移动（src↔sim）
 * - 视图标题栏：全部展开（expandAll）+ VS Code 内置全部收起（showCollapseAll）
 * - 写操作全部经 Vivado batch TCL（复用 runScript：状态栏转圈 + 停止按钮），
 *   完成后重解析 .xpr 事实校验；.xpr 变化（含 Vivado GUI 里的改动）也触发刷新
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { parseXpr, fileSetOf, samePath } = require('./xpr');
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
        const cats = [quickActionsNode(srcSet, simSet), srcTree, simTree];

        if (constrFiles.length) {
            cats.push(catItem('约束文件（constrs_1）', constrFiles.map(f => fileNode(f, 'constraint'))));
        }

        // 未加入工程的工作区源文件/约束（右键即可加入）
        const inPrj = new Set();
        for (const s of parsed.sets) for (const f of s.files) inPrj.add(f);
        const unadded = [];
        try {
            const uris = await vscode.workspace.findFiles('**/*.{sv,v,svh,vh,xdc}', '**/{.svtools,node_modules,prj}/**', 2000);
            for (const u of uris) {
                if (![...inPrj].some(f => samePath(f, u.fsPath))) unadded.push(fileNode(u.fsPath, 'orphan'));
            }
        } catch (err) { /* 扫描失败跳过 */ }
        if (unadded.length) cats.push(catItem('未加入工程（' + unadded.length + '）', unadded));

        roots = cats;
    }

    /**
     * top 级快捷操作区（树首固定区域）：不需要定位到 top 模块右键，
     * 一键触发 xelab / 综合 / 报告 / 布局布线 / bitstream / 时序报告。
     */
    function quickActionsNode(srcSet, simSet) {
        const srcTop = srcSet.top || '';
        const simTop = simSet.top || '';
        const items = [
            actionItem('xelab 详细化（' + (simTop ? '仿真 top: ' + simTop : '无仿真 top，回退综合 top') + '）', 'zap', 'svtools.vivado.tree.quickElaborate'),
            actionItem('工程综合（synth_1' + (srcTop ? ' · ' + srcTop : '') + '）', 'tools', 'svtools.vivado.tree.synthesize'),
            actionItem('综合报告（分层资源 + 逻辑级数）', 'graph', 'svtools.vivado.tree.reportSynth'),
            actionItem('布局布线（impl_1，自动级联综合）', 'circuit-board', 'svtools.vivado.tree.implement'),
            actionItem('布局布线报告（资源占用）', 'list-tree', 'svtools.vivado.tree.reportImplUtil'),
            actionItem('时序报告（WNS/TNS）', 'watch', 'svtools.vivado.tree.reportTiming'),
            actionItem('生成 Bitstream（impl → write_bitstream）', 'package', 'svtools.vivado.tree.bitstream')
        ];
        const it = catItem('top 级操作' + (srcTop || simTop ? '（top: ' + (srcTop || simTop) + '）' : ''), items);
        it.iconPath = new vscode.ThemeIcon('zap');
        it.contextValue = 'actions';
        return it;
    }

    /** 快捷区条目：无子级，点击即执行绑定的命令。 */
    function actionItem(label, icon, command) {
        const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon(icon);
        it.contextValue = 'action';
        it.tooltip = '点击执行';
        it.command = { command, title: label };
        return it;
    }

    function buildSetTree(label, set, unitIndex, kind) {        const children = [];
        const claimed = [];
        if (set.top && unitIndex.get(set.top)) {
            const visited = new Set([set.top]);
            children.push(moduleNode(set.top, unitIndex, visited, claimed, true));
        }
        // 不在 top 层级下的文件平铺（库里单元未被引用 / 纯包含文件等）
        for (const f of set.files) {
            if (!claimed.some(c => samePath(c, f))) children.push(fileNode(f, kind === 'sim' ? 'simFile' : 'file'));
        }
        const it = catItem(label + (set.top ? ' · top: ' + set.top : ''), children);
        it.contextValue = 'setRoot';
        return it;
    }

    /** 模块层级节点：文件内引用到的工作区单元递归为子节点（环安全）。 */
    function moduleNode(name, unitIndex, visited, claimed, isTop) {
        const file = unitIndex.get(name);
        claimed.push(file);
        const children = [];
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch (err) { /* 读不了就没有子级 */ }
        for (const [unit, f] of unitIndex) {
            if (visited.has(unit) || samePath(f, file)) continue;
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

    /**
     * 写操作结果按 .xpr 事实校验：Vivado batch 退出码与脚本标记都可能说谎
     * （脚本内错误仍退出 0、工程被 GUI 占用时修改可能不落盘），唯一可信的是
     * 重解析后的 .xpr 状态。check(parsed) 返回 true=符合预期。
     */
    function xprFact(xprPath, check) {
        try { return check(parseXpr(xprPath)); } catch (err) { return false; }
    }

    /** 写操作失败统一提示（含 Vivado 侧标记差异，通道里有完整输出）。 */
    function reportWriteFail(what, r) {
        out.show(true);
        let hint = '';
        if (r && r.stdout && /SVTOOLS_TCL_ERROR/.test(r.stdout)) {
            const m = r.stdout.match(/SVTOOLS_TCL_ERROR ([^\r\n]*)/);
            if (m) hint = '：' + m[1].slice(0, 160);
        } else if (r && r.code === 0) {
            hint = '（Vivado 报成功但 .xpr 未变化，常见原因：工程正被 Vivado GUI 打开）';
        }
        vscode.window.showErrorMessage(what + '失败' + hint + '——详见 Vivado 输出通道');
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
        const r = await runTcl('add_file.tcl', buildAddFilesScript(xpr, file, setPick.value, /\.sv(h)?$/i.test(file)));
        if (!r || r.code !== 0 || !xprFact(xpr, p => fileSetOf(p, file) === setPick.value)) {
            reportWriteFail(path.basename(file) + ' 加入 ' + setPick.value + ' ', r);
            return;
        }
        vscode.window.showInformationMessage(path.basename(file) + ' 已加入 ' + setPick.value);
    }

    async function removeFileFromProject(nodeArg) {
        const xpr = await currentXpr(); if (!xpr) return;
        const node = nodeArg && nodeArg.nodeData;
        if (!node || !node.file) return;
        let parsed;
        try { parsed = parseXpr(xpr); } catch (err) { vscode.window.showErrorMessage('读取 .xpr 失败'); return; }
        const from = fileSetOf(parsed, node.file);
        if (!from) {
            // 不在工程里还点移出：多数是树没刷新或模块节点路径与 .xpr 不一致
            vscode.window.showWarningMessage(path.basename(node.file) + ' 不在当前 .xpr 中，已刷新工程树');
            refresh();
            return;
        }
        const r = await runTcl('remove_file.tcl', buildRemoveFilesScript(xpr, node.file, from));
        if (!r || r.code !== 0 || !xprFact(xpr, p => fileSetOf(p, node.file) === null)) {
            reportWriteFail(path.basename(node.file) + ' 从 ' + from + ' 移出 ', r);
            return;
        }
        vscode.window.showInformationMessage(path.basename(node.file) + ' 已从 ' + from + ' 移出工程');
    }

    async function setTop(nodeArg, fileset) {
        const xpr = await currentXpr(); if (!xpr) return;
        const node = nodeArg && nodeArg.nodeData;
        const mod = node && node.module;
        if (!mod) { vscode.window.showErrorMessage('请右键模块节点设置 top'); return; }
        const r = await runTcl('set_top.tcl', buildSetTopScript({ xprPath: xpr, fileset, top: mod }));
        const ok = r && r.code === 0 && xprFact(xpr, p => {
            const s = p.sets.find(x => x.name === fileset);
            return !!s && s.top === mod;
        });
        if (!ok) { reportWriteFail(mod + ' 设为 ' + fileset + ' 顶层 ', r); return; }
        vscode.window.showInformationMessage(mod + ' 已设为 ' + fileset + ' 顶层');
    }

    async function moveFile(nodeArg, to) {
        const xpr = await currentXpr(); if (!xpr) return;
        const node = nodeArg && nodeArg.nodeData;
        if (!node || !node.file) return;
        let parsed;
        try { parsed = parseXpr(xpr); } catch (err) { vscode.window.showErrorMessage('读取 .xpr 失败'); return; }
        const from = fileSetOf(parsed, node.file);
        if (!from) {
            vscode.window.showWarningMessage(path.basename(node.file) + ' 不在当前 .xpr 中，已刷新工程树');
            refresh();
            return;
        }
        if (from === to) { vscode.window.showInformationMessage('已在 ' + to + ' 中'); return; }
        const r = await runTcl('move_file.tcl', buildMoveFileScript({
            xprPath: xpr, file: node.file, from, to, isSv: /\.sv(h)?$/i.test(node.file)
        }));
        if (!r || r.code !== 0 || !xprFact(xpr, p => fileSetOf(p, node.file) === to)) {
            reportWriteFail(path.basename(node.file) + '：' + from + ' → ' + to + ' ', r);
            return;
        }
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

    /** 快捷区 xelab：从 .xpr 取 sim_1 top（无则综合 top）的源文件打开后详细化。 */
    async function quickElaborate() {
        const xpr = await currentXpr(); if (!xpr) return;
        let parsed;
        try { parsed = parseXpr(xpr); } catch (err) { vscode.window.showErrorMessage('读取 .xpr 失败'); return; }
        const simSet = parsed.sets.find(s => s.type === 'SimulationSrcs') || {};
        const srcSet = parsed.sets.find(s => s.type === 'DesignSrcs') || {};
        const top = simSet.top || srcSet.top;
        if (!top) { vscode.window.showErrorMessage('工程未设置 top 模块（在文件树右键模块设置）'); return; }
        let unitIndex = new Map();
        try { unitIndex = (await scanWorkspaceSources()).modules; } catch (err) { /* */ }
        const file = unitIndex.get(top);
        if (!file) {
            // 索引找不到时兜底：top 名 + 常见扩展名在工程文件集里找
            const cand = [...simSet.files, ...srcSet.files].find(f => samePath(path.basename(f), top + '.sv') || samePath(path.basename(f), top + '.v'));
            if (!cand) { vscode.window.showErrorMessage('找不到 top 模块 ' + top + ' 的源文件'); return; }
            return elaborateTop({ nodeData: { file: cand } });
        }
        return elaborateTop({ nodeData: { file } });
    }

    /** 综合 / 布局布线 / Bitstream（impl 自动级联 synth）。 */
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

    /**
     * 报告：跑 tcl 生成 .rpt → webview 打开 + 摘要进通道。
     * @param {'synth_1'|'impl_1'} run
     * @param {Array<'utilization'|'logic_levels'|'timing_summary'>} [kinds] 缺省 = 该 run 全套
     */
    async function openRunReports(run, kinds) {
        const xpr = await currentXpr(); if (!xpr) return;
        const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const base = ws ? ws.uri.fsPath : path.dirname(xpr);
        const outDir = path.join(base, '.svtools', 'vivado', 'reports', run);
        const scriptPath = path.join(base, '.svtools', 'vivado', 'reports_' + run + '.tcl');
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(scriptPath, buildRunReportsScript({ xprPath: xpr, run, outDir, reports: kinds }));
        const r = await runScript(scriptPath, { quiet: true });
        if (!r || r.code !== 0) {
            out.show(true);
            vscode.window.showErrorMessage(run + ' 报告生成失败——若 run 未完成请先运行综合/布局布线（详见输出通道）');
            return;
        }
        const list = kinds || (run === 'synth_1' ? ['utilization', 'logic_levels'] : ['utilization', 'timing_summary']);
        const FILE_OF = {
            'synth_1:utilization': ['synth_utilization.rpt', '综合报告 · 分层资源占用', (t) => summarizeHier('synth', t)],
            'synth_1:logic_levels': ['synth_logic_levels.rpt', '综合报告 · 逻辑级数分布', (t) => log('[synth] ' + parseLogicLevelSummary(t))],
            'impl_1:utilization': ['impl_utilization.rpt', '布局布线报告 · 分层资源占用', (t) => summarizeHier('impl', t)],
            'impl_1:timing_summary': ['timing_summary.rpt', '时序报告 · Timing Summary', summarizeTiming]
        };
        for (const k of list) {
            const entry = FILE_OF[run + ':' + k];
            if (!entry) continue;
            const p = path.join(outDir, entry[0]);
            if (fs.existsSync(p)) showReport(vscode, vscode.Uri.file(p), entry[1]);
            if (entry[2]) { try { entry[2](fs.readFileSync(p, 'utf8')); } catch (err) { /* 摘要失败不影响打开报告 */ } }
        }
    }

    /** 分层资源摘要进通道（synth/impl 共用 parseUtilHierSummary）。 */
    function summarizeHier(tag, text) {
        for (const s of parseUtilHierSummary(text)) log('[' + tag + '] ' + s);
    }
    function summarizeTiming(text) {
        const m = text.match(/^\|\s*(?:Design Timing Summary|WNS\(ns\)[^\n]*\|)\s*\n[^\n]*\n\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)\s*\|\s*(-?[\d.]+)/m);
        if (m) log('[impl] WNS ' + m[1] + 'ns | TNS ' + m[2] + 'ns | WHS ' + m[3] + 'ns | THS ' + m[4] + 'ns'
            + (parseFloat(m[1]) >= 0 && parseFloat(m[3]) >= 0 ? '（时序满足）' : '（存在违例！）'));
    }

    /** 全部展开（视图标题栏按钮；收起用 VS Code 内置 collapse-all）。 */
    async function expandAll() {
        const stack = [...roots];
        while (stack.length) {
            const n = stack.pop();
            if (n.children && n.children.length) {
                stack.push(...n.children);
                try { await tree.reveal(n, { select: false, focus: false, expand: true }); } catch (err) { /* 节点不可 reveal 跳过 */ }
            }
        }
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
        vscode.commands.registerCommand('svtools.vivado.tree.quickElaborate', quickElaborate),
        vscode.commands.registerCommand('svtools.vivado.tree.synthesize', () => launchRun('synth_1', null, '综合')),
        vscode.commands.registerCommand('svtools.vivado.tree.implement', () => launchRun('impl_1', 'route_design', '布局布线')),
        vscode.commands.registerCommand('svtools.vivado.tree.bitstream', () => launchRun('impl_1', 'write_bitstream', 'Bitstream 生成')),
        vscode.commands.registerCommand('svtools.vivado.tree.reportSynth', () => openRunReports('synth_1')),
        vscode.commands.registerCommand('svtools.vivado.tree.reportImpl', () => openRunReports('impl_1')),
        vscode.commands.registerCommand('svtools.vivado.tree.reportImplUtil', () => openRunReports('impl_1', ['utilization'])),
        vscode.commands.registerCommand('svtools.vivado.tree.reportTiming', () => openRunReports('impl_1', ['timing_summary'])),
        vscode.commands.registerCommand('svtools.vivado.tree.expandAll', expandAll)
    );

    refresh();
}

module.exports = { activateProjectTree };
