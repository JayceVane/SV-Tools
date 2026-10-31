'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {runProcess}=require('../src/toolchains/process');
const {acquireWorkspaceLease}=require('../src/toolchains/workspace-lease');
const {run}=require('../src/cli/main');
const {resolveContext}=require('../src/agent/context');
const {lint}=require('../src/agent/operations');
const {findIverilogBinDir}=require('../src/toolchains/iverilog');
const {preservesCharacters}=require('../src/editor/format-safety');
const cli=path.resolve(__dirname,'../src/cli/main.js');
async function fixture(t) {
    const workspace=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'svtools-agent-工程 ')));
    t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
    await fs.writeFile(path.join(workspace,'top.sv'),'module top(input a,output b); child u(a,b); endmodule\n');
    await fs.writeFile(path.join(workspace,'child.sv'),'module child(input a,output b); assign b=a; endmodule\n');
    return workspace;
}
async function command(workspace,args) {
    const output=await runProcess(process.execPath,[cli,...args,'--workspace',workspace],{timeoutMs:15000});
    assert.equal(output.stderr,'');
    return {code:output.code,json:JSON.parse(output.stdout)};
}
test('真实CLI子进程输出单份JSON，公共服务导入不加载vscode',async t=>{
    const workspace=await fixture(t);
    const inspected=await command(workspace,['project','inspect','--limit','1']);
    assert.equal(inspected.code,0);assert.equal(inspected.json.apiVersion,'1');assert.equal(inspected.json.data.files.items.length,1);
    const invalid=await command(workspace,['unknown']);assert.equal(invalid.code,2);assert.equal(invalid.json.status,'failed');
    const guarded=await runProcess(process.execPath,['-e',`const Module=require('module'),load=Module._load;Module._load=function(n,...a){if(n==='vscode')throw Error('IDE loaded');return load.call(this,n,...a)};require(${JSON.stringify(cli)}).run(['project','inspect','--workspace',${JSON.stringify(workspace)}]).then(r=>{if(r.exitCode)throw Error(JSON.stringify(r))});`],{timeoutMs:15000});
    assert.equal(guarded.code,0,guarded.stderr);
});
test('格式化预览只读，check非零，显式写入保全字符且复验幂等；旧Rust CLI继续可用',async t=>{
    const workspace=await fixture(t), file=path.join(workspace,'top.sv'), source=await fs.readFile(file,'utf8');
    const preview=await command(workspace,['format','--file','top.sv']);
    assert.equal(preview.code,0);assert.equal(preview.json.data.written,false);assert.equal(await fs.readFile(file,'utf8'),source);
    assert.equal((await command(workspace,['format','--file','top.sv','--check'])).code,1);
    assert.equal((await command(workspace,['format','--file','top.sv','--write'])).json.data.written,true);
    assert(preservesCharacters(source,await fs.readFile(file,'utf8')));
    assert.equal((await command(workspace,['format','--file','top.sv','--check'])).code,0);
    const binary=path.resolve(__dirname,'../bin',process.platform==='win32'?'svtools.exe':'svtools');
    const old=await runProcess(binary,['--check',file],{timeoutMs:15000});assert.equal(old.code,0,old.stderr);
});
test('跨进程租约限制同一资源，拥有者退出自动释放，排队可以取消',async t=>{
    const workspace=await fixture(t), lease=path.resolve(__dirname,'../src/toolchains/workspace-lease.js');
    const child=spawn(process.execPath,['-e',`require(${JSON.stringify(lease)}).acquireWorkspaceLease(${JSON.stringify(workspace)},'test-owned').then(()=>{console.log('ready');setInterval(()=>{},1000)});`],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    t.after(()=>{if(child.exitCode===null)child.kill();});
    await new Promise((done,reject)=>{child.stdout.once('data',done);child.once('error',reject);child.once('exit',code=>reject(Error('early exit '+code)));});
    await assert.rejects(acquireWorkspaceLease(workspace,'test-owned',{waitMs:0}),{code:'RESOURCE_BUSY'});
    const controller=new AbortController(), waiting=acquireWorkspaceLease(workspace,'test-owned',{signal:controller.signal});controller.abort();
    await assert.rejects(waiting,{name:'AbortError'});
    child.kill();await new Promise(done=>child.once('exit',done));
    const release=await acquireWorkspaceLease(workspace,'test-owned',{waitMs:2000});await release();
});
const haveIcarus=!!findIverilogBinDir('');
test('真实Icarus：依赖补入、头文件快照、原路径诊断、失败不伪装通过', {skip:!haveIcarus},async t=>{
    const workspace=await fixture(t);
    await fs.writeFile(path.join(workspace,'bits.svh'),'`define BITS 1');
    await fs.writeFile(path.join(workspace,'child.sv'),'`include "bits.svh"\nmodule child(input a,output b);assign b=a;endmodule');
    const good=await command(workspace,['lint','--file','top.sv','--top','top']);
    assert.equal(good.code,0,JSON.stringify(good));assert.equal(good.json.data.files.length,2);assert(good.json.data.tool.version.includes('Icarus'));
    const manifest=JSON.parse(await fs.readFile(good.json.artifacts.find(a=>a.kind==='manifest').path,'utf8'));
    assert.equal(manifest.runId,good.json.data.runId);assert.equal(manifest.context.revision,good.json.context.revision);
    assert.equal(good.json.artifacts.filter(a=>a.kind==='log').length,3);
    await fs.writeFile(path.join(workspace,'child.sv'),'module child(input a,output b);\n assign b = ;\nendmodule');
    const bad=await command(workspace,['lint','--file','top.sv','--top','top']);assert.equal(bad.code,1,JSON.stringify(bad));
    assert.equal(bad.json.status,'failed');assert(bad.json.diagnostics.some(d=>d.file===path.join(workspace,'child.sv') && d.line===2));
});
test('未解析include的诊断指向原始名称，不泄漏本轮快照路径', {skip:!haveIcarus},async t=>{
    const workspace=await fixture(t);
    await fs.writeFile(path.join(workspace,'child.sv'),'`include "missing.svh"\nmodule child(input a,output b);assign b=a;endmodule');
    const output=await command(workspace,['lint','--file','top.sv','--top','top']);
    assert.equal(output.code,1,JSON.stringify(output));
    const text=JSON.stringify(output.json.diagnostics);
    assert(!/unresolved/.test(text) && !/\.svtools/.test(text), text);
    assert(/missing\.svh/.test(text), text);
});
test('真实Icarus：排队时修改源码使结果失效，取消排队不会运行工具', {skip:!haveIcarus},async t=>{
    const workspace=await fixture(t), held=[await acquireWorkspaceLease(workspace,'tool-process',{slots:1})];
    // 第一槽已占用，第二次以slots=2取得另一槽。
    held.push(await acquireWorkspaceLease(workspace,'tool-process',{slots:2}));
    t.after(()=>Promise.all(held.map(release=>release())));
    let prepared;const ready=new Promise(done=>{prepared=done;});
    const pending=lint({workspace,file:'top.sv',top:'top'},{onContext:prepared});
    const rejected=assert.rejects(pending,{code:'CONTEXT_CHANGED'});
    await ready;await fs.appendFile(path.join(workspace,'top.sv'),'// changed');
    await Promise.all(held.map(release=>release()));await rejected;
    const again=[await acquireWorkspaceLease(workspace,'tool-process',{slots:1}),await acquireWorkspaceLease(workspace,'tool-process',{slots:2})];
    const controller=new AbortController();let cancelReady;
    const cancelPrepared=new Promise(done=>{cancelReady=done;});
    const cancelled=lint({workspace,file:'top.sv',top:'top'},{signal:controller.signal,onContext:cancelReady});
    const stopped=assert.rejects(cancelled,{code:'TOOL_CANCELLED'});
    await cancelPrepared;controller.abort();await stopped;await Promise.all(again.map(release=>release()));
    const before=(await resolveContext({workspace})).context.revision;
    await assert.rejects(lint({workspace,file:'top.sv',expectedRevision:'old'}),{code:'CONTEXT_CHANGED'});
    assert.equal((await resolveContext({workspace})).context.revision,before);
});
