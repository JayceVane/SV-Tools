'use strict';

const { SV_KEYWORDS, SV_SNIPPETS } = require('./completion-data');

/** @param {{vscode: object, loadNativeModule: () => object|null}} deps @returns {object} 大纲、定义、补全和Hover Provider。 */
function createLanguageProviders({ vscode, loadNativeModule }) {
    /**
     * Map analyzer SymbolKind string to vscode.SymbolKind
     */
    function mapSymbolKind(kind) {
        const map = {
            'Module': vscode.SymbolKind.Module,
            'Interface': vscode.SymbolKind.Interface,
            'Package': vscode.SymbolKind.Namespace,
            'Class': vscode.SymbolKind.Class,
            'Task': vscode.SymbolKind.Method,
            'Function': vscode.SymbolKind.Function,
            'Parameter': vscode.SymbolKind.Constant,
            'Port': vscode.SymbolKind.Property,
            'Variable': vscode.SymbolKind.Variable,
            'Net': vscode.SymbolKind.Variable,
            'Instance': vscode.SymbolKind.Object,
            'Typedef': vscode.SymbolKind.Struct,
            'Enum': vscode.SymbolKind.Enum,
            'Struct': vscode.SymbolKind.Struct,
            'Property': vscode.SymbolKind.Property,
            'Sequence': vscode.SymbolKind.Class,
            'Covergroup': vscode.SymbolKind.Class,
        };
        return map[kind] || vscode.SymbolKind.Variable;
    }

    /**
     * Convert an SvSymbol from the native module to a vscode.DocumentSymbol
     */
    function toDocumentSymbol(sym) {
        // Rust returns 1-based lines, VSCode uses 0-based
        const range = new vscode.Range(
            sym.startLine - 1, sym.startCol,
            sym.endLine - 1, sym.endCol
        );
        // Selection range: use the name position (first line, start col)
        const selectionRange = new vscode.Range(
            sym.startLine - 1, sym.startCol,
            sym.startLine - 1, sym.startCol + sym.name.length
        );
        const docSym = new vscode.DocumentSymbol(
            sym.name,
            sym.detail || '',
            mapSymbolKind(sym.kind),
            range,
            selectionRange
        );
        if (sym.children && sym.children.length > 0) {
            docSym.children = sym.children.map(toDocumentSymbol);
        }
        return docSym;
    }

    /**
     * Provide document symbols for Outline view
     */
    async function provideDocumentSymbols(document) {
        const native = loadNativeModule();
        if (!native || !native.extractSymbols) {
            return [];
        }

        try {
            const text = document.getText();
            const result = native.extractSymbols(text);
            return result.symbols.map(toDocumentSymbol);
        } catch (error) {
            console.error('Symbol extraction failed:', error);
            return [];
        }
    }

    // ── Go to Definition (module instance → source file) ──────────

    const MODULE_DEF_RE = /^\s*module\s+(\w+)/gm;

    /**
     * Search workspace files for a module definition by name.
     * Returns { uri, line } or null.
     */
    async function findModuleDefinition(moduleName) {
        const files = await vscode.workspace.findFiles(
            '**/*.{v,sv,vh,svh}',
            '**/node_modules/**'
        );
        for (const uri of files) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                const text = doc.getText();
                MODULE_DEF_RE.lastIndex = 0;
                let match;
                while ((match = MODULE_DEF_RE.exec(text)) !== null) {
                    if (match[1] === moduleName) {
                        const pos = doc.positionAt(match.index + match[0].indexOf(moduleName));
                        return { uri, line: pos.line };
                    }
                }
            } catch (e) {
                // skip unreadable files
            }
        }
        return null;
    }

    /**
     * Provide Go to Definition for module instances
     */
    async function provideDefinition(document, position) {
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
        if (!wordRange) return null;

        const word = document.getText(wordRange);

        // Check if this word is a module instantiation:
        // pattern: <module_name> #(...) <inst_name> (  or  <module_name> <inst_name> (
        const lineText = document.lineAt(position.line).text;
        const beforeWord = lineText.substring(0, wordRange.start.character).trimEnd();

        // Skip if the word is a keyword or looks like a port/signal
        const svKeywords = new Set([
            'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg',
            'logic', 'always', 'assign', 'begin', 'end', 'if', 'else', 'case',
            'endcase', 'for', 'while', 'function', 'endfunction', 'task',
            'endtask', 'parameter', 'localparam', 'generate', 'endgenerate',
            'interface', 'endinterface', 'package', 'endpackage', 'class',
            'endclass', 'typedef', 'enum', 'struct', 'return', 'posedge',
            'negedge', 'or', 'and', 'not', 'integer', 'real', 'time',
            'initial', 'final', 'default', 'signed', 'unsigned', 'automatic',
            'static', 'virtual', 'extends', 'implements', 'import', 'export',
        ]);
        if (svKeywords.has(word)) return null;

        // Heuristic: the word is likely a module type if it's at the start of
        // a statement (possibly after whitespace) and followed by # or an
        // instance name + (
        const afterWord = lineText.substring(wordRange.end.character).trimStart();
        const looksLikeInst =
            afterWord.startsWith('#') ||
            afterWord.startsWith('(') ||
            /^[A-Za-z_]\w*\s*[#(]/.test(afterWord);

        // Also match when cursor is on the module type in "module_type u_inst ("
        if (!looksLikeInst && !beforeWord.match(/^[.]$/)) {
            // Check previous non-empty content — if it's start of line or after ;
            // it could still be a module type
            if (beforeWord !== '' && !beforeWord.endsWith(';') && !beforeWord.endsWith(')')) {
                return null;
            }
        }

        const result = await findModuleDefinition(word);
        if (result) {
            return new vscode.Location(
                result.uri,
                new vscode.Position(result.line, 0)
            );
        }
        return null;
    }

    // ── Completion ────────────────────────────────────────────────

    /**
     * Detect the code context at the cursor position
     */
    function detectContext(document, position) {
        // Use full text from document start to cursor for accurate depth counting
        const textBefore = document.getText(
            new vscode.Range(0, 0, position.line, position.character)
        );
        const lineText = document.lineAt(position.line).text;
        const beforeCursor = lineText.substring(0, position.character);

        // Module header / body / always detection below (no instance logic here)
        const moduleDepth = (textBefore.match(/\bmodule\b/g) || []).length
            - (textBefore.match(/\bendmodule\b/g) || []).length;
        const alwaysDepth = (textBefore.match(/\balways\b/g) || []).length;
        const beginCount = (textBefore.match(/\bbegin\b/g) || []).length;
        const endCount = (textBefore.match(/\bend\b(?!module|task|function|case|generate|class|interface|package|property|sequence|group|clocking|checker|specify|primitive|config)/g) || []).length;

        if (moduleDepth <= 0) {
            return { type: 'top_level' };
        }

        // Inside always block (heuristic: after "always" and inside begin/end)
        const lastAlways = textBefore.lastIndexOf('always');
        const lastEndmodule = textBefore.lastIndexOf('endmodule');
        if (lastAlways > lastEndmodule && beginCount > endCount) {
            return { type: 'always_body' };
        }

        // Module header (between "module" and first ";")
        const lastModule = textBefore.lastIndexOf('module');
        const afterModule = textBefore.substring(lastModule);
        if (lastModule > lastEndmodule && !afterModule.includes(';')) {
            return { type: 'module_header' };
        }

        return { type: 'module_body' };
    }

    /**
     * Find the module type of the instantiation enclosing the cursor.
     * Returns null if the cursor is clearly outside the instantiation.
     */
    function findEnclosingInstantiation(document, position) {
        const startLine = Math.max(0, position.line - 30);
        const text = document.getText(
            new vscode.Range(startLine, 0, position.line, position.character)
        );

        // Find the last "identifier [#(...)] identifier (" pattern
        const re = /([A-Za-z_]\w*)\s*(?:#\s*\([\s\S]*?\)\s*)?([A-Za-z_]\w*)\s*\(/g;
        let lastMatch = null;
        let m;
        while ((m = re.exec(text)) !== null) {
            lastMatch = m;
        }
        if (!lastMatch) return null;

        // Simple check: if ");" appears after the match, the instantiation is closed
        const afterMatch = text.substring(lastMatch.index + lastMatch[0].length);
        const closed = /\)\s*;/.test(afterMatch);
        if (closed) return null;

        return { moduleType: lastMatch[1], instName: lastMatch[2] };
    }

    /**
     * Find the module type of the instantiation at the cursor position
     * using tree-sitter analyzer's Instance symbol ranges.
     * Returns { moduleType, startLine, endLine } or null.
     */
    function findInstanceAtPosition(document, position, native) {
        if (!native || !native.extractSymbols) return null;
        try {
            const result = native.extractSymbols(document.getText());
            const line = position.line + 1; // analyzer uses 1-based lines
            for (const sym of result.symbols) {
                if (!sym.children) continue;
                for (const child of sym.children) {
                    if (child.kind === 'Instance' && child.detail
                        && line >= child.startLine && line <= child.endLine) {
                        return {
                            moduleType: child.detail,
                            startLine: child.startLine,
                            endLine: child.endLine
                        };
                    }
                }
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    /**
     * Provide completion items (context-aware)
     */
    async function provideCompletionItems(document, position) {
        const items = [];
        const native = loadNativeModule();
        const lineText = document.lineAt(position.line).text;
        const beforeCursor = lineText.substring(0, position.character);

        // ── Instance port/parameter completion (exclusive) ──
        if (/\.\s*\w*$/.test(beforeCursor)) {
            const inst = findInstanceAtPosition(document, position, native);
            if (inst) {
                return await getInstanceCompletions(inst.moduleType, 'instance_port', native, document, position, inst.startLine, inst.endLine);
            }
        }

        let ctx;
        try {
            ctx = detectContext(document, position);
        } catch (e) {
            ctx = { type: 'module_body' };
        }

        // ── Context-specific snippets ──
        const contextSnippets = {
            'top_level': ['module', 'module_param', 'interface', 'package', 'typedef_enum', 'typedef_struct',
                'timescale', 'include', 'define', 'testbench'],
            'module_header': ['parameter', 'localparam'],
            'module_body': ['always', 'always_ff', 'always_ff_rst', 'always_comb', 'always_latch', 'always_star',
                'always_posedge', 'assign', 'wire', 'reg', 'logic', 'parameter', 'localparam',
                'generate_for', 'initial', 'function', 'task', 'fsm', 'typedef_enum', 'typedef_struct',
                'if', 'ifelse', 'case', 'casex', 'for', 'beginend'],
            'always_body': ['if', 'ifelse', 'case', 'casex', 'for', 'beginend'],
        };

        const allowedLabels = contextSnippets[ctx.type] || null;

        for (const snip of SV_SNIPPETS) {
            // In specific contexts, only show relevant snippets
            if (allowedLabels && !allowedLabels.includes(snip.label)) continue;
            const item = new vscode.CompletionItem(snip.label, vscode.CompletionItemKind.Snippet);
            item.detail = snip.detail;
            item.insertText = new vscode.SnippetString(snip.body);
            items.push(item);
        }

        // ── Keywords (filtered by context) ──
        const contextKeywords = {
            'top_level': ['module', 'endmodule', 'interface', 'endinterface', 'package', 'endpackage',
                'class', 'endclass', 'typedef', 'import', 'export', 'function', 'task'],
            'module_header': ['input', 'output', 'inout', 'parameter', 'localparam', 'wire', 'reg',
                'logic', 'signed', 'unsigned', 'integer', 'real'],
            'module_body': null, // all keywords
            'always_body': ['if', 'else', 'case', 'casex', 'casez', 'endcase', 'for', 'foreach',
                'while', 'do', 'repeat', 'forever', 'begin', 'end', 'return', 'break', 'continue',
                'posedge', 'negedge', 'disable', 'wait', 'fork', 'join', 'join_any', 'join_none'],
        };

        const allowedKw = contextKeywords[ctx.type];
        for (const kw of SV_KEYWORDS) {
            if (allowedKw && !allowedKw.includes(kw)) continue;
            items.push(new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword));
        }

        // ── Symbols from current file ──
        if (native && native.extractSymbols) {
            try {
                const result = native.extractSymbols(document.getText());
                for (const sym of result.symbols) {
                    const kindMap = {
                        'Module': vscode.CompletionItemKind.Module,
                        'Interface': vscode.CompletionItemKind.Interface,
                        'Package': vscode.CompletionItemKind.Module,
                        'Class': vscode.CompletionItemKind.Class,
                    };
                    if (kindMap[sym.kind]) {
                        const item = new vscode.CompletionItem(sym.name, kindMap[sym.kind]);
                        item.detail = sym.kind;
                        items.push(item);
                    }
                    if (sym.children) {
                        for (const child of sym.children) {
                            const childKindMap = {
                                'Port': vscode.CompletionItemKind.Field,
                                'Parameter': vscode.CompletionItemKind.Constant,
                                'Variable': vscode.CompletionItemKind.Variable,
                                'Net': vscode.CompletionItemKind.Variable,
                                'Instance': vscode.CompletionItemKind.Reference,
                                'Task': vscode.CompletionItemKind.Method,
                                'Function': vscode.CompletionItemKind.Function,
                            };
                            if (childKindMap[child.kind]) {
                                const item = new vscode.CompletionItem(child.name, childKindMap[child.kind]);
                                item.detail = `${child.kind} (${sym.name})`;
                                items.push(item);
                            }
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }

        return items;
    }

    /**
     * Get port/parameter completions for a module instantiation.
     * Filters out ports/params that are already connected.
     */
    async function getInstanceCompletions(moduleType, completionType, native, document, position, instStartLine, instEndLine) {
        const items = [];
        const def = await findModuleDefinition(moduleType);
        if (!def) return items;

        // Collect already-connected port/param names ONLY within this instance's range
        const usedNames = new Set();
        if (document && instStartLine && instEndLine) {
            const text = document.getText(
                new vscode.Range(instStartLine - 1, 0, instEndLine - 1, 200)
            );
            const dotRe = /\.([A-Za-z_]\w*)\s*\(/g;
            let dm;
            while ((dm = dotRe.exec(text)) !== null) {
                usedNames.add(dm[1]);
            }
        }

        try {
            const targetDoc = await vscode.workspace.openTextDocument(def.uri);
            if (!native || !native.extractSymbols) return items;

            const result = native.extractSymbols(targetDoc.getText());
            const mod = result.symbols.find(s => s.name === moduleType);
            if (!mod || !mod.children) return items;

            const filterKind = completionType === 'instance_param' ? 'Parameter' : 'Port';
            const allSymbols = mod.children.filter(c => c.kind === filterKind);
            const symbols = allSymbols.filter(c => !usedNames.has(c.name));

            for (const sym of symbols) {
                const item = new vscode.CompletionItem(
                    sym.name,
                    completionType === 'instance_param'
                        ? vscode.CompletionItemKind.Constant
                        : vscode.CompletionItemKind.Field
                );
                item.detail = sym.detail || `${sym.kind} of ${moduleType}`;
                item.insertText = new vscode.SnippetString(
                    `${sym.name}($1)`
                );
                item.sortText = `0_${sym.name}`;
                items.push(item);
            }
        } catch (e) { /* ignore */ }

        return items;
    }

    // ── Hover ─────────────────────────────────────────────────────

    /**
     * Provide hover information for module instances and signals
     */
    async function provideHover(document, position) {
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
        if (!wordRange) return null;

        const word = document.getText(wordRange);
        const native = loadNativeModule();
        const lineText = document.lineAt(position.line).text;

        // 1. Check if hovering on an instance name → resolve its module type
        if (native && native.extractSymbols) {
            try {
                const result = native.extractSymbols(document.getText());
                for (const sym of result.symbols) {
                    if (!sym.children) continue;
                    for (const child of sym.children) {
                        if (child.name === word && child.kind === 'Instance') {
                            // child.detail holds the module type name from tree-sitter
                            const moduleType = child.detail;
                            if (moduleType) {
                                const hover = await buildModuleTypeHover(moduleType, native, wordRange);
                                if (hover) return hover;
                            }
                            // Fallback: basic instance info
                            const md = new vscode.MarkdownString();
                            md.appendCodeblock(`${moduleType || 'module'} ${child.name}`, 'systemverilog');
                            md.appendMarkdown(`*Instance* in \`${sym.name}\` (line ${child.startLine})`);
                            return new vscode.Hover(md, wordRange);
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }

        // 2. Check if hovering on a module type name in instantiation context
        const afterWord = lineText.substring(wordRange.end.character).trimStart();
        const looksLikeModuleType =
            afterWord.startsWith('#') ||
            afterWord.startsWith('(') ||
            /^[A-Za-z_]\w*\s*[#(]/.test(afterWord);

        if (looksLikeModuleType) {
            const hover = await buildModuleTypeHover(word, native, wordRange);
            if (hover) return hover;
        }

        // 3. Check current file symbols (ports, signals, params, module names)
        if (native && native.extractSymbols) {
            try {
                const result = native.extractSymbols(document.getText());
                for (const sym of result.symbols) {
                    if (sym.name === word) {
                        return buildSymbolHover(sym);
                    }
                    if (sym.children) {
                        for (const child of sym.children) {
                            if (child.name === word) {
                                const md = new vscode.MarkdownString();
                                md.appendCodeblock(child.detail || `${child.kind} ${child.name}`, 'systemverilog');
                                md.appendMarkdown(`*${child.kind}* in \`${sym.name}\` (line ${child.startLine})`);
                                return new vscode.Hover(md, wordRange);
                            }
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }

        return null;
    }

    /**
     * Extract module type name from an instantiation line.
     * e.g. "fifo_module u_fifo (" → "fifo_module"
     *      "fifo_module #(.W(8)) u_fifo (" → "fifo_module"
     */
    function extractModuleTypeFromLine(lineText, instanceName) {
        const trimmed = lineText.trim();
        // Pattern: <module_type> [#(...)] <instance_name> (
        const re = new RegExp(`([A-Za-z_]\\w*)\\s*(?:#\\s*\\([^)]*\\)\\s*)?${instanceName}\\s*\\(`);
        const m = trimmed.match(re);
        if (m && m[1] !== instanceName) {
            return m[1];
        }
        // Simpler: first word on the line if instance name is the second word
        const words = trimmed.split(/\s+/);
        if (words.length >= 2 && words[1] === instanceName) {
            return words[0];
        }
        return null;
    }

    /**
     * Build hover card for a module type: search workspace, parse, show ports/params
     */
    async function buildModuleTypeHover(moduleName, native, wordRange) {
        const def = await findModuleDefinition(moduleName);
        if (!def) return null;

        try {
            const targetDoc = await vscode.workspace.openTextDocument(def.uri);
            if (native && native.extractSymbols) {
                const result = native.extractSymbols(targetDoc.getText());
                const mod = result.symbols.find(s => s.name === moduleName);
                if (mod) {
                    return buildSymbolHover(mod, def.uri, wordRange);
                }
            }
            // Fallback: link only
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**module** \`${moduleName}\`\n\n`);
            md.appendMarkdown(`Defined in [${vscode.workspace.asRelativePath(def.uri)}:${def.line + 1}](${def.uri}#L${def.line + 1})`);
            return new vscode.Hover(md, wordRange);
        } catch (e) {
            return null;
        }
    }

    /**
     * Build a hover card for a symbol with its children summary
     */
    function buildSymbolHover(sym, uri, wordRange) {
        const md = new vscode.MarkdownString();
        md.appendCodeblock(`${sym.kind.toLowerCase()} ${sym.name}`, 'systemverilog');

        if (sym.children && sym.children.length > 0) {
            const params = sym.children.filter(c => c.kind === 'Parameter');
            const ports = sym.children.filter(c => c.kind === 'Port');
            const others = sym.children.filter(c => !['Parameter', 'Port'].includes(c.kind));

            if (params.length > 0) {
                md.appendMarkdown(`**Parameters** (${params.length})\n\n`);
                md.appendCodeblock(
                    params.map(p => p.detail || p.name).join('\n'),
                    'systemverilog'
                );
            }
            if (ports.length > 0) {
                md.appendMarkdown(`**Ports** (${ports.length})\n\n`);
                md.appendCodeblock(
                    ports.map(p => p.detail || p.name).join('\n'),
                    'systemverilog'
                );
            }
            if (others.length > 0) {
                md.appendMarkdown(`**Internal** (${others.length}): `);
                md.appendMarkdown(others.slice(0, 10).map(c => `\`${c.name}\``).join(', '));
                if (others.length > 10) md.appendMarkdown(` … +${others.length - 10} more`);
                md.appendMarkdown('\n\n');
            }
        }

        if (uri) {
            md.appendMarkdown(`Defined in [${vscode.workspace.asRelativePath(uri)}:${sym.startLine}](${uri}#L${sym.startLine})`);
        } else {
            md.appendMarkdown(`Line ${sym.startLine}–${sym.endLine}`);
        }

        return new vscode.Hover(md, wordRange);
    }
    return { provideDocumentSymbols, provideDefinition, provideCompletionItems, provideHover };
}

module.exports = { createLanguageProviders };
