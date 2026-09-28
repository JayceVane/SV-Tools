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
const os = require('os');
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

/** 取文件中第一个 module 声明的模块名（无则空串）。 */
function firstModuleName(text) {
    const m = String(text || '').match(/\bmodule\s+([A-Za-z_][A-Za-z0-9_]*)/);
    return m ? m[1] : '';
}

/** 生成器件库导出 TCL（vivado batch 无工程模式跑，输出 name|family|package|speed 行）。 */
function buildExportPartsScript(outPath) {
    const tclPath = String(outPath).replace(/\\/g, '/');
    return [
        'set fh [open ' + tclQuote(tclPath) + ' w]',
        'fconfigure $fh -encoding utf-8',
        'foreach p [get_parts *] {',
        '  puts $fh "$p|[get_property FAMILY $p]|[get_property PACKAGE $p]|[get_property SPEED $p]"',
        '}',
        'close $fh',
        'puts "SVTOOLS_PARTS_EXPORTED"'
    ].join('\n') + '\n';
}

/** 解析器件库 dump 文本（跳过非法行），按名称排序。 */
function parsePartsDump(text) {
    const parts = [];
    const seen = new Set();
    String(text || '').split(/\r?\n/).forEach(function (line) {
        const seg = line.split('|');
        if (seg.length < 4 || !/^xc|^x[au]/i.test(seg[0])) return;
        const p = { name: seg[0], family: seg[1], pkg: seg[2], speed: seg[3] };
        if (seen.has(p.name)) return;
        seen.add(p.name);
        parts.push(p);
    });
    parts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return parts;
}

/** 汇总筛选维度（按选中项动态重算时使用）。 */
function partFilterOptions(parts) {
    const fam = new Set(), pkg = new Set(), spd = new Set();
    parts.forEach(p => { fam.add(p.family); pkg.add(p.pkg); spd.add(p.speed); });
    const s = a => Array.from(a).sort();
    return { families: s(fam), packages: s(pkg), speeds: s(spd) };
}

/** 按已选维度过滤器件列表。 */
function filterParts(parts, sel) {
    return parts.filter(p =>
        (!sel.family || p.family === sel.family) &&
        (!sel.pkg || p.pkg === sel.pkg) &&
        (!sel.speed || p.speed === sel.speed));
}

/** 生成"把文件加入已存在工程指定文件集"的增量 TCL（已存在则跳过）。 */
function buildAddFilesScript(xprPath, file, fileset, isSv) {
    return [
        'open_project ' + tclQuote(xprPath),
        'set fs [get_filesets ' + tclQuote(fileset) + ']',
        'set f ' + tclQuote(file),
        'if {[llength [get_files -quiet -of $fs $f]] == 0} {',
        '    add_files -fileset $fs $f',
        '    puts "SVTOOLS_ADDED $f"',
        '} else {',
        '    puts "SVTOOLS_ALREADY_IN $f"',
        '}',
        isSv ? 'catch { set_property file_type SystemVerilog [get_files -of $fs $f] }' : '',
        'update_compile_order -fileset $fs',
        'puts "SVTOOLS_DONE"'
    ].filter(Boolean).join('\n') + '\n';
}

/** 生成"把文件移出工程（按文件名在指定文件集内匹配）"的增量 TCL。 */
function buildRemoveFilesScript(xprPath, file, fileset) {
    const base = path.basename(String(file));
    return [
        'open_project ' + tclQuote(xprPath),
        'set fs [get_filesets ' + tclQuote(fileset) + ']',
        'set removed 0',
        'foreach f [get_files -quiet -of $fs] {',
        '    if {[string match -nocase *' + base.replace(/[\\{}$"]/g, '') + ' $f]} {',
        '        remove_files $f',
        '        set removed 1',
        '    }',
        '}',
        'puts [expr {$removed ? "SVTOOLS_REMOVED" : "SVTOOLS_NOT_IN_PRJ"}]',
        'puts "SVTOOLS_DONE"'
    ].join('\n') + '\n';
}

/**
 * 生成 xsim 行为仿真 TCL：打开工程（缺文件先补入）→ 当前文件模块置为 sim_1 顶层 → launch_simulation。
 * @param {{xprPath:string, top:string, file:string, isSv:boolean, runtime:string}} o
 */
function buildSimulateScript(o) {
    const L = [
        'open_project ' + tclQuote(o.xprPath),
        'set fs [get_filesets sim_1]',
        'set f ' + tclQuote(o.file)
    ];
    if (o.file) {
        L.push('if {[llength [get_files -quiet -of $fs $f]] == 0} {');
        L.push('    add_files -fileset $fs $f');
        L.push(o.isSv ? '    catch { set_property file_type SystemVerilog [get_files -of $fs $f] }' : '');
        L.push('}');
    }
    if (o.top) {
        L.push('set_property top ' + tclQuote(o.top) + ' [get_filesets sim_1]');
        L.push('update_compile_order -fileset sim_1');
    }
    L.push('set_property -name {xsim.simulate.runtime} -value ' + tclQuote(o.runtime || '1000ns') + ' -objects [get_filesets sim_1]');
    L.push('launch_simulation');
    L.push('puts "SVTOOLS_SIM_DONE"');
    return L.filter(Boolean).join('\n') + '\n';
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
        const runtime = cfg.get('simRuntime', '1000ns') || '1000ns';
        const xpr = await refreshProjectContext();
        if (!xpr) { vscode.window.showErrorMessage('未找到 Vivado 工程（.xpr），请先运行 "Vivado: 创建工程"'); return; }
        vscode.window.showInformationMessage('Vivado xsim 仿真：顶层 ' + top + '（runtime ' + runtime + '）');
        return runIncrementalTcl('simulate.tcl',
            buildSimulateScript({ xprPath: xpr, top, file: cur.path, isSv: cur.isSv, runtime }));
    }

    /** 标签页 ▶ 按钮：选择仿真引擎。 */
    async function simulatePick() {
        const engine = await vscode.window.showQuickPick(
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

    /** Vivado 风格逐级筛选选型；返回 part 字符串（''=不设置），undefined=用户取消。 */
    async function pickPart(defaultPart) {
        const parts = await loadPartsCatalog();
        const MANUAL = '\u0000manual';
        const NONE = '\u0000none';
        if (!parts.length) {
            // 导不出库（无 Vivado / 结构变化）：回退手输
            const v = await vscode.window.showInputBox({
                prompt: '器件型号（-part，如 xc7a35tcsg324-1，可留空后在 Vivado 中选择）',
                value: defaultPart || ''
            });
            return v === undefined ? undefined : v.trim();
        }
        const sel = { family: '', pkg: '', speed: '' };
        // 系列 → 封装 → 速度等级（每级可"(全部)"跳过，Esc 取消整个选型）
        for (const [key, title, dim] of [['family', '系列 Family', 'families'], ['pkg', '封装 Package', 'packages'], ['speed', '速度等级 Speed', 'speeds']]) {
            const pool = key === 'family' ? parts : filterParts(parts, sel);
            const values = partFilterOptions(pool)[dim];
            if (values.length <= 1) { sel[key] = key === 'family' && values.length === 1 ? values[0] : ''; continue; }
            const pick = await vscode.window.showQuickPick(
                [{ label: '(全部)', value: '' }].concat(values.map(v => ({ label: v, value: v, picked: v === sel[key] })))
                    .concat(key === 'family' ? [{ label: '(手动输入型号…)', value: MANUAL }] : []),
                { placeHolder: '筛选 · ' + title + '（当前候选 ' + pool.length + ' 个）' });
            if (pick === undefined) return undefined;
            if (pick.value === MANUAL) {
                const v = await vscode.window.showInputBox({ prompt: '手动输入器件型号（-part）', value: defaultPart || '' });
                return v === undefined ? undefined : v.trim();
            }
            sel[key] = pick.value;
        }
        const pool = filterParts(parts, sel);
        const pick = await vscode.window.showQuickPick(
            [{ label: '(不设置，建好后在 Vivado 中选择)', value: NONE }]
                .concat(pool.map(p => ({
                    label: p.name,
                    description: p.family + ' · ' + p.pkg + ' · ' + p.speed,
                    picked: p.name === defaultPart
                }))),
            { placeHolder: '选择器件（共 ' + pool.length + ' 个，输入可搜索，如 xc7z100）' });
        if (pick === undefined) return undefined;
        return pick.value === NONE ? '' : pick.value;
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
    buildAddFilesScript,
    buildRemoveFilesScript,
    buildSimulateScript,
    buildExportPartsScript,
    parsePartsDump,
    partFilterOptions,
    filterParts,
    firstModuleName,
    extractVivadoIssues,
    matchGlobList,
    classifyFiles,
    DEFAULT_STRUCTURE,
    activateVivado
};
