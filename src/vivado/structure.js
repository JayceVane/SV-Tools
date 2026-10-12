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
// 工程结构模板：目录 glob 把工作区文件划入 sources/sim/constraints 文件集（纯函数，不依赖 vscode）。

const path = require('path');

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

module.exports = { matchGlobList, classifyFiles, DEFAULT_STRUCTURE };
