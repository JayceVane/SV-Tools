'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createProjectFlowController } = require('../src/project/flow-controller');
async function host(t) {
    const root = await fs.mkdtemp(path.resolve('bin/trace-context-'));
    const file = path.join(root, 'tb.sv'), other = path.join(root, 'adder.sv');
    const text = 'module tb; reg [7:0] data; wire [7:0] out; dut u_dut(.data(data),.out(out));endmodule\nmodule dut(input [7:0] data,output [7:0] out);assign out=data;endmodule';
    await fs.writeFile(file, text);
    await fs.writeFile(other, 'module adder; genvar i; for(i=0;i<4;i=i+1) begin:g wire q;end endmodule');
    const document = { uri: { scheme: 'file', fsPath: file }, isDirty: false, isClosed: false, offsetAt: value => value,
        getText: range => range ? text.slice(range.start, range.end) : text };
    const editor = name => {
        const start = text.indexOf(name);
        return { document, selection: { isEmpty: false, start, end: start + name.length, active: start + name.length } };
    };
    let current = { id: 'p', key: '1', root, top: 'adder', includeDirs: [], defines: [], sets: [{ type: 'DesignSrcs', top: 'adder', files: [other, file] }] };
    const updates = [], dialogs = [];
    const projects = { current: async () => current };
    const vscode = { workspace: { textDocuments: [document], getConfiguration: () => ({ get: (_, value) => value }) }, window: { activeTextEditor: editor('data'),
            showQuickPick: async () => {
                dialogs.push('pick');
            }, withProgress: async (_, action) => {
                dialogs.push('progress');
                return action(null, { onCancellationRequested: () => ({ dispose() {
                        } }) });
            } }, ProgressLocation: { Notification: 15 } };
    const flow = createProjectFlowController({ vscode, projects, onChange: value => updates.push(value) });
    t.after(() => flow.dispose());
    return { flow, editor, document, updates, dialogs, projects, vscode, setProject: project => {
            current = project;
            flow.projectChanged(project);
        } };
}
test('首次选择即可静默追踪TB，错误综合top自动回退且复用模型', async (t) => {
    const h = await host(t);
    await h.flow.follow(h.editor('data'));
    assert.equal(h.flow.get()?.top, 'tb');
    assert.equal(h.flow.get()?.rootFallback, true);
    assert.equal(h.flow.get()?.origin.name, 'data');
    assert.ok(!h.flow.get().issues.some(issue => issue.startsWith('adder.')));
    const snapshots = h.flow.get().sourceSnapshots;
    await h.flow.follow(h.editor('out'));
    assert.equal(h.flow.get().origin.name, 'out');
    assert.equal(h.flow.get().sourceSnapshots, snapshots);
    assert.deepEqual(h.dialogs, []);
});
test('连续选择只发布最后一个结果，固定和取消自动跟随有效', async (t) => {
    const h = await host(t);
    const first = h.flow.follow(h.editor('data'));
    h.flow.follow(h.editor('out'));
    await first;
    assert.equal(h.flow.get()?.origin.name, 'out');
    assert.ok(h.updates.filter(update => update.flow).every(update => update.flow.origin.name === 'out'));
    h.flow.setPinned(true);
    await h.flow.follow(h.editor('data'));
    assert.equal(h.flow.get().origin.name, 'out');
    h.flow.setPinned(false);
    const next = h.flow.follow(h.editor('data'));
    h.flow.cancelFollow();
    await next;
    assert.equal(h.flow.get().origin.name, 'out');
});
test('自动模式不弹框，脏文件/非成员有提示，工程切换取消分析', async (t) => {
    const h = await host(t);
    h.document.isDirty = true;
    await h.flow.follow(h.editor('data'));
    assert.equal(h.flow.get(), undefined);
    assert.match(h.updates.at(-1).message, /保存/);
    h.document.isDirty = false;
    const next = h.flow.follow(h.editor('data'));
    h.setProject(null);
    await next;
    assert.equal(h.flow.get(), undefined);
    assert.deepEqual(h.dialogs, []);
});
test('手动命令保持进度与实例选择入口，空白选择不重建模型', async (t) => {
    const h = await host(t);
    await h.flow.trace();
    assert.equal(h.flow.get().origin.name, 'data');
    assert.deepEqual(h.dialogs, ['progress']);
    const previous = h.flow.get();
    await h.flow.follow({ document: h.document, selection: { isEmpty: true } });
    assert.equal(h.flow.get(), previous);
});

test('清除或源码失效后释放固定状态，下一次选择可重新追踪', async (t) => {
    const h = await host(t);
    await h.flow.follow(h.editor('data'));
    h.flow.setPinned(true);
    h.flow.clear('源码发生变化，请重新追踪');
    await h.flow.follow(h.editor('out'));
    assert.equal(h.flow.get()?.origin.name, 'out');
    assert.equal(h.flow.get()?.pinned, false);
});
