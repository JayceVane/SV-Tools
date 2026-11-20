'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { projectHtml } = require('../src/project/view');
const { projectTree } = require('../src/project/tree-model');
const { parseXprText } = require('../src/vivado/xpr');
const noop = () => ({ dispose() {
    } });
async function host(t) {
    const commands = new Map(), calls = [], sent = [], errors = [], subscriptions = [];
    let provider, receive, traceMode = 'selection';
    let project = { id: 'p1', name: 'local', kind: 'svtools', path: path.resolve('bin/local.json'), root: path.resolve('bin'), sets: [{ name: 'sources', type: 'DesignSrcs', top: 'top', files: [path.resolve('bin/top.sv')] }], key: '1', includeDirs: [], defines: [] };
    const listeners = new Set(), projects = { current: async () => project, onDidChange(fn) {
            listeners.add(fn);
            return noop();
        }, discover: async () => [], invalidate() {
            for (const fn of listeners)
                fn();
        }, remove: async (...args) => calls.push(['remove', ...args]), select: async () => {
        }, create: async () => {
        }, add: async () => {
        }, update: async () => {
        } };
    const vscode = { Uri: { file: fsPath => ({ fsPath, scheme: 'file' }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) }, window: { registerWebviewViewProvider(id, value) {
                assert.equal(id, 'svtools.vivado.projectTree');
                provider = value;
                return noop();
            }, showErrorMessage: error => errors.push(error), showQuickPick: async () => undefined }, ConfigurationTarget: {Workspace:2,Global:1}, workspace: { getConfiguration: () => ({ get: key => key==='design.planFile'?'svtools.design.json':traceMode, update:async (_,value)=>{traceMode=value;} }), createFileSystemWatcher: () => ({ onDidChange: noop, onDidCreate: noop, onDidDelete: noop, dispose() {
                } }) }, commands: { registerCommand(id, callback) {
                commands.set(id, callback);
                return noop();
            }, executeCommand: async (...args) => calls.push(args) } };
    const context = { subscriptions, workspaceState: { get: () => ({}), update: async () => {
            } }, extensionUri: { fsPath: path.resolve('.') } };
    const filename = path.resolve(__dirname, '../src/project/index.js'), module = { exports: {} }, localRequire = createRequire(filename);
    const flow = { get: () => null, cancelFollow() {}, clear() {
        }, projectChanged() {
        }, dispose() {
        }, trace: async () => {
        }, setPinned() {
        } };
    const factory = new vm.Script('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})').runInThisContext();
    factory(name => name === './flow-controller' ? { createProjectFlowController: () => flow } : localRequire(name), module, module.exports);
    const api = module.exports.activateProjectView(context, { vscode, projects, vivado: { refreshProjectContext: async () => {
            }, projectTree: { refresh: async () => {
                } } }, sourceCatalog: {} });
    provider.resolveWebviewView({ webview: { cspSource:'vscode-webview://test', asWebviewUri: uri => uri.fsPath, postMessage: value => sent.push(value), onDidReceiveMessage(fn) {
                receive = fn;
                return noop();
            } } });
    await api.refresh();
    t.after(() => {
        for (const disposable of subscriptions)
            disposable.dispose?.();
    });
    return { api, commands, calls, sent, errors, async message(data) {
            receive(data);
            await new Promise(resolve => setImmediate(resolve));
        }, setProject(value) {
            project = value;
            projects.invalidate();
        } };
}
test('仅一个工程Webview，菜单只允许宿主当前节点动作，过期节点不能操作任意文件', async (t) => {
    const h = await host(t), snapshot = h.sent.at(-1), file = snapshot.nodes[0].children[0];
    assert.equal(snapshot.project.name, 'local');
    assert.equal(file.label, 'top.sv');
    assert.ok(h.commands.has('svtools.project.trace'));
    await h.message({ action: 'command', revision: snapshot.revision, command: 'workbench.action.quit', nodeId: file.id });
    assert.equal(h.calls.length, 0);
    assert.ok(h.errors.some(error => error.includes('允许列表')));
    await h.message({ action: 'command', revision: snapshot.revision - 1, command: 'remove', nodeId: file.id });
    assert.equal(h.calls.length, 0);
    await h.message({ action: 'command', revision: snapshot.revision, command: 'remove', nodeId: 'arbitrary-file' });
    assert.equal(h.calls.length, 0);
    await h.message({ action: 'command', revision: snapshot.revision, command: 'remove', nodeId: file.id });
    assert.equal(h.calls[0][0], 'remove');
    assert.equal(h.calls[0][2], file.file);
});
test('空工程状态也发送恢复入口，工程文本不插入可执行HTML', async (t) => {
    const h = await host(t);
    h.setProject(null);
    await h.api.refresh();
    assert.equal(h.sent.at(-1).project, null);
    assert.deepEqual(h.sent.at(-1).nodes, []);
    const html = projectHtml({ cspSource:'vscode-webview://test', asWebviewUri: uri => uri }, '/extension', { Uri: { joinPath: (_, ...parts) => '/' + parts.join('/') } });
    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'nonce-/);
    assert.match(html, /style-src vscode-webview:\/\/test/);
    assert.match(html, /href="\/src\/project\/style.css"/);
    assert.match(html, /src="\/src\/project\/icons.js"/);
    for (const id of ['actions', 'toolReports']) {
        const trigger = html.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>'))[0];
        assert.match(trigger, /aria-haspopup="menu"/);
        assert.match(trigger, /aria-expanded="false"/);
        assert.match(trigger, /aria-controls="menu"/);
    }
    assert.ok(!html.includes('unsafe-inline'));
    const client = fs.readFileSync(path.resolve(__dirname, '../src/project/client.js'), 'utf8');
    assert.ok(!client.includes('innerHTML'));
    assert.match(client, /label.textContent\s*=\s*node.label/);
});

test('工程菜单允许切换自动/手动追踪，并即时显示当前模式', async t => {
    const h = await host(t);
    assert.match(h.sent.at(-1).actions.find(action=>action.id==='traceTrigger').label,/自动追踪/);
    await h.message({action:'command',revision:h.sent.at(-1).revision,command:'traceTrigger'});
    assert.match(h.sent.at(-1).actions.find(action=>action.id==='traceTrigger').label,/手动追踪/);
    await h.message({action:'command',revision:h.sent.at(-1).revision,command:'traceTrigger'});
    assert.match(h.sent.at(-1).actions.find(action=>action.id==='traceTrigger').label,/自动追踪/);
    assert.deepEqual(h.errors,[]);
});

test('Vivado流程独立提供七项命令，仍校验工程身份与快照世代', async t => {
    const h=await host(t),local=h.api.getSnapshot().project;
    assert.deepEqual(h.sent.at(-1).toolActions,[]);
    h.setProject({...local,id:'vivado',kind:'vivado',path:path.resolve('bin/top.xpr')});
    await h.api.refresh();
    let snapshot=h.sent.at(-1);
    assert.equal(snapshot.toolActions.length,7);
    assert.equal(snapshot.actions.some(action=>action.id==='synthesize'),false);
    await h.message({action:'command',revision:snapshot.revision,command:'implement'});
    assert.equal(h.calls.at(-1)[0],'svtools.vivado.tree.implement');
    assert.equal(h.calls.at(-1)[1].nodeData.xpr,path.resolve('bin/top.xpr'));
    snapshot=h.sent.at(-1);
    h.setProject(local);
    await h.api.refresh();
    const count=h.calls.length;
    await h.message({action:'command',revision:snapshot.revision,command:'bitstream'});
    assert.equal(h.calls.length,count);
    await h.message({action:'command',revision:h.sent.at(-1).revision,command:'synthesize'});
    assert.equal(h.calls.length,count);
    assert.match(h.errors.at(-1),/允许列表/);
});
test('文件视图聚合角色，实例视图区分同文件多实例，信号不会成为树节点', () => {
    const file = path.resolve('bin/leaf.sv'), project = { root: path.dirname(file), sets: [{ name: 'sources', files: [file] }] }, nodes = [{ id: 'a', parentId: null, moduleName: 'leaf', label: 'u_a : leaf', source: { path: file }, names: ['u_a'], roles: ['internal', 'output'], details: [], declaration: { name: 'r_data', indices: [0] } }, { id: 'b', parentId: null, moduleName: 'leaf', label: 'u_b : leaf', source: { path: file }, names: ['u_b'], roles: ['input'], details: [] }];
    const files = projectTree(project, { flow: { nodes } });
    assert.deepEqual(files[0].children[0].flags.map(f => f.symbol), ['●', '→', '←']);
    const instances = projectTree(project, { projection: 'instances', flow: { nodes } });
    assert.equal(instances.length, 2);
    assert.notEqual(instances[0].id, instances[1].id);
    assert.ok(instances.every(n => !n.label.includes('r_data')));
});

test('Vivado 文件视图按 IP 和 BD 分组，保留实际成员的路径和所属文件集', async t => {
    const h = await host(t), root = path.resolve('bin'), file = path.join(root, 'nested', 'example.xpr');
    const parsed = parseXprText(`<Project><FileSets>
        <FileSet Name="sources_1" Type="DesignSrcs">
            <File Path="$PPRDIR/top.sv"/><File Path="$PPRDIR/ip/z_fifo/z_fifo.xci"/><File Path="$PPRDIR/bd/sys/sys.bd"/>
        </FileSet>
        <FileSet Name="a_fifo" Type="BlockSrcs">
            <File Path="$PPRDIR/ip/a_fifo/a_fifo.XCIX"/><File Path="$PPRDIR/ip/a_fifo/config.prj"/>
            <Config><Option Name="TopModule" Val="a_fifo"/></Config>
        </FileSet>
        <FileSet Name="sys_child" Type="BlockSrcs"><Config><Option Name="TopModule" Val="sys_child"/></Config></FileSet>
        <FileSet Name="sim_1" Type="SimulationSrcs"/>
    </FileSets></Project>`, file);
    h.setProject({ id: file, name: 'example', kind: 'vivado', path: file, root, sets: parsed.sets });
    await h.api.refresh();
    const snapshot = h.sent.at(-1), [sources, sim, ips, bd, blockSources] = snapshot.nodes;
    assert.deepEqual(snapshot.nodes.map(node => node.label), ['sources_1', 'sim_1', 'IP · 2', 'Block Design · 1', '块源文件']);
    assert.equal(snapshot.project.location, 'nested');
    assert.equal(snapshot.project.path, file);
    assert.deepEqual(sources.children[0].children.map(node => node.label), ['top.sv']);
    assert.deepEqual(sim.children, []);
    assert.equal(ips.collapsedByDefault, true);
    assert.deepEqual(ips.children.map(node => [node.label, node.fileset]), [['a_fifo.XCIX', 'a_fifo'], ['z_fifo.xci', 'sources_1']]);
    assert.equal(bd.children[0].fileset, 'sources_1');
    assert.equal(blockSources.children[0].fileset, 'a_fifo');
    const ip = ips.children[0];
    await h.message({ action: 'command', revision: snapshot.revision, command: 'ipManager', nodeId: ip.id });
    assert.deepEqual(h.calls.at(-1), ['svtools.vivado.assets.ip', { nodeData: { file: ip.file, fileset: 'a_fifo', xpr: file } }]);
    await h.message({ action: 'command', revision: h.api.getSnapshot().revision, command: 'blockDesign', nodeId: bd.children[0].id });
    assert.deepEqual(h.calls.at(-1), ['svtools.vivado.assets.bd', { nodeData: { file: bd.children[0].file, fileset: 'sources_1', xpr: file } }]);
    await h.message({ action: 'open', revision: h.api.getSnapshot().revision, nodeId: ip.id });
    assert.deepEqual(h.calls.at(-1), ['vscode.open', { fsPath: path.join(root, 'nested', 'ip', 'a_fifo', 'a_fifo.XCIX'), scheme: 'file' }]);
    await h.message({ action: 'command', revision: h.api.getSnapshot().revision, command: 'removeFile', nodeId: ip.id });
    assert.equal(h.calls.at(-1)[0], 'svtools.vivado.tree.removeFile');
    assert.equal(h.calls.at(-1)[1].nodeData.fileset, 'a_fifo');
});

test('同一侧栏的只读进展读取计划，链接限定当前工程且不创建状态',async t=>{
    const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'svtools-progress-'));
    t.after(()=>{assert.ok(path.basename(root).startsWith('svtools-progress-'));fs.rmSync(root,{recursive:true,force:true});});
    fs.writeFileSync(path.join(root,'top.sv'),'module top; endmodule');
    fs.writeFileSync(path.join(root,'svtools.design.json'),JSON.stringify({schemaVersion:1,id:'p',title:'Progress',top:'top',overview:'fixture',requirements:[{id:'R1',text:'requirement'}],modules:[{id:'top',name:'top',responsibility:'fixture',sources:['top.sv'],requirements:['R1'],deltaSignals:['tb.q']}]}));
    const h=await host(t);h.setProject({id:'progress-project',name:'progress',kind:'svtools',root,sets:[]});await h.api.refresh();
    await h.message({action:'projection',projection:'progress',revision:h.api.getSnapshot().revision});
    for(let i=0;i<50&&!h.sent.at(-1)?.progress?.available;i++)await new Promise(resolve=>setTimeout(resolve,10));
    let snapshot=h.sent.at(-1);assert.equal(snapshot.projection,'progress');assert.equal(snapshot.progress.readOnly,true);assert.equal(snapshot.progress.summary.total,1);assert.deepEqual(snapshot.nodes,[]);assert.equal(fs.existsSync(path.join(root,'.svtools')),false);
    const link=snapshot.progress.modules[0].references[0];await h.message({action:'openProgress',linkId:link.id,revision:snapshot.revision});for(let i=0;i<50&&!h.calls.some(call=>call[0]==='vscode.open');i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(h.calls.some(call=>call[0]==='vscode.open'&&call[1].fsPath===fs.realpathSync.native(path.join(root,'top.sv'))),JSON.stringify({calls:h.calls,expected:fs.realpathSync.native(path.join(root,'top.sv')),errors:h.errors}));
    const count=h.calls.length;await h.message({action:'openProgress',linkId:'arbitrary-path',revision:snapshot.revision});assert.equal(h.calls.length,count);
    await h.message({action:'openProgress',linkId:link.id,revision:snapshot.revision-1});assert.equal(h.calls.length,count);
    h.setProject({id:'other',name:'other',kind:'svtools',root,sets:[]});await h.api.refresh();await h.message({action:'openProgress',linkId:link.id,revision:h.api.getSnapshot().revision});assert.equal(h.calls.length,count);
});

test('设计讲解保留未触发结论，候选变化后收起原判断，并拒绝工程外路径', async t => {
    const { createHash } = require('node:crypto');
    const { loadReview, revealObservation, loadReviewSample } = require('../src/design/review-model');
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'svtools-review-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const trace = '$timescale 1 ns $end\n$scope module t $end $var wire 4 ! q [3:0] $end $upscope $end $enddefinitions $end\n#10 b1000 !\n';
    const files = [['rtl', 'top.sv', 'module top; endmodule'], ['log', 'run.log', 'cover hits: 0'], ['vcd', 'trace.vcd', trace]];
    for (const [, file, content] of files) fs.writeFileSync(path.join(root, file), content);
    const manifest = { schemaVersion: 1, title: 'Review', files: files.map(([id, file, content]) => ({
        id, path: file, sha256: createHash('sha256').update(content).digest('hex'),
    })), rules: [{ id: 'ready', title: 'Ready', module: 'top', contract: 'ready at n+1',
        group: 'Bus',
        interfaces: [{ id: 'handoff', title: 'Write response to address',
            from: { module: 'source', expectation: 'can hold VALID', refs: [{ file: 'rtl', label: 'source', line: 1 }] },
            to: { module: 'sink', expectation: 'sample with READY' }, status: 'unresolved', rationale: 'needs a timing test' }],
        mechanism: 'hold', stimulus: 'requests', checker: 'cover', variants: [{ id: 'a', label: 'A', inputs: ['rtl'] }],
        events: [{ id: 'n1', title: 'n+1', expected: 'ready', interfaces: ['handoff'], flow: [{ label: 'control', detail: 'observe' }],
            expectedValues: [{ id: 'sample-expected', label: 'signed data', encoding: 'signed', value: '-8' }],
            refs: [{ file: 'rtl', label: 'source', line: 1 }],
            observations: [{ variant: 'a', status: 'not_triggered', text: 'cover hits: 0',
                refs: [{ file: 'log', label: 'coverage', line: 1 },
                    { file: 'vcd', label: 'sample', sample: { at: '10', signals: ['t.q'],
                        expect: [{ signal: 't.q', id: 'sample-expected' }] } }] }] }],
    }] };
    const file = path.join(root, 'svtools.review.json');
    fs.writeFileSync(file, JSON.stringify(manifest));
    const { snapshot, links, observations } = await loadReview(root);
    const rule = snapshot.rules[0];
    assert.equal(rule.group, 'Bus');
    assert.deepEqual(rule.events[0].interfaces, ['handoff']);
    assert.equal(rule.interfaces[0].to.expectation, 'sample with READY');
    assert.equal(links.get(rule.interfaces[0].from.refs[0].token).file.path, 'top.sv');
    const request = snapshot.rules[0].events[0].evidence[0];
    assert.deepEqual(Object.keys(request).sort(), ['token', 'variant']);
    const observation = observations.get(request.token);
    assert.equal((await revealObservation(root, observation)).status, 'not_triggered');
    const sample = await loadReviewSample(root, links.get(observation.refs[1].token));
    assert.deepEqual(sample.checks.map(item => [item.signal, item.actual, item.status]), [['t.q', '-8', 'match']]);
    fs.appendFileSync(path.join(root, 'top.sv'), '\n//changed');
    const stale = await revealObservation(root, observation);
    assert.equal(stale.status, 'unavailable');
    assert.deepEqual(stale.refs, []);
    const expectedBinding = manifest.rules[0].events[0].observations[0].refs[1].sample.expect[0];
    expectedBinding.id = 'missing';
    fs.writeFileSync(file, JSON.stringify(manifest));
    await assert.rejects(loadReview(root), /sample\.expect/);
    expectedBinding.id = 'sample-expected';
    manifest.rules[0].events[0].interfaces = ['missing'];
    fs.writeFileSync(file, JSON.stringify(manifest));
    await assert.rejects(loadReview(root), /events\.n1\.interfaces/);
    manifest.files[0].path = '../outside.sv';
    fs.writeFileSync(file, JSON.stringify(manifest));
    await assert.rejects(loadReview(root), /files\.rtl\.path/);
});

test('定版 Note 可独立打开，测试台变更使原仿真证据退出当前结论', async t => {
    const { createHash } = require('node:crypto');
    const history = require('../src/design/note-history-store');
    const { loadReview, verifiedNote, revealObservation, verifyObservationLink } = require('../src/design/review-model');
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'svtools-review-note-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const noteId = 'nt_pinned', content = '# Hold\n\nPinned design explanation\n';
    const hash = value => createHash('sha256').update(value).digest('hex');
    const version = await history.record(root, noteId, content, 'checkpoint', 'Before review');
    const inputs = [
        ['rtl', 'fifo.sv', 'module fifo;\n//: Hold [note:nt_pinned]\nendmodule\n', 'RTL'],
        ['tb', 'tb.sv', 'module tb; endmodule\n', '测试台'],
        ['log', 'run.log', 'TC-01 passed\n', '运行日志'],
    ];
    const files = inputs.map(([id, file, text, label]) => {
        fs.writeFileSync(path.join(root, file), text);
        return { id, path: file, label, sha256: hash(text) };
    });
    const runText = JSON.stringify({ schemaVersion: 1, inputs: files.slice(0, 2), artifacts: [files[2]] });
    fs.writeFileSync(path.join(root, 'run.json'), runText);
    files.push({ id: 'run', path: 'run.json', label: '运行记录', sha256: hash(runText) });
    const manifest = { schemaVersion: 1, title: 'Pinned review', files, rules: [{
        id: 'hold', title: 'Hold', module: 'fifo', note: {
            id: noteId, version, sha256: hash(content), anchor: { file: 'rtl', line: 2 },
        }, contract: 'Hold', mechanism: 'Enable', stimulus: 'Stall', checker: 'Compare',
        variants: [{ id: 'v', label: 'Run 1', inputs: ['rtl', 'tb'], run: 'run' }],
        events: [{ id: 'e', title: 'Hold', expected: 'Stable', refs: [], flow: [{ label: 'Wait', detail: 'No enable' }],
            observations: [{ variant: 'v', status: 'passed', text: 'One check passed', refs: [{ file: 'log', label: 'Log' }] }] }],
    }] };
    const indexFile = path.join(root, 'svtools.review.json');
    fs.writeFileSync(indexFile, JSON.stringify(manifest));
    const view = await loadReview(root);
    const pin = view.notes.get(view.snapshot.rules[0].note.token);
    const observation = view.observations.values().next().value;
    assert.equal((await verifiedNote(root, pin)).content, content);
    assert.equal((await revealObservation(root, observation)).status, 'passed');

    fs.appendFileSync(path.join(root, 'tb.sv'), '// changed test\n');
    assert.deepEqual(await revealObservation(root, observation), {
        status: 'unavailable', text: '以下定版输入或产物需重新核对。', refs: [],
        issues: [{ label: '测试台', path: 'tb.sv', reason: 'changed' }],
    });
    await assert.rejects(verifyObservationLink(root, view.links.get(observation.refs[0].token)), /测试台/);
    assert.equal((await verifiedNote(root, pin)).content, content);

    files[1].sha256 = hash(fs.readFileSync(path.join(root, 'tb.sv')));
    fs.writeFileSync(indexFile, JSON.stringify(manifest));
    const rebound = await loadReview(root);
    assert.deepEqual((await revealObservation(root, rebound.observations.values().next().value)).issues,
        [{ label: '测试台', path: 'tb.sv', reason: 'run-input' }]);

    fs.writeFileSync(path.join(root, 'tb.sv'), inputs[1][2]);
    files[1].sha256 = hash(inputs[1][2]);
    manifest.rules[0].note.anchor.line = 3;
    fs.writeFileSync(indexFile, JSON.stringify(manifest));
    const edit = await loadReview(root);
    assert.deepEqual((await revealObservation(root, edit.observations.values().next().value)).issues,
        [{ label: 'RTL 锚点', path: 'fifo.sv', reason: 'anchor' }]);
    manifest.rules[0].note.sha256 = 'b'.repeat(64);
    fs.writeFileSync(indexFile, JSON.stringify(manifest));
    const tampered = await loadReview(root);
    await assert.rejects(verifiedNote(root, tampered.notes.values().next().value), /定版记录不一致/);
});

test('编辑器定版从运行记录创建可复核快照并保留已有规则', async t => {
    const { createHash } = require('node:crypto');
    const history = require('../src/design/note-history-store');
    const { preparePin, savePin } = require('../src/design/review-pin');
    const { exportNotes } = require('../src/design/note-export');
    const { loadReview, verifiedNote, revealObservation } = require('../src/design/review-model');
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'svtools-note-pin-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }, () => {}));
    const id = 'nt_freeze', content = '# 复核标题\n\n说明与代码锚点绑定。\n';
    fs.mkdirSync(path.join(root, 'docs/design-notes'), { recursive: true });
    fs.writeFileSync(path.join(root, history.notePath(id)), content);
    function artifact(file, text) {
        fs.writeFileSync(path.join(root, file), text);
        return { path: file, sha256: createHash('sha256').update(text).digest('hex') };
    }
    const rtl = artifact('engine.sv', 'module engine;\n//: 冻结 [note:nt_freeze]\nendmodule\n');
    const testbench = artifact('tb.sv', 'module tb;\ninitial check_bit();\nendmodule\n');
    const wave = artifact('wave.vcd', 'VCD output');
    const log = artifact('run.log', 'check result');
    artifact('run.json', JSON.stringify({ schemaVersion: 1, runId: 'run-42', entry: testbench.path,
        inputs: [rtl, testbench], artifacts: [log, { ...wave, sample: { at: '5 ns', signals: ['tb.hold'] } }] }));
    const prepared = await preparePin(root, id, 'run.json');
    assert.deepEqual(prepared.anchors, [{ path: rtl.path, line: 2, title: '冻结' }]);
    const selection = { anchor: prepared.anchors[0], testbench: testbench.path, line: 2, artifacts: prepared.run.artifacts };

    fs.appendFileSync(path.join(root, testbench.path), '// diff\n');
    await assert.rejects(savePin(root, id, prepared, selection), /tb\.sv/);
    assert.equal(fs.existsSync(path.join(root, 'svtools.review.json')), false);
    assert.deepEqual((await history.listRevisions(root, id)).revisions, []);
    fs.writeFileSync(path.join(root, testbench.path), 'module tb;\ninitial check_bit();\nendmodule\n');

    const first = await savePin(root, id, prepared, selection);
    let review = await loadReview(root);
    const pinned = review.snapshot.rules[0];
    const frozen = await verifiedNote(root, review.notes.get(pinned.note.token));
    assert.equal(frozen.content, content);
    assert.equal(pinned.id, first);
    const observed = await revealObservation(root, review.observations.get(pinned.events[0].evidence[0].token));
    assert.equal(observed.status, 'pending_review');
    const pending = await exportNotes(root, { note: id, final: true, out: 'pending-notes', imageFormat: 'md' });
    assert.deepEqual(pending.notes[0].verification, { status: 'pending_review', outcomes: ['pending_review'] });
    const file = path.join(root, 'svtools.review.json');
    const index = JSON.parse(fs.readFileSync(file, 'utf8'));
    index.rules[0].events[0].observations[0].status = 'not_triggered';
    fs.writeFileSync(file, JSON.stringify(index));
    const captured = await exportNotes(root, { note: id, final: true, out: 'reviewed-notes', imageFormat: 'md' });
    assert.deepEqual(captured.notes[0].verification, { status: 'review_recorded', outcomes: ['not_triggered'] });
    assert.deepEqual(observed.refs.map(ref => ref.label), ['打开运行记录', 'run.log', 'wave.vcd']);
    const waveLink = review.links.get(observed.refs[2].token);
    assert.deepEqual(waveLink.sample.signals, ['tb.hold']);
    assert.equal(waveLink.sample.at, '5 ns');
    assert.equal(review.links.get(pinned.events[0].refs[1].token).line, 2);

    fs.writeFileSync(path.join(root, history.notePath(id)), '# 下一次定版\n');
    const second = await savePin(root, id, prepared, selection);
    review = await loadReview(root);
    assert.deepEqual(review.snapshot.rules.map(rule => rule.id), [first, second]);
    assert.equal((await verifiedNote(root, review.notes.get(review.snapshot.rules[0].note.token))).content, content);
    const source = JSON.parse(fs.readFileSync(path.join(root, 'svtools.review.json'), 'utf8'));
    assert.equal(source.files.length, 5);
});
