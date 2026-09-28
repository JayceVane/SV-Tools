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
// 工作区扫描辅助：源文件/约束/TCL 枚举、顶层模块识别（vscode 经参数注入，便于单测 mock）。

const path = require('path');

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

module.exports = { scanVerilogFiles, scanConstraintFiles, scanTclFiles, detectTopModules, guessSimTop };
