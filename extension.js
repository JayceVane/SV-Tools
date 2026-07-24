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
 * This is a VSCode extension adapted from the Sublime Text SystemVerilog plugin
 * by Nicolas Belmonte (https://github.com/nicolas3d/SystemVerilog)
 * and Verilog-Gadget plugin by yongchan jeon (poucotm@gmail.com)
 */

const vscode = require('vscode');
const path = require('path');

// Load native module
let svtools = null;

function loadNativeModule() {
    if (svtools) return svtools;
    
    try {
        // Try to load the native module
        const modulePath = path.join(__dirname, 'svtools.win32-x64-msvc.node');
        svtools = require(modulePath);
        console.log('svtools native module loaded successfully');
        return svtools;
    } catch (err) {
        console.error('Failed to load svtools native module:', err);
        return null;
    }
}

/**
 * Format Verilog/SystemVerilog code using native module
 */
async function formatDocument(document, range = null) {
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return null;
    }

    const config = vscode.workspace.getConfiguration('svtools');

    // Get the document text
    const text = document.getText(range);

    // Get configuration options (camelCase for napi-rs auto-conversion)
    const options = {
        indentStyle: config.get('indentStyle', '1tbs'),
        useTab: config.get('useTab', false),
        nbSpace: config.get('tabSize', 4),
        maxConsecutiveEmptyLines: config.get('maxConsecutiveEmptyLines', 1),
        reindentOnly: false,
        ignoreTick: config.get('ignoreTick', true),
        oneDeclPerLine: config.get('oneDeclPerLine', false),
        oneBindPerLine: config.get('oneBindPerLine', true),
        alignComma: config.get('alignComma', true),
        paramOneLine: config.get('paramOneLine', true),
        importSameLine: config.get('importSameLine', false),
        instAlignPort: config.get('instAlignPort', true)
    };

    try {
        const formattedText = native.formatText(text, options);
        return formattedText;
    } catch (error) {
        vscode.window.showErrorMessage(`Formatting failed: ${error.message}`);
        console.error('Formatting error:', error);
        return null;
    }
}

/**
 * Generate module instantiation
 */
async function generateModuleInstance() {
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const document = editor.document;
    const text = document.getText();
    const config = vscode.workspace.getConfiguration('svtools');

    const options = {
        instPrefix: config.get('instPrefix', 'u_'),
        reset: config.get('reset', []),
        includeDeclarations: config.get('includePortDeclarations', true)
    };

    try {
        const result = native.generateModuleInst(text, options);
        if (result.success) {
            await vscode.env.clipboard.writeText(result.result);
            vscode.window.showInformationMessage(`Module instantiation copied to clipboard: ${result.module}`);
        } else {
            vscode.window.showErrorMessage(`Failed to generate module instance: ${result.error}`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Module instantiation failed: ${error.message}`);
    }
}

/**
 * Generate testbench
 */
async function generateTestbench() {
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const document = editor.document;
    const text = document.getText();
    const config = vscode.workspace.getConfiguration('svtools');

    const options = {
        instPrefix: config.get('instPrefix', 'u_'),
        reset: config.get('reset', []),
        sreset: config.get('sreset', []),
        clock: config.get('clock', ['clk']),
        waveType: config.get('waveType', 'fsdb'),
        taskInit: config.get('taskInit', true),
        taskDrive: config.get('taskDrive', true)
    };

    try {
        const result = native.generateTestbench(text, options);
        if (result.success) {
            // Create new untitled document with testbench code
            const doc = await vscode.workspace.openTextDocument({
                language: 'systemverilog',
                content: result.result
            });
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`Testbench generated for module: ${result.module}`);
        } else {
            vscode.window.showErrorMessage(`Failed to generate testbench: ${result.error}`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Testbench generation failed: ${error.message}`);
    }
}

/**
 * Repeat code with numbers
 */
async function repeatCodeWithNumbers() {
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const selection = editor.selection;
    const template = editor.document.getText(selection);

    // Ask user for range
    const rangeInput = await vscode.window.showInputBox({
        prompt: 'Enter range [from]~[to],[↓step],[→step]',
        placeHolder: '0~10',
        value: '0~10'
    });

    if (!rangeInput) {
        return;
    }

    try {
        // Parse range input
        const rangeMatch = rangeInput.match(/(-?\d+)\s*~\s*(-?\d+)/);
        if (!rangeMatch) {
            vscode.window.showErrorMessage('Invalid range format. Use: start~end[,row_step[,col_step]]');
            return;
        }

        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);

        const parts = rangeInput.split(',');
        const rowStep = parts.length > 1 ? parseInt(parts[1]) || 1 : 1;
        const colStep = parts.length > 2 ? parseInt(parts[2]) || 0 : 0;

        const options = {
            start,
            end,
            rowStep,
            colStep,
            clipboardLines: []
        };

        // Check if {cb} placeholder is used
        if (template.includes('{cb}')) {
            const clipboardText = await vscode.env.clipboard.readText();
            options.clipboardLines = clipboardText.split('\n').filter(l => l.trim());
        }

        const result = native.repeatCode(template, options);
        await editor.edit(editBuilder => {
            editBuilder.replace(selection, result);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Repeat code failed: ${error.message}`);
    }
}

/**
 * Align selected code
 */
async function alignSelectedCode() {
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const selection = editor.selection;
    const text = editor.document.getText(selection);
    const config = vscode.workspace.getConfiguration('svtools');

    try {
        const result = native.alignCode(text, config.get('tabSize', 4));
        await editor.edit(editBuilder => {
            editBuilder.replace(selection, result);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Align code failed: ${error.message}`);
    }
}

/**
 * Insert header template
 */
async function insertHeaderTemplate() {
    const native = loadNativeModule();
    if (!native) {
        vscode.window.showErrorMessage('svtools native module not loaded');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const config = vscode.workspace.getConfiguration('svtools');
    const headerTemplate = config.get('headerTemplate', getDefaultHeaderTemplate());
    const document = editor.document;

    const tabSize = vscode.workspace.getConfiguration('editor', {}).get('tabSize', 4);

    try {
        const result = native.generateHeader(headerTemplate, document.fileName, tabSize);
        // Insert at the beginning of the document
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), result);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Header insertion failed: ${error.message}`);
    }
}

/**
 * Get default header template
 */
function getDefaultHeaderTemplate() {
    return `// -----------------------------------------------------------------------------
// Module      : {FILE}
// Description : Module description
// Author      : Your Name
// Date        : {DATE} {TIME}
// -----------------------------------------------------------------------------
// Copyright (C) {YEAR} Your Company
// -----------------------------------------------------------------------------
// License     : Apache License 2.0
// -----------------------------------------------------------------------------
// History :
// {DATE} {TIME} : {FILE} - Created
// -----------------------------------------------------------------------------
// Notes :
// -----------------------------------------------------------------------------
`;
}

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

const SV_KEYWORDS = [
    'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg',
    'logic', 'always', 'always_comb', 'always_ff', 'always_latch',
    'assign', 'begin', 'end', 'if', 'else', 'case', 'endcase',
    'casex', 'casez', 'for', 'while', 'do', 'repeat', 'forever',
    'function', 'endfunction', 'task', 'endtask', 'parameter',
    'localparam', 'generate', 'endgenerate', 'genvar', 'interface',
    'endinterface', 'modport', 'package', 'endpackage', 'class',
    'endclass', 'typedef', 'enum', 'struct', 'union', 'packed',
    'return', 'posedge', 'negedge', 'edge', 'or', 'and', 'not',
    'integer', 'real', 'time', 'bit', 'byte', 'shortint', 'int',
    'longint', 'shortreal', 'string', 'void', 'initial', 'final',
    'default', 'signed', 'unsigned', 'automatic', 'static',
    'virtual', 'extends', 'implements', 'import', 'export',
    'pure', 'extern', 'fork', 'join', 'join_any', 'join_none',
    'disable', 'wait', 'event', 'assert', 'assume', 'cover',
    'property', 'endproperty', 'sequence', 'endsequence',
    'covergroup', 'endgroup', 'rand', 'randc', 'constraint',
    'new', 'super', 'this', 'null', 'unique', 'priority',
];

const SV_SNIPPETS = [
    // Always blocks
    { label: 'always', detail: 'always @(...)', body: 'always @(${1:*}) begin\n\t$0\nend' },
    { label: 'always_ff', detail: 'always_ff @(posedge clk)', body: 'always_ff @(posedge ${1:clk}) begin\n\t$0\nend' },
    { label: 'always_ff_rst', detail: 'always_ff with async reset', body: 'always_ff @(posedge ${1:clk} or negedge ${2:rst_n}) begin\n\tif (!$2) begin\n\t\t$0\n\tend else begin\n\t\t\n\tend\nend' },
    { label: 'always_comb', detail: 'always_comb', body: 'always_comb begin\n\t$0\nend' },
    { label: 'always_latch', detail: 'always_latch', body: 'always_latch begin\n\t$0\nend' },
    { label: 'always_star', detail: 'always @(*)', body: 'always @(*) begin\n\t$0\nend' },
    { label: 'always_posedge', detail: 'always @(posedge clk)', body: 'always @(posedge ${1:clk}) begin\n\t$0\nend' },
    // Module / interface
    { label: 'module', detail: 'module template', body: 'module ${1:name} (\n\tinput  ${2:clk},\n\tinput  ${3:rst_n},\n\toutput ${4:data}\n);\n\n\t$0\n\nendmodule' },
    { label: 'module_param', detail: 'module with parameters', body: 'module ${1:name} #(\n\tparameter ${2:W} = ${3:8}\n) (\n\tinput  ${4:clk},\n\tinput  ${5:rst_n},\n\toutput ${6:data}\n);\n\n\t$0\n\nendmodule' },
    { label: 'interface', detail: 'interface template', body: 'interface ${1:name};\n\tlogic ${2:valid};\n\tlogic ${3:ready};\n\n\tmodport master (output $2, input $3);\n\tmodport slave  (input  $2, output $3);\nendinterface' },
    // Control flow
    { label: 'if', detail: 'if statement', body: 'if (${1:cond}) begin\n\t$0\nend' },
    { label: 'ifelse', detail: 'if-else statement', body: 'if (${1:cond}) begin\n\t$0\nend else begin\n\t\nend' },
    { label: 'case', detail: 'case statement', body: 'case (${1:sel})\n\t${2:val}: $0\n\tdefault: ;\nendcase' },
    { label: 'casex', detail: 'casex statement', body: 'casex (${1:sel})\n\t${2:val}: $0\n\tdefault: ;\nendcase' },
    { label: 'for', detail: 'for loop', body: 'for (int ${1:i} = 0; $1 < ${2:N}; $1++) begin\n\t$0\nend' },
    { label: 'generate_for', detail: 'generate for loop', body: 'genvar ${1:i};\ngenerate\n\tfor ($1 = 0; $1 < ${2:N}; $1 = $1 + 1) begin : ${3:gen_label}\n\t\t$0\n\tend\nendgenerate' },
    { label: 'beginend', detail: 'begin ... end block', body: 'begin\n\t$0\nend' },
    { label: 'initial', detail: 'initial block', body: 'initial begin\n\t$0\nend' },
    { label: 'initial_forever', detail: 'initial forever (clock gen)', body: 'initial begin\n\t${1:clk} = 1\'b0;\n\tforever #${2:5} $1 = ~$1;\nend' },
    // Declarations
    { label: 'assign', detail: 'assign statement', body: 'assign ${1:out} = ${2:in};' },
    { label: 'wire', detail: 'wire declaration', body: 'wire ${1:[${2:W}-1:0] }${3:name};' },
    { label: 'reg', detail: 'reg declaration', body: 'reg ${1:[${2:W}-1:0] }${3:name};' },
    { label: 'logic', detail: 'logic declaration', body: 'logic ${1:[${2:W}-1:0] }${3:name};' },
    { label: 'parameter', detail: 'parameter declaration', body: 'parameter ${1:NAME} = ${2:value};' },
    { label: 'localparam', detail: 'localparam declaration', body: 'localparam ${1:NAME} = ${2:value};' },
    { label: 'typedef_enum', detail: 'typedef enum', body: 'typedef enum logic [${1:1}:0] {\n\t${2:IDLE},\n\t${3:RUN},\n\t${4:DONE}\n} ${5:state_t};' },
    { label: 'typedef_struct', detail: 'typedef struct packed', body: 'typedef struct packed {\n\tlogic [${1:7}:0] ${2:data};\n\tlogic           ${3:valid};\n} ${4:packet_t};' },
    // Task / function
    { label: 'function', detail: 'function template', body: 'function automatic ${1:logic} ${2:name}(${3:input logic a});\n\t$0\nendfunction' },
    { label: 'task', detail: 'task template', body: 'task automatic ${1:name}(${2:input logic a});\n\t$0\nendtask' },
    // Testbench
    { label: 'testbench', detail: 'testbench template', body: '`timescale 1ns / 1ps\n\nmodule ${1:tb}_${2:top};\n\n\treg clk;\n\treg rst_n;\n\n\t// Clock generation\n\tinitial begin\n\t\tclk = 1\'b0;\n\t\tforever #5 clk = ~clk;\n\tend\n\n\t// Reset & stimulus\n\tinitial begin\n\t\trst_n = 1\'b0;\n\t\t#100;\n\t\trst_n = 1\'b1;\n\t\t$0\n\t\t#1000;\n\t\t$$finish;\n\tend\n\n\t// DUT\n\t$2 u_dut (\n\t\t.clk   (clk),\n\t\t.rst_n (rst_n)\n\t);\n\nendmodule' },
    { label: 'timescale', detail: '`timescale directive', body: '`timescale ${1:1ns} / ${2:1ps}' },
    { label: 'include', detail: '`include directive', body: '`include "${1:file.svh}"' },
    { label: 'define', detail: '`define directive', body: '`define ${1:NAME} ${2:value}' },
    // Misc
    { label: 'fsm', detail: 'FSM 3-process template', body: '// State definition\ntypedef enum logic [1:0] {\n\tIDLE,\n\tRUN,\n\tDONE\n} state_t;\n\nstate_t state, next_state;\n\n// State register\nalways_ff @(posedge ${1:clk} or negedge ${2:rst_n}) begin\n\tif (!$2)\n\t\tstate <= IDLE;\n\telse\n\t\tstate <= next_state;\nend\n\n// Next state logic\nalways_comb begin\n\tnext_state = state;\n\tcase (state)\n\t\tIDLE: $0\n\t\tRUN:  \n\t\tDONE: \n\t\tdefault: next_state = IDLE;\n\tendcase\nend\n\n// Output logic\nalways_comb begin\n\tcase (state)\n\t\tIDLE: ;\n\t\tRUN:  ;\n\t\tDONE: ;\n\t\tdefault: ;\n\tendcase\nend' },
];

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

/**
 * Activate the extension
 */
function activate(context) {
    console.log('SystemVerilog extension is now active!');

    // Preload native module
    loadNativeModule();

    // Register document formatting edit provider for both verilog and systemverilog
    const languages = ['verilog', 'systemverilog'];

    const provider = {
        async provideDocumentFormattingEdits(document) {
            const fullRange = new vscode.Range(
                document.lineAt(0).range.start,
                document.lineAt(document.lineCount - 1).range.end
            );

            const formattedText = await formatDocument(document, fullRange);

            if (formattedText !== null) {
                return [vscode.TextEdit.replace(fullRange, formattedText)];
            }
            return [];
        },

        async provideDocumentRangeFormattingEdits(document, range) {
            const formattedText = await formatDocument(document, range);

            if (formattedText !== null) {
                return [vscode.TextEdit.replace(range, formattedText)];
            }
            return [];
        }
    };

    // Register formatter for each language
    languages.forEach(lang => {
        context.subscriptions.push(
            vscode.languages.registerDocumentFormattingEditProvider(lang, provider)
        );
        context.subscriptions.push(
            vscode.languages.registerDocumentRangeFormattingEditProvider(lang, provider)
        );
        context.subscriptions.push(
            vscode.languages.registerDocumentSymbolProvider(lang, { provideDocumentSymbols })
        );
        context.subscriptions.push(
            vscode.languages.registerDefinitionProvider(lang, { provideDefinition })
        );
        context.subscriptions.push(
            vscode.languages.registerCompletionItemProvider(lang, { provideCompletionItems }, '.', ' ')
        );
        context.subscriptions.push(
            vscode.languages.registerHoverProvider(lang, { provideHover })
        );
    });

    // Register formatter command
    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.formatDocument', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                vscode.commands.executeCommand('editor.action.formatDocument');
            }
        })
    );

    // Register Verilog-Gadget commands
    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.moduleInstantiation', generateModuleInstance)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.generateTestbench', generateTestbench)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.repeatCode', repeatCodeWithNumbers)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.alignCode', alignSelectedCode)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('svtools.insertHeader', insertHeaderTemplate)
    );
}

/**
 * Deactivate the extension
 */
function deactivate() {
    // Native module doesn't need cleanup
    svtools = null;
}

module.exports = {
    activate,
    deactivate
};
