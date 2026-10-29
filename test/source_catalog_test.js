'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSourceCatalog } = require('../src/workspace/source-catalog');
const uri = file => ({ fsPath: file, toString: () => file });
test('四种消费者共用发现缓存但各自约束扩展与预算，生成文件始终排除', async () => {
    let calls = 0;
    const vscode = { workspace: { async findFiles() { calls++; return ['/p/a.sv','/p/b.v','/p/defs.svh','/p/.svtools/tmp.sv'].map(uri); } } };
    const catalog = createSourceCatalog({ vscode });
    const [a,b] = await Promise.all([catalog.discover({ limit:2 }),catalog.discover({ extensions:['sv','v'],limit:10 })]);
    assert.equal(calls,1); assert.equal(a.truncated,true); assert.equal(b.uris.length,2);
    await catalog.discover({ limit:10 }); assert.equal(calls,1);
    catalog.invalidate(); await catalog.discover({}); assert.equal(calls,2); catalog.dispose();
});
test('工程成员优先且不会混入工作区替代实现，外部文件仍退回工作区发现', async () => {
    let project = { files: ['/p/design.sv','/p/tb.sv'], roots:['/p'], key:'first' }, calls=0;
    const catalog = createSourceCatalog({ vscode:{ Uri:{ file:uri },workspace:{ async findFiles(){ calls++;return [uri('/p/alternate.sv')]; } } },
        getPreferred: async ({ file }) => file === '/outside/top.sv' ? null : project });
    const first = await catalog.discover({file:'/p/wave.vcd'}); assert.deepEqual(first.uris.map(u=>u.fsPath),project.files); assert.equal(calls,0);
    project={...project,files:['/p/new.sv'],key:'second'};
    assert.deepEqual((await catalog.discover({file:'/p/wave.vcd'})).uris.map(u=>u.fsPath),['/p/new.sv']);
    assert.equal((await catalog.discover({file:'/outside/top.sv'})).uris[0].fsPath,'/p/alternate.sv'); catalog.dispose();
});
test('失效期间完成的发现不能污染新缓存，取消不会中断其它消费者', async () => {
    let finish, calls=0;
    const catalog=createSourceCatalog({vscode:{workspace:{findFiles(){calls++;return new Promise(resolve=>{finish=resolve;});}}}});
    const token={isCancellationRequested:false};const first=catalog.discover({token});await Promise.resolve();
    token.isCancellationRequested=true;catalog.invalidate();finish([uri('/p/old.sv')]);
    assert.equal((await first).truncated,true);const second=catalog.discover({});await Promise.resolve();finish([uri('/p/new.sv')]);
    assert.equal((await second).uris[0].fsPath,'/p/new.sv');assert.equal(calls,2);catalog.dispose();
});

test('扫描期间的真实新增会有界重读，不把清单世代变化误当作文件超限', async () => {
    const pending = [], catalog = createSourceCatalog({ vscode: { workspace: { findFiles: () => new Promise(resolve => pending.push(resolve)) } } });
    const request = catalog.discover();
    catalog.invalidate({ kind: 'create', uri: uri('/p/new.sv') }); pending.shift()([uri('/p/old.sv')]);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(pending.length, 1);
    pending.shift()([uri('/p/new.sv')]); const result = await request;
    assert.equal(result.truncated, false); assert.equal(result.uris[0].fsPath, '/p/new.sv'); catalog.dispose();
});

test('连续失效只重读一次，返回失效原因而不谎称清单完整', async () => {
    const pending = [], catalog = createSourceCatalog({ vscode: { workspace: { findFiles: () => new Promise(resolve => pending.push(resolve)) } } });
    const request = catalog.discover(); catalog.invalidate(); pending.shift()([uri('/p/a.sv')]);
    await new Promise(resolve => setImmediate(resolve)); catalog.invalidate(); pending.shift()([uri('/p/b.sv')]);
    const result = await request; assert.equal(result.invalidated, true); assert.equal(result.truncated, true);
    assert.equal(pending.length, 0); catalog.dispose();
});

test('工具产物和主题配置不会使源码缓存失效，相关配置仍会刷新', async () => {
    let configure, calls = 0;
    const catalog = createSourceCatalog({ vscode: { workspace: {
        findFiles: async () => { calls++; return [uri('/p/a.sv')]; },
        onDidChangeConfiguration(callback) { configure = callback; return { dispose() {} }; }
    } } });
    await catalog.discover(); catalog.invalidate({ kind: 'create', uri: uri('/p/.svtools/circuit/sources.sv') });
    configure({ affectsConfiguration: key => key === 'workbench.colorTheme' }); await catalog.discover(); assert.equal(calls, 1);
    configure({ affectsConfiguration: key => key === 'svtools' }); await catalog.discover(); assert.equal(calls, 2); catalog.dispose();
});

const { createCompletionIndex } = require('../src/editor/completion/index');
test('外部include目录新增文件使共享发现缓存失效，不依赖TTL或重新打开编辑器',async()=>{
    const contents=new Map([['/p/top.sv','module top; endmodule'],['/include/first.svh','typedef int first_word;']]),handlers=new Map();
    const vscode={Uri:{file:uri},RelativePattern:class{constructor(base){this.baseUri=uri(base);}},workspace:{textDocuments:[],workspaceFolders:[{uri:uri('/p')}],
        getConfiguration:()=>({get:(name,fallback)=>name==='includePaths'?['/include']:fallback}),
        async findFiles(pattern){return [...contents.keys()].filter(file=>file.startsWith(typeof pattern==='string'?'/p/':pattern.baseUri.fsPath+'/')).map(uri);},
        fs:{stat:async target=>({size:contents.get(target.fsPath).length}),readFile:async target=>Buffer.from(contents.get(target.fsPath))},
        createFileSystemWatcher(pattern){const callbacks={};handlers.set(typeof pattern==='string'?pattern:pattern.baseUri.fsPath,callbacks);
            return {onDidCreate(callback){callbacks.create=callback;return {dispose(){}};},onDidChange:()=>({dispose(){}}),onDidDelete:()=>({dispose(){}}),dispose(){}};}}};
    const catalog=createSourceCatalog({vscode}),index=createCompletionIndex({vscode,sourceCatalog:catalog}),document={uri:uri('/p/top.sv'),version:1,languageId:'systemverilog',getText:()=>contents.get('/p/top.sv')};
    await index.snapshot(document);contents.set('/include/new.svh','typedef int newly_created;');handlers.get('/include').create(uri('/include/new.svh'));
    const result=await index.snapshot(document);assert.ok(result.records.some(record=>record.model.symbols.some(s=>s.name==='newly_created')));
    index.dispose();catalog.dispose();
});

const fs = require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createProjectSourceProvider}=require('../src/workspace/project-sources');
test('真实XPR上下文按仿真入口收窄，保留设计集，手工打开VCD时不猜测多个仿真集',async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'svtools-project-context-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const xpr=path.join(root,'demo.xpr'),design=path.join(root,'design.sv'),a=path.join(root,'tb_a.sv'),b=path.join(root,'tb_b.sv');
    await fs.writeFile(xpr,'<Project><FileSets>'+[['sources_1','DesignSrcs','design.sv'],['sim_a','SimulationSrcs','tb_a.sv'],['sim_b','SimulationSrcs','tb_b.sv']].map(([name,type,file])=>`<FileSet Name="${name}" Type="${type}"><File Path="${file}"/></FileSet>`).join('')+'</FileSets></Project>');
    const provider=createProjectSourceProvider({vscode:{Uri:{file:uri},workspace:{getWorkspaceFolder:()=>({uri:uri(root)})}},projectSelection:{current:async()=>xpr}});
    assert.deepEqual((await provider({root,file:a})).files,[design,a]);
    assert.deepEqual((await provider({root,file:path.join(root,'wave.vcd')})).files,[design,a,b]);
    assert.equal(await provider({root,file:path.join(root,'alternate.sv')}),null);
});

test('空HDL清单的工程上下文回落工作区发现，不把空清单当作有效成员',async()=>{
    const vscode={Uri:{file:uri},workspace:{async findFiles(){return [uri('/p/workspace.sv')];}}};
    const provider=createProjectSourceProvider({vscode,projects:{current:async()=>({root:'/p',key:'empty',sets:[{type:'DesignSrcs',files:[]},{type:'SimulationSrcs',files:[]}]})}});
    assert.equal(await provider({root:'/p'}),null);
    const catalog=createSourceCatalog({vscode,getPreferred:provider});
    const result=await catalog.discover({file:'/p/top.sv'});
    assert.deepEqual(result.uris.map(item=>item.fsPath),['/p/workspace.sv']);
    assert.equal(result.provenance,'workspace');
    catalog.dispose();
});
