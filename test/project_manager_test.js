'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { createProjectManager } = require('../src/project/manager');
const { createProjectSelection } = require('../src/vivado/projects');
const { createProjectSourceProvider } = require('../src/workspace/project-sources');
async function fixture(t, options = {}) {
    const base = path.resolve(__dirname, '../bin/project-manager-test');
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'run-'));
    const data = new Map(), state = { get: key => data.get(key), update: async (key, value) => data.set(key, value) };
    const uri = fsPath => ({ fsPath, scheme: 'file' }), vscode = { Uri: { file: uri }, workspace: { workspaceFolders: [{ uri: uri(root) }], getWorkspaceFolder: () => ({ uri: uri(root) }), findFiles: async () => [] } };
    const legacy = createProjectSelection({ workspace: vscode.workspace, state }), projects = createProjectManager({ vscode, state, vivadoSelection: legacy, ...options });
    t.after(() => projects.dispose());
    return { root, state, vscode, projects, legacy };
}
test('自管理工程配置按文件保存，目录跟随、显式成员、排除与真实top共享同一快照', async (t) => {
    const { root, projects } = await fixture(t);
    const src = path.join(root, 'src');
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, 'top.sv'), 'module top; endmodule');
    let project = await projects.create(root, 'corelib');
    await projects.add(project, src);
    project = await projects.current();
    assert.equal(project.sets[0].files.length, 1);
    await fs.writeFile(path.join(src, 'child.v'), 'module child; endmodule');
    assert.equal((await projects.current()).sets[0].files.length, 2);
    await projects.remove(project, path.join(src, 'child.v'));
    assert.equal((await projects.current()).sets[0].files.length, 1);
    assert.ok(await fs.stat(path.join(src, 'child.v')));
    await projects.add(project, path.join(src, 'child.v'));
    await projects.update(project, config => {
        config.top = 'top';
        config.includeDirs = ['src'];
        config.defines = ['SYNTHESIS'];
    });
    project = await projects.current();
    assert.equal(project.top, 'top');
    assert.deepEqual(project.defines, ['SYNTHESIS']);
    assert.deepEqual(project.includeDirs, [src]);
    assert.equal(project.sets[0].files.length, 2);
    await projects.move(project,path.join(src,'child.v'),'simulation');
    const moved = await projects.current();
    assert.equal(moved.sets[0].files.length,1);
    assert.deepEqual(moved.sets[1].files,[path.join(src,'child.v')]);
    assert.equal((JSON.parse(await fs.readFile(project.path, 'utf8'))).root, '../..');
    assert.equal(await projects.vivadoSelection.current(), null);
});
test('Vivado和SV Tools工程共享选择，发现新XPR不会覆盖显式选择，恢复服务保留活动工程', async (t) => {
    const f = await fixture(t);
    const xpr = path.join(f.root, 'chip.xpr');
    await fs.writeFile(xpr, '<Project><FileSets><FileSet Name="sources_1" Type="DesignSrcs"><File Path="$PPRDIR/top.sv"/><Config><Option Name="TopModule" Val="top"/></Config></FileSet></FileSets></Project>');
    const local = await f.projects.create(f.root, 'local');
    await f.projects.select({ kind: 'vivado', path: xpr });
    assert.equal((await f.projects.current()).top, 'top');
    assert.equal(await f.projects.vivadoSelection.current(), xpr);
    await f.projects.select(local);
    f.vscode.workspace.findFiles = async () => [{ fsPath: xpr }];
    assert.equal((await f.projects.current()).name, 'local');
    const restored = createProjectManager({ vscode: f.vscode, state: f.state, vivadoSelection: f.legacy });
    t.after(() => restored.dispose());
    assert.equal((await restored.current()).name, 'local');
    const list = await restored.discover();
    assert.ok(list.some(item => item.kind === 'svtools'));
    assert.ok(list.some(item => item.kind === 'vivado'));
});
test('源码消费者尊重自管理工程成员，不混入同目录中的替代实现', async (t) => {
    const f = await fixture(t);
    const local = await f.projects.create(f.root, 'corelib'), file = path.join(f.root, 'member.sv');
    await fs.writeFile(file, 'module member;endmodule');
    await f.projects.add(local, file);
    const preferred = createProjectSourceProvider({ vscode: f.vscode, projects: f.projects, projectSelection: f.projects.vivadoSelection });
    const result = await preferred({ root: f.root, file });
    assert.deepEqual(result.files, [file]);
    assert.equal(await preferred({ root: f.root, file: path.join(f.root, 'not-member.sv') }), null);
});
test('快速切换工程按请求顺序提交，旧状态写入迟到不会覆盖最后一次选择', async (t) => {
    const f = await fixture(t);
    const first = await f.projects.create(f.root,'first');
    const second = await f.projects.create(f.root,'second');
    const update = f.state.update;
    let unblock, entered;
    const barrier = new Promise(resolve => { unblock = resolve; });
    const writing = new Promise(resolve => { entered = resolve; });
    f.state.update = async (key,value) => {
        if (key === 'svtools.project.active' && value.path === first.path) { entered(); await barrier; }
        return update(key,value);
    };
    const selectingFirst = f.projects.select(first);
    await writing;
    const selectingSecond = f.projects.select(second);
    await new Promise(resolve => setImmediate(resolve));
    unblock();
    await Promise.all([selectingFirst,selectingSecond]);
    assert.equal((await f.projects.current()).id,second.id);
    assert.equal(f.state.get('svtools.project.active').path,second.path);
});

test('Windows配置替换的短暂占用有界重试，永久失败保留原配置', {skip:process.platform!=='win32'}, async (t) => {
    let attempts = 0, permanent = false;
    const f = await fixture(t, {rename:async (from,to) => {
        if (permanent || attempts++ < 2) throw Object.assign(new Error('temporary lock'),{code:'EPERM'});
        return fs.rename(from,to);
    }});
    const project = await f.projects.create(f.root,'locked');
    await f.projects.update(project,config => {config.top='top';});
    assert.equal(attempts,3);
    const original = await fs.readFile(project.path,'utf8');
    permanent = true;
    await assert.rejects(f.projects.update(project,config => {config.top='other';}),/temporary lock/);
    assert.equal(await fs.readFile(project.path,'utf8'),original);
});

test('不覆盖同名工程、错误schema或任意JSON，拒绝无效名称', async (t) => {
    const f = await fixture(t);
    await f.projects.create(f.root, 'local');
    await assert.rejects(f.projects.create(f.root, 'local'), /已存在/);
    await assert.rejects(f.projects.create(f.root, '../escape'), /无效/);
    await assert.rejects(f.projects.update({ kind: 'svtools', path: path.join(f.root, 'package.json') }, () => {
    }));
});
