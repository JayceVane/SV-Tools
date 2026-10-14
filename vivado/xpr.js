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
 * .xpr 工程文件解析（正则实现，无 XML 依赖）：文件集成员、各集 top、器件。
 * .xpr 是 Vivado 的 XML 工程描述：
 *   <Option Name="Part" Val="..."/>
 *   <FileSet Name="sources_1" Type="DesignSrcs"> <File Path="$PPRDIR/../src/a.v"/> ... </FileSet>
 *   FileSet 的 <Config><Option Name="TopModule" Val="top"/>（无 top 时缺省）
 * $PPRDIR 指工程文件所在目录，路径统一以 / 分隔；解析结果给工程树/报告用，
 * 不修改 .xpr（所有写操作经 Vivado batch TCL）。
 */

'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 解析 .xpr。
 * @param {string} xprPath 绝对路径
 * @returns {{path: string, dir: string, part: string, sets: Array<{name: string, type: string, top: string, files: string[]}>}}
 * @throws {Error} 文件不可读
 */
function parseXpr(xprPath) {
    const text = fs.readFileSync(xprPath, 'utf8');
    const dir = path.dirname(xprPath);

    const part = (text.match(/<Option Name="Part" Val="([^"]+)"/) || [])[1] || '';

    const sets = [];
    const setRe = /<FileSet Name="([^"]+)" Type="([^"]+)"[^>]*>([\s\S]*?)<\/FileSet>/g;
    let m;
    while ((m = setRe.exec(text)) !== null) {
        const [, name, type, body] = m;
        const files = [];
        const fileRe = /<File Path="([^"]+)"/g;
        let f;
        while ((f = fileRe.exec(body)) !== null) {
            files.push(resolveXprPath(f[1], dir));
        }
        const top = (body.match(/<Option Name="TopModule" Val="([^"]*)"/) || [])[1] || '';
        sets.push({ name, type, top, files });
    }
    return { path: xprPath, dir, part, sets };
}

/** .xpr 内的 $PPRDIR 相对路径 → 绝对路径（统一平台分隔符后规范 .. 段）。 */
function resolveXprPath(p, xprDir) {
    let s = p.replace(/\$PPRDIR/g, xprDir).replace(/\\/g, '/');
    // file:/// 转义形态（少数版本写入）也处理掉
    s = s.replace(/^file:\/{2,}/i, '');
    const abs = path.posix.normalize(s);
    return path.normalize(abs);
}

/**
 * 两个文件路径是否同一文件：normalize 后精确比较；win32 再忽略大小写
 * （盘符大小写、目录段大小写在不同来源——findFiles / Vivado 写入——可能不同）。
 */
function samePath(a, b) {
    const x = path.normalize(String(a || ''));
    const y = path.normalize(String(b || ''));
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * 便捷查询：某文件属于哪个文件集（sources_1/sim_1/constrs_1/…）。
 * @returns {string|null} 文件集名；不在工程中返回 null
 */
function fileSetOf(parsed, absFile) {
    for (const s of parsed.sets) {
        if (s.files.some(f => samePath(f, absFile))) return s.name;
    }
    return null;
}

module.exports = { parseXpr, fileSetOf, samePath, resolveXprPath };
