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
 * Vivado TCL 集成：批处理模式运行 TCL 脚本 + 工程创建向导（生成并执行 create_project TCL）。
 *
 * 模块分层：
 *  - Vivado 定位 / batch 参数构建 / TCL 转义与工程脚本生成为纯函数，不依赖 vscode，可独立单元测试；
 *  - activateVivado() 负责 VSCode 集成（命令、输出通道、状态栏、超时与停止）。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUTPUT_CHANNEL_TITLE = 'SystemVerilog Tools · Vivado';
const TOOL_PROBE_TIMEOUT_MS = 20000; // vivado.bat -version 冷启动可达十几秒

// ---------------------------------------------------------------------------

/** 规范化用户配置的 Vivado 路径：接受安装根目录 / bin 目录 / vivado.bat 全路径，统一返回 bin 目录。 */
function normalizeVivadoDir(configured) {
    const trimmed = String(configured || '').trim();
    if (!trimmed) return null;
    const base = path.basename(trimmed).toLowerCase();
    if (base === 'vivado.bat' || base === 'vivado') return path.dirname(trimmed);
    if (base === 'bin') return trimmed;
    return path.join(trimmed, 'bin');
}

/**
 * 定位 Vivado bin 目录。查找顺序：显式配置 → XILINX_VIVADO → PATH → 常见安装位置。
 * @returns {string|null} 含 vivado.bat（win）/ vivado（posix）的 bin 目录
 */
function findVivadoBinDir(configured, env, existsFn, platform) {
    const pf = platform || process.platform;
    const exe = pf === 'win32' ? 'vivado.bat' : 'vivado';
    const exists = existsFn || ((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
    const envRef = env || process.env;

    const tryDir = (dir) => {
        if (!dir) return null;
        const cand = path.join(dir, exe);
        return exists(cand) ? dir : null;
    };

    // 1. 显式配置
    const fromConfig = tryDir(normalizeVivadoDir(configured));
    if (fromConfig) return fromConfig;

    // 2. XILINX_VIVADO（通常指向 <root>/<version>）
    if (envRef.XILINX_VIVADO) return tryDir(path.join(String(envRef.XILINX_VIVADO), 'bin'));

    // 3. PATH
    const pathDirs = String(envRef.PATH || '').split(path.delimiter).filter(Boolean);
    for (const d of pathDirs) {
        const hit = tryDir(d);
        if (hit) return hit;
    }

    // 4. 常见安装位置（盘符 × Xilinx 根 × 版本，取最新版本号）
    const roots = [];
    if (pf === 'win32') {
        for (const drive of ['C:', 'D:', 'E:']) {
            roots.push(path.join(drive + '\\', 'Xilinx', 'Vivado'));
            roots.push(path.join(drive + '\\', 'DevKit', 'Xilinx', 'Vivado'));
            roots.push(path.join(drive + '\\', 'Tools', 'Xilinx', 'Vivado'));
        }
    } else {
        roots.push('/opt/Xilinx/Vivado', '/tools/Xilinx/Vivado');
    }
    for (const root of roots) {
        let versions = [];
        try { versions = fs.readdirSync(root).filter(n => /^\d{4}\.\d/.test(n)); } catch (e) { continue; }
        versions.sort((a, b) => (a < b ? 1 : -1)); // 版本号字符串降序，取最新
        for (const v of versions) {
            const hit = tryDir(path.join(root, v, 'bin'));
            if (hit) return hit;
        }
    }
    return null;
}

/** vivado batch 模式参数（-tclargs 后的额外参数必须放最后）。 */
function buildBatchArgs(scriptPath, tclArgs, extraArgs) {
    const args = ['-mode', 'batch', '-nolog', '-nojournal', '-source', scriptPath];
    (extraArgs || []).forEach(a => args.push(a));
    const ta = (tclArgs || []).map(String);
    if (ta.length) args.push('-tclargs', ...ta);
    return args;
}

/** Windows cmd /c 行的参数引号。 */
function cmdQuote(a) {
    const s = String(a);
    if (!/[\s"^&|<>()%!]/.test(s)) return s;
    return '"' + s.replace(/"/g, '""') + '"';
}

/** TCL 列表元素转义：路径统一转 / 后按需加花括号（braced word 内 \ 为字面量，不安全故先消除）。 */
function tclQuote(value) {
    const s = String(value).replace(/\\/g, '/');
    if (s === '') return '{}';
    if (!/[\s{}[\]$"'\\/;#]/.test(s)) return s;
    if (!/[{}]/.test(s)) return '{' + s + '}';
    return '"' + s.replace(/([\\$"[\]])/g, '\\$1') + '"'; // 含花括号的罕见情况退化为双引号+转义
}

/** 多元素 TCL 列表：{a b c}。 */
function tclList(items) {
    return '[list ' + (items || []).map(i => tclQuote(i)).join(' ') + ']';
}

/**
 * 生成 create_project TCL 脚本文本。
 * @param {{name:string, dir:string, part:string, sources:string[], sims:string[], constraints:string[], top:string, simTop:string}} o
 */
function buildCreateProjectScript(o) {
    const L = [];
    L.push('# 由 svtools (VSCode 扩展) 生成的 Vivado 工程创建脚本');
    L.push('# 工程名: ' + o.name + (o.part ? '，器件: ' + o.part : '（未指定 -part，在 Vivado 中手动选择）'));
    L.push('');
    L.push('set prj_dir ' + tclQuote(o.dir));
    L.push('');
    L.push('if {[file exists $prj_dir/' + o.name + '.xpr]} {');
    L.push('    # 已存在同名工程则直接打开，避免重复创建');
    L.push('    open_project $prj_dir/' + o.name + '.xpr');
    L.push('} else {');
    L.push('    create_project ' + tclQuote(o.name) + ' $prj_dir' + (o.part ? ' -part ' + tclQuote(o.part) : ''));
    (o.sources || []).forEach(f => L.push('    add_files -fileset sources_1 ' + tclQuote(f)));
    (o.constraints || []).forEach(f => L.push('    add_files -fileset constrs_1 ' + tclQuote(f)));
    (o.sims || []).forEach(f => L.push('    add_files -fileset sim_1 ' + tclQuote(f)));
    L.push('    # .sv 文件显式标记 file_type（Vivado 有时按扩展名识别不全）');
    L.push('    foreach f [get_files -of [get_filesets sources_1]] {');
    L.push('        if {[string match -nocase *.sv $f]} { set_property file_type SystemVerilog $f }');
    L.push('    }');
    L.push('    foreach f [get_files -of [get_filesets sim_1]] {');
    L.push('        if {[string match -nocase *.sv $f]} { set_property file_type SystemVerilog $f }');
    L.push('    }');
    if (o.top) L.push('    set_property top ' + tclQuote(o.top) + ' [get_filesets sources_1]');
    if (o.simTop) L.push('    set_property top ' + tclQuote(o.simTop) + ' [get_filesets sim_1]');
    L.push('    update_compile_order -fileset sources_1');
    L.push('    update_compile_order -fileset sim_1');
    L.push('}');
    L.push('');
    L.push('puts "SVTOOLS_PROJECT_READY"');
    return L.join('\n') + '\n';
}

/** 从 batch 输出提取错误/严重警告行（供通道摘要）。 */
function extractVivadoIssues(lines) {
    const issues = [];
    String(lines).split(/\r?\n/).forEach(line => {
        const m = line.match(/^(ERROR|CRITICAL WARNING):\s*(.*)$/);
        if (m) issues.push({ level: m[1], text: m[2].slice(0, 300) });
    });
    return issues.slice(0, 50);
}

/** 匹配工程结构模板的 glob：'src'/'src/**'（目录前缀）、'*.xdc'（扩展名）。 */
function matchGlobList(relPath, patterns) {
    const rel = String(relPath || '').replace(/\\/g, '/');
    return (patterns || []).some(function (raw) {
        let pat = String(raw).replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/\*\*$/, '');
        if (!pat) return false;
        if (pat.startsWith('*.')) return rel.toLowerCase().endsWith(pat.slice(1).toLowerCase());
        return rel === pat || rel.startsWith(pat + '/');
    });
}

/**
 * 按工程结构模板把工作区文件分类。sim 优先于 sources（tb 目录常被两者覆盖时归 sim）。
 * @param {string[]} absFiles 绝对路径列表
 * @param {string} rootDir 工作区根
 * @param {{sources:string[], sim:string[], constraints:string[]}} structure glob 模板
 */
function classifyFiles(absFiles, rootDir, structure) {
    const st = structure || {};
    const rel = f => path.relative(rootDir, f).replace(/\\/g, '/');
    const out = { sources: [], sims: [], constraints: [], others: [] };
    absFiles.forEach(function (f) {
        const r = rel(f);
        if (matchGlobList(r, st.sim)) out.sims.push(f);
        else if (matchGlobList(r, st.sources)) out.sources.push(f);
        else if (matchGlobList(r, st.constraints)) out.constraints.push(f);
        else out.others.push(f);
    });
    return out;
}

/** 工程结构模板默认值（对应用户 03_example 工程模板：src/RTL、sim/tb、prj/工程）。 */
const DEFAULT_STRUCTURE = {
    sources: ['src', 'rtl', 'rtl/**', 'src/**'],
    sim: ['sim', 'tb', 'sim/**', 'tb/**'],
    constraints: ['constraints', 'xdc', 'constraints/**', 'xdc/**', '*.xdc'],
    projectDir: 'prj'
};

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

            out.show(true);
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
                    log('[vivado] 超时 (' + timeoutMs + 'ms)，终止进程');
                    try { child.kill(); } catch (e) { /* ignore */ }
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

        // 5. 器件型号
        const part = await vscode.window.showInputBox({
            prompt: '器件型号（-part，如 xc7z100ffg900-2，可留空后在 Vivado 中选择）',
            value: cfg.get('part', '') || ''
        });
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
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(scriptPath));
        const edit = new vscode.WorkspaceEdit();
        edit.insert(vscode.Uri.file(scriptPath), new vscode.Position(0, 0), script);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        vscode.window.showTextDocument(doc);

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
        vscode.commands.registerCommand('svtools.vivado.createProject', () => createProject())
    );

    return {
        runScript, stopRun, createProject,
        resolveBinDir
    };
}

// ---------------- 工作区扫描辅助（activate 内使用，抽出来便于 mock 测试） ----------------

async function scanVerilogFiles(vscode, rootDir) {
    const found = [];
    const skip = new Set(['node_modules', '.git', 'vivado_prj', 'simulate', 'scripts', '.vscode', 'extension']);
    async function walk(dir, depth) {
        if (depth > 6) return;
        let entries;
        try { entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir)); }
        catch (e) { return; }
        for (const [name, type] of entries) {
            const full = path.join(dir, name);
            if (type === vscode.FileType.Directory) {
                if (!skip.has(name)) await walk(full, depth + 1);
            } else if (/\.(sv|v)$/i.test(name)) {
                found.push(full);
            }
        }
    }
    await walk(rootDir, 0);
    return found.sort();
}

async function scanConstraintFiles(vscode, rootDir) {
    const found = [];
    async function walk(dir, depth) {
        if (depth > 6) return;
        let entries;
        try { entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir)); }
        catch (e) { return; }
        for (const [name, type] of entries) {
            const full = path.join(dir, name);
            if (type === vscode.FileType.Directory) {
                if (!['node_modules', '.git'].includes(name)) await walk(full, depth + 1);
            } else if (/\.xdc$/i.test(name)) {
                found.push(full);
            }
        }
    }
    await walk(rootDir, 0);
    return found.sort();
}

async function scanTclFiles(vscode, rootDir) {
    const found = [];
    const skip = new Set(['node_modules', '.git', 'vivado_prj', 'simulate']);
    async function walk(dir, depth) {
        if (depth > 6) return;
        let entries;
        try { entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir)); }
        catch (e) { return; }
        for (const [name, type] of entries) {
            const full = path.join(dir, name);
            if (type === vscode.FileType.Directory) {
                if (!skip.has(name)) await walk(full, depth + 1);
            } else if (/\.tcl$/i.test(name)) {
                found.push(full);
            }
        }
    }
    await walk(rootDir, 0);
    return found.sort();
}

/** 从源文件内容识别 module 名（顶层启发：实例化少的优先，这里简单取全部 module 名）。 */
async function detectTopModules(vscode, files) {
    const names = [];
    for (const f of files.slice(0, 50)) {
        let text = '';
        try { text = (await vscode.workspace.fs.readFile(vscode.Uri.file(f))).toString('utf8'); }
        catch (e) { continue; }
        let m;
        const re = /\bmodule\s+([A-Za-z_][A-Za-z0-9_]*)/g;
        while ((m = re.exec(text)) !== null) {
            if (!names.includes(m[1])) names.push(m[1]);
        }
    }
    // 被 instantiate 的模块名降低优先级：从文本中找 "name u_" 形式的实例化
    const instanced = new Set();
    for (const f of files.slice(0, 50)) {
        let text = '';
        try { text = (await vscode.workspace.fs.readFile(vscode.Uri.file(f))).toString('utf8'); }
        catch (e) { continue; }
        let m;
        const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(?:#\s*\([^)]*\)\s*)?u_[A-Za-z0-9_]+/gm;
        while ((m = re.exec(text)) !== null) instanced.add(m[1]);
    }
    const tops = names.filter(n => !instanced.has(n));
    return tops.length ? tops : names;
}

async function guessSimTop(vscode, simFiles) {
    for (const f of simFiles) {
        let text = '';
        try { text = (await vscode.workspace.fs.readFile(vscode.Uri.file(f))).toString('utf8'); }
        catch (e) { continue; }
        const m = text.match(/\bmodule\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (m) return m[1];
    }
    return '';
}

module.exports = {
    normalizeVivadoDir,
    findVivadoBinDir,
    buildBatchArgs,
    cmdQuote,
    tclQuote,
    tclList,
    buildCreateProjectScript,
    extractVivadoIssues,
    matchGlobList,
    classifyFiles,
    DEFAULT_STRUCTURE,
    activateVivado
};
