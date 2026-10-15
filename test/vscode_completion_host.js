'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');
const MARKER = '/*?*/';
const labelOf = item => typeof item.label === 'string' ? item.label : item.label.label;
const rangeOf = item => item.range?.replacing || item.range;
const isSvtoolsItem = item => /^[0-3]_/.test(item.sortText || '');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** 通过真实 VS Code 命令、编辑事件和 SnippetString 验收补全，所有写入限于独立夹具。 */
async function run() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root && path.basename(root) === 'workspace', '必须使用独立的验收工作区');
    const extension = vscode.extensions.getExtension('JayceVane.svtools'); assert.ok(extension);
    await extension.activate();
    const checks = [], native = [];
    const config = vscode.workspace.getConfiguration('svtools.completion');
    const write = async (name, text) => { const filename = path.join(root, name); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, text); return filename; };
    async function sample(name, text) {
        const offset = text.indexOf(MARKER); assert.ok(offset >= 0, '夹具必须指定光标');
        const uri = vscode.Uri.file(await write(name, text.replace(MARKER, '')));
        const document = await vscode.workspace.openTextDocument(uri);
        return { document, position: document.positionAt(offset) };
    }
    const complete = async fixture => (await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', fixture.document.uri, fixture.position)) || { items: [] };
    async function eventually(fixture, predicate) {
        for (let attempt = 0; attempt < 60; attempt++) {
            const list = await complete(fixture);
            if (predicate(list)) return list;
            await sleep(50);
        }
        const list = await complete(fixture);
        assert.ok(predicate(list), '文件事件处理后补全结果仍未满足条件：' + list.items.map(labelOf).join(', '));
        return list;
    }
    const find = (list, name) => { const item = list.items.find(entry => labelOf(entry) === name); assert.ok(item, '缺少补全项 ' + name + '；已有：' + list.items.map(labelOf).join(', ')); return item; };
    async function check(name, action) {
        const started = performance.now();
        try { await action(); checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - started) }); }
        catch (error) { checks.push({ name, passed: false, error: error.stack }); console.error('COMPLETION_HOST_CHECK_FAILED ' + name + ': ' + error.message); }
    }

    await write('types_pkg.sv', `package types_pkg;
class parent;
    int parent_counter;
    protected int protected_counter;
    local int private_counter;
    static function int static_count(); return 1; endfunction
    function int read(); return parent_counter; endfunction
endclass
class child extends parent;
    int child_counter;
endclass
class box #(type T = parent);
    T value;
endclass
typedef struct packed { logic valid; logic [7:0] payload; } packet_t;
endpackage
`);
    await write('long_leaf.sv', 'module long_leaf #(parameter WIDTH = 8, parameter DEPTH = 16) (\n' +
        ['input logic clk', ...Array.from({ length: 90 }, (_, index) => 'input logic port_' + index)].join(',\n') + '\n); endmodule\n');
    await write('macros.svh', '`define PROJECT_WORD(W) logic [(W)-1:0]\n');

    await check('真实语言注册：SystemVerilog 与 Verilog 关键词过滤', async () => {
        const sv = await sample('keyword.sv', 'module keyword; always_f/*?*/ endmodule'); find(await complete(sv), 'always_ff');
        const v = await sample('keyword.v', 'module keyword_v; always_f/*?*/ endmodule');
        assert.ok(!(await complete(v)).items.some(item => labelOf(item) === 'always_ff'));
    });
    await check('词中补全具有完整替换范围，真实 insertSnippet 不重复后缀', async () => {
        const fixture = await sample('snippet.sv', 'mod/*?*/ule');
        const list = await complete(fixture);
        const item = list.items.find(entry => labelOf(entry) === 'module' && entry.insertText instanceof vscode.SnippetString);
        assert.ok(item, '模块骨架必须返回真实 SnippetString');
        assert.equal(fixture.document.getText(rangeOf(item)), 'module');
        const editor = await vscode.window.showTextDocument(fixture.document);
        assert.equal(await editor.insertSnippet(item.insertText, rangeOf(item)), true);
        assert.match(fixture.document.getText(), /module\s+\w+/); assert.match(fixture.document.getText(), /endmodule/);
        assert.match(fixture.document.getText(), /endmodule\s*$/, '替换不能留下原词尾');
        await vscode.commands.executeCommand('leaveSnippet');
    });
    await check('跨文件 package 导入、继承与访问权限', async () => {
        const fixture = await sample('inherit.sv', 'module inherit; import types_pkg::*; child obj; initial obj./*?*/ endmodule');
        const list = await eventually(fixture, result => result.items.some(item => labelOf(item) === 'parent_counter'));
        find(list, 'child_counter'); find(list, 'read');
        assert.ok(!list.items.some(item => ['private_counter', 'protected_counter'].includes(labelOf(item))));
    });
    await check('参数化类型成员链与 static 域', async () => {
        const fixture = await sample('generic.sv', 'module generic; types_pkg::box #(types_pkg::child) obj; initial obj.value./*?*/ endmodule');
        const list = await complete(fixture); find(list, 'child_counter'); find(list, 'parent_counter');
        const scoped = await sample('static.sv', 'module static_probe; initial types_pkg::parent::/*?*/ endmodule');
        const statics = await complete(scoped); find(statics, 'static_count');
        assert.ok(!statics.items.some(item => labelOf(item) === 'parent_counter'));
    });
    await check('queue、二维数组降维与结构体成员', async () => {
        const queue = await sample('queue.sv', 'module queue_probe; int words[$]; initial words./*?*/ endmodule');
        const methods = await complete(queue); find(methods, 'push_back'); find(methods, 'pop_front');
        const mem = await sample('mem.sv', 'module mem; types_pkg::packet_t cells[4][8]; initial cells[1][2]./*?*/ endmodule');
        const members = await complete(mem); find(members, 'valid'); find(members, 'payload');
    });
    await check('string 别名、enum 和标准 std/process 域', async () => {
        const strings = await sample('text_probe.sv', 'module text_probe; typedef string text_t; text_t text; initial text.to/*?*/ endmodule'); find(await complete(strings), 'tolower');
        const enums = await sample('enum_probe.sv', 'module enum_probe; typedef enum { IDLE, BUSY } state_t; state_t state; initial state./*?*/ endmodule'); find(await complete(enums), 'name');
        const standard = await sample('std_probe.sv', 'module std_probe; initial std::/*?*/ endmodule'); find(await complete(standard), 'randomize');
        const process = await sample('process_probe.sv', 'module process_probe; initial process::state::/*?*/ endmodule'); find(await complete(process), 'FINISHED');
    });
    await check('virtual interface 的 modport 成员', async () => {
        await write('bus.sv', 'interface bus; logic ready, hidden; modport drv(output ready); endinterface');
        const fixture = await sample('virtual_probe.sv', 'class virtual_probe; virtual bus.drv vif; function void drive(); vif./*?*/ endfunction endclass');
        const list = await eventually(fixture, result => result.items.some(item => labelOf(item) === 'ready')); find(list, 'ready');
        assert.ok(!list.items.some(item => isSvtoolsItem(item) && labelOf(item) === 'hidden'), 'modport 必须隐藏未声明接口信号');
    });
    await check('匿名嵌套 struct 与 covergroup/coverpoint 的 coverage options', async () => {
        const nested = await sample('nested.sv', 'module nested; struct packed { int data; struct packed { bit valid; } meta; } packet; initial packet.meta./*?*/ endmodule'); find(await complete(nested), 'valid');
        const group = await sample('coverage.sv', 'module coverage; int data; covergroup cg; cp: coverpoint data; endgroup cg cov; initial cov.option./*?*/ endmodule');
        const options = await complete(group); find(options, 'goal'); find(options, 'per_instance'); find(options, 'auto_bin_max');
        const point = await sample('coverpoint.sv', 'module coverpoint_probe; int data; covergroup cg; cp: coverpoint data; endgroup cg cov; initial cov.cp./*?*/ endmodule'); find(await complete(point), 'get_inst_coverage');
    });
    await check('已有调用括号接受 plain insertText，仅替换完整方法名', async () => {
        const fixture = await sample('plain_call.sv', 'module plain_call; string text; initial text.to/*?*/lower(); endmodule');
        const item = find(await complete(fixture), 'tolower'); assert.equal(typeof item.insertText, 'string'); assert.equal(item.insertText, 'tolower');
        assert.equal(fixture.document.getText(rangeOf(item)), 'tolower');
        const editor = await vscode.window.showTextDocument(fixture.document);
        assert.equal(await editor.edit(builder => builder.replace(rangeOf(item), item.insertText)), true);
        assert.equal(fixture.document.getText(), 'module plain_call; string text; initial text.tolower(); endmodule');
    });
    await check('escaped identifier 接受普通文本并保留终止空白', async () => {
        const fixture = await sample('escaped.sv', 'module escaped; int \\value.with.dot ; initial \\value.w/*?*/ endmodule');
        const item = find(await complete(fixture), '\\value.with.dot'); assert.equal(typeof item.insertText, 'string'); assert.ok(item.insertText.endsWith(' '));
        const editor = await vscode.window.showTextDocument(fixture.document); await editor.edit(builder => builder.replace(rangeOf(item), item.insertText));
        assert.match(fixture.document.getText(), /initial \\value\.with\.dot\s+endmodule/);
    });
    await check('超过 30 行的实例端口与参数，已连接项去重', async () => {
        const fixture = await sample('ports.sv', 'module ports; long_leaf #(.WIDTH(8)) dut (\n.clk(0),\n' +
            Array.from({ length: 70 }, (_, index) => '.port_' + index + '(0),').join('\n') + '\n.po/*?*/\n); endmodule');
        const ports = await complete(fixture); find(ports, 'port_89'); assert.ok(!ports.items.some(item => labelOf(item) === 'port_0'));
        const params = await sample('params.sv', 'module params; long_leaf #(.WIDTH(8), .DE/*?*/) dut (); endmodule'); find(await complete(params), 'DEPTH');
    });
    const toolsFile = path.join(root, '..', 'tools.json');
    const hasTools = await fs.stat(toolsFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (hasTools) await check('真实接受参数补全后 Icarus 编译通过', async () => {
        const tools = JSON.parse((await fs.readFile(toolsFile, 'utf8')).replace(/^\uFEFF/, ''));
        const fixture = await sample('compile_probe.sv', "module compile_probe; long_leaf #(.DE/*?*/PTH(16)) dut (.clk(1'b0)); endmodule");
        const item = find(await complete(fixture), 'DEPTH'); assert.equal(fixture.document.getText(rangeOf(item)), 'DEPTH');
        const editor = await vscode.window.showTextDocument(fixture.document);
        const snippet = item.insertText instanceof vscode.SnippetString ? item.insertText : new vscode.SnippetString(item.insertText);
        assert.equal(await editor.insertSnippet(snippet, rangeOf(item)), true); await vscode.commands.executeCommand('leaveSnippet'); await fixture.document.save();
        const execute = promisify(execFile);
        const env = { ...process.env, PATH: tools.cygwin ? tools.cygwin + path.delimiter + process.env.PATH : process.env.PATH };
        const version = await execute(tools.iverilog, ['-V'], { env, timeout: 15000, windowsHide: true });
        const result = await execute(tools.iverilog, ['-g2012', '-s', 'compile_probe', '-o', path.join(root, '..', 'accepted-completion.vvp'), fixture.document.uri.fsPath, path.join(root, 'long_leaf.sv')], { env, timeout: 15000, windowsHide: true });
        native.push({ tool: 'iverilog', version: version.stdout.split(/\r?\n/)[0], stdout: result.stdout, stderr: result.stderr });
    });
    await check('工程宏与系统任务保留前缀，接受后不重复 $ 或反引号', async () => {
        const macro = await sample('macro.sv', 'module macro_probe; `PROJECT_/*?*/ endmodule');
        find(await eventually(macro, list => list.items.some(item => labelOf(item) === 'PROJECT_WORD')), 'PROJECT_WORD');
        const system = await sample('system.sv', 'module system_probe; initial $dumpv/*?*/; endmodule');
        const item = find(await complete(system), 'dumpvars'); assert.equal(system.document.getText(rangeOf(item)), 'dumpv');
        const editor = await vscode.window.showTextDocument(system.document);
        await editor.insertSnippet(item.insertText instanceof vscode.SnippetString ? item.insertText : new vscode.SnippetString(item.insertText), rangeOf(item));
        assert.match(system.document.getText(), /\$dumpvars/); assert.ok(!system.document.getText().includes('$$'));
        await vscode.commands.executeCommand('leaveSnippet');
    });
    await check('注释与普通字符串抑制 SV Tools HDL 建议', async () => {
        for (const [name, text] of [['comment.sv', 'module comment_probe; // obj./*?*/\nendmodule'], ['string.sv', 'module string_probe; string s = "always_/*?*/"; endmodule']]) {
            const list = await complete(await sample(name, text));
            assert.ok(!list.items.some(isSvtoolsItem), 'SV Tools 不应在注释或普通字符串返回 HDL 建议');
        }
    });
    await check('未保存文档优先于磁盘，实时编辑使声明失效', async () => {
        await write('dirty_pkg.sv', 'package dirty_pkg; int disk_only; endpackage');
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'dirty_pkg.sv')));
        const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'package dirty_pkg; int dirty_only; endpackage');
        assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(document.isDirty, true);
        const fixture = await sample('dirty_probe.sv', 'module dirty_probe; initial dirty_pkg::/*?*/ endmodule');
        const list = await complete(fixture); find(list, 'dirty_only'); assert.ok(!list.items.some(item => labelOf(item) === 'disk_only'));
    });
    await check('磁盘文件新增、修改、删除逐步更新工程索引', async () => {
        const fixture = await sample('events.sv', 'module events; initial event_pkg::/*?*/ endmodule');
        const filename = await write('event_pkg.sv', 'package event_pkg; int created; endpackage');
        await eventually(fixture, list => list.items.some(item => labelOf(item) === 'created'));
        await fs.writeFile(filename, 'package event_pkg; int changed; endpackage');
        const changed = await eventually(fixture, list => list.items.some(item => labelOf(item) === 'changed'));
        assert.ok(!changed.items.some(item => labelOf(item) === 'created'));
        await fs.unlink(filename);
        await eventually(fixture, list => !list.items.some(item => labelOf(item) === 'changed'));
    });
    await check('外部 includePaths 与 include 文件名建议', async () => {
        const external = path.join(root, '..', 'include'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'external.svh'), 'package external_pkg; int external_word; endpackage');
        await config.update('includePaths', [external], vscode.ConfigurationTarget.Workspace);
        try {
            assert.equal((await vscode.workspace.findFiles(new vscode.RelativePattern(external, '**/*.{v,sv,vh,svh}'))).length, 1, '真实宿主必须能发现 includePath 文件');
            assert.deepEqual(vscode.workspace.getConfiguration('svtools.completion').get('includePaths'), [external]);
            const fixture = await sample('external_probe.sv', 'module external_probe; initial external_pkg::/*?*/ endmodule'); find(await eventually(fixture, list => list.items.some(item => labelOf(item) === 'external_word')), 'external_word');
            const include = await sample('include_probe.sv', '`include "/*?*/"\nmodule include_probe; endmodule');
            assert.ok((await complete(include)).items.some(item => /external\.svh$/.test(labelOf(item))));
            await fs.writeFile(path.join(external, 'external.svh'), 'package external_pkg; int external_changed; endpackage');
            const changed = await eventually(fixture, list => list.items.some(item => labelOf(item) === 'external_changed'));
            assert.ok(!changed.items.some(item => labelOf(item) === 'external_word'), 'includePath 外部文件修改必须淘汰旧定义');
            const created = await sample('external_create.sv', 'module external_create; initial external_extra_pkg::/*?*/ endmodule');
            await complete(created);
            const newFile = path.join(external, 'created.svh'); await fs.writeFile(newFile, 'package external_extra_pkg; int external_created; endpackage');
            await eventually(created, list => list.items.some(item => labelOf(item) === 'external_created'));
            await fs.unlink(newFile); await eventually(created, list => !list.items.some(item => labelOf(item) === 'external_created'));
        } finally { await config.update('includePaths', [], vscode.ConfigurationTarget.Workspace); }
    });
    await check('UVM 1.2 与 1800.2 配置、方法和宏，off 配置抑制目录', async () => {
        for (const version of ['1.2', '1800.2']) {
            await config.update('uvmVersion', version, vscode.ConfigurationTarget.Workspace);
            const fixture = await sample('uvm_' + version.replace('.', '_') + '.sv', 'class component extends uvm_component; function void run(); this./*?*/ endfunction endclass');
            find(await complete(fixture), 'get_full_name');
            const macro = await sample('uvm_macro_' + version.replace('.', '_') + '.sv', '`uvm_in/*?*/'); find(await complete(macro), 'uvm_info');
            const configDb = await sample('uvm_config_' + version.replace('.', '_') + '.sv', 'module config_probe; initial uvm_config_db#(int)::/*?*/ endmodule'); find(await complete(configDb), 'set');
        }
        await config.update('uvmVersion', 'off', vscode.ConfigurationTarget.Workspace);
        const disabled = await sample('uvm_disabled.sv', '`uvm_in/*?*/'); assert.ok(!(await complete(disabled)).items.some(item => labelOf(item) === 'uvm_info'));
        await config.update('uvmVersion', '1.2', vscode.ConfigurationTarget.Workspace);
    });
    await check('UVM utils 注册类的 factory type_id 与 create 返回类型', async () => {
        const fixture = await sample('factory.sv', 'import uvm_pkg::*; class transaction extends uvm_sequence_item; `uvm_object_utils(transaction) int payload; endclass module factory_probe; initial transaction::type_id::/*?*/ endmodule');
        find(await complete(fixture), 'create');
        const chain = await sample('factory_chain.sv', 'import uvm_pkg::*; class transaction2 extends uvm_sequence_item; `uvm_object_utils(transaction2) int payload; endclass module factory_probe2; initial transaction2::type_id::create("transaction2")./*?*/ endmodule');
        const list = await complete(chain); find(list, 'payload'); find(list, 'get_name');
    });
    await check('索引文件预算通过真实 CompletionList 显示 isIncomplete', async () => {
        await config.update('maxFiles', 1, vscode.ConfigurationTarget.Workspace);
        const fixture = await sample('budget.sv', 'module budget; alw/*?*/ endmodule');
        assert.equal((await complete(fixture)).isIncomplete, true);
        await config.update('maxFiles', undefined, vscode.ConfigurationTarget.Workspace);
    });
    await check('标准配置与 begin_keywords 区间过滤，end_keywords 恢复默认', async () => {
        const old = await sample('begin_keywords.sv', '`begin_keywords "1364-1995"\nmodule begin_old; loc/*?*/ endmodule');
        assert.ok(!(await complete(old)).items.some(item => isSvtoolsItem(item) && labelOf(item) === 'localparam'));
        const restored = await sample('end_keywords.sv', '`begin_keywords "1364-1995"\nmodule old; endmodule\n`end_keywords\ncl/*?*/'); find(await complete(restored), 'class');
        await config.update('standard', '1364-2005', vscode.ConfigurationTarget.Workspace);
        try {
            const fixture = await sample('configured_standard.sv', 'module configured_standard; always_f/*?*/ endmodule');
            assert.ok(!(await complete(fixture)).items.some(item => isSvtoolsItem(item) && labelOf(item) === 'always_ff'));
        } finally { await config.update('standard', undefined, vscode.ConfigurationTarget.Workspace); }
    });
    await check('候选列表预算可继续输入收窄，完整窄结果恢复 isIncomplete', async () => {
        await config.update('maxItems', 2, vscode.ConfigurationTarget.Workspace);
        try {
            const broad = await sample('item_budget.sv', 'module item_budget; int cap_alpha, cap_beta, cap_gamma; initial /*?*/ endmodule');
            const list = await complete(broad); assert.equal(list.isIncomplete, true); assert.equal(list.items.filter(isSvtoolsItem).length, 2);
            const narrow = await sample('item_budget_narrow.sv', 'module item_budget_narrow; int cap_alpha, cap_beta, cap_gamma; initial cap_g/*?*/ endmodule');
            const result = await complete(narrow); find(result, 'cap_gamma'); assert.equal(result.isIncomplete, false);
        } finally { await config.update('maxItems', undefined, vscode.ConfigurationTarget.Workspace); }
    });

    const report = { vscode: vscode.version, version: extension.packageJSON.version, checks, native, nativeSkipped: !hasTools, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length };
    await fs.writeFile(path.join(root, '..', 'host-report.json'), JSON.stringify(report, null, 2));
    console.log('SVTOOLS_COMPLETION_HOST_VALIDATED ' + JSON.stringify(report));
    assert.equal(report.failed, 0, report.failed + ' 项真实补全宿主验收失败，完整原因见 host-report.json');
}
module.exports = { run };
