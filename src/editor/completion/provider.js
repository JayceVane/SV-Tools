'use strict';

const { createCompletionIndex } = require('./index');
const { complete } = require('./engine');
const { contextAt } = require('./syntax');

const KINDS = { keyword: 'Keyword', snippet: 'Snippet', module: 'Module', interface: 'Interface', package: 'Module', class: 'Class',
    typedef: 'TypeParameter', enum: 'Enum', enumMember: 'EnumMember', struct: 'Struct', port: 'Field', parameter: 'Constant', localparam: 'Constant',
    variable: 'Variable', net: 'Variable', instance: 'Reference', function: 'Method', task: 'Method', macro: 'Function', property: 'Property', sequence: 'Function',
    covergroup: 'Class', modport: 'Interface', file: 'File', constant: 'Constant' };

/** 编辑器适配只负责配置、取消、SnippetString 与准确的双替换区间。 */
function createCompletionProvider({ vscode, onError = console.warn, sourceCatalog }) {
    const index = createCompletionIndex({ vscode, onError, sourceCatalog });
    async function provideCompletionItems(document, position, token) {
        if (token?.isCancellationRequested) return undefined;
        const current = index.update(document);
        const cursorContext = contextAt(current.model, document.offsetAt(position));
        if (['comment', 'string'].includes(cursorContext.kind)) return new vscode.CompletionList([], false);
        const snapshot = await index.snapshot(document, token);
        if (token?.isCancellationRequested) return undefined;
        const config = vscode.workspace.getConfiguration('svtools.completion', document.uri);
        const options = { language: document.languageId, uvm: config.get('uvmVersion', '1.2'), standard: config.get('standard', 'auto'), maxItems: config.get('maxItems', 1000) };
        if (snapshot.current.model === current.model) options.context = cursorContext;
        const result = complete(snapshot, document.offsetAt(position), options);
        const range = { inserting: new vscode.Range(document.positionAt(result.context.start), position),
            replacing: new vscode.Range(document.positionAt(result.context.start), document.positionAt(result.context.end)) };
        const items = result.items.map(entry => {
            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind[KINDS[entry.kind] || 'Variable']);
            item.range = range;
            item.detail = entry.signature || entry.detail || entry.standard;
            item.sortText = `${entry.priority ?? 1}_${entry.name}`;
            item.insertText = entry.body ? new vscode.SnippetString(entry.body) : entry.name + (entry.name.startsWith('\\') ? ' ' : '');
            if (entry.category || entry.standard || entry.sourceUri) item.documentation = [entry.standard, entry.category, entry.sourceUri].filter(Boolean).join('\n');
            return item;
        });
        return new vscode.CompletionList(items, result.incomplete);
    }
    return { provideCompletionItems, dispose: index.dispose, index };
}

module.exports = { createCompletionProvider };
