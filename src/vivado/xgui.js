'use strict';

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
// XGUI Tcl 静态解析：只提取页面/分组/控件、提示与静态说明，不执行 IP 的 Tcl。
// Vivado 用同一份文件在 GUI 中构建定制界面；tcl 模式没有 ipgui 包，所以这里按生成格式取值。

const WORD = /\$\{[\w.:-]+\}|"(?:\\.|[^"\\])*"|\{[^{}]*\}|[^\s\[\]"]+/gu;

/** 去掉引号或花括号，只保留可静态确认的字面量；静态说明允许出现 [ ] 等展示字符。 */
function literal(token, { display = false } = {}) {
    const content = token?.replace(/^(?:"([\s\S]*)"|\{([\s\S]*)\})$/u, (_, quoted, braced) => quoted ?? braced);
    if (!content) return '';
    if (display) return content.replace(/\s+/gu, ' ').trim().slice(0, 500);
    return /[$\[\]{}]/u.test(content) ? '' : content.trim();
}

/** $name 或 ${name} 形式的变量引用。 */
const reference = token => /^\$(?:\{([\w.:-]+)\}|([\w.:-]+))$/u.exec(token || '')?.slice(1).find(Boolean);

/** 合并反斜线续行：XGUI 生成长调用时会换行。 */
const statements = source => source.replace(/\\\r?\n\s*/gu, ' ').split(/\r?\n/u).map(line => line.trim());

/**
 * 解析 init_gui 中的界面结构。
 * @param {string} source XGUI Tcl 文本
 * @returns {{params: Map<string,object>, notes: Map<string,string[]>}} 参数名 → 描述；分组路径 → 静态说明
 */
function parseLayout(source) {
    const objects = new Map(), params = new Map(), notes = new Map();
    const ADD = /^(?:set\s+([\w.:-]+)\s+\[\s*)?ipgui::add_(page|group|panel|table|param|static_text|staticText)\s+(.+)$/u;
    const pathOf = entry => {
        const parents = [];
        for (let item = entry.parent, depth = 0; item && depth++ < 12; item = item.parent) {
            if (item.type === 'page' || item.type === 'group' || item.display_name) parents.unshift(item.display_name || item.key);
        }
        return parents.join(' / ');
    };
    for (const line of statements(source)) {
        const add = ADD.exec(line);
        if (add) {
            const [, name, type, args] = add, words = args.match(WORD) || [];
            const option = key => { const index = words.indexOf('-' + key); return index >= 0 ? words[index + 1] : undefined; };
            const key = literal(option('name')) || (type === 'static_text' ? 'note:' + notes.size : '');
            if (!key) continue;
            const parent = objects.get(reference(option('parent')));
            const entry = { key, type, parent, widget: literal(option('widget')) };
            if (type === 'static_text') {
                const text = literal(option('text'), { display: true });
                if (text && parent) {
                    const group = pathOf(entry);
                    if (!notes.has(group)) notes.set(group, []);
                    if (!notes.get(group).includes(text)) notes.get(group).push(text);
                }
                continue;
            }
            if (name) objects.set(name, entry);
            if (type === 'param' && !params.has(key)) params.set(key, entry);
            continue;
        }
        if (!line.startsWith('set_property ')) continue;
        const [, property, wordValue, variable, extra] = line.match(WORD) || [];
        if (extra || !['display_name', 'tooltip'].includes(property)) continue;
        const entry = objects.get(reference(variable)), caption = literal(wordValue);
        if (entry && caption) entry[property] = caption;
    }
    return {
        params: new Map([...params].map(([key, entry]) => [key, {
            label: entry.display_name, help: entry.tooltip, group: pathOf(entry), widget: entry.widget
        }])),
        notes
    };
}

module.exports = { parseLayout, literal, reference };
