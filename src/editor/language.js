'use strict';

const { createCompletionProvider } = require('./completion/provider');

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

    // 补全由独立语义索引和规范目录驱动，不依赖原生模块可用性。
    const completion = createCompletionProvider({ vscode });
    const { provideCompletionItems } = completion;

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
    return { provideDocumentSymbols, provideDefinition, provideCompletionItems, provideHover, dispose: completion.dispose };
}

module.exports = { createLanguageProviders };
