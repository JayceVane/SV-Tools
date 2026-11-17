'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { tokenize } = require('./completion/syntax');
const { keyOf } = require('../project/model');

const LANGUAGES = new Set(['verilog', 'systemverilog', 'system-verilog']);
const CONDITIONAL = new Set(['`ifdef', '`ifndef', '`elsif', '`else', '`endif']);
const HAS_CONDITIONAL = /`ifn?def(?![\w$])/;
const MACRO = /^[A-Za-z_][A-Za-z0-9_$]*/;
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_INPUT_SIZE = 4 * 1024 * 1024;
const MAX_INCLUDE_DEPTH = 24;
const MAX_LOOKUPS = 4096;

/** Retain original offsets. An incomplete directive or unresolved active include leaves normal highlighting. */
async function inactiveRanges({ file, text, defines = [], readInclude }) {
    const macros = new Set(defines.map(value => MACRO.exec(value)?.[0]).filter(Boolean)), ranges = [];
    let remaining = MAX_INPUT_SIZE;
    async function scan(file, text, depth) {
        if (depth >= MAX_INCLUDE_DEPTH || text.length > MAX_FILE_SIZE || (remaining -= text.length) < 0) return false;
        const tokens = tokenize(text).filter(token => token.kind !== 'comment');
        const stack = [];
        let active = true, start = 0;
        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index];
            if (token.kind !== 'macro' && token.kind !== 'define') continue;
            const next = tokens[index + 1];
            const argument = next && !/[\r\n]/.test(text.slice(token.end, next.start)) ? next : null;
            if (CONDITIONAL.has(token.value)) {
                if (depth === 0 && !active && text.slice(start, token.start).trim()) ranges.push([start, token.start]);
                const directive = token.value;
                const named = directive !== '`else' && directive !== '`endif';
                const name = named && argument?.kind === 'identifier' && MACRO.exec(argument.value)?.[0];
                if (named && (!name || name !== argument.value)) return false;
                if (directive === '`ifdef' || directive === '`ifndef') {
                    const matched = macros.has(name) === (directive === '`ifdef');
                    stack.push({ parent: active, matched, seenElse: false });
                    active = active && matched;
                } else {
                    const frame = stack.at(-1);
                    if (!frame) return false;
                    if (directive === '`endif') {
                        stack.pop();
                        active = frame.parent;
                    } else {
                        if (frame.seenElse) return false;
                        frame.seenElse = directive === '`else';
                        const matched = frame.seenElse || macros.has(name);
                        active = frame.parent && !frame.matched && matched;
                        frame.matched ||= matched;
                    }
                }
                if (named) index++;
                start = named ? argument.end : token.end;
            } else if (active) {
                if (token.kind === 'define') {
                    const name = MACRO.exec(token.value.slice('`define'.length).trimStart())?.[0];
                    if (name) macros.add(name);
                } else if (token.value === '`undef') {
                    if (argument?.kind !== 'identifier' || MACRO.exec(argument.value)?.[0] !== argument.value) return false;
                    macros.delete(argument.value);
                    index++;
                } else if (token.value === '`undefineall') {
                    macros.clear();
                } else if (token.value === '`include') {
                    const literal = argument?.kind === 'string' && argument.closed && /^"([^"\r\n]+)"$/.exec(argument.value);
                    if (!literal) return false;
                    const header = await readInclude(file, literal[1]);
                    if (!header || !await scan(header.file, header.text, depth + 1)) return false;
                    index++;
                }
            }
        }
        return stack.length === 0;
    }
    return await scan(file, text, 0) ? ranges : [];
}

function activateConditionalHighlighting({ vscode, getProjectSources, sourceCatalog }) {
    const { workspace, window } = vscode;
    const decoration = window.createTextEditorDecorationType({ opacity: '0.55', rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
    const editors = () => window.visibleTextEditors.filter(({ document }) => document.uri.scheme === 'file' && LANGUAGES.has(document.languageId));
    let generation = 0, timer, dependencies = new Set(), scanning = new Set();

    async function analyze(document, touched) {
        const text = document.getText(), file = document.uri.fsPath;
        if (text.length > MAX_FILE_SIZE || !HAS_CONDITIONAL.test(text)) return [];
        const root = workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
        const project = await getProjectSources({ root, file, findContainingVivado: true });
        if (project?.ambiguousDefines) return [];
        const configured = workspace.getConfiguration('svtools.iverilog', document.uri).get('includePaths', []);
        const directories = [...new Set([...configured.map(dir => path.resolve(root || path.dirname(file), dir)),
            ...(project?.includeDirs || []), ...(project?.files || []).map(member => path.dirname(member))])];
        const open = new Map(workspace.textDocuments.filter(doc => doc.uri.scheme === 'file').map(doc => [keyOf(doc.uri.fsPath), doc]));
        const cached = new Map();
        let lookups = MAX_LOOKUPS;
        async function readInclude(parent, name) {
            const candidates = new Set([path.dirname(parent), ...directories].map(directory => path.resolve(directory, name)));
            for (const candidate of candidates) {
                if (--lookups < 0) return null;
                const key = keyOf(candidate);
                touched.add(key);
                if (!cached.has(key)) {
                    const current = open.get(key);
                    if (current) cached.set(key, { file: candidate, text: current.getText() });
                    else {
                        try {
                            const stat = await fs.stat(candidate);
                            if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;
                            const bytes = await fs.readFile(candidate);
                            if (bytes.length > MAX_FILE_SIZE) return null;
                            cached.set(key, { file: candidate, text: bytes.toString('utf8') });
                        } catch (error) {
                            if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
                            cached.set(key, null);
                        }
                    }
                }
                if (cached.get(key)) return cached.get(key);
            }
            return null;
        }
        return inactiveRanges({ file, text, defines: project?.defines, readInclude });
    }

    async function refresh(version) {
        const visible = editors(), touched = new Set(), documents = [...new Set(visible.map(editor => editor.document))];
        scanning = touched;
        const results = new Map(await Promise.all(documents.map(async document => {
            try {
                return [document, await analyze(document, touched)];
            } catch (error) {
                console.warn('[SV Tools] 读取条件编译高亮上下文失败：' + error.message);
                return [document, []];
            }
        })));
        if (version !== generation) return;
        dependencies = touched;
        scanning = new Set();
        for (const editor of visible) {
            const { document } = editor;
            editor.setDecorations(decoration, results.get(document).map(([start, end]) => new vscode.Range(document.positionAt(start), document.positionAt(end))));
        }
    }

    function schedule(uri) {
        const visible = editors();
        if (uri && !/\.xpr$/i.test(uri.fsPath) && !dependencies.has(keyOf(uri.fsPath)) && !scanning.has(keyOf(uri.fsPath))
            && !visible.some(editor => editor.document.uri.toString() === uri.toString())) return;
        const version = ++generation;
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(version), 100);
    }
    const subscriptions = [window.onDidChangeVisibleTextEditors(() => schedule()),
        workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) schedule(event.document.uri); }),
        workspace.onDidCloseTextDocument(document => schedule(document.uri)),
        sourceCatalog.onDidChange(change => schedule(change?.uri))];
    schedule();
    return { dispose() { generation++; clearTimeout(timer); subscriptions.forEach(subscription => subscription.dispose()); decoration.dispose(); } };
}

module.exports = { activateConditionalHighlighting, inactiveRanges };
