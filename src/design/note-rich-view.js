'use strict';

const { randomBytes } = require('node:crypto');

function activateRichNotes(context, vscode) {
    const type = 'svtools.note.rich';
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(type, {
        resolveCustomTextEditor(document, panel) {
            const { webview } = panel;
            const design = vscode.Uri.joinPath(context.extensionUri, 'src', 'design');
            const vendor = vscode.Uri.joinPath(context.extensionUri, 'bin', 'vendor');
            const resource = (root, file) => webview.asWebviewUri(vscode.Uri.joinPath(root, file));
            const nonce = randomBytes(24).toString('hex');
            webview.options = { enableScripts: true, localResourceRoots: [design, vendor] };
            webview.html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}">
            <link rel="stylesheet" href="${resource(design, 'note-rich.css')}"><title>设计笔记</title>
            <header><button id="mode" type="button">Markdown 源码</button><button id="save" type="button">保存</button>
            <button id="reload" type="button" hidden>读取文件</button></header>
            <div id="tools" role="toolbar" aria-label="格式">
            <button data-action="heading">标题</button><button data-action="bold">粗体</button><button data-action="italic">斜体</button>
            <button data-action="list">列表</button><button data-action="quote">引用</button><button data-action="code">代码块</button>
            <button data-action="table">表格</button><input id="url" aria-label="链接地址" placeholder="https://…"><button id="link">插入链接</button></div>
            <p id="status" role="status"></p><div id="editor"></div><textarea id="source" aria-label="Markdown 源码" spellcheck="false" hidden></textarea>
            <script nonce="${nonce}" src="${resource(vendor, 'note-editor.js')}"></script></html>`;
            const send = (conflict = false) => webview.postMessage({ type: 'state', content: document.getText(), version: document.version, conflict });
            let queue = Promise.resolve();
            const changes = vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document === document) void send();
            });
            const messages = webview.onDidReceiveMessage(message => {
                queue = queue.catch(() => {}).then(async () => {
                    if (message?.type === 'ready') return send();
                    if (message?.type === 'save') { if (document.isDirty) await document.save(); return; }
                    if (message?.type !== 'edit' || typeof message.content !== 'string' || Buffer.byteLength(message.content) > 1024 * 1024
                        || message.version !== document.version) return send(true);
                    const text = document.getText();
                    if (text === message.content) return send();
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), message.content);
                    if (!await vscode.workspace.applyEdit(edit)) return send(true);
                    await send();
                }).catch(error => vscode.window.showErrorMessage('SV Tools · ' + error.message));
            });
            panel.onDidDispose(() => { messages.dispose(); changes.dispose(); });
        }
    }, { webviewOptions: { retainContextWhenHidden: true } }), vscode.commands.registerCommand('svtools.note.editRich', target => {
        const uri = target instanceof vscode.Uri ? target : vscode.window.activeTextEditor?.document.uri;
        if (uri?.path.endsWith('.svnote.md')) return vscode.commands.executeCommand('vscode.openWith', uri, type);
    }));
}

module.exports = { activateRichNotes };
