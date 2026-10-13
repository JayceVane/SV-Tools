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
 * - 数据源：完整 .xpr 文件集与本工程源码的有界引用预览，无需启动 Vivado。
 * - 工程根下按实际文件集显示成员，快捷操作单独分组；仿真引用不冒充成员。
 * - 右键：加入/移出工程、设综合/仿真 top、文件集间移动（src↔sim）
 * - 视图标题栏：全部展开（expandAll）+ VS Code 内置全部收起（showCollapseAll）
 * - 写操作全部经 Vivado batch TCL（复用 runScript：状态栏转圈 + 停止按钮），
 *   完成后重解析 .xpr 事实校验；.xpr 变化（含 Vivado GUI 里的改动）也触发刷新
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { parseXpr, fileSetOf, samePath } = require('./xpr');
const { buildProjectTree } = require('./tree-model');
const { cancelledError } = require('../toolchains/job');
const { showReport } = require('./reportView');
const {
    buildAddFilesScript, buildRemoveFilesScript, buildSetTopScript, buildMoveFileScript,
    buildLaunchRunScript, buildRunReportsScript,
    parseUtilHierSummary, parseLogicLevelSummary
} = require('./tclgen');

/**
 * 激活工程树视图。
 * @param {import('vscode').ExtensionContext} context
 * @param {object} deps 工程选择、批处理、停止、日志与 VS Code 边界。
 */
function activateProjectTree(context, deps) {
    const vscode = deps.vscode || require('vscode');
    const { findProjectXpr, runScript, log, out } = deps;
    const changes = new vscode.EventEmitter();
    let roots = [], parents = new WeakMap(), disposed = false, revision = 0, queued = false, refreshing = null;
    let watcherTimer = null, operation = null, externalStage = null, stopRequested = false, stopAction = null, modelUnits = new Map(), pickerToken = null;
    function setRunning(stage) {
        if (disposed) return;
        externalStage = stage;
        tree.message = operation ? '正在执行：' + operation : stage ? 'Vivado 正在运行，可使用标题栏停止任务' : undefined;
        Promise.resolve(vscode.commands.executeCommand('setContext', 'svtools.vivado.busy', !!operation || !!stage || !!deps.isRunning?.())).catch(error => log('[工程树] 更新任务状态失败：' + error.message));
    }

    function items(nodes, parent) {
        return nodes.map(node => {
            const state = !node.children?.length ? vscode.TreeItemCollapsibleState.None
                : node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
            const item = new vscode.TreeItem(node.label, state);
            for (const key of ['id', 'description', 'tooltip', 'contextValue', 'nodeData']) item[key] = node[key];
            item.iconPath = new vscode.ThemeIcon(node.icon || 'file-code');
            if (node.command) item.command = { command: node.command, title: node.label, arguments: [item] };
            else if (node.nodeData?.file) {
                item.resourceUri = vscode.Uri.file(node.nodeData.file);
                item.command = { command: 'vscode.open', title: '打开', arguments: [item.resourceUri] };
            }
            parents.set(item, parent); item.children = items(node.children || [], item); return item;
        });
    }
    const info = message => ({ id: 'state:' + message, label: message, icon: 'info', contextValue: 'info', children: [] });
    roots = items([info('正在发现 Vivado 工程…')]);
    const provider = { onDidChangeTreeData: changes.event, getTreeItem: item => item,
        getChildren: item => item ? item.children || [] : roots, getParent: item => parents.get(item) };
    const tree = vscode.window.createTreeView('svtools.vivado.projectTree', { treeDataProvider: provider, showCollapseAll: true });
    context.subscriptions.push(tree, changes);

    /** 每次构建局部快照，提交时核对代次；错误与空工作区也有可见内容。 */
    async function rebuild() {
        const xpr = await findProjectXpr();
        if (!xpr) return { roots: [info('没有 Vivado 工程。点击“选择工程”打开 .xpr，或创建工程。')], issues: [] };
        const parsed = parseXpr(xpr), folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(xpr));
        let workspaceFiles = [], scanError = null;
        if (folder) {
            try {
                const pattern = new vscode.RelativePattern(folder.uri, '**/*.{sv,v,svh,vh,xdc,sdc,ucf}');
                workspaceFiles = (await vscode.workspace.findFiles(pattern, '**/{.svtools,node_modules,*.srcs,*.runs,*.cache}/**', 2000)).map(uri => uri.fsPath);
            } catch (error) { scanError = '扫描未加入文件失败：' + error.message; log('[工程树] ' + scanError); }
        }
        const snapshot = await buildProjectTree(parsed, { workspaceFiles });
        if (scanError) snapshot.issues.push(scanError);
        return { ...snapshot, count: new Set(parsed.sets.flatMap(set => set.files)).size };
    }
    function refresh() {
        if (disposed) return Promise.resolve();
        queued = true; revision++; tree.message = '正在刷新工程…';
        if (!refreshing) refreshing = (async () => {
            while (queued && !disposed) {
                queued = false; const version = revision; let snapshot;
                try { snapshot = await rebuild(); }
                catch (error) { log('[工程树] 刷新失败：' + error.message); snapshot = { roots: [info('读取工程失败：' + error.message)], issues: [error.message] }; }
                if (disposed || version !== revision) continue;
                parents = new WeakMap(); roots = items(snapshot.roots); modelUnits = snapshot.units || new Map();
                tree.description = snapshot.project ? path.basename(snapshot.project) : undefined;
                tree.message = operation ? '正在执行：' + operation : externalStage ? 'Vivado 正在运行，可使用标题栏停止任务' : snapshot.issues.length ? '有 ' + snapshot.issues.length + ' 项工程提示，详见树和输出通道' : undefined;
                tree.badge = snapshot.count ? { value: snapshot.count, tooltip: '当前工程文件数' } : undefined;
                for (const issue of snapshot.issues) log('[工程树] ' + issue);
                changes.fire(undefined);
            }
        })().finally(() => { refreshing = null; if (queued && !disposed) return refresh(); });
        return refreshing;
    }
    function scheduleRefresh() {
        if (disposed) return;
        clearTimeout(watcherTimer); watcherTimer = setTimeout(() => { watcherTimer = null; refresh(); }, 300);
    }
    for (const glob of ['**/*.xpr', '**/*.{sv,v,svh,vh,xdc,sdc,ucf}']) {
        try {
            const watcher = vscode.workspace.createFileSystemWatcher(glob);
            context.subscriptions.push(watcher, watcher.onDidChange(scheduleRefresh), watcher.onDidCreate(scheduleRefresh), watcher.onDidDelete(scheduleRefresh));
        } catch (error) { log('[工程树] 文件监听不可用：' + error.message); }
    }
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh), vscode.workspace.onDidSaveTextDocument(scheduleRefresh));
    function dispose() {
        if (disposed) return;
        Promise.resolve(stopOperation()).catch(error => console.error('工程树任务取消失败：', error));
        pickerToken?.dispose(); disposed = true; revision++; clearTimeout(watcherTimer); changes.dispose();
    }
    context.subscriptions.push({ dispose });

    /** 写操作入口串行，运行中不会先覆写脚本；刷新仍然可用。 */
    function guarded(label, action) {
        return async node => {
            if (disposed) return;
            if (operation || deps.isRunning?.()) { vscode.window.showWarningMessage('Vivado 正在处理任务，请等待完成或先停止。'); return; }
            operation = label; stopRequested = false; stopAction = null;
            pickerToken = vscode.CancellationTokenSource ? new vscode.CancellationTokenSource() : null; setRunning(externalStage);
            try { return await action(node); }
            catch (error) {
                log('[工程树] ' + label + '：' + error.message);
                if (error.code !== 'TOOL_CANCELLED') vscode.window.showErrorMessage(label + '失败：' + error.message);
            }
            finally { operation = null; stopAction = null; pickerToken?.dispose(); pickerToken = null; setRunning(externalStage); await refresh(); }
        };
    }
    function stopOperation() {
        if (operation) stopRequested = true;
        pickerToken?.cancel();
        if (stopAction) return stopAction();
        if (deps.isRunning?.()) return deps.stopRun?.();
        return !!operation;
    }

    // ---------------- 命令实现 ----------------

    async function currentXpr(node) {
        const xpr = await findProjectXpr();
        if (!xpr) vscode.window.showErrorMessage('未找到 Vivado 工程（.xpr）');
        if (node?.nodeData?.xpr && !samePath(node.nodeData.xpr, xpr)) {
            vscode.window.showWarningMessage('工程已切换，请在刷新后的树中重新选择操作。'); return null;
        }
        if (xpr) parseXpr(xpr);
        return xpr;
    }

    /** 写操作通用流程：跑 tcl → 成功后刷新树。 */
    async function runTcl(name, body, xpr, validate = () => true) {
        if (stopRequested) throw cancelledError();
        async function checkCurrent() {
            if (stopRequested) throw cancelledError();
            const current = await findProjectXpr();
            if (!samePath(current, xpr) || !validate(parseXpr(xpr))) {
                vscode.window.showWarningMessage('工程或文件集成员已变化，请刷新后重新执行。'); throw cancelledError('工程状态已变化');
            }
        }
        await checkCurrent();
        const base = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(xpr))?.uri.fsPath || path.dirname(xpr);
        const parent = path.join(base, '.svtools', 'vivado', 'actions');
        await fs.promises.mkdir(parent, { recursive: true });
        const directory = await fs.promises.mkdtemp(path.join(parent, 'action-'));
        const scriptPath = path.join(directory, name);
        await fs.promises.writeFile(scriptPath, body);
        await checkCurrent();
        return runScript(scriptPath, { quiet: true, panel: true });
    }

    /**
     * 写操作结果按 .xpr 事实校验：Vivado batch 退出码与脚本标记都可能说谎
     * （脚本内错误仍退出 0、工程被 GUI 占用时修改可能不落盘），唯一可信的是
     * 重解析后的 .xpr 状态。check(parsed) 返回 true=符合预期。
     */
    function xprFact(xprPath, check) {
        try { return check(parseXpr(xprPath)); } catch (err) { log('[工程树] 写入后读取工程失败：' + err.message); return false; }
    }

    /** 写操作失败统一提示（含 Vivado 侧标记差异，通道里有完整输出）。 */
    function reportWriteFail(what, r) {
        if (r?.status === 'cancelled') { log('[工程树] ' + what + '已取消'); return; }
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

    async function chooseFileset(parsed, type, node) {
        const sets = parsed.sets.filter(set => !type || set.type === type);
        if (!sets.length) { vscode.window.showWarningMessage('工程中没有目标文件集。请先在 Vivado 中建立文件集。'); return null; }
        if (type && sets.length === 1) return sets[0].name;
        const preferred = node?.nodeData?.fileset;
        const choices = [...sets].sort((a, b) => Number(b.name === preferred) - Number(a.name === preferred)).map(set => ({ label: set.name, description: set.type, value: set.name }));
        return (await vscode.window.showQuickPick(choices, { placeHolder: '选择目标文件集' }, pickerToken?.token))?.value || null;
    }
    const hasMember = (parsed, set, file) => parsed.sets.find(entry => entry.name === set)?.files.some(member => samePath(member, file));
    const succeeded = result => result?.code === 0 && (!result.status || result.status === 'success');

    async function addFileToProject(nodeArg) {
        const xpr = await currentXpr(nodeArg); if (!xpr) return;
        // 目标文件：右键未加入文件时直接用之；工具栏按钮则弹出工作区文件选择
        let file = nodeArg?.nodeData?.file || nodeArg?.file;
        if (!file) {
            let uris = [];
            uris = await vscode.workspace.findFiles('**/*.{sv,v,svh,vh,xdc,sdc,ucf}', '**/{.svtools,node_modules}/**', 2000);
            if (!uris.length) { vscode.window.showInformationMessage('工作区没有可加入的源文件/约束'); return; }
            const pick = await vscode.window.showQuickPick(
                uris.map(u => ({ label: path.basename(u.fsPath), description: vscode.workspace.asRelativePath(u.fsPath), fsPath: u.fsPath })),
                { placeHolder: '选择要加入工程的文件' }, pickerToken?.token);
            if (!pick) return;
            file = pick.fsPath;
        }
        const parsed = parseXpr(xpr), target = await chooseFileset(parsed, null, nodeArg); if (!target) return;
        if (hasMember(parsed, target, file)) { vscode.window.showInformationMessage('文件已在 ' + target + ' 中'); return; }
        const r = await runTcl('add_file.tcl', buildAddFilesScript(xpr, file, target, /\.sv(h)?$/i.test(file)), xpr,
            latest => latest.sets.some(set => set.name === target));
        if (!succeeded(r) || !xprFact(xpr, p => hasMember(p, target, file))) {
            reportWriteFail(path.basename(file) + ' 加入 ' + target + ' ', r);
            return;
        }
        vscode.window.showInformationMessage(path.basename(file) + ' 已加入 ' + target);
    }

    async function removeFileFromProject(nodeArg) {
        if (nodeArg?.nodeData?.isReference) { vscode.window.showWarningMessage('此节点仅为引用，请在实际文件集中管理。'); return; }
        const xpr = await currentXpr(nodeArg); if (!xpr) return;
        const node = nodeArg && nodeArg.nodeData;
        if (!node || !node.file) return;
        let parsed;
        try { parsed = parseXpr(xpr); } catch (err) { vscode.window.showErrorMessage('读取 .xpr 失败'); return; }
        const from = node.fileset || fileSetOf(parsed, node.file);
        if (!from || !hasMember(parsed, from, node.file)) {
            // 不在工程里还点移出：多数是树没刷新或模块节点路径与 .xpr 不一致
            vscode.window.showWarningMessage(path.basename(node.file) + ' 不在当前 .xpr 中，已刷新工程树');
            refresh();
            return;
        }
        const r = await runTcl('remove_file.tcl', buildRemoveFilesScript(xpr, node.file, from), xpr, latest => hasMember(latest, from, node.file));
        if (!succeeded(r) || !xprFact(xpr, p => !hasMember(p, from, node.file))) {
            reportWriteFail(path.basename(node.file) + ' 从 ' + from + ' 移出 ', r);
            return;
        }
        vscode.window.showInformationMessage(path.basename(node.file) + ' 已从 ' + from + ' 移出工程');
    }

    async function setTop(nodeArg, type) {
        if (nodeArg?.nodeData?.isReference) { vscode.window.showWarningMessage('请在实际文件集的模块节点设置顶层。'); return; }
        const xpr = await currentXpr(nodeArg); if (!xpr) return;
        const node = nodeArg && nodeArg.nodeData;
        const mod = node && node.module;
        if (!mod) { vscode.window.showErrorMessage('请右键模块节点设置 top'); return; }
        const parsed = parseXpr(xpr), fileset = await chooseFileset(parsed, type, nodeArg); if (!fileset) return;
        const allowed = parsed.sets.filter(set => set.name === fileset || type === 'SimulationSrcs' && set.type === 'DesignSrcs').flatMap(set => set.files);
        if (!allowed.some(file => samePath(file, node.file))) { vscode.window.showWarningMessage('请先将该文件加入目标文件集。'); return; }
        const r = await runTcl('set_top.tcl', buildSetTopScript({ xprPath: xpr, fileset, top: mod }), xpr,
            latest => latest.sets.some(set => set.name === fileset && set.type === type)
                && latest.sets.some(set => (set.name === fileset || type === 'SimulationSrcs' && set.type === 'DesignSrcs') && set.files.some(file => samePath(file, node.file))));
        const ok = succeeded(r) && xprFact(xpr, p => {
            const s = p.sets.find(x => x.name === fileset);
            return !!s && s.top === mod;
        });
        if (!ok) { reportWriteFail(mod + ' 设为 ' + fileset + ' 顶层 ', r); return; }
        vscode.window.showInformationMessage(mod + ' 已设为 ' + fileset + ' 顶层');
    }

    async function moveFile(nodeArg, type) {
        if (nodeArg?.nodeData?.isReference) { vscode.window.showWarningMessage('此节点仅为引用，请在实际文件集中管理。'); return; }
        const xpr = await currentXpr(nodeArg); if (!xpr) return;
        const node = nodeArg && nodeArg.nodeData;
        if (!node || !node.file) return;
        let parsed;
        try { parsed = parseXpr(xpr); } catch (err) { vscode.window.showErrorMessage('读取 .xpr 失败'); return; }
        const from = node.fileset || fileSetOf(parsed, node.file);
        if (!from || !hasMember(parsed, from, node.file)) {
            vscode.window.showWarningMessage(path.basename(node.file) + ' 不在当前 .xpr 中，已刷新工程树');
            refresh();
            return;
        }
        const to = await chooseFileset(parsed, type, nodeArg); if (!to) return;
        if (from === to) { vscode.window.showInformationMessage('已在 ' + to + ' 中'); return; }
        const r = await runTcl('move_file.tcl', buildMoveFileScript({
            xprPath: xpr, file: node.file, from, to, isSv: /\.sv(h)?$/i.test(node.file)
        }), xpr, latest => hasMember(latest, from, node.file) && latest.sets.some(set => set.name === to && set.type === type));
        if (!succeeded(r) || !xprFact(xpr, p => hasMember(p, to, node.file) && !hasMember(p, from, node.file))) {
            reportWriteFail(path.basename(node.file) + '：' + from + ' → ' + to + ' ', r);
            return;
        }
        vscode.window.showInformationMessage(path.basename(node.file) + '：' + from + ' → ' + to);
    }

    /** top 级 xelab 详细化：打开文件后复用现有 lint 详细化命令。 */
    async function elaborateTop(nodeArg) {
        const xpr = await currentXpr(nodeArg); if (!xpr) return;
        const node = nodeArg && nodeArg.nodeData;
        if (!node || !node.file) return;
        await refresh();
        const parsed = parseXpr(xpr), targetSet = parsed.sets.find(set => set.name === node.fileset);
        const sets = targetSet?.type === 'DesignSrcs' ? [targetSet]
            : parsed.sets.filter(set => set.type === 'DesignSrcs' || set.type === 'SimulationSrcs' && set.name === node.fileset);
        const files = [...new Set(sets.flatMap(set => set.files).filter(file => /\.(sv|v)$/i.test(file)))];
        const members = new Set(sets.flatMap(set => set.files));
        const modules = new Map([...modelUnits].filter(([, file]) => [...members].some(member => samePath(member, file))));
        const projectScope = { files, modules, includePaths: [...new Set([...members].map(file => path.dirname(file)))] };
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(node.file));
        await vscode.window.showTextDocument(doc);
        if (stopRequested) throw cancelledError();
        stopAction = () => vscode.commands.executeCommand('svtools.lint.stop', doc);
        await vscode.commands.executeCommand('svtools.xvlog.elaborate', doc, { top: node.module, projectScope });
    }

    /** 快捷区 xelab：从 .xpr 取 sim_1 top（无则综合 top）的源文件打开后详细化。 */
    async function quickElaborate(nodeArg) {
        const xpr = await currentXpr(nodeArg); if (!xpr) return;
        let parsed;
        try { parsed = parseXpr(xpr); } catch (err) { vscode.window.showErrorMessage('读取 .xpr 失败'); return; }
        let candidates = parsed.sets.filter(set => set.type === 'SimulationSrcs' && set.top);
        if (!candidates.length) candidates = parsed.sets.filter(set => set.type === 'DesignSrcs' && set.top);
        if (!candidates.length) { vscode.window.showErrorMessage('工程未设置 top 模块（在文件树右键模块设置）'); return; }
        const chosen = candidates.length === 1 ? candidates[0] : (await vscode.window.showQuickPick(
            candidates.map(set => ({ label: set.name, description: 'top: ' + set.top, set })), { placeHolder: '选择要详细化的工程文件集' }, pickerToken?.token))?.set;
        if (!chosen) return;
        const top = chosen.top, allowed = [...chosen.files, ...parsed.sets.filter(set => set.type === 'DesignSrcs').flatMap(set => set.files)];
        await refresh();
        const stack = [...roots], matches = [];
        while (stack.length) { const item = stack.pop(); if (item.nodeData?.module === top && allowed.some(member => samePath(member, item.nodeData.file))) matches.push(item.nodeData.file); stack.push(...item.children); }
        const file = matches.find(candidate => chosen.files.some(member => samePath(member, candidate))) || matches[0];
        if (!file) {
            // 索引找不到时兜底：top 名 + 常见扩展名在工程文件集里找
            const cand = allowed.find(f => samePath(path.basename(f), top + '.sv') || samePath(path.basename(f), top + '.v'));
            if (!cand) { vscode.window.showErrorMessage('找不到 top 模块 ' + top + ' 的源文件'); return; }
            return elaborateTop({ nodeData: { file: cand, module: top, fileset: chosen.name, xpr } });
        }
        return elaborateTop({ nodeData: { file, module: top, fileset: chosen.name, xpr } });
    }

    /** 综合 / 布局布线 / Bitstream（impl 自动级联 synth）。 */
    async function launchRun(run, toStep, label, nodeArg) {
        const xpr = await currentXpr(nodeArg); if (!xpr) return;
        vscode.window.showInformationMessage(label + '启动（状态栏可查看进度/停止）…');
        const r = await runTcl('launch_run.tcl', buildLaunchRunScript({ xprPath: xpr, run, toStep }), xpr);
        if (r?.status === 'cancelled') { log('[工程树] ' + label + '已取消'); return; }
        if (!succeeded(r)) {
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
    async function openRunReports(run, kinds, nodeArg) {
        const xpr = await currentXpr(nodeArg); if (!xpr) return;
        const base = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(xpr))?.uri.fsPath || path.dirname(xpr);
        const parent = path.join(base, '.svtools', 'vivado', 'reports', run);
        await fs.promises.mkdir(parent, { recursive: true });
        const outDir = await fs.promises.mkdtemp(path.join(parent, 'report-'));
        const r = await runTcl('reports_' + run + '.tcl', buildRunReportsScript({ xprPath: xpr, run, outDir, reports: kinds }), xpr);
        if (r?.status === 'cancelled') { log('[工程树] 报告任务已取消'); return; }
        if (!succeeded(r)) {
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
            if (entry[2]) { try { entry[2](fs.readFileSync(p, 'utf8')); } catch (err) { log('[工程树] 读取报告摘要失败：' + err.message); } }
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
        await refresh(); const stack = [...roots]; let expanded = 0;
        while (stack.length) {
            const n = stack.pop();
            if (n.children && n.children.length) {
                stack.push(...n.children);
                if (++expanded > 500) { vscode.window.showInformationMessage('已展开前 500 个分组，其余可手动展开。'); break; }
                try { await tree.reveal(n, { select: false, focus: false, expand: true }); }
                catch (err) { log('[工程树] 展开节点失败：' + err.message); break; }
            }
        }
    }

    // ---------------- 注册 ----------------

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.vivado.tree.refresh', refresh),
        vscode.commands.registerCommand('svtools.vivado.tree.stop', stopOperation),
        vscode.commands.registerCommand('svtools.vivado.tree.selectProject', guarded('选择工程', () => deps.selectProject(pickerToken?.token))),
        vscode.commands.registerCommand('svtools.vivado.tree.addFile', guarded('加入文件', addFileToProject)),
        vscode.commands.registerCommand('svtools.vivado.tree.removeFile', guarded('移出文件', removeFileFromProject)),
        vscode.commands.registerCommand('svtools.vivado.tree.setTopSynth', guarded('设置综合顶层', n => setTop(n, 'DesignSrcs'))),
        vscode.commands.registerCommand('svtools.vivado.tree.setTopSim', guarded('设置仿真顶层', n => setTop(n, 'SimulationSrcs'))),
        vscode.commands.registerCommand('svtools.vivado.tree.moveToSim', guarded('移入仿真集', n => moveFile(n, 'SimulationSrcs'))),
        vscode.commands.registerCommand('svtools.vivado.tree.moveToSources', guarded('移入设计集', n => moveFile(n, 'DesignSrcs'))),
        vscode.commands.registerCommand('svtools.vivado.tree.elaborate', guarded('详细化', elaborateTop)),
        vscode.commands.registerCommand('svtools.vivado.tree.quickElaborate', guarded('顶层详细化', quickElaborate)),
        vscode.commands.registerCommand('svtools.vivado.tree.synthesize', guarded('综合', n => launchRun('synth_1', null, '综合', n))),
        vscode.commands.registerCommand('svtools.vivado.tree.implement', guarded('布局布线', n => launchRun('impl_1', 'route_design', '布局布线', n))),
        vscode.commands.registerCommand('svtools.vivado.tree.bitstream', guarded('生成 Bitstream', n => launchRun('impl_1', 'write_bitstream', 'Bitstream 生成', n))),
        vscode.commands.registerCommand('svtools.vivado.tree.reportSynth', guarded('综合报告', n => openRunReports('synth_1', undefined, n))),
        vscode.commands.registerCommand('svtools.vivado.tree.reportImpl', guarded('实现报告', n => openRunReports('impl_1', undefined, n))),
        vscode.commands.registerCommand('svtools.vivado.tree.reportImplUtil', guarded('资源报告', n => openRunReports('impl_1', ['utilization'], n))),
        vscode.commands.registerCommand('svtools.vivado.tree.reportTiming', guarded('时序报告', n => openRunReports('impl_1', ['timing_summary'], n))),
        vscode.commands.registerCommand('svtools.vivado.tree.expandAll', expandAll)
    );

    const ready = refresh();
    setRunning(null);
    return { refresh, ready, dispose, setRunning, isBusy: () => !!operation, getChildren: provider.getChildren, onDidChangeTreeData: changes.event };
}

module.exports = { activateProjectTree };
