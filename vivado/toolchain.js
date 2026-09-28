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
// Vivado 工具链定位与批处理调用参数（纯函数，不依赖 vscode）。

const fs = require('fs');
const path = require('path');


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

module.exports = { normalizeVivadoDir, findVivadoBinDir, buildBatchArgs, cmdQuote };
