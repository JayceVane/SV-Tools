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
// Vivado 集成入口：activateVivado 集成层（命令接线、输出通道/状态栏运行器、工程创建向导、
// 增量文件管理、双引擎仿真、器件选型）+ 各子模块纯函数汇总导出。
// extension.js 的 require('./vivado') 解析到本目录。

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizeVivadoDir, findVivadoBinDir, buildBatchArgs, cmdQuote } = require('./toolchain');
const {
    tclQuote, tclList, buildCreateProjectScript, buildAddFilesScript, buildRemoveFilesScript,
    buildSimulateScript, extractVivadoIssues, firstModuleName,
    buildOocReportsScript, parseUtilHierSummary, parseLogicLevelSummary
} = require('./tclgen');
const { buildExportPartsScript, parsePartsDump, partFilterOptions, filterParts, buildPartPickerHtml } = require('./parts');
const { matchGlobList, classifyFiles, DEFAULT_STRUCTURE } = require('./structure');
const { scanVerilogFiles, scanConstraintFiles, scanTclFiles, detectTopModules, guessSimTop } = require('./scan');

const OUTPUT_CHANNEL_TITLE = 'SystemVerilog Tools · Vivado';

// ---------------------------------------------------------------------------

/** @returns {import('vscode')} deps 里注入的 vscode（单测时 mock） */
function activateVivado(context, deps) {
    const vscode = (deps && deps.vscode) || require('vscode');
    const out = vscode.window.createOutputChannel(OUTPUT_CHANNEL_TITLE);

    let running = null;      // { child, scriptPath, startedAt, timer }
    let statusItem = null;
    let binDirCache = null;

    function log(msg) { out.appendLine(msg); }

    function status(text, command) {
        if (!statusItem) {
            statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
            statusItem.name = 'svtools Vivado';
        }
        if (!text) { statusItem.hide(); return; }
        statusItem.text = text;
        statusItem.tooltip = 'svtools Vivado';
        statusItem.command = command || undefined;
        statusItem.show();
    }

    function resolveBinDir() {
        if (binDirCache) return binDirCache;
        const cfg = vscode.workspace.getConfiguration('svtools.vivado');
        binDirCache = findVivadoBinDir(cfg.get('path'), process.env, null, process.platform);
        return binDirCache;
    }

    // ---------------- Vivado 工程探测（决定标签页按钮显隐） ----------------

    async function findProjectXpr() {
        const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        if (!ws) return null;
        const uris = await vscode.workspace.findFiles('**/*.xpr', '**/{node_modules,vivado_prj,.svtools}/**', 20);
        if (uris.length) return uris[0].fsPath;
        // 兜底：结构模板工程目录
        const st = getStructure();
        const guess = path.join(ws.uri.fsPath, st.projectDir);
        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(guess));
            const xpr = entries.find(e => e[0].toLowerCase().endsWith('.xpr'));
            if (xpr) return path.join(guess, xpr[0]);
        } catch (e) { /* 目录不存在 */ }
        return null;
    }

    let hasProjectCtx = false;
    async function refreshProjectContext() {
        const xpr = await findProjectXpr();
        if (!!xpr !== hasProjectCtx) {
            hasProjectCtx = !!xpr;
            vscode.commands.executeCommand('setContext', 'svtools.vivado.hasProject', hasProjectCtx);
        }
        return xpr;
    }

    /** 当前编辑器若是 Verilog 源文件返回 {path, isSv, rel}，否则提示并返回 null。 */
    function currentVerilogFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showErrorMessage('没有活动编辑器'); return null; }
        const f = editor.document.fileName;
        if (!/\.(sv|v|svh|vh)$/i.test(f)) {
            vscode.window.showErrorMessage('当前文件不是 Verilog/SystemVerilog 源文件');
            return null;
        }
        return { path: f, isSv: /\.(sv|svh)$/i.test(f), doc: editor.document };
    }

    /** 按结构模板判断文件应进哪个文件集。 */
    function filesetOf(absFile, rootDir) {
        const rel = path.relative(rootDir, absFile);
        if (matchGlobList(rel, getStructure().sim)) return 'sim_1';
        return 'sources_1';
    }

    async function runIncrementalTcl(name, scriptBody) {
        const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        if (!ws) { vscode.window.showErrorMessage('请先打开一个工作区'); return; }
        const xpr = await refreshProjectContext();
        if (!xpr) { vscode.window.showErrorMessage('未找到 Vivado 工程（.xpr），请先运行 "Vivado: 创建工程"'); return; }
        const scriptPath = path.join(ws.uri.fsPath, '.svtools', 'vivado', name);
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
        fs.writeFileSync(scriptPath, scriptBody);
        return runScript(scriptPath);
    }

    async function addCurrentToProject() {
        const cur = currentVerilogFile();
        if (!cur) return;
        const ws = vscode.workspace.workspaceFolders[0];
        const fs1 = filesetOf(cur.path, ws.uri.fsPath);
        const pick = await vscode.window.showQuickPick(
            [{ label: 'sources_1（RTL 源文件）', value: 'sources_1' }, { label: 'sim_1（仿真/测试台）', value: 'sim_1' }],
            { placeHolder: '加入哪个文件集（按工程结构模板预判为 ' + fs1 + '）' });
        if (!pick) return;
        vscode.window.showInformationMessage('正在把 ' + path.basename(cur.path) + ' 加入 ' + pick.value + '…');
        return runIncrementalTcl('add_file.tcl', buildAddFilesScript(await refreshProjectContext(), cur.path, pick.value, cur.isSv));
    }

    async function removeCurrentFromProject() {
        const cur = currentVerilogFile();
        if (!cur) return;
        const ws = vscode.workspace.workspaceFolders[0];
        const fs1 = filesetOf(cur.path, ws.uri.fsPath);
        return runIncrementalTcl('remove_file.tcl', buildRemoveFilesScript(await refreshProjectContext(), cur.path, fs1));
    }

    /** Vivado xsim 行为仿真：当前文件置为 sim_1 顶层。 */
    async function simulateWithVivado() {
        const cur = currentVerilogFile();
        if (!cur) return;
        const top = firstModuleName(cur.doc.getText());
        if (!top) { vscode.window.showErrorMessage('当前文件里没有找到 module 声明'); return; }
        const cfg = vscode.workspace.getConfiguration('svtools.vivado');
        const runtime = String(cfg.get('simRuntime', '') || '');   // 空 = 跑到 $finish（xsim -runall）
        const xpr = await refreshProjectContext();
        if (!xpr) { vscode.window.showErrorMessage('未找到 Vivado 工程（.xpr），请先运行 "Vivado: 创建工程"'); return; }
        vscode.window.showInformationMessage('Vivado xsim 仿真：顶层 ' + top + (runtime ? '（runtime ' + runtime + '）' : '（跑到 $finish）'));
        return runIncrementalTcl('simulate.tcl',
            buildSimulateScript({ xprPath: xpr, top, file: cur.path, isSv: cur.isSv, runtime }));
    }

    /**
     * 传递闭包收集综合文件集：入口文件 + 其文本中出现的工作区定义单元（词边界
     * 匹配，含模块实例化/import 引用；注释误命中只多读文件，不影响 -top 综合）。
     * @param {string} entryFile
     * @returns {Promise<string[]>}
     */
    async function collectSynthFiles(entryFile) {
        const files = [entryFile];
        let index;
        try { index = (await require('../iverilog').scanWorkspaceSources()).modules; } catch (err) { return files; }
        const seen = new Set(files.map(f => path.resolve(f)));
        const nameRes = [...index.keys()].map(n => ({ n, re: new RegExp('\\b' + n.replace(/[$]/g, '\\$') + '\\b') }));
        for (let i = 0; i < files.length; i++) {
            let text = '';
            try { text = fs.readFileSync(files[i], 'utf8'); } catch (err) { continue; }
            for (const { n, re } of nameRes) {
                const f = index.get(n);
                if (f && !seen.has(path.resolve(f)) && re.test(text)) {
                    seen.add(path.resolve(f));
                    files.push(f);
                }
            }
        }
        return files;
    }

    /** OOC 综合结束后：解析两份报告摘要进输出通道，并把 .rpt 打开到编辑器。 */
    async function showOocReports(outDir, top, modeLabel) {
        const utilRpt = path.join(outDir, 'utilization_hier.rpt');
        const llRpt = path.join(outDir, 'logic_levels.rpt');
        log('———— OOC 报告（' + top + (modeLabel ? '，' + modeLabel : '') + '）————');
        try {
            for (const s of parseUtilHierSummary(fs.readFileSync(utilRpt, 'utf8'))) log(s);
        } catch (err) { /* 报告缺失时只开文件 */ }
        try {
            log(parseLogicLevelSummary(fs.readFileSync(llRpt, 'utf8')));
        } catch (err) { /* 同上 */ }
        log('完整报告: ' + utilRpt);
        for (const f of [utilRpt, llRpt]) {
            try { await vscode.window.showTextDocument(vscode.Uri.file(f), { preview: false }); } catch (err) { /* 打不开只留通道摘要 */ }
        }
    }

    /**
     * 标签页 Vivado 快捷入口：当前模块 OOC 综合 → 分层资源占用 + 逻辑级数
     * 分布报告。不依赖/修改 .xpr 工程。两档可选（对比优化收益）：
     * 保持层次 = -flatten_hierarchy none（可看子模块分摊，禁跨边界优化）；
     * 全优化 = full（Vivado 默认，跨模块边界优化，层次被展平）。
     * 两档都是 out_of_context，对比时只差 flatten 一个变量。
     */
    async function vivadoReports() {
        const cur = currentVerilogFile();
        if (!cur) return;
        const text = cur.doc.getText();
        if (/\buvm_[a-z0-9_]+/i.test(text)) {
            vscode.window.showWarningMessage('当前文件使用 UVM（测试平台不可综合），请打开 RTL 模块文件再生成报告。');
            return;
        }
        // 综合策略：保持层次（默认）/ 全优化，两档对比只差 -flatten_hierarchy
        const modePick = await vscode.window.showQuickPick([
            {
                label: '保持层次（默认）',
                description: '-flatten_hierarchy none：保留模块边界，可看子模块资源分摊；禁跨边界优化',
                value: 'none'
            },
            {
                label: '全优化',
                description: '-flatten_hierarchy full（Vivado 默认）：跨模块边界优化，资源/时序最优；层次被展平',
                value: 'full'
            }
        ], { placeHolder: 'OOC 综合策略（两档都为 out_of_context，可分别跑一次对比差别）' });
        if (!modePick) return;   // 用户取消
        const flatten = modePick.value;

        // 综合顶层取自当前文件（不碰工程 top）；多模块文件让用户挑，单模块直取
        const modules = [...text.matchAll(/^[ \t]*(?:module|macromodule)[ \t]+([A-Za-z_][A-Za-z0-9_$]*)/gm)].map(m => m[1]);
        if (!modules.length) { vscode.window.showErrorMessage('当前文件里没有找到 module 声明'); return; }
        let top = modules[0];
        if (modules.length > 1) {
            const pick = await vscode.window.showQuickPick(
                modules.map(m => ({ label: m, description: m === modules[0] ? '文件中第一个模块' : '' })),
                { placeHolder: '当前文件包含 ' + modules.length + ' 个 module，选择要综合的顶层' });
            if (!pick) return;   // 用户取消
            top = pick.label;
        }

        // 器件来源：工作区 .xpr → svtools.vivado.part 配置
        let part = '';
        const xpr = await findProjectXpr();
        if (xpr) {
            try { part = (fs.readFileSync(xpr, 'utf8').match(/Option Name="Part" Val="([^"]+)"/) || [])[1] || ''; } catch (err) { /* 读不到走配置 */ }
        }
        const cfg = vscode.workspace.getConfiguration('svtools.vivado');
        if (!part) part = String(cfg.get('part', '') || '').trim();
        if (!part) {
            vscode.window.showErrorMessage(
                '未找到器件型号：工作区没有 .xpr，且 svtools.vivado.part 未配置', '打开设置'
            ).then(choice => {
                if (choice === '打开设置') vscode.commands.executeCommand('workbench.action.openSettings', 'svtools.vivado.part');
            });
            return;
        }

        const files = await collectSynthFiles(cur.path);
        const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const base = ws ? ws.uri.fsPath : path.dirname(cur.path);
        // 两档报告分目录存放，分别跑一次后可直接对比/不被覆盖
        const outDir = path.join(base, '.svtools', 'vivado', 'ooc', flatten === 'full' ? 'opt' : 'hier');
        const scriptPath = path.join(base, '.svtools', 'vivado', 'ooc_reports.tcl');
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
        fs.writeFileSync(scriptPath, buildOocReportsScript({
            files,
            includeDirs: [...new Set(files.map(f => path.dirname(f)))],
            top, part, outDir, flatten,
            isSv: files.some(f => /\.(sv|svh)$/i.test(f))
        }));
        const modeLabel = flatten === 'full' ? '全优化（flatten full）' : '保持层次（flatten none）';
        vscode.window.showInformationMessage(`OOC 综合中：${top}（${part}，${files.length} 个文件，${modeLabel}）— 可在 Vivado 输出通道查看进度`);
        const r = await runScript(scriptPath, { quiet: true });
        if (!r || r.code !== 0) {
            out.show(true);
            vscode.window.showErrorMessage('OOC 综合失败（详见 Vivado 输出通道）');
            return;
        }
        await showOocReports(outDir, top, modeLabel);
    }

    /** 标签页 ▶ 按钮：选择仿真引擎。 */
    async function simulatePick() {        const engine = await vscode.window.showQuickPick(
            [
                { label: '$(chip) Icarus Verilog', description: 'iverilog 编译 + vvp（无需 Vivado 工程）', value: 'iverilog' },
                { label: '$(circuit-board) Vivado xsim', description: '行为仿真，当前文件置为 sim_1 顶层（需 Vivado 工程）', value: 'vivado' }
            ],
            { placeHolder: '选择仿真引擎' });
        if (!engine) return;
        if (engine.value === 'iverilog') return vscode.commands.executeCommand('svtools.iverilog.simulate');
        return simulateWithVivado();
    }

    // ---------------- 器件选型（Vivado 向导式：系列 → 封装 → 速度 → 搜索选择） ----------------

    let partsCache = null;   // null=未加载 []=空库
    async function loadPartsCatalog() {
        if (partsCache !== null) return partsCache;
        const binDir = resolveBinDir();
        if (!binDir) return (partsCache = []);
        const ver = path.basename(path.dirname(binDir)) || 'unknown';   // 如 2022.1
        const cacheDir = context.globalStoragePath || path.join(os.homedir(), '.svtools');
        const dumpPath = path.join(cacheDir, 'vivado_parts_' + ver + '.txt');
        try {
            if (!fs.existsSync(dumpPath)) {
                fs.mkdirSync(cacheDir, { recursive: true });
                const scriptPath = path.join(cacheDir, 'export_parts.tcl');
                fs.writeFileSync(scriptPath, buildExportPartsScript(dumpPath));
                status('$(database) 导出 Vivado 器件库…');
                try {
                    await runScript(scriptPath, { quiet: true, timeoutMs: 120000 });
                } finally { status(null); }
            }
            partsCache = parsePartsDump(fs.readFileSync(dumpPath, 'utf8'));
        } catch (e) {
            partsCache = [];
        }
        return partsCache;
    }

    /** 器件选型详情页（webview，Vivado 向导风格：筛选下拉 + 搜索联想 + 表格 + 详情）；返回 part 字符串（''=不设置），undefined=用户取消。 */
    async function pickPart(defaultPart) {
        const parts = await loadPartsCatalog();
        if (!parts.length) {
            // 导不出库（无 Vivado / 结构变化）：回退手输
            const v = await vscode.window.showInputBox({
                prompt: '器件型号（-part，如 xc7a35tcsg324-1，可留空后在 Vivado 中选择）',
                value: defaultPart || ''
            });
            return v === undefined ? undefined : v.trim();
        }
        return new Promise((resolve) => {
            const panel = vscode.window.createWebviewPanel(
                'svtoolsPartPicker', '器件选型',
                vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            panel.webview.html = buildPartPickerHtml(parts, defaultPart);
            let settled = false;
            const finish = (v) => {
                if (settled) return;
                settled = true;
                panel.dispose();
                resolve(v);
            };
            panel.webview.onDidReceiveMessage(function (msg) {
                if (!msg) return;
                if (msg.type === 'pick') finish(String(msg.part || ''));
                else if (msg.type === 'cancel') finish(undefined);
            });
            panel.onDidDispose(function () { finish(undefined); });
        });
    }

    /** 运行 TCL 脚本。返回 Promise<{code, ms, issues}>（供命令与 AI Agent 工具复用）。 */
    function runScript(scriptPath, opts) {
        return new Promise((resolve) => {
            if (running) {
                vscode.window.showWarningMessage('Vivado 正在运行 ' + path.basename(running.scriptPath) + '，请先停止');
                resolve({ code: null, error: 'busy' });
                return;
            }
            const binDir = resolveBinDir();
            if (!binDir) {
                const pick = vscode.window.showErrorMessage(
                    '未找到 Vivado（vivado.bat）。请在设置 svtools.vivado.path 中指定安装目录，如 D:\\DevKit\\Xilinx\\Vivado\\2022.1',
                    '打开设置');
                if (pick && pick.then) pick.then(v => {
                    if (v) vscode.commands.executeCommand('workbench.action.openSettings', 'svtools.vivado.path');
                });
                resolve({ code: null, error: 'not-found' });
                return;
            }
            const bat = path.join(binDir, process.platform === 'win32' ? 'vivado.bat' : 'vivado');
            const args = buildBatchArgs(scriptPath, (opts && opts.tclArgs) || [], (opts && opts.extraArgs) || []);
            const cwd = (opts && opts.cwd) || path.dirname(scriptPath);

            if (!(opts && opts.quiet)) out.show(true);
            log('————————————————————————————————————');
            log('[vivado] ' + bat + ' ' + args.join(' '));
            log('[vivado] cwd: ' + cwd);
            const startedAt = Date.now();
            status('$(loading~spin) Vivado 运行中…', 'svtools.vivado.stop');

            let child;
            if (process.platform === 'win32') {
                // Node 24 起 spawn .bat 必须经 shell；显式 cmd /c 并逐参引号，避免空格路径断裂
                const line = [bat].concat(args).map(cmdQuote).join(' ');
                child = spawn('cmd.exe', ['/d', '/s', '/c', line], { cwd, windowsVerbatimArguments: true });
            } else {
                child = spawn(bat, args, { cwd });
            }
            running = { child, scriptPath, startedAt, timer: null };

            const done = (code, reason) => {
                if (!running) return;
                clearTimeout(running.timer);
                running = null;
                const ms = Date.now() - startedAt;
                const issues = extractVivadoIssues(outLines.join('\n'));
                status(null);
                if (code === 0) {
                    log('[vivado] 完成，耗时 ' + (ms / 1000).toFixed(1) + 's' +
                        (issues.length ? '，' + issues.length + ' 条错误/严重警告' : ''));
                } else {
                    log('[vivado] 退出 code=' + code + (reason ? ' (' + reason + ')' : '') + '，耗时 ' + (ms / 1000).toFixed(1) + 's');
                }
                refreshProjectContext();   // create_project 等操作可能新建/删除了 .xpr
                resolve({ code: code, ms: ms, issues: issues });
            };

            const outLines = [];
            const feed = (chunk) => {
                const s = chunk.toString('utf8');
                outLines.push(s);
                out.append(s);
            };
            child.stdout.on('data', feed);
            child.stderr.on('data', feed);
            child.on('error', (e) => { log('[vivado] 启动失败: ' + e.message); done(null, e.code || 'spawn-error'); });
            child.on('close', (code) => done(code, null));

            const timeoutMs = (opts && opts.timeoutMs !== undefined)
                ? opts.timeoutMs
                : vscode.workspace.getConfiguration('svtools.vivado').get('timeoutMs', 0);
            if (timeoutMs > 0) {
                running.timer = setTimeout(() => {
                    log('[vivado] 超时 (' + timeoutMs + 'ms)，终止进程树');
                    try {
                        // 只 kill() 会只杀掉 cmd.exe 壳，vivado/xsim 孤儿化继续运行
                        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
                        else child.kill('SIGKILL');
                    } catch (e) { /* ignore */ }
                    done(null, 'timeout');
                }, timeoutMs);
            }
        });
    }

    function stopRun() {
        if (!running) { vscode.window.showInformationMessage('没有正在运行的 Vivado 任务'); return; }
        log('[vivado] 用户请求停止，终止进程树');
        try {
            if (process.platform === 'win32') spawn('taskkill', ['/pid', String(running.child.pid), '/T', '/F']);
            else running.child.kill('SIGKILL');
        } catch (e) { /* ignore */ }
        return true;
    }

    // ---------------- 建工程向导（按工程结构模板，默认 src/sim/prj，可自定义） ----------------

    function getStructure() {
        const cfg = vscode.workspace.getConfiguration('svtools.vivado');
        const st = cfg.get('structure', null);
        if (!st || typeof st !== 'object') return JSON.parse(JSON.stringify(DEFAULT_STRUCTURE));
        return {
            sources: Array.isArray(st.sources) ? st.sources : DEFAULT_STRUCTURE.sources,
            sim: Array.isArray(st.sim) ? st.sim : DEFAULT_STRUCTURE.sim,
            constraints: Array.isArray(st.constraints) ? st.constraints : DEFAULT_STRUCTURE.constraints,
            projectDir: String(st.projectDir || DEFAULT_STRUCTURE.projectDir)
        };
    }

    function classifyByTbHeuristic(absFiles, rootDir) {
        // 无结构模板可依据时的兜底：文件名 tb_ 前缀 / tb 目录归 sim
        const out = { sources: [], sims: [], constraints: [], others: [] };
        absFiles.forEach(f => {
            const rel = path.relative(rootDir, f);
            const base = path.basename(rel).toLowerCase().replace(/\.(sv|v)$/, '');
            if (/^tb_|_tb$/.test(base) || /(^|[\\/])tb[\\/]/i.test(rel)) out.sims.push(f);
            else out.sources.push(f);
        });
        return out;
    }

    async function createProject() {
        const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        if (!ws) { vscode.window.showErrorMessage('请先打开一个工作区文件夹'); return; }
        const cfg = vscode.workspace.getConfiguration('svtools.vivado');
        const structure = getStructure();

        // 1. 工程名
        const name = await vscode.window.showInputBox({
            prompt: 'Vivado 工程名', value: ws.name || 'prj',
            validateInput: v => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) ? '' : '需为合法标识符（字母/数字/下划线，不以数字开头）'
        });
        if (name === undefined) return;

        // 2. 工程目录（相对工作区，默认取结构模板的 projectDir，如 prj/）
        const prjRel = await vscode.window.showInputBox({
            prompt: '工程输出目录（相对工作区）',
            value: structure.projectDir,
            validateInput: v => v.trim() ? '' : '不能为空'
        });
        if (prjRel === undefined) return;

        // 3. 扫描并按工程结构模板分类（src→sources、sim→sim_1、xdc→constrs_1）
        const files = await scanVerilogFiles(vscode, ws.uri.fsPath);
        const xdcFiles = await scanConstraintFiles(vscode, ws.uri.fsPath);
        const all = files.concat(xdcFiles);
        let groups = classifyFiles(all, ws.uri.fsPath, structure);
        const tbFallback = classifyByTbHeuristic(groups.others.filter(f => /\.(sv|v)$/i.test(f)), ws.uri.fsPath);
        groups = {
            sources: groups.sources.concat(tbFallback.sources),
            sims: groups.sims.concat(tbFallback.sims),
            constraints: groups.constraints.concat(groups.others.filter(f => /\.xdc$/i.test(f))),
            others: []
        };
        if (!files.length) {
            // 工作区没有 Verilog 源码：询问是否按模板创建目录骨架（src/ sim/ prj/）
            const skel = await vscode.window.showInformationMessage(
                '工作区内没有 .v/.sv 源文件。按工程模板创建目录骨架（src/、sim/、' + prjRel.trim() + '/）？', '创建', '取消');
            if (skel !== '创建') return;
            for (const d of ['src', 'sim', prjRel.trim()]) {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(ws.uri.fsPath, d)));
            }
            vscode.window.showInformationMessage('目录骨架已创建，把源码放入 src/、测试台放入 sim/ 后重新运行本命令');
            return;
        }

        // 4. 源文件多选确认（结构模板分类 + 兜底启发，未分类默认不选）
        const picks = await vscode.window.showQuickPick(
            all.map(f => {
                const rel = path.relative(ws.uri.fsPath, f);
                const grp = groups.sources.includes(f) ? 'sources' :
                    (groups.sims.includes(f) ? 'sim' :
                        (groups.constraints.includes(f) ? 'constrs' : '未分类'));
                return { label: rel, description: grp, picked: grp !== '未分类', abs: f, grp };
            }),
            { canPickMany: true, placeHolder: '选择加入工程的文件（按结构模板预分：sources/sim/constrs，未分类可手动勾选）' }
        );
        if (!picks) return;
        const sources = picks.filter(p => p.grp !== 'sim' && p.grp !== 'constrs').map(p => p.abs);
        const sims = picks.filter(p => p.grp === 'sim').map(p => p.abs);
        const constraints = picks.filter(p => p.grp === 'constrs').map(p => p.abs);

        // 5. 器件型号（Vivado 式逐级筛选：系列 → 封装 → 速度 → 搜索选择）
        const part = await pickPart(cfg.get('part', '') || '');
        if (part === undefined) return;

        // 6. 顶层模块
        const tops = await detectTopModules(vscode, sources);
        const top = await vscode.window.showQuickPick(
            [{ label: '(不设置)', value: '' }].concat(tops.map(t => ({ label: t, value: t }))),
            { placeHolder: 'sources 顶层模块（' + (tops.length || 0) + ' 个候选，可跳过）' }
        );
        if (top === undefined) return;
        const simTopGuess = sims.length ? await guessSimTop(vscode, sims) : '';

        // 7. 生成脚本到 .svtools/vivado/（工具产物区，与仿真输出同约定）
        const script = buildCreateProjectScript({
            name: name.trim(),
            dir: path.join(ws.uri.fsPath, prjRel.trim()),
            part: part.trim(),
            sources, sims, constraints,
            top: top.value, simTop: simTopGuess
        });
        const scriptDir = path.join(ws.uri.fsPath, '.svtools', 'vivado');
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(scriptDir));
        const scriptPath = path.join(scriptDir, 'create_prj.tcl');
        // 直接写文件（openTextDocument 对不存在的文件会报错，不能先用）
        await vscode.workspace.fs.writeFile(vscode.Uri.file(scriptPath), Buffer.from(script, 'utf8'));
        vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(scriptPath)));
        refreshProjectContext();

        // 8. 立即运行？
        const run = await vscode.window.showInformationMessage(
            '已生成 ' + path.relative(ws.uri.fsPath, scriptPath) + '，立即用 Vivado batch 创建工程？', '运行', '稍后手动运行');
        if (run === '运行') return runScript(scriptPath);
        return { scriptPath };
    }

    // ---------------- 命令接线 ----------------

    context.subscriptions.push(
        out,
        vscode.commands.registerCommand('svtools.vivado.runScript', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && /\.tcl$/i.test(editor.document.fileName)) {
                if (editor.document.isUntitled) { vscode.window.showErrorMessage('请先保存 TCL 脚本'); return; }
                await editor.document.save();
                return runScript(editor.document.fileName);
            }
            const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            if (!ws) { vscode.window.showErrorMessage('请先打开一个工作区'); return; }
            const picks = await scanTclFiles(vscode, ws.uri.fsPath);
            if (!picks.length) { vscode.window.showInformationMessage('工作区内没有 .tcl 脚本'); return; }
            const sel = await vscode.window.showQuickPick(
                picks.map(f => ({ label: path.relative(ws.uri.fsPath, f), abs: f })),
                { placeHolder: '选择要运行的 TCL 脚本' });
            if (!sel) return;
            return runScript(sel.abs);
        }),
        vscode.commands.registerCommand('svtools.vivado.runActiveScript', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !/\.tcl$/i.test(editor.document.fileName)) {
                vscode.window.showErrorMessage('当前编辑器不是 .tcl 文件');
                return;
            }
            if (editor.document.isUntitled) { vscode.window.showErrorMessage('请先保存 TCL 脚本'); return; }
            await editor.document.save();
            return runScript(editor.document.fileName);
        }),
        vscode.commands.registerCommand('svtools.vivado.stop', () => stopRun()),
        vscode.commands.registerCommand('svtools.vivado.createProject', () => createProject()),
        vscode.commands.registerCommand('svtools.vivado.addToFileset', () => addCurrentToProject()),
        vscode.commands.registerCommand('svtools.vivado.removeFromFileset', () => removeCurrentFromProject()),
        vscode.commands.registerCommand('svtools.vivado.simulate', () => simulateWithVivado()),
        vscode.commands.registerCommand('svtools.vivado.reports', () => vivadoReports()),
        vscode.commands.registerCommand('svtools.simulate.pick', () => simulatePick()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => refreshProjectContext())
    );
    refreshProjectContext();

    return {
        runScript, stopRun, createProject, simulateWithVivado,
        refreshProjectContext,
        resolveBinDir
    };
}

module.exports = {
    ...require('./toolchain'),
    ...require('./tclgen'),
    ...require('./parts'),
    ...require('./structure'),
    ...require('./scan'),
    activateVivado
};
