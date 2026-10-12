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

/**
 * 解析 VCD 文本。
 * @param {string} text VCD 文件全文
 * @returns {{
 *   headers: {key: string, value: string}[],
 *   scopes: {name: string, type: string, path: string}[],
 *   vars: {id: string, name: string, width: number, type: string, scopePath: string, path: string}[],
 *   changes: Map<string, {t: number, value: string}[]>,
 *   endTime: number,
 *   timescale: string
 * }}
 *  - changes 以信号 id 为键，时间升序；value 为字符串形式（标量 '0'/'1'/'x'/'z'，
 *    向量为去掉前缀的二进制串如 'x0x00xxx'，实数为十进制文本）
 */
function parseVcd(text) {
    const headers = [];
    const scopes = [];
    const vars = [];
    const changes = new Map();
    let timescale = '';
    let endTime = 0;

    const scopeStack = [];
    let currentHeader = null;
    /** 最近一次 # 时间戳 */
    let lastTime = 0;

    const lines = String(text).split(/\r?\n/);
    for (let raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        // 头字段既允许单行 $timescale 1ns $end，也允许跨行内容。
        if (currentHeader) {
            const endIndex = line.indexOf('$end');
            currentHeader.parts.push(endIndex >= 0 ? line.slice(0, endIndex).trim() : line);
            if (endIndex >= 0) {
                const value = currentHeader.parts.filter(Boolean).join(' ');
                headers.push({ key: currentHeader.key, value });
                if (currentHeader.key === '$timescale') timescale = value;
                currentHeader = null;
            }
            continue;
        }
        const headerStart = line.match(/^\$(date|version|timescale|comment)\b(.*)$/i);
        if (headerStart) {
            const key = '$' + headerStart[1].toLowerCase();
            const body = headerStart[2].trim();
            const endIndex = body.indexOf('$end');
            if (endIndex >= 0) {
                const value = body.slice(0, endIndex).trim();
                headers.push({ key, value });
                if (key === '$timescale') timescale = value;
            } else {
                currentHeader = { key, parts: [body] };
            }
            continue;
        }

        // --- scope 层级 ---
        const scopeStart = line.match(/^\$scope\s+(\w+)\s+(\S+)\s*\$end$/i);
        if (scopeStart) {
            scopeStack.push({ type: scopeStart[1], name: scopeStart[2] });
            scopes.push({
                name: scopeStart[2],
                type: scopeStart[1],
                path: scopeStack.map(s => s.name).join('.')
            });
            continue;
        }
        if (/^\$upscope/i.test(line)) {
            scopeStack.pop();
            continue;
        }

        const varStart = line.match(/^\$var\s+(\w+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(\[[^\]]+\]))?\s*\$end$/i);
        if (varStart) {
            const scopePath = scopeStack.map(s => s.name).join('.');
            const variable = {
                id: varStart[3],
                name: varStart[4],
                width: parseInt(varStart[2], 10),
                type: varStart[1],
                scopePath,
                path: scopePath ? `${scopePath}.${varStart[4]}` : varStart[4]
            };
            vars.push(variable);
            continue;
        }
        if (/^\$enddefinitions/i.test(line)) {
            continue;
        }

        // --- 值变更区 ---
        const timeMatch = line.match(/^#(\S+)$/);
        if (timeMatch) {
            const t = parseNumber(timeMatch[1]);
            if (t !== null) {
                if (t > endTime) endTime = t;
                lastTime = t;
            }
            continue;
        }
        // $dumpall 使用当前时间；初始 $dumpvars 位于首个时间戳之前时自然使用 0。
        if (/^\$(dumpvars|dumpall)\b/i.test(line)) continue;
        if (/^\$dumpoff\b/i.test(line) || /^\$dumpon\b/i.test(line)) continue;
        if (/^\$end\b/i.test(line)) continue;
        if (/^\$comment\b/i.test(line)) continue;

        const change = parseValueChange(line);
        if (!change) continue;
        pushChange(changes, change.id, { t: lastTime, value: change.value });
    }
    return { headers, scopes, vars, changes, endTime, timescale };
}

function pushChange(map, id, entry) {
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(entry);
}

/**
 * 解析单行值变更。
 * 标量：`0!` `1"` `x$` `z%`；向量：`b1010 #` 或 `B1010 #`；实数：`r25.5 %`。
 * @returns {{id: string, value: string}|null}
 */
function parseValueChange(line) {
    let m = line.match(/^([01xzXZ])(\S+)$/);
    if (m) return { id: m[2], value: m[1].toLowerCase() };
    m = line.match(/^([brBR])\s*(\S+)\s+(\S+)$/);
    if (m) return { id: m[3], value: m[2].toLowerCase() };
    return null;
}

/** VCD 时间/实数解析（支持普通整数与小数）。 */
function parseNumber(text) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
}

/**
 * 解析 $timescale 为「每个时间单位对应的秒数」。如 '1ns' → 1e-9，'10ps' → 1e-10。
 * @param {string} timescale 如 '1s'、'1ns'、'100ps'、'10 us'
 * @returns {number|null} 秒数；无法解析返回 null
 */
function parseTimescaleSeconds(timescale) {
    // 兼容 VCD 标准变体：s/sec、ms/msec、us/usec、ns/nsec、ps/psec、fs/fsec（大小写不敏感、允许空格）
    const m = String(timescale || '').trim().match(/^(\d+(?:\.\d+)?)\s*(sec|s|ms|msec|us|usec|ns|nsec|ps|psec|fs|fsec)$/i);
    if (!m) return null;
    const value = parseFloat(m[1]);
    const unitFactors = { s: 1, sec: 1, ms: 1e-3, msec: 1e-3, us: 1e-6, usec: 1e-6, ns: 1e-9, nsec: 1e-9, ps: 1e-12, psec: 1e-12, fs: 1e-15, fsec: 1e-15 };
    return value * unitFactors[m[2].toLowerCase()];
}

/**
 * 把扁平 var 列表组织成 scope 树（供信号树面板展示）。
 * 同一 id 可能在多个 scope 出现（父模块信号在子 scope 的引用），按 path 全部保留。
 * @param {ReturnType<typeof parseVcd>} vcd
 * @returns {{name: string, path: string, type: string, children: (object|var)[]}}
 *          树节点：scope 节点有 children；信号节点含 id/width/type。
 */
function buildSignalTree(vcd) {
    const root = { name: '', path: '', type: 'root', children: [] };
    const scopeNodes = new Map([['', root]]);

    for (const scope of vcd.scopes) {
        const parentPath = scope.path.includes('.')
            ? scope.path.slice(0, scope.path.lastIndexOf('.'))
            : '';
        const parent = scopeNodes.get(parentPath) || root;
        const node = { name: scope.name, path: scope.path, type: scope.type, children: [] };
        scopeNodes.set(scope.path, node);
        parent.children.push(node);
    }
    for (const v of vcd.vars) {
        // 参数/规格参数是常量，对波形查看无意义（iverilog 会把它们 dump 成 t=0 变更），不进树
        if (/^(spec)?parameter$/i.test(v.type)) continue;
        const parent = scopeNodes.get(v.scopePath) || root;
        parent.children.push({
            name: v.name,
            path: v.path,
            id: v.id,
            width: v.width,
            type: v.type,
            hasChanges: vcd.changes.has(v.id) && vcd.changes.get(v.id).length > 0
        });
    }
    return root;
}

module.exports = { parseVcd, buildSignalTree, parseTimescaleSeconds };
