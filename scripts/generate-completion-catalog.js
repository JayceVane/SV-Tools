'use strict';

// 从固定的公开参考实现生成接口数据；不加载仿真器，不展开用户工程。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_REFERENCE = path.join(ROOT, 'bin', 'completion-reference');
const OUTPUT = path.join(ROOT, 'src', 'editor', 'completion');
const SLANG_COMMIT = 'fd809bc29cc39cc2a467aa29773524144e631e97';
const SOURCE_RELEASES = [
    { profile: '1.2', directory: 'uvm-1.2', archive: 'uvm-1.2.tar.gz', sha256: '502a2e605ce552bfd9767803c7e99a053715b00f7a9c4c511c3fbfddfb30157c', url: 'https://accellera.org/images/downloads/standards/uvm/uvm-1.2.tar.gz' },
    { profile: '1800.2', directory: '1800.2-2020.3.2', archive: 'uvm-2020.3.2.tar.gz', sha256: '4664ac015f23c72106dd785906aa874d70932ea63f74b85de1e32fa5339c15eb', url: 'https://accellera.org/images/downloads/standards/uvm/1800.2-2020.3.2%20Release.gz' },
];

/** @param {string} directory @returns {string[]} 排序后的普通文件，不跟随链接。 */
function filesBelow(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : [];
    });
}

/** @param {string} text @returns {string} 保持偏移和换行的代码视图。 */
function mask(text) {
    return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"/g, value => value.replace(/[^\r\n]/g, ' '));
}

/** @param {string} text @param {string} separator @returns {string[]} 忽略嵌套括号的分隔。 */
function splitBalanced(text, separator = ',') {
    const masked = mask(text);
    let depth = 0;
    let start = 0;
    const pieces = [];
    for (let i = 0; i < masked.length; i++) {
        if ('([{'.includes(masked[i])) depth++;
        if (')]}'.includes(masked[i])) depth--;
        if (masked[i] === separator && depth === 0) {
            pieces.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    pieces.push(text.slice(start).trim());
    return pieces;
}

function closing(text, start) {
    const pair = { '(': ')', '[': ']', '{': '}' };
    const stack = [pair[text[start]]];
    for (let i = start + 1; i < text.length; i++) {
        if (pair[text[i]]) stack.push(pair[text[i]]);
        else if (text[i] === stack[stack.length - 1] && !--stack.length) return i;
    }
    return -1;
}

function normalize(text) {
    return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
}

function commentBefore(text, offset) {
    let cursor = offset;
    let first = offset;
    while (cursor > 0) {
        const previous = text.lastIndexOf('\n', cursor - 1);
        const line = text.slice(previous + 1, cursor).trim();
        if (line && !line.startsWith('//')) break;
        first = previous + 1;
        cursor = previous;
    }
    return text.slice(first, offset);
}

function category(comment, profile, qualified, docs) {
    const annotation = [...comment.matchAll(/@uvm-(ieee|contrib|accellera|compat)\b([^\n]*)/g)].at(-1);
    if (annotation) return { category: annotation[1], standard: annotation[1] === 'ieee' ? 'IEEE 1800.2-2020' : null, section: annotation[2].trim() };
    if (docs.has(qualified)) return { category: profile === '1.2' ? 'uvm-1.2' : 'reference', standard: profile === '1.2' ? 'UVM 1.2' : null };
    return null;
}

function documentedNames(root) {
    const names = new Set();
    const docsRoot = path.join(root, 'docs', 'html', 'index');
    for (const file of filesBelow(docsRoot).filter(file => file.endsWith('.html'))) {
        const html = fs.readFileSync(file, 'utf8');
        for (const match of html.matchAll(/href="[^"#]*#([^"<>]+)"/g)) {
            const name = match[1].replace(/&amp;/g, '&').replace(/#?\([^)]*\)/g, '');
            names.add(name);
        }
    }
    return names;
}

function parseParameters(text) {
    return splitBalanced(text).filter(Boolean).map(value => {
        const parts = splitBalanced(value, '=');
        const declaration = parts[0];
        const name = /([A-Za-z_]\w*)\s*$/.exec(declaration)?.[1];
        return name ? { name, type: declaration.slice(0, declaration.lastIndexOf(name)).trim() || 'type', default: parts.length > 1 ? parts.slice(1).join('=').trim() : undefined } : null;
    }).filter(Boolean);
}

function argumentNames(parameters) {
    return splitBalanced(parameters).filter(Boolean).map(value => {
        const declaration = splitBalanced(value, '=')[0];
        return /([A-Za-z_]\w*)\s*(?:\[[\s\S]*\])?\s*$/.exec(declaration)?.[1] || 'argument';
    });
}

function escapeSnippet(value) {
    return value.replace(/[\\$}]/g, '\\$&');
}

function callBody(name, parameters, prefix = '') {
    return prefix + name + '(' + argumentNames(parameters).map((value, index) => '${' + (index + 1) + ':' + escapeSnippet(value) + '}').join(', ') + ')';
}

function macroBody(macro) {
    const defaults = { ID: '"ID"', MSG: '"message"', VERBOSITY: 'UVM_MEDIUM', FLAG: 'UVM_DEFAULT', ARG: 'field', T: 'type', TYPE: 'type', SFX: '_suffix', SEQ_OR_ITEM: 'item', PRIORITY: '-1', SEQR: 'sequencer', CB: 'callback_type' };
    const args = parseParameters(macro.parameters).map((parameter, index) => {
        const placeholder = '${' + (index + 1) + ':' + escapeSnippet(parameter.default || defaults[parameter.name] || parameter.name.toLowerCase()) + '}';
        return parameter.name === 'CONSTRAINTS' ? '{ ' + placeholder + ' }' : placeholder;
    });
    return '`' + macro.name + (macro.hasArguments ? '(' + args.join(', ') + ')' : '');
}

function extractMacros(text, source) {
    const definitions = [];
    const code = mask(text);
    for (const match of code.matchAll(/^\s*`define\s+([A-Za-z_]\w*)(\([^\n]*?\))?/gm)) {
        const offset = match.index + match[0].indexOf('`define');
        const rawHeader = /^`define\s+([A-Za-z_]\w*)(\([^\n]*?\))?/.exec(text.slice(offset));
        let end = text.indexOf('\n', offset);
        if (end < 0) end = text.length;
        while (end < text.length && /\\\r?$/.test(text.slice(offset, end))) {
            const next = text.indexOf('\n', end + 1);
            end = next < 0 ? text.length : next;
        }
        definitions.push({ name: rawHeader[1], parameters: rawHeader[2]?.slice(1, -1) || '', hasArguments: Boolean(rawHeader[2]), replacement: text.slice(offset + rawHeader[0].length, end).replace(/\\\r?\n/g, '\n'), source, offset, end, comment: commentBefore(text, offset) });
    }
    return definitions;
}

// 只展开库自身定义的接口宏；深度和字符总量有界，避免任意预处理器执行。
function expandInterfaceMacros(text, macros, depth = 0) {
    if (depth >= 12 || text.length > 500000) return text;
    const code = mask(text);
    const changes = [];
    for (const match of code.matchAll(/`([A-Za-z_]\w*)/g)) {
        const macro = macros.get(match[1]);
        if (!macro || !/\b(?:function|task)\b|`UVM_[A-Z_]+(?:IMP|COMMON|PORT)/.test(macro.replacement)) continue;
        let end = match.index + match[0].length;
        let args = [];
        if (macro.hasArguments) {
            while (/\s/.test(code[end] || '') && end < code.length) end++;
            if (code[end] !== '(') continue;
            const close = closing(code, end);
            if (close < 0) continue;
            args = splitBalanced(text.slice(end + 1, close));
            end = close + 1;
        }
        let replacement = macro.replacement;
        const parameters = parseParameters(macro.parameters);
        parameters.forEach((parameter, index) => {
            const value = args[index] === undefined || args[index] === '' ? parameter.default || '' : args[index];
            replacement = replacement.replace(new RegExp('\\b' + parameter.name + '\\b', 'g'), () => value);
        });
        replacement = replacement.replace(/``/g, '');
        changes.push({ start: match.index, end, replacement: expandInterfaceMacros(replacement, macros, depth + 1) });
    }
    for (const change of changes.reverse()) text = text.slice(0, change.start) + change.replacement + text.slice(change.end);
    return text;
}

function removeMacros(text, definitions) {
    let result = text;
    for (const definition of [...definitions].reverse()) result = result.slice(0, definition.offset) + result.slice(definition.offset, definition.end).replace(/[^\r\n]/g, ' ') + result.slice(definition.end);
    return result;
}

function tokenList(code) {
    return [...code.matchAll(/[A-Za-z_$][\w$]*|::|[^\s]/g)].map(match => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
}

function statementEnd(code, start) {
    let depth = 0;
    for (let i = start; i < code.length; i++) {
        if ('([{'.includes(code[i])) depth++;
        else if (')]}'.includes(code[i])) depth--;
        else if (code[i] === ';' && depth === 0) return i;
    }
    return -1;
}

function extractClasses(text) {
    const code = mask(text);
    const tokens = tokenList(code);
    const classes = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.value !== 'class' || tokens[index - 1]?.value === 'typedef') continue;
        const nameToken = tokens[index + 1];
        if (!/^[A-Za-z_]\w*$/.test(nameToken?.value || '')) continue;
        const headerEnd = statementEnd(code, nameToken.end);
        if (headerEnd < 0) continue;
        let endIndex = index + 2;
        let depth = 1;
        for (; endIndex < tokens.length; endIndex++) {
            if (tokens[endIndex].value === 'class' && tokens[endIndex - 1]?.value !== 'typedef') depth++;
            if (tokens[endIndex].value === 'endclass' && !--depth) break;
        }
        if (endIndex === tokens.length) throw new Error('未闭合的参考库 class: ' + nameToken.value);
        const header = normalize(text.slice(nameToken.end, headerEnd));
        let parameterText = '';
        const parameterStart = header.search(/^#\s*\(/);
        if (parameterStart >= 0 && /^#\s*\(/.test(header.slice(parameterStart))) {
            const opening = header.indexOf('(', parameterStart);
            parameterText = header.slice(opening + 1, closing(mask(header), opening));
        }
        const base = /\bextends\s+([\s\S]*?)(?:\bimplements\b|$)/.exec(header)?.[1].trim();
        const qualifier = /(?:virtual|interface)\s*$/.exec(code.slice(0, token.start));
        classes.push({ name: nameToken.value, start: qualifier ? qualifier.index : token.start, headerEnd, end: tokens[endIndex].start, parameters: parseParameters(parameterText), base });
        index = endIndex;
    }
    return classes;
}

function extractMethods(text, source, owner, profile, docs, forcePublic = false) {
    const code = mask(text);
    const methods = [];
    const blocks = [];
    let declarationCount = 0;
    const regex = /\b(function|task)\b/g;
    let match;
    while ((match = regex.exec(code))) {
        const end = statementEnd(code, match.index);
        if (end < 0) break;
        const prefixStart = Math.max(code.lastIndexOf(';', match.index - 1), code.lastIndexOf('\n', match.index - 1)) + 1;
        const qualifiers = normalize(text.slice(prefixStart, match.index));
        const declaration = text.slice(match.index + match[0].length, end);
        const declarationCode = code.slice(match.index + match[0].length, end);
        const opening = declarationCode.indexOf('(');
        const namePart = opening < 0 ? declaration : declaration.slice(0, opening);
        const nameMatch = /([A-Za-z_]\w*)\s*$/.exec(namePart);
        if (!nameMatch || /::/.test(namePart)) continue;
        const name = nameMatch[1];
        declarationCount++;
        const parameters = opening < 0 ? '' : declaration.slice(opening + 1, closing(declarationCode, opening));
        const visibility = /\blocal\b/.test(qualifiers) ? 'local' : /\bprotected\b/.test(qualifiers) ? 'protected' : 'public';
        const returnType = normalize(namePart.slice(0, nameMatch.index)).replace(/\b(?:automatic|static|virtual|pure|extern|local|protected)\b/g, '').trim() || (name === 'new' ? owner : 'void');
        const comment = commentBefore(text, prefixStart);
        const info = category(comment, profile, owner ? owner + '.' + name : name, docs);
        if (visibility === 'public' && (info || forcePublic)) {
            methods.push({ name, kind: match[1], signature: (match[1] === 'function' && name !== 'new' ? returnType + ' ' : '') + name + '(' + normalize(parameters) + ')', body: callBody(name, parameters), returnType, type: returnType, visibility, static: /\bstatic\b/.test(qualifiers), deprecated: /\bDEPRECATED\b/.test(comment) || /\/deprecated\//.test(source) || undefined, requires: /\bimport\b/.test(qualifiers) ? 'DPI-C' : undefined, ...(info || { category: 'reference-generated', standard: null }), source });
        }
        const isPrototype = /\b(?:extern|pure|import)\b/.test(qualifiers);
        let blockEnd = end + 1;
        if (!isPrototype) {
            const endWord = match[1] === 'function' ? 'endfunction' : 'endtask';
            const bodyEnd = new RegExp('\\b' + endWord + '\\b', 'g');
            bodyEnd.lastIndex = end + 1;
            const bodyMatch = bodyEnd.exec(code);
            if (bodyMatch) blockEnd = bodyMatch.index + bodyMatch[0].length;
        }
        blocks.push({ start: prefixStart, end: blockEnd });
        regex.lastIndex = blockEnd;
    }
    return { methods, blocks, declarationCount };
}

function extractFields(text, source, owner, profile, docs, blocks) {
    let code = mask(text);
    for (const block of [...blocks].reverse()) code = code.slice(0, block.start) + code.slice(block.start, block.end).replace(/[^\r\n]/g, ' ') + code.slice(block.end);
    const fields = [];
    for (const match of code.matchAll(/(?:^|[;\n])([ \t]*(?:(?:static|const|rand|randc|protected|local)\s+)*[A-Za-z_]\w*(?:(?:\s*::\s*[A-Za-z_]\w*)|(?:\s*#\s*\([\s\S]*?\))|(?:\s+(?:signed|unsigned))|(?:\s*\[[^\]]*\]))*\s+[A-Za-z_]\w*(?:\s*\[[^\]]*\])?(?:\s*=\s*[^;]*)?\s*;)/g)) {
        const offset = match.index + match[0].indexOf(match[1]);
        const raw = normalize(text.slice(offset, offset + match[1].length)).replace(/;$/, '');
        const declaration = splitBalanced(raw, '=')[0];
        const parts = /^(.*?)\s+([A-Za-z_]\w*)(\s*\[[\s\S]*\])?$/.exec(declaration);
        if (!parts || /\b(?:typedef|return|function|task|endfunction|endtask)\b/.test(parts[1])) continue;
        if (/\b(?:protected|local)\b/.test(parts[1])) continue;
        const name = parts[2];
        const info = category(commentBefore(text, offset), profile, owner ? owner + '.' + name : name, docs);
        if (!info) continue;
        const type = parts[1].replace(/\b(?:static|const|rand|randc)\b/g, '').trim() + (parts[3] || '');
        fields.push({ name, kind: 'field', type, signature: type + ' ' + name, visibility: 'public', static: /\bstatic\b/.test(parts[1]), ...info, source });
    }
    return fields;
}

function extractTypesAndConstants(text, source, profile, docs) {
    const code = mask(text);
    const symbols = [];
    const constants = [];
    for (const match of code.matchAll(/\btypedef\s+(?!class\b)([\s\S]*?);/g)) {
        const raw = normalize(text.slice(match.index + 'typedef'.length, match.index + match[0].length - 1));
        const typeMatch = /([A-Za-z_]\w*)\s*(?:\[[\s\S]*\])?\s*$/.exec(raw);
        if (!typeMatch || !typeMatch[1].startsWith('uvm_')) continue;
        const name = typeMatch[1];
        const info = category(commentBefore(text, match.index), profile, name, docs);
        if (!info) continue;
        const type = raw.slice(0, typeMatch.index).trim();
        const members = [];
        if (/^enum\b/.test(type)) {
            const opening = type.indexOf('{');
            const end = closing(mask(type), opening);
            for (const item of splitBalanced(type.slice(opening + 1, end))) {
                const constantName = /^([A-Za-z_]\w*)/.exec(item)?.[1];
                if (constantName) {
                    const constant = { name: constantName, kind: 'enumMember', type: name, ...info, source };
                    members.push(constant);
                    constants.push(constant);
                }
            }
        }
        symbols.push({ name, kind: /^enum\b/.test(type) ? 'enum' : 'typedef', type, members, ...info, source });
    }
    for (const match of code.matchAll(/\b(?:parameter|localparam|const)\s+[^;{}]*?\b(UVM_[A-Za-z0-9_]+)\s*=/g)) {
        const info = category(commentBefore(text, match.index), profile, match[1], docs);
        if (info || docs.has(match[1])) constants.push({ name: match[1], kind: 'constant', ...(info || { category: 'reference', standard: null }), source });
    }
    return { symbols, constants };
}

function uniqueNamed(items) {
    const map = new Map();
    const rank = { ieee: 6, 'uvm-1.2': 5, contrib: 4, accellera: 3, compat: 2, reference: 1, 'reference-generated': 0 };
    for (const item of items) if (!map.has(item.name) || (rank[item.category] || 0) > (rank[map.get(item.name).category] || 0)) map.set(item.name, item);
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {string} referenceRoot @param {object} release @param {Set<string>} previousDocs @returns {object} */
function generateUvm(referenceRoot, release, previousDocs) {
    const root = path.join(referenceRoot, release.directory);
    const archiveHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(referenceRoot, release.archive))).digest('hex');
    if (archiveHash !== release.sha256) throw new Error('UVM 官方归档校验失败: ' + release.archive);
    const docs = documentedNames(root);
    // 1800.2 的 NODOCS 标记代表外部 LRM 文档；旧公开接口另标参考/兼容，不能冒充 IEEE 条目。
    if (release.profile !== '1.2') for (const name of previousDocs) docs.add(name);
    const sourceFiles = filesBelow(path.join(root, 'src')).filter(file => /\.svh?$/.test(file));
    const sources = sourceFiles.map(file => ({ source: path.relative(root, file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8') }));
    const macroMap = new Map();
    for (const { text, source } of sources) for (const macro of extractMacros(text, source)) {
        if (!macroMap.has(macro.name) || macro.replacement.trim()) macroMap.set(macro.name, macro);
    }
    const symbols = [];
    const functions = [];
    const constants = [];
    let classDeclarations = 0;
    let publicMethodDeclarations = 0;
    let includedClassDeclarations = 0;
    let publicClassMethodDeclarations = 0;
    for (const { text, source } of sources) {
        const clean = removeMacros(text, extractMacros(text, source));
        const classes = extractClasses(clean);
        classDeclarations += classes.length;
        let globals = clean;
        for (const cls of [...classes].reverse()) globals = globals.slice(0, cls.start) + globals.slice(cls.start, cls.end + 'endclass'.length).replace(/[^\r\n]/g, ' ') + globals.slice(cls.end + 'endclass'.length);
        for (const cls of classes) {
            const info = category(commentBefore(clean, cls.start), release.profile, cls.name, docs);
            if (!info) continue;
            includedClassDeclarations++;
            const originalBody = clean.slice(cls.headerEnd + 1, cls.end);
            const body = expandInterfaceMacros(originalBody, macroMap);
            const parsed = extractMethods(body, source, cls.name, release.profile, docs);
            const originalMethods = extractMethods(originalBody, source, cls.name, release.profile, docs, true);
            publicClassMethodDeclarations += originalMethods.declarationCount;
            const originalMethodNames = new Set(originalMethods.methods.map(method => method.name));
            const generated = body !== originalBody ? extractMethods(body, source, cls.name, release.profile, docs, true).methods.filter(method => !originalMethodNames.has(method.name) && !/^m_|^__/.test(method.name)) : [];
            const members = uniqueNamed([...parsed.methods, ...generated, ...extractFields(originalBody, source, cls.name, release.profile, docs, originalMethods.blocks)]);
            publicMethodDeclarations += originalMethods.methods.filter(method => method.category !== 'reference-generated').length;
            symbols.push({ name: cls.name, kind: 'class', base: cls.base, parameters: cls.parameters, members, ...info, source });
        }
        const globalMethods = extractMethods(globals, source, '', release.profile, docs);
        functions.push(...globalMethods.methods);
        symbols.push(...extractFields(globals, source, '', release.profile, docs, globalMethods.blocks).filter(field => /^uvm_/.test(field.name)).map(field => ({ ...field, kind: 'variable' })));
        const types = extractTypesAndConstants(globals, source, release.profile, docs);
        symbols.push(...types.symbols);
        constants.push(...types.constants);
    }
    const macros = [];
    for (const macro of macroMap.values()) {
        const info = category(macro.comment, release.profile, '`' + macro.name, docs) || category(macro.comment, release.profile, macro.name, docs);
        if (!info || /_SVH$|_SV$/.test(macro.name)) continue;
        if (release.profile === '1800.2' && /\/deprecated\//.test(macro.source)) Object.assign(info, { category: 'compat', standard: null });
        macros.push({ name: macro.name, kind: 'macro', signature: '`' + macro.name + (macro.hasArguments ? '(' + normalize(macro.parameters) + ')' : ''), body: macroBody(macro), deprecated: /\/deprecated\//.test(macro.source) || /\bDEPRECATED\b/.test(macro.comment) || undefined, ...info, source: macro.source });
    }
    const result = { metadata: { schemaVersion: 1, profile: release.profile, implementation: release.directory, sourceUrl: release.url, archiveSha256: release.sha256, license: 'Apache-2.0', sourceFiles: sources.length, discoveredClassDeclarations: classDeclarations, publicClassMethodDeclarations, publicMethodDeclarations, excludedPublicClassMethodDeclarations: publicClassMethodDeclarations - publicMethodDeclarations, policy: '公开文档/官方 API 注释；私有及 protected 不进入补全；库接口宏仅在已公开类中展开；扩展/兼容与 IEEE 分开标注。' }, symbols: uniqueNamed(symbols), functions: uniqueNamed(functions), constants: uniqueNamed(constants), macros: uniqueNamed(macros) };
    result.metadata.counts = { symbols: result.symbols.length, classes: result.symbols.filter(symbol => symbol.kind === 'class').length, members: result.symbols.reduce((count, symbol) => count + (symbol.members?.length || 0), 0), functions: result.functions.length, constants: result.constants.length, macros: result.macros.length };
    result.metadata.excludedClassDeclarations = classDeclarations - includedClassDeclarations;
    result.metadata.duplicatePublicClassDeclarations = includedClassDeclarations - result.metadata.counts.classes;
    return { result, docs };
}

function generateLanguage(referenceRoot) {
    const root = path.join(referenceRoot, 'slang-' + SLANG_COMMIT);
    const lexer = fs.readFileSync(path.join(root, 'source', 'parsing', 'LexerFacts.cpp'), 'utf8');
    const keywordGroups = {};
    for (const match of lexer.matchAll(/#define ((?:NEW)?KEYWORDS_[A-Za-z0-9_]+) ([\s\S]*?)(?=\r?\n\r?\n)/g)) keywordGroups[match[1]] = [...match[2].matchAll(/\{ "([A-Za-z0-9_]+)"/g)].map(item => item[1]);
    const ordered = ['KEYWORDS_1364_1995', 'NEWKEYWORDS_1364_2001_noconfig', 'NEWKEYWORDS_1364_2001', 'NEWKEYWORDS_1364_2005', 'NEWKEYWORDS_1800_2005', 'NEWKEYWORDS_1800_2009', 'NEWKEYWORDS_1800_2012'];
    const profiles = {};
    const keywords = [];
    for (const group of ordered) {
        if (!keywordGroups[group]?.length) throw new Error('缺失标准关键词分组: ' + group);
        keywords.push(...keywordGroups[group]);
        const name = group.replace(/^(?:NEW)?KEYWORDS_/, '').replace('_', '-').replace(/_noconfig$/, '-noconfig');
        profiles[name] = [...new Set(keywords)].sort();
    }
    profiles['1800-2017'] = profiles['1800-2012'];
    profiles['1800-2023'] = profiles['1800-2012'];
    const systems = fs.readFileSync(path.join(root, 'scripts', 'systemnames.txt'), 'utf8').split(/\r?\n/).map(line => /^\$\S+/.exec(line)?.[0]).filter(Boolean);
    const specify = fs.readFileSync(path.join(root, 'source', 'ast', 'symbols', 'SpecifySymbols.cpp'), 'utf8');
    const timingChecks = [...specify.matchAll(/\{"(\$[a-z]+)"sv, std::move\(/g)].map(match => match[1]);
    if (timingChecks.length !== 12) throw new Error('时序检查目录与已核验标准不一致');
    return { metadata: { source: 'https://github.com/MikePopoloski/slang/tree/' + SLANG_COMMIT, sourceCommit: SLANG_COMMIT, lexerSha256: crypto.createHash('sha256').update(lexer).digest('hex'), license: 'MIT', keywordCounts: Object.fromEntries(Object.entries(profiles).map(([name, values]) => [name, values.length])), systems: systems.length, timingChecks: timingChecks.length }, profiles, systems, timingChecks };
}

/** @param {string} referenceRoot @returns {object} 写入可重现目录，缺失/校验失败直接报错。 */
function generate(referenceRoot = DEFAULT_REFERENCE) {
    fs.mkdirSync(OUTPUT, { recursive: true });
    const language = generateLanguage(referenceRoot);
    fs.writeFileSync(path.join(OUTPUT, 'language-standard.json'), JSON.stringify(language, null, 2) + '\n');
    let previousDocs = new Set();
    const counts = {};
    for (const release of SOURCE_RELEASES) {
        const { result, docs } = generateUvm(referenceRoot, release, previousDocs);
        fs.writeFileSync(path.join(OUTPUT, 'uvm-' + release.profile.replace('.', '-') + '.json'), JSON.stringify(result, null, 2) + '\n');
        previousDocs = docs;
        counts[release.profile] = result.metadata;
    }
    const uvmRoot = path.join(referenceRoot, SOURCE_RELEASES[1].directory);
    const licenses = { generatedFrom: '仅接口名称、声明与来源类别；实现体不进入发布包。', uvmLicense: fs.readFileSync(path.join(uvmRoot, 'LICENSE.txt'), 'utf8'), uvmNotice: fs.readFileSync(path.join(uvmRoot, 'NOTICE.txt'), 'utf8'), uvm12Notice: fs.readFileSync(path.join(referenceRoot, SOURCE_RELEASES[0].directory, 'NOTICE.txt'), 'utf8'), slangLicense: fs.readFileSync(path.join(referenceRoot, 'slang-' + SLANG_COMMIT, 'LICENSE'), 'utf8') };
    fs.writeFileSync(path.join(OUTPUT, 'catalog-licenses.json'), JSON.stringify(licenses, null, 2) + '\n');
    return { language: language.metadata, uvm: counts };
}

if (require.main === module) {
    try { process.stdout.write(JSON.stringify(generate(process.argv[2] || DEFAULT_REFERENCE), null, 2) + '\n'); }
    catch (error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
}

module.exports = { generate, generateUvm, generateLanguage, mask, splitBalanced, extractClasses, extractMethods, expandInterfaceMacros, extractMacros, documentedNames };
