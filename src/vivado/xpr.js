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
/** XPR 专用 XML 读取：先验证完整 Project，再提取文件集；不写工程文件。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const XML_SPACE = /^[ \t\r\n]*$/;
const XML_TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_:](?:"[^"<]*"|'[^'<]*'|[^'"<>])*>/g;

function isXmlCharacter(code) {
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff)
        || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}
function decodeEntities(value, fail) {
    return value.replace(/&(?:([^;]+);)?/g, (token, entity) => {
        if (Object.hasOwn(XML_ENTITIES, entity)) return XML_ENTITIES[entity];
        if (/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity || '')) {
            const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
            if (isXmlCharacter(code)) return String.fromCodePoint(code);
        }
        fail('非法或未知 XML entity：' + token);
    });
}
function readAttributes(body, fail) {
    const attrs = Object.create(null);
    const attr = /[ \t\r\n]+([A-Za-z_:][A-Za-z0-9_.:-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"<]*)"|'([^'<]*)')/y;
    let offset = 0;
    while (!XML_SPACE.test(body.slice(offset))) {
        attr.lastIndex = offset;
        const match = attr.exec(body);
        if (!match) fail('属性必须以空白分隔，并使用完整的引号与等号');
        const name = match[1];
        if (Object.hasOwn(attrs, name)) fail('重复 XML 属性：' + name);
        attrs[name] = decodeEntities((match[2] ?? match[3]).replace(/[\t\r\n]/g, ' '), fail);
        offset = attr.lastIndex;
    }
    return attrs;
}
function readElement(token, fail) {
    const match = /^<(\/?)([A-Za-z_:][A-Za-z0-9_.:-]*)([\s\S]*)>$/.exec(token);
    if (!match) fail('非法 XML 标签');
    const [, closing, name, body] = match;
    if (closing) {
        if (!XML_SPACE.test(body)) fail('结束标签不能包含属性：' + name);
        return { name, closing: true, attrs: null, empty: false };
    }
    const empty = body.endsWith('/');
    return { name, closing: false, attrs: readAttributes(empty ? body.slice(0, -1) : body, fail), empty };
}

/**
 * 解析完整 XPR 文本；仅支持 Vivado 使用的 XML 1.0，无 DTD 或外部 entity。
 * @param {string} text UTF-8 解码后的文本
 * @param {string} xprPath 工程文件路径，用于诊断和解析相对引用
 * @returns {{path:string, dir:string, part:string, sets:Array<{name:string,type:string,top:string,files:string[]}>}}
 * @throws {Error} XML 损坏、非 Project 根、关键文件集属性缺失
 */
function parseXprText(text, xprPath) {
    if (typeof text !== 'string') throw new TypeError('XPR 文本必须是字符串');
    if (typeof xprPath !== 'string' || !xprPath) throw new TypeError('XPR 路径不能为空');
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    let position = 0;
    const fail = message => {
        const line = text.slice(0, position).split('\n').length;
        throw new Error('XPR XML 无效（' + xprPath + '，第 ' + line + ' 行）：' + message);
    };
    for (const character of text) {
        if (!isXmlCharacter(character.codePointAt(0))) fail('包含 XML 1.0 不允许的字符');
        position += character.length;
    }
    position = 0;
    const parsed = { path: xprPath, dir: path.dirname(xprPath), part: '', sets: [] };
    const stack = [];
    const names = new Set();
    const topNames = new Set();
    let hasProject = false;
    let hasPart = false;
    const tokens = new RegExp(XML_TOKEN.source, 'g');
    let offset = 0;
    let match;
    const checkText = fragment => {
        if (fragment.includes('<')) fail('标记未闭合或不受支持（XPR 不支持 DTD）');
        if (!stack.length && !XML_SPACE.test(fragment)) fail('Project 根元素外含有文本');
        if (fragment.includes(']]>')) fail('普通 XML 文本不能包含 ]]>');
        decodeEntities(fragment, fail);
    };
    while ((match = tokens.exec(text))) {
        position = offset;
        checkText(text.slice(offset, match.index));
        const token = match[0];
        position = match.index;
        offset = tokens.lastIndex;
        if (token.startsWith('<!--')) {
            const comment = token.slice(4, -3);
            if (comment.includes('--') || comment.endsWith('-')) fail('非法 XML 注释');
            continue;
        }
        if (token.startsWith('<?')) {
            const instruction = /^<\?([A-Za-z_:][A-Za-z0-9_.:-]*)([\s\S]*)\?>$/.exec(token);
            if (!instruction || (instruction[2] && !/^[ \t\r\n]/.test(instruction[2]))) fail('非法 XML processing instruction');
            if (instruction[1].toLowerCase() === 'xml') {
                if (instruction[1] !== 'xml' || position !== 0) fail('XML 声明必须位于文件开头');
                const attrs = readAttributes(instruction[2], fail);
                const order = Object.keys(attrs).join(',');
                if (attrs.version !== '1.0' || !['version', 'version,encoding', 'version,standalone', 'version,encoding,standalone'].includes(order)
                    || instruction[2].includes('&')
                    || (Object.hasOwn(attrs, 'encoding') && !/^utf-8$/i.test(attrs.encoding))
                    || (Object.hasOwn(attrs, 'standalone') && !['yes', 'no'].includes(attrs.standalone))) fail('仅支持完整的 UTF-8 XML 1.0 声明');
            }
            continue;
        }
        if (token.startsWith('<![CDATA[')) {
            if (!stack.length) fail('CDATA 必须位于 Project 内');
            continue;
        }
        const element = readElement(token, fail);
        if (element.closing) {
            const opened = stack.pop();
            if (!opened || opened.name !== element.name) fail('结束标签不匹配：' + element.name);
            continue;
        }
        if (!stack.length) {
            if (hasProject || element.name !== 'Project') fail('文件必须包含且仅包含一个 Project 根元素');
            hasProject = true;
        }
        let set = stack.length ? stack[stack.length - 1].set : null;
        const attrs = element.attrs;
        if (element.name === 'FileSet') {
            if (set) fail('FileSet 不能嵌套');
            if (!attrs.Name || !attrs.Type) fail('FileSet 缺少 Name 或 Type');
            if (names.has(attrs.Name)) fail('重复 FileSet：' + attrs.Name);
            names.add(attrs.Name);
            set = { name: attrs.Name, type: attrs.Type, top: '', files: [] };
            parsed.sets.push(set);
        } else if (element.name === 'File' && set) {
            if (!attrs.Path) fail('File 缺少 Path');
            try { set.files.push(resolveXprPath(attrs.Path, parsed.dir)); }
            catch (error) { fail('File 路径无效：' + error.message); }
        } else if (element.name === 'Option') {
            if (!set && attrs.Name === 'Part' && !hasPart) {
                if (!Object.hasOwn(attrs, 'Val')) fail('Part 缺少 Val');
                parsed.part = attrs.Val;
                hasPart = true;
            } else if (set && attrs.Name === 'TopModule' && !topNames.has(set.name)) {
                if (!Object.hasOwn(attrs, 'Val')) fail('TopModule 缺少 Val');
                set.top = attrs.Val;
                topNames.add(set.name);
            }
        }
        if (!element.empty) stack.push({ name: element.name, set });
    }
    position = offset;
    checkText(text.slice(offset));
    if (!hasProject) fail('缺少 Project 根元素');
    if (stack.length) fail('文件未写完，缺少结束标签：' + stack[stack.length - 1].name);
    return parsed;
}

/**
 * 读取 .xpr，读取/编码/XML 错误均带文件上下文；所有写操作仍经 Vivado batch Tcl。
 * @param {string} xprPath 工程文件路径
 * @returns {ReturnType<typeof parseXprText>}
 * @throws {Error} 文件不可读、UTF-8 损坏或 XML 不完整
 */
function parseXpr(xprPath) {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(xprPath));
        return parseXprText(text, xprPath);
    } catch (error) {
        throw new Error('读取 XPR 失败（' + xprPath + '）：' + error.message, { cause: error });
    }
}

/**
 * $PPRDIR、file URL、普通相对引用 → 规范化绝对路径；相对引用以 XPR 目录为基准。
 * @param {string} reference XML entity 已解码的文件引用
 * @param {string} xprDir 工程文件所在目录
 * @returns {string} 本机文件路径
 * @throws {Error} 空路径或无效 file URL
 */
function resolveXprPath(reference, xprDir) {
    if (typeof reference !== 'string' || !reference) throw new Error('XPR 文件引用不能为空');
    const value = reference.replace(/\$PPRDIR(?=[/\\]|$)/g, () => path.resolve(xprDir)).replace(/\\/g, '/');
    if (/^file:/i.test(value)) return path.normalize(fileURLToPath(value));
    return path.resolve(xprDir, value);
}

/**
 * normalize 后比较路径；Windows 忽略大小写。
 * @param {string} a @param {string} b
 * @returns {boolean} 两个路径是否等价，不查询文件系统
 */
function samePath(a, b) {
    const x = path.normalize(String(a || ''));
    const y = path.normalize(String(b || ''));
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * @param {ReturnType<typeof parseXprText>} parsed
 * @param {string} absFile 文件绝对路径
 * @returns {string|null} 第一个匹配的文件集；不在工程中则 null
 */
function fileSetOf(parsed, absFile) {
    for (const set of parsed.sets) if (set.files.some(file => samePath(file, absFile))) return set.name;
    return null;
}
module.exports = { parseXpr, parseXprText, fileSetOf, samePath, resolveXprPath };