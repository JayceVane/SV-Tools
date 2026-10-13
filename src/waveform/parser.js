'use strict';

const DEFAULT_LIMITS = Object.freeze({ maxTokenLength: 16 * 1024 * 1024, maxHeaderLength: 1024 * 1024,
    maxVariables: 1000000, maxSignalWidth: 16 * 1024 * 1024 - 1, maxReferenceLength: 65536, maxScopeDepth: 256 });
const HEADER_COMMANDS = new Set(['$date', '$version', '$timescale', '$comment']);
const DUMP_COMMANDS = new Set(['$dumpvars', '$dumpall', '$dumpon', '$dumpoff']);

/** 带源码位置的解析错误，避免静默丢弃损坏或截断的数据。 */
class VcdParseError extends Error {
    constructor(message, line, column) {
        super(`VCD 第 ${line} 行、第 ${column} 列：${message}`);
        this.name = 'VcdParseError';
        this.code = 'VCD_PARSE';
        this.line = line;
        this.column = column;
    }
}

/**
 * 增量 VCD token 解析器；字节流先由调用者解码为文本。所有入口共享这一语法实现。
 * @param {{onChange?: (id: string, time: number, value: string) => void, onVariable?: (variable: object) => void, limits?: object}} [options]
 * @returns {{write: (chunk: string) => void, finish: () => object}}
 */
function createVcdParser({ onChange = () => {}, onVariable = () => {}, limits = {} } = {}) {
    const cap = { ...DEFAULT_LIMITS, ...limits };
    for (const [name, maximum] of Object.entries(DEFAULT_LIMITS)) {
        if (!Number.isSafeInteger(cap[name]) || cap[name] < 1 || cap[name] > maximum) {
            throw Object.assign(new Error('VCD 解析限制 ' + name + ' 必须为 1–' + maximum + ' 的整数'), { code: 'VCD_RESOURCE_LIMIT' });
        }
    }
    const metadata = { headers: [], scopes: [], vars: [], endTime: 0, timescale: '' };
    const scopes = [];
    const ids = new Set();
    let command = null;
    let commandParts = [];
    let commandLength = 0;
    let pendingValue = null;
    let dumpOpen = false;
    let definitionsEnded = false;
    let time = 0;
    let carry = '';
    let line = 1;
    let column = 1;
    let tokenLine = 1;
    let tokenColumn = 1;
    let finished = false;
    const fail = message => { throw new VcdParseError(message, tokenLine, tokenColumn); };
    const failResource = message => {
        const error = new VcdParseError(message, tokenLine, tokenColumn);
        error.code = 'VCD_RESOURCE_LIMIT';
        throw error;
    };

    function deliver(callback, ...args) {
        try { callback(...args); }
        catch (error) {
            if (['VCD_PARSE', 'VCD_RESOURCE_LIMIT'].includes(error.code) && error.line === undefined) {
                const contextual = new VcdParseError(error.message, tokenLine, tokenColumn);
                contextual.code = error.code;
                contextual.cause = error;
                throw contextual;
            }
            throw error;
        }
    }

    function reference(parts, width) {
        let name = parts[3];
        if (name.length > cap.maxReferenceLength || parts[2].length > cap.maxReferenceLength) failResource('VCD 信号引用或 id 超过安全长度');
        const suffix = parts.slice(4).join('');
        const selections = suffix.match(/\[[+-]?\d+(?::[+-]?\d+)?\]/g) || [];
        if (selections.join('') !== suffix) fail('$var 索引或范围无效：' + suffix.slice(0, 80));
        let range;
        for (const selection of selections) {
            const bounds = selection.slice(1, -1).split(':').map(Number);
            if (bounds.some(bound => !Number.isSafeInteger(bound))) fail('$var 索引超出安全整数范围');
            if (bounds.length === 1) {
                if (range) fail('$var 的数组索引必须位于向量范围之前');
                name += '[' + bounds[0] + ']';
            } else {
                if (range) fail('$var 只能包含一个向量范围');
                const size = Math.abs(bounds[0] - bounds[1]) + 1;
                if (!Number.isSafeInteger(size) || size !== width) fail('$var 范围与声明位宽不一致');
                if (width === 1) name += '[' + bounds[0] + ']';
                else range = '[' + bounds.join(':') + ']';
            }
        }
        if (name.length > cap.maxReferenceLength) failResource('VCD 信号引用超过安全长度');
        return { name, ...(range ? { range } : {}) };
    }

    function endCommand() {
        const parts = commandParts;
        if (HEADER_COMMANDS.has(command)) {
            const value = parts.join(' ');
            if (!definitionsEnded) metadata.headers.push({ key: command, value });
            if (command === '$timescale') {
                if (parseTimescaleSeconds(value) === null) fail('非法的 $timescale：' + value);
                metadata.timescale = value;
            }
        } else if (command === '$scope') {
            if (definitionsEnded || parts.length !== 2) fail('$scope 声明不完整');
            if (scopes.length >= cap.maxScopeDepth || scopes.join('.').length + parts[1].length + 1 > cap.maxReferenceLength) failResource('VCD 作用域超过安全深度或长度');
            scopes.push(parts[1]);
            metadata.scopes.push({ type: parts[0], name: parts[1], path: scopes.join('.') });
        } else if (command === '$upscope') {
            if (parts.length || !scopes.length) fail('$upscope 没有对应作用域');
            scopes.pop();
        } else if (command === '$var') {
            if (definitionsEnded || parts.length < 4) fail('$var 声明不完整');
            const width = Number(parts[1]);
            if (!/^\d+$/.test(parts[1]) || !Number.isSafeInteger(width) || width < 1) fail('非法信号位宽：' + parts[1]);
            if (width > cap.maxSignalWidth) failResource('VCD 声明位宽超过 ' + cap.maxSignalWidth + ' 位安全上限');
            if (metadata.vars.length >= cap.maxVariables) failResource('信号声明超过资源上限');
            const scopePath = scopes.join('.');
            const selected = reference(parts, width);
            const path = scopePath ? scopePath + '.' + selected.name : selected.name;
            if (path.length > cap.maxReferenceLength) failResource('VCD 信号路径超过安全长度');
            const variable = { type: parts[0], width, id: parts[2], ...selected, scopePath, path };
            metadata.vars.push(variable);
            ids.add(variable.id);
            deliver(onVariable, variable);
        } else if (command === '$enddefinitions') {
            if (parts.length || definitionsEnded || scopes.length) fail('$enddefinitions 前的作用域未关闭或声明无效');
            definitionsEnded = true;
        }
        command = null;
        commandParts = [];
        commandLength = 0;
    }

    function emitValue(id, value) {
        if (!definitionsEnded) fail('值变更出现在 $enddefinitions 之前');
        if (!ids.has(id)) fail('值变更引用未声明的信号：' + id);
        deliver(onChange, id, time, value);
    }

    function accept(token) {
        if (token.length > cap.maxTokenLength) failResource('单个 token 超过资源上限');
        if (command) {
            if (token.toLowerCase() === '$end') endCommand();
            else {
                commandLength += token.length + (commandParts.length ? 1 : 0);
                if (commandLength > cap.maxHeaderLength) failResource('VCD 头字段超过资源上限');
                commandParts.push(token);
            }
            return;
        }
        if (pendingValue !== null) {
            emitValue(token, pendingValue);
            pendingValue = null;
            return;
        }
        if (token[0] === '$') {
            const key = token.toLowerCase();
            if (key === '$end') {
                if (!dumpOpen) fail('无对应命令的 $end');
                dumpOpen = false;
            } else if (DUMP_COMMANDS.has(key)) {
                if (!definitionsEnded || dumpOpen) fail('嵌套或提前出现的 dump 命令');
                dumpOpen = true;
            } else {
                command = key;
            }
            return;
        }
        if (token[0] === '#') {
            const source = token.slice(1);
            const next = Number(source);
            if (!/^\d+$/.test(source) || !Number.isSafeInteger(next) || next < time) fail('时间戳必须是递增的非负安全整数：' + source);
            if (!definitionsEnded) fail('时间戳出现在 $enddefinitions 之前');
            time = next;
            metadata.endTime = next;
            return;
        }
        const prefix = token[0].toLowerCase();
        if ('01xz'.includes(prefix) && token.length > 1) {
            emitValue(token.slice(1), prefix);
        } else if (prefix === 'b') {
            const value = token.slice(1).toLowerCase();
            if (!value || !/^[01xz]+$/.test(value)) fail('非法二进制值：' + token.slice(0, 80));
            pendingValue = value;
        } else if (prefix === 'r') {
            const value = token.slice(1);
            if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) fail('非法实数值：' + value);
            pendingValue = value;
        } else {
            fail('无法识别的值 token：' + token.slice(0, 80));
        }
    }

    function write(chunk) {
        if (finished) throw new Error('VCD 解析器已结束');
        const text = String(chunk);
        let tokenStart = -1;
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            const isWhitespace = code <= 32 || (code === 0xfeff && line === 1 && column === 1);
            if (isWhitespace) {
                if (tokenStart >= 0 || carry) {
                    accept(carry + (tokenStart >= 0 ? text.slice(tokenStart, index) : ''));
                    carry = '';
                    tokenStart = -1;
                }
                if (code === 10) { line++; column = 1; } else column++;
            } else {
                if (tokenStart < 0) {
                    tokenStart = index;
                    if (!carry) { tokenLine = line; tokenColumn = column; }
                }
                column++;
            }
        }
        if (tokenStart >= 0) carry += text.slice(tokenStart);
        if (carry.length > cap.maxTokenLength) failResource('单个 token 超过资源上限');
    }

    function finish() {
        if (finished) throw new Error('VCD 解析器已结束');
        if (carry) { accept(carry); carry = ''; }
        if (command) fail('文件截断：' + command + ' 缺少 $end');
        if (pendingValue !== null) fail('文件截断：向量或实数缺少信号标识');
        if (dumpOpen) fail('文件截断：dump 命令缺少 $end');
        if (metadata.vars.length && !definitionsEnded) fail('文件截断：缺少 $enddefinitions');
        finished = true;
        return metadata;
    }
    return { write, finish };
}

/** 小文本兼容入口；大文件应使用 VcdSession，避免在宿主创建全文和事件对象。 */
function parseVcd(text) {
    const changes = new Map();
    const parser = createVcdParser({ onChange(id, t, value) {
        if (!changes.has(id)) changes.set(id, []);
        changes.get(id).push({ t, value });
    } });
    parser.write(String(text));
    return { ...parser.finish(), changes };
}

/** @param {string} timescale @returns {number|null} 每个 VCD tick 对应的秒数。 */
function parseTimescaleSeconds(timescale) {
    const match = String(timescale || '').trim().match(/^(\d+(?:\.\d+)?)\s*(sec|s|ms|msec|us|usec|ns|nsec|ps|psec|fs|fsec)$/i);
    if (!match) return null;
    const factors = { s: 1, sec: 1, ms: 1e-3, msec: 1e-3, us: 1e-6, usec: 1e-6, ns: 1e-9, nsec: 1e-9, ps: 1e-12, psec: 1e-12, fs: 1e-15, fsec: 1e-15 };
    return Number(match[1]) * factors[match[2].toLowerCase()];
}

/** 信号树既接受兼容解析结果，也接受仅含 changeCount 的 worker 元数据。 */
function buildSignalTree(vcd) {
    const root = { name: '', path: '', type: 'root', children: [] };
    const nodes = new Map([['', root]]);
    for (const scope of vcd.scopes) {
        const parentPath = scope.path.includes('.') ? scope.path.slice(0, scope.path.lastIndexOf('.')) : '';
        const node = { ...scope, children: [] };
        (nodes.get(parentPath) || root).children.push(node);
        nodes.set(scope.path, node);
    }
    for (const variable of vcd.vars) {
        if (/^(spec)?parameter$/i.test(variable.type)) continue;
        const hasChanges = typeof variable.changeCount === 'number' ? variable.changeCount > 0
            : Boolean(vcd.changes && vcd.changes.has(variable.id) && vcd.changes.get(variable.id).length);
        (nodes.get(variable.scopePath) || root).children.push({ name: variable.name, path: variable.path,
            id: variable.id, width: variable.width, type: variable.type, ...(variable.range ? { range: variable.range } : {}), hasChanges });
    }
    return root;
}

module.exports = { DEFAULT_LIMITS, createVcdParser, VcdParseError, parseVcd, buildSignalTree, parseTimescaleSeconds };
