'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.equal(path.basename(folder?.uri.fsPath ?? ''), 'workspace', 'Use an isolated test workspace');
    await vscode.extensions.getExtension('JayceVane.svtools').activate();
    const fixtures = [];
    const uri = name => vscode.Uri.joinPath(folder.uri, name);
    const write = (name, content) => vscode.workspace.fs.writeFile(uri(name), Buffer.from(content));
    const open = async name => vscode.window.showTextDocument(uri(name));
    function line(document, text) {
        const offset = document.getText().indexOf(text);
        assert.ok(offset >= 0, text);
        return document.positionAt(offset);
    }
    async function hover(document, text) {
        const entries = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, line(document, text));
        return entries.flatMap(entry => entry.contents);
    }
    async function choose(editor, text, fromContextMenu = false) {
        const position = line(editor.document, text);
        editor.selection = new vscode.Selection(position, position);
        const args = fromContextMenu ? [editor.document.uri] : [];
        await vscode.commands.executeCommand('svtools.note.open', ...args);
    }

    await write('notes.sv', [
        'module notes;',
        '    //< 区域标题',
        '    wire one;',
        '    //< 内层',
        '    wire two;',
        '    //>',
        '    //>',
        '    /** 验证 **文档注释**',
        '     *',
        '     * 第二段',
        '     */',
        '    //: 观察点',
        '    wire evidence;',
        '    /*',
        '    //: 块注释里的伪标记',
        '    */',
        '    wire trailing; //< 行尾伪标记',
        '    //< 未配对',
        '    wire tail;',
        'endmodule',
    ].join('\r\n'));
    let editor = await open('notes.sv');
    let document = editor.document;
    const docPreview = await hover(document, '第二段');
    assert.ok(docPreview.some(markdown => markdown.value.includes('**文档注释**\n\n第二段')));
    for (const text of ['块注释里的伪标记', '行尾伪标记', '未配对']) {
        assert.ok(!(await hover(document, text)).some(markdown => markdown.value.includes('command:svtools.note.open')));
    }
    for (const text of ['区域标题', '内层', '观察点']) {
        assert.ok((await hover(document, text)).some(markdown => markdown.value.includes('command:svtools.note.open')));
    }
    fixtures.push('nested markers, CRLF, doc-comment preview and stray markers');

    await choose(editor, '区域标题');
    const match = document.getText().match(/\[note:(nt_[a-f0-9]{10})\]/);
    assert.ok(match, 'creating through the command should attach a short ID');
    const note = uri('docs/design-notes/' + match[1] + '.svnote.md');
    const noteEditor = vscode.window.activeTextEditor;
    assert.equal(noteEditor.document.uri.toString(), note.toString());
    assert.match(noteEditor.document.getText(), /# 区域标题/);
    assert.ok(await noteEditor.edit(edit => edit.insert(new vscode.Position(1, 0),
        '\n**设计依据**\n\n[可执行链接](command:svtools.note.open)\n')));
    const preview = await hover(document, '区域标题');
    const markdown = preview.find(item => item.value.includes('**设计依据**'));
    assert.ok(markdown, 'hover should read the unsaved Markdown editor buffer');
    assert.equal(markdown.isTrusted, undefined);
    assert.equal(markdown.baseUri.toString(), note.toString());
    assert.ok(preview.some(item => item.isTrusted?.enabledCommands?.includes('svtools.note.open')));
    assert.ok(await noteEditor.document.save());
    fixtures.push('create note, dirty-buffer Markdown preview and command isolation');

    const noteHistory = require('../src/design/note-history-store');
    const readHistory = () => noteHistory.listRevisions(folder.uri.fsPath, match[1]);
    let archive = await readHistory();
    for (let attempt = 0; archive.revisions.length < 2 && attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        archive = await readHistory();
    }
    assert.equal(archive.revisions.length, 2, 'creating and saving a note should record two versions');
    assert.match((await noteHistory.readRevision(folder.uri.fsPath, match[1], archive.revisions[0].version)).content, /\*\*设计依据\*\*/);
    assert.equal((await noteHistory.readRevision(folder.uri.fsPath, match[1], archive.revisions[1].version)).content, '# 区域标题\n');
    fixtures.push('creation and save create separate immutable history versions');

    editor = await open('notes.sv');
    document = editor.document;
    const title = line(document, '区域标题');
    assert.ok(await editor.edit(edit => edit.replace(new vscode.Range(title, title.translate(0, '区域标题'.length)), '改名后的标题')));
    assert.ok((await hover(document, '改名后的标题')).some(item => item.value.includes('**设计依据**')));
    await write('related.v', 'module related;\n    //: Verilog verification [note:' + match[1] + ']\n    wire checked;\nendmodule\n');
    editor = await open('related.v');
    assert.equal(editor.document.languageId, 'verilog');
    assert.ok((await hover(editor.document, 'Verilog verification')).some(item => item.value.includes('**设计依据**')));
    await choose(editor, 'Verilog verification', true);
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), note.toString());
    assert.equal((await vscode.workspace.fs.readDirectory(uri('docs/design-notes'))).length, 1);
    fixtures.push('rename a title, share one note across SystemVerilog and Verilog, open without overwriting');

    const legacyId = 'nt_12345678-1234-4321-8123-123456789abc';
    const legacyFile = 'docs/design-notes/' + legacyId + '.svnote.md';
    await write(legacyFile, '# Legacy note\n\nThe UUID still resolves.\n');
    await write('legacy.sv', 'module legacy;\n    //: Legacy binding [note:' + legacyId + ']\n    wire old;\nendmodule\n');
    editor = await open('legacy.sv');
    assert.ok((await hover(editor.document, 'Legacy binding')).some(item => item.value.includes('The UUID still resolves.')));
    await choose(editor, 'Legacy binding', true);
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri(legacyFile).toString());
    assert.equal((await vscode.workspace.fs.readDirectory(uri('docs/design-notes'))).length, 2);
    fixtures.push('existing UUID notes still preview and open');

    const reportedSource = process.env.SVTOOLS_NOTE_HOVER_SOURCE;
    const hoverFile = '笔记 (100%20) #sample.sv';
    const hoverTitle = 'Click through the hover link';
    await write(hoverFile, reportedSource ? (await fs.readFile(reportedSource, 'utf8')).replace(/^([ \t]*\/\/<[ \t]+)\S[^\r\n]*/m, '$1' + hoverTitle)
        : 'module hover_sample;\n    //< ' + hoverTitle + '\n    wire signal;\n    //>\nendmodule\n');
    editor = await open(hoverFile);
    document = editor.document;
    const hoverAction = (await hover(document, hoverTitle)).find(item => item.isTrusted?.enabledCommands?.includes('svtools.note.open'));
    assert.ok(hoverAction);
    const commandUri = vscode.Uri.parse(/\]\((command:[^)]+)\)/.exec(hoverAction.value)[1]);
    assert.equal(commandUri.path, 'svtools.note.open');
    // VS Code parses the URI, then the command opener decodes the query before parsing its arguments.
    let commandArgs;
    try {
        commandArgs = JSON.parse(decodeURIComponent(commandUri.query));
    } catch {
        commandArgs = JSON.parse(commandUri.query);
    }
    await vscode.commands.executeCommand(commandUri.path, ...commandArgs);
    assert.match(document.lineAt(line(document, hoverTitle).line).text, /\[note:nt_[a-f0-9]{10}\]/,
        'the decoded hover link should attach a short ID to the hovered line');
    assert.match(vscode.window.activeTextEditor.document.getText(), new RegExp('^# ' + hoverTitle));
    fixtures.push('decoded hover command creates a note for a path with spaces and percent escapes');

    await write('fold.sv', 'module fold_probe;\n    //< Flat region\n    wire a;\n    wire b;\n    //>\n    always @(*) begin\n        if (a) begin\n            $display("a");\n        end\n    end\nendmodule\n');
    editor = await open('fold.sv');
    const flatStart = line(editor.document, '//< Flat region');
    const flatEnd = line(editor.document, '//>');
    const plainStart = line(editor.document, 'always @(*) begin');
    const folding = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', editor.document.uri);
    assert.ok(folding.some(range => range.start === flatStart.line && range.end === flatEnd.line), JSON.stringify(folding));
    assert.ok(folding.some(range => range.start === plainStart.line), 'ordinary indentation folding should remain available');
    fixtures.push('VS Code marker folding and ordinary indentation folding');

    const otherProvider = vscode.languages.registerFoldingRangeProvider('systemverilog', {
        provideFoldingRanges: () => [new vscode.FoldingRange(plainStart.line, 9)]
    });
    try {
        const ranges = () => vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', editor.document.uri);
        assert.ok(!(await ranges()).some(range => range.start === flatStart.line));
        await vscode.workspace.getConfiguration('editor', editor.document).update('foldingStrategy', 'indentation',
            vscode.ConfigurationTarget.Workspace);
        assert.ok((await ranges()).some(range => range.start === flatStart.line && range.end === flatEnd.line));
        fixtures.push('syntax provider precedence and the indentation fallback');
    } finally {
        otherProvider.dispose();
    }

    const realProject = process.env.SVTOOLS_DESIGN_NOTE_FIXTURES;
    if (realProject) {
        const cases = [
            {
                rtl: 'src/conv/linebuf_3x3.sv',
                test: 'sim/conv/indep/tb_indep_conv3x3.sv',
                start: '    reg [1:0] r_sel_row1;',
                after: '    sdp_ram #(',
                check: "                    if (int'(o_data) !== expv) begin",
                title: '行缓存读口与 bank 选择对齐',
                explanation: '读数据在下一拍到达。bank 选择也打一拍，换行时才能选到产生该拍读数据的 RAM。独立卷积参考模型在输出有效时逐像素比较。'
            },
            {
                rtl: 'src/axi/i2c/i2c_byte_engine.sv',
                test: 'sim/axi/tb_axi_iic.sv',
                start: '    localparam [2:0] SCL_SYNC_DLY',
                after: '    // ---------------- 段 3：',
                check: '        check_bit("TC-I2C-07 stretch happened"',
                title: '释放 SCL 后判定从机拉伸',
                explanation: '先等 SCL 输入同步链稳定，若主机释放后线仍为低才请求冻结节拍。用例检查从机实际拉低 SCL、事务延长且正常结束。精确的冻结边界还需要观察节拍信号。'
            }
        ];
        for (const [index, item] of cases.entries()) {
            const id = 'project-sample-' + index;
            const rtl = (await fs.readFile(path.join(realProject, item.rtl), 'utf8')).replace(/\r\n/g, '\n');
            const tb = (await fs.readFile(path.join(realProject, item.test), 'utf8')).replace(/\r\n/g, '\n');
            assert.ok(rtl.includes(item.start) && rtl.includes(item.after) && tb.includes(item.check));
            const name = path.basename(item.rtl);
            const testName = path.basename(item.test);
            await write(name, rtl.replace(item.start, '    //< ' + item.title + ' [note:' + id + ']\n' + item.start)
                .replace(item.after, '    //>\n' + item.after));
            const checkLine = tb.slice(0, tb.indexOf(item.check)).split('\n').length + 1;
            const indent = item.check.match(/^ +/)[0];
            await write(testName, tb.replace(item.check, indent + '//: 核对用例 [note:' + id + ']\n' + item.check));
            await write('docs/design-notes/' + id + '.svnote.md',
                '# ' + item.title + '\n\n' + item.explanation + '\n\n[核对用例](../../' + testName + '#L' + checkLine + ')\n');
            const source = (await open(name)).document;
            const start = line(source, item.title);
            const end = line(source, '//>');
            const ranges = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', source.uri);
            assert.ok(ranges.some(range => range.start === start.line && range.end === end.line), name);
            const sourcePreview = await hover(source, item.title);
            assert.ok(sourcePreview.some(item => item.value.includes('../../' + testName + '#L' + checkLine)));
            const testPreview = await hover((await open(testName)).document, '核对用例 [note:');
            assert.ok(testPreview.some(preview => preview.value.includes(item.explanation)));
            fixtures.push(item.rtl + ' and ' + item.test + ' share a note');
        }
    }

    await write('../host-report.json', JSON.stringify({ passed: true, checks: fixtures }, null, 2));
}

module.exports = { run };
