'use strict';

const { findDesignNote } = require('./review-pin');
const { inventory } = require('./note-service');
const { exportNotes } = require('./note-export');

function activateNoteExport(context, vscode) {
    context.subscriptions.push(vscode.commands.registerCommand('svtools.note.export', async target => {
        const current = findDesignNote(vscode, target);
        let root = current?.root;
        if (!root) {
            const folders = vscode.workspace.workspaceFolders || [];
            root = (folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick())?.uri.fsPath;
            if (!root) return;
        }
        const { window, workspace, Uri } = vscode;
        try {
            const notes = await inventory(root);
            const choices = [];
            if (current) choices.push({ label: '当前笔记', note: current.id });
            for (const topic of [...new Set(notes.map(note => note.topic).filter(Boolean))]) choices.push({ label: '主题 · ' + topic, topic });
            choices.push({ label: '全部设计笔记' });
            const scope = await window.showQuickPick(choices, { title: '选择笔记导出范围' });
            if (!scope) return;
            const formats = [{ label: 'HTML', id: 'html' }, { label: 'Markdown', id: 'md' }, { label: 'PDF', id: 'pdf' }];
            const file = await window.showQuickPick(formats, { title: '选择导出格式' });
            if (!file) return;
            const mode = await window.showQuickPick(['固定笔记版本', '草稿'], { title: '导出类型' });
            if (!mode) return;
            const out = await window.showInputBox({ title: '工程内的输出目录', value: 'docs/note-export-' + Date.now() });
            if (!out) return;
            const candidates = notes.filter(note => (!scope.note || scope.note === note.id) && (!scope.topic || scope.topic === note.topic));
            const paths = new Set(candidates.map(note => Uri.joinPath(Uri.file(root), note.path).toString()));
            if (workspace.textDocuments.some(doc => doc.isDirty && paths.has(doc.uri.toString()))) throw new Error('请先保存选中的笔记。');
            const result = await window.withProgress({ location: vscode.ProgressLocation.Notification, title: '导出设计笔记' },
                () => exportNotes(root, { ...scope, imageFormat: file.id, final: mode === '固定笔记版本', out }));
            const action = await window.showInformationMessage('已导出设计笔记 · ' + result.manifest, '打开清单');
            if (action) await window.showTextDocument(await workspace.openTextDocument(Uri.joinPath(Uri.file(root), result.manifest)));
        } catch (error) { window.showErrorMessage('SV Tools · ' + error.message); }
    }));
}

module.exports = { activateNoteExport };
