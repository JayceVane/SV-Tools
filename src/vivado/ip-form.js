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
// IP 定制表单模型：把 Vivado 参数与 XGUI 分组整理成“页面 → 分组 → 参数”的阅读结构。
// 参数全集来自 Vivado；XGUI 只决定分组、控件与说明，缺分组时统一落到“其他参数”。

const FALLBACK = '其他参数';

/**
 * @param {Array<{key:string,group?:string,label?:string,help?:string,widget?:string}>} parameters
 * @param {Array<{group:string,texts:string[]}>} [notes] XGUI 里的静态说明
 * @returns {{pages:Array<{id:string,title:string,groups:Array<{id:string,title:string,notes:string[],rows:object[]}>}>, total:number}}
 */
function buildForm(parameters, notes = []) {
    const pages = new Map(), noteMap = new Map((notes || []).map(note => [note.group || '', note.texts || []]));
    let total = 0;
    for (const parameter of parameters || []) {
        if (!parameter || typeof parameter.key !== 'string') continue;
        const path = String(parameter.group || '').split(' / ').map(part => part.trim()).filter(Boolean);
        const page = path.length ? path[0] : FALLBACK;
        const group = path.length > 1 ? path.slice(1).join(' / ') : (path.length === 1 ? '常规' : FALLBACK);
        if (!pages.has(page)) pages.set(page, { id: 'p' + pages.size, title: page, path: page, groups: new Map() });
        const pageEntry = pages.get(page), groupKey = page + '\u0000' + group;
        let groupEntry = pageEntry.groups.get(groupKey);
        if (!groupEntry) {
            // path 与 XGUI 的分组路径一致，供可见性过滤使用。
            groupEntry = { id: pageEntry.id + ':' + pageEntry.groups.size, title: group,
                path: String(parameter.group || FALLBACK), notes: [], rows: [] };
            pageEntry.groups.set(groupKey, groupEntry);
        }
        groupEntry.rows.push(parameter);
        total += 1;
    }
    for (const [page, entry] of pages) {
        for (const group of entry.groups.values()) {
            const key = page === FALLBACK ? (group.title === FALLBACK ? '' : group.title) : (group.title === '常规' ? '' : page + ' / ' + group.title);
            const texts = noteMap.get(key) || noteMap.get([page, group.title].join(' / ')) || [];
            group.notes = texts;
        }
    }
    // 兜底分组排在最后，避免无 XGUI 信息的参数抢在 IP Configuration 之前。
    const list = [...pages.values()].map(entry => ({ id: entry.id, title: entry.title, path: entry.path,
        groups: [...entry.groups.values()] }));
    list.sort((left, right) => Number(left.title === FALLBACK) - Number(right.title === FALLBACK));
    return { pages: list, total };
}

module.exports = { buildForm, FALLBACK };
