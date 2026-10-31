'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {resolveContext,assertCurrent}=require('../src/agent/context');
const {readProjectSnapshot}=require('../src/project/model');
const {run}=require('../src/cli/main');
async function fixture(t) {
    const workspace=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'svtools-agent-context-')));
    t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
    await fs.writeFile(path.join(workspace,'top.sv'),'module top; endmodule\n');
    return workspace;
}
async function project(workspace,name,changes={}) {
    const folder=path.join(workspace,'.svtools','projects');await fs.mkdir(folder,{recursive:true});
    const file=path.join(folder,name+'.json');
    await fs.writeFile(file,JSON.stringify({schemaVersion:1,name,root:'../..',sources:['top.sv'],simulation:[],includeDirs:[],defines:[],exclude:[],folders:[],top:'top',simTop:'',...changes}));
    return file;
}
test('无编辑器工程模型与CLI使用相同成员/文件集，并拒绝多工程歧义',async t=>{
    const workspace=await fixture(t), file=await project(workspace,'one');
    const shared=await readProjectSnapshot({kind:'svtools',path:file});
    const first=await resolveContext({workspace});
    assert.deepEqual(first.context.files.map(file=>file.path),shared.sets[0].files);
    assert.equal(first.context.top,'top');assert.equal(first.context.fileset,'sources');
    await project(workspace,'two');
    await assert.rejects(resolveContext({workspace}),{code:'AMBIGUOUS_PROJECT'});
    assert.equal((await resolveContext({workspace,project:file})).context.project.name,'one');
});
test('哈希身份发现相同文件长度和mtime的修改，配置和头文件变化也使快照失效',async t=>{
    const workspace=await fixture(t), file=path.join(workspace,'top.sv');
    const initial=await resolveContext({workspace}), stat=await fs.stat(file);
    await fs.writeFile(file,'module foo; endmodule\n');await fs.utimes(file,stat.atime,stat.mtime);
    await assert.rejects(assertCurrent(initial),{code:'CONTEXT_CHANGED'});
    await fs.writeFile(path.join(workspace,'defs.svh'),'`define X 1');
    const next=await resolveContext({workspace});
    await fs.writeFile(path.join(workspace,'defs.svh'),'`define X 2');
    await assert.rejects(assertCurrent(next),{code:'CONTEXT_CHANGED'});
    const last=await resolveContext({workspace});await fs.mkdir(path.join(workspace,'.svtools'),{recursive:true});
    await fs.writeFile(path.join(workspace,'.svtools','cli.json'),JSON.stringify({schemaVersion:1,defines:['SIM']}));
    await assert.rejects(assertCurrent(last),{code:'CONTEXT_CHANGED'});
});
test('显式XPR设计文件集不会混入其他设计文件集，仿真关联歧义明确返回',async t=>{
    const workspace=await fixture(t);await fs.writeFile(path.join(workspace,'other.sv'),'module other;endmodule');
    const file=path.join(workspace,'design.xpr');
    await fs.writeFile(file,'<Project><FileSets><FileSet Name="src1" Type="DesignSrcs"><File Path="$PPRDIR/top.sv"/></FileSet><FileSet Name="src2" Type="DesignSrcs"><File Path="$PPRDIR/other.sv"/></FileSet><FileSet Name="sim" Type="SimulationSrcs"/></FileSets></Project>');
    await assert.rejects(resolveContext({workspace}),{code:'AMBIGUOUS_FILESET'});
    const value=await resolveContext({workspace,fileset:'src1'});
    assert.deepEqual(value.context.files.map(file=>path.basename(file.path)),['top.sv']);
    await assert.rejects(resolveContext({workspace,fileset:'sim'}),{code:'AMBIGUOUS_SOURCESET'});
});
test('自动扫描排除生成目录；严格UTF8、源码预算、配置字段和分页有界',async t=>{
    const workspace=await fixture(t);await fs.mkdir(path.join(workspace,'.svtools','generated'),{recursive:true});
    await fs.writeFile(path.join(workspace,'.svtools','generated','ghost.sv'),'module ghost;endmodule');
    assert.equal((await resolveContext({workspace})).context.files.length,1);
    await fs.writeFile(path.join(workspace,'broken.v'),Buffer.from([255,254]));
    await assert.rejects(resolveContext({workspace}),/encoded|encoding|编码/i);await fs.unlink(path.join(workspace,'broken.v'));
    const folder=path.join(workspace,'.svtools');
    for(const value of [null,[],{schemaVersion:1,command:'arbitrary'},{schemaVersion:1,timeoutMs:0},{schemaVersion:1,format:{tabSize:'oops'}},{schemaVersion:1,format:{invented:true}}]) {
        await fs.writeFile(path.join(folder,'cli.json'),JSON.stringify(value));await assert.rejects(resolveContext({workspace}),{code:'CONFIG_INVALID'});
    }
    await fs.unlink(path.join(folder,'cli.json'));
    const value=await run(['project','inspect','--workspace',workspace,'--limit','201']);assert.equal(value.exitCode,2);
    const handle=await fs.open(path.join(workspace,'huge.v'),'w');await handle.truncate(8*1024*1024+1);await handle.close();
    await assert.rejects(resolveContext({workspace}),{code:'SOURCE_LIMIT'});
});
test('选定文件必须属于工程；缺失依赖和未知参数不会作为成功返回',async t=>{
    const workspace=await fixture(t);await project(workspace,'only');
    await fs.writeFile(path.join(workspace,'excluded.sv'),'module excluded;endmodule');
    await assert.rejects(resolveContext({workspace,file:'excluded.sv'}),{code:'FILE_NOT_IN_CONTEXT'});
    for(const args of [['lint','--iverilog','no-such-tool','--file','top.sv'],['lint','--write'],['project','inspect','--wat'],['task','status','../escape']]) {
        const value=await run([...args,'--workspace',workspace]);assert.equal(value.output.status,'failed');assert.equal(value.exitCode,2);
    }
});
module.exports={fixture};
