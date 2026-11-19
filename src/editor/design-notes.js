'use strict';

const { randomBytes } = require('node:crypto');
const { tokenize } = require('./completion/syntax');

const COMMAND = 'svtools.note.open';
const NOTE_DIRECTORY = 'docs/design-notes';
const NOTE_KEY = '[a-z0-9][a-z0-9_-]{0,79}';
const MARKER = /^\/\/([<:])[ \t]+(\S.*)$/u;
const NOTE_ID = new RegExp('[ \\t]+\\[note:(' + NOTE_KEY + ')\\]$', 'u');

// The VS Code command opener decodes the query after parsing the URI.
function documentKey(document) {
    return Buffer.from(document.uri.toString()).toString('base64url');
}

function readAnchors(text, tokens) {
    const markers = new Map();
    const docs = [];
    const openRegions = [];
    if (!/\/\/[<:]\s|\/\*\*/u.test(text)) return { markers, docs };

    let line = 0, lineStart = 0, newline = text.indexOf('\n');
    for (const part of tokens ?? tokenize(text)) {
        if (part.kind !== 'comment') continue;
        if (part.value.startsWith('/**') && part.closed) {
            const body = part.value.slice(3, -2).replace(/\r\n/g, '\n').replace(/^[ \t]*\*(?:[ \t]|$)/gm, '').trim();
            if (body) docs.push({ start: part.start, end: part.end, body });
            continue;
        }
        while (newline >= 0 && newline < part.start) {
            line++;
            lineStart = newline + 1;
            newline = text.indexOf('\n', lineStart);
        }
        if (text.slice(lineStart, part.start).trim()) continue;
        const comment = part.value.trimEnd();
        if (comment === '//>') {
            const region = openRegions.pop();
            if (region) markers.set(region.line, region);
            continue;
        }
        const match = MARKER.exec(comment);
        if (!match) continue;
        const id = NOTE_ID.exec(match[2]);
        const marker = {
            line,
            offset: part.start,
            start: part.start - lineStart,
            end: part.start - lineStart + comment.length,
            title: id ? match[2].slice(0, id.index).trimEnd() : match[2],
            id: id?.[1]
        };
        if (match[1] === '<') openRegions.push(marker);
        else markers.set(line, marker);
    }
    return { markers, docs };
}

function createDesignNotes(vscode) {
    const { workspace, window, Uri, Range, Position, MarkdownString, Hover, WorkspaceEdit } = vscode;
    const chinese = /^zh\b/i.test(vscode.env.language);
    const label = (en, zh) => chinese ? zh : en;
    const cache = new WeakMap();
    const busy = new WeakSet();

    function anchors(document) {
        const cached = cache.get(document);
        if (cached?.version === document.version) return cached;
        const result = { version: document.version, ...readAnchors(document.getText()) };
        cache.set(document, result);
        return result;
    }

    function noteUri(folder, id) {
        return Uri.joinPath(folder.uri, NOTE_DIRECTORY, id + '.svnote.md');
    }

    async function readNote(uri) {
        const key = uri.toString();
        const openDocument = workspace.textDocuments.find(document => document.uri.toString() === key);
        if (openDocument) return openDocument.getText();
        try {
            return Buffer.from(await workspace.fs.readFile(uri)).toString('utf8');
        } catch (error) {
            if (error.code !== 'FileNotFound') throw error;
            return undefined;
        }
    }

    async function provideHover(document, position, token) {
        const { markers, docs } = anchors(document);
        const marker = markers.get(position.line);
        if (!marker || position.character < marker.start || position.character > marker.end) {
            if (!docs.length) return undefined;
            const offset = document.offsetAt(position);
            const doc = docs.find(entry => entry.start <= offset && offset < entry.end);
            if (!doc) return undefined;
            const markdown = new MarkdownString(doc.body);
            markdown.baseUri = document.uri;
            return new Hover(markdown, new Range(document.positionAt(doc.start), document.positionAt(doc.end)));
        }

        const folder = workspace.getWorkspaceFolder(document.uri);
        const contents = [];
        let body;
        if (folder && marker.id) {
            const uri = noteUri(folder, marker.id);
            try {
                body = await readNote(uri);
                if (body?.trim()) {
                    const markdown = new MarkdownString(body);
                    markdown.baseUri = uri;
                    contents.push(markdown);
                }
            } catch (error) {
                const markdown = new MarkdownString();
                markdown.appendText(label('Cannot read design note: ', '无法读取设计笔记：') + error.message);
                contents.push(markdown);
            }
        }
        if (token.isCancellationRequested) return undefined;
        if (!contents.length) {
            const header = new MarkdownString();
            header.appendText(marker.title);
            contents.push(header);
        }
        if (folder) {
            const action = new MarkdownString();
            const args = encodeURIComponent(JSON.stringify([{
                documentKey: documentKey(document), version: document.version, line: marker.line
            }]));
            const title = body === undefined ? label('Open or create note', '打开或创建笔记') : label('Open note', '打开笔记');
            action.appendMarkdown('[' + title + '](command:' + COMMAND + '?' + args + ')');
            action.isTrusted = { enabledCommands: [COMMAND] };
            contents.push(action);
        }
        return new Hover(contents, new Range(marker.line, marker.start, marker.line, marker.end));
    }

    async function open(target) {
        const editor = window.activeTextEditor;
        if (!editor || !['verilog', 'systemverilog'].includes(editor.document.languageId)) return;
        const { document } = editor;
        let line = editor.selection.active.line;
        if (target instanceof Uri) {
            if (target.toString() !== document.uri.toString()) return;
        } else if (target) {
            if (target.documentKey !== documentKey(document) || target.version !== document.version) {
                window.showInformationMessage(label('The source changed. Open the design note from the current marker.',
                    '源码位置已更新，请从当前标记重新打开笔记。'));
                return;
            }
            line = target.line;
        }
        if (busy.has(document)) return;

        const marker = anchors(document).markers.get(line);
        if (!marker) {
            window.showInformationMessage(label(
                'Place the cursor on a //< Title or //: Title marker. Close regions with //>.',
                '请将光标放在 //< 标题 或 //: 标题 行。折叠区域用 //> 结束。'
            ));
            return;
        }
        const folder = workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            window.showInformationMessage(label('Open the HDL project folder to store its notes.', '请打开 HDL 工程文件夹以保存笔记。'));
            return;
        }

        busy.add(document);
        try {
            const version = document.version;
            const id = marker.id ?? 'nt_' + randomBytes(5).toString('hex');
            const uri = noteUri(folder, id);
            if (!marker.id || await readNote(uri) === undefined) {
                await workspace.fs.createDirectory(Uri.joinPath(folder.uri, NOTE_DIRECTORY));
                if (document.version !== version || document.isClosed) {
                    window.showInformationMessage(label('The source changed. Invoke the note command again.', '源码已修改，请重新执行笔记命令。'));
                    return;
                }
                const edit = new WorkspaceEdit();
                const title = marker.title.replace(/[\\*_[\]<>#]/g, '\\$&');
                edit.createFile(uri, { contents: Buffer.from('# ' + title + '\n') });
                if (!marker.id) edit.insert(document.uri, new Position(marker.line, marker.end), ' [note:' + id + ']');
                if (!await workspace.applyEdit(edit)) {
                    throw new Error(label('Could not create the note or update its marker.', '无法创建笔记或更新源码标记。'));
                }
            }
            await window.showTextDocument(await workspace.openTextDocument(uri), { viewColumn: vscode.ViewColumn.Beside });
        } catch (error) {
            window.showErrorMessage('SV Tools: ' + error.message);
        } finally {
            busy.delete(document);
        }
    }

    return { provideHover, open, markerAt: (document, line) => anchors(document).markers.get(line) };
}

module.exports = { createDesignNotes, readAnchors, NOTE_DIRECTORY, NOTE_KEY };
