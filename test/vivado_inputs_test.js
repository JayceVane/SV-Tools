'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {run,report}=require('../src/agent/vivado');
const {resolveContext}=require('../src/agent/context');
const {captureInputs,materialize}=require('../src/agent/vivado-inputs');
const {parseXprText}=require('../src/vivado/xpr');
const {randomUUID}=require('node:crypto');
const {directory,writeJson}=require('../src/agent/storage');
const tasks=require('../src/agent/tasks');
const configuration=(top='top',part='xc7z100ffg900-2',define='8',state='current')=>`<Project><Configuration><Option Name="Part" Val="${part}"/></Configuration><FileSets><FileSet Name="sources_1" Type="DesignSrcs"><File Path="$PPRDIR/top.sv"/><Config><Option Name="TopModule" Val="${top}"/><Define Name="WIDTH" Val="${define}"/></Config></FileSet><FileSet Name="constrs_1" Type="Constrs"><File Path="$PPRDIR/top.xdc"/></FileSet></FileSets><Runs><Run Id="synth_1" SrcSet="sources_1" Part="${part}" State="${state}"/></Runs></Project>`;
async function fixture(t) {
    const workspace=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'svtools-vivado-inputs-')));
    t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
    await fs.writeFile(path.join(workspace,'top.sv'),'module top;endmodule\nmodule other;endmodule');
    await fs.writeFile(path.join(workspace,'top.xdc'),'create_clock -period 10 [get_ports clk]');
    await fs.writeFile(path.join(workspace,'top.xpr'),configuration());
    return {workspace,project:'top.xpr',run:'synth_1'};
}
async function completed({snapshot}) {
    const checkpoint=path.join(snapshot.root,'test.dcp');await fs.writeFile(checkpoint,'DCP from immutable inputs');
    return 'SVTOOLS_RUN_STATUS synth_design Complete! 100%\nSVTOOLS_RUN_VERSION test\nSVTOOLS_CHECKPOINT '+checkpoint+'\nSVTOOLS_DONE\n';
}
const timing=async()=> 'SVTOOLS_JSON {"run":"synth_1","paths":[]}\nSVTOOLS_DONE\n';
test('配置绑定包含top、器件、宏；运行时State不使报告误过期',async t=>{
    const input=await fixture(t);await run(input,{runner:completed});
    for(const config of [configuration('other'),configuration('top','xc7z020clg400-1'),configuration('top','xc7z100ffg900-2','16')]) {
        await fs.writeFile(path.join(input.workspace,'top.xpr'),config);
        const output=await report({...input,kind:'timing'},{runner:timing});assert.equal(output.data.stale,true);assert.equal(output.data.configurationChanged,true);
    }
    await fs.writeFile(path.join(input.workspace,'top.xpr'),configuration('top','xc7z100ffg900-2','8','out-of-date'));
    assert.equal((await report({...input,kind:'timing'},{runner:timing})).data.stale,false);
});
test('运行器只读取隔离输入；改源后不能把B绑定为A，还原后也不复活失败记录',async t=>{
    const input=await fixture(t),file=path.join(input.workspace,'top.sv'),original=await fs.readFile(file,'utf8');
    await assert.rejects(run(input,{runner:async args=>{
        await fs.writeFile(file,original+'\n// B');
        const copy=args.snapshot.copies.find(copy=>copy.original===file);
        assert.equal(await fs.readFile(copy.path,'utf8'),original);
        assert(!args.script.includes('open_project {'+path.join(input.workspace,'top.xpr').replace(/\\/g,'/')+'}'));
        return completed(args);
    }}),{code:'CONTEXT_CHANGED'});
    await fs.writeFile(file,original);
    await assert.rejects(report({...input,kind:'timing'},{runner:timing}),{code:'VIVADO_RUN_FAILED'});
});
test('排队后上下文改变在调用工具前拒绝，保留原工程文件',async t=>{
    const input=await fixture(t),file=path.join(input.workspace,'top.sv');let invoked=false;
    await assert.rejects(run(input,{onContext:()=>fs.appendFile(file,'\n// changed while queued'),runner:async args=>{invoked=true;return completed(args);}}),{code:'CONTEXT_CHANGED'});
    assert.equal(invoked,false);
    assert.equal(await fs.readFile(path.join(input.workspace,'top.xpr'),'utf8'),configuration());
});
test('检查点必须存在且保持原始内容，不以旧manifest掩盖产物替换',async t=>{
    const input=await fixture(t);let checkpoint;
    await run(input,{runner:async args=>{checkpoint=path.join(args.snapshot.root,'test.dcp');return completed(args);}});
    await fs.writeFile(checkpoint,'replaced');
    await assert.rejects(report({...input,kind:'timing'},{runner:timing}),{code:'ARTIFACT_INVALID'});
});
test('生成工程重定位源码、约束、include，且拒绝未知脚本/IP依赖',async t=>{
    const input=await fixture(t);await fs.writeFile(path.join(input.workspace,'defs.svh'),'`define YES 1');
    await fs.writeFile(path.join(input.workspace,'top.xpr'),configuration().replace('<Project>','<Project><DefaultLaunch Dir="D:/original-runs"/>'));
    await fs.writeFile(path.join(input.workspace,'top.sv'),'`include "defs.svh"\nmodule top;endmodule');
    const resolved=await resolveContext(input),captured=await captureInputs(resolved,'synth_1');
    const root=path.join(input.workspace,'.svtools','build'),snapshot=await materialize(captured,resolved,root);
    const parsed=parseXprText(await fs.readFile(snapshot.project,'utf8'),snapshot.project);
    assert.match(await fs.readFile(snapshot.project,'utf8'),/DefaultLaunch Dir="\$PRUNDIR"/);
    assert(parsed.sets.flatMap(set=>set.files).every(file=>file.startsWith(root)));
    const source=snapshot.copies.find(copy=>copy.original.endsWith('top.sv'));assert((await fs.readFile(source.path,'utf8')).includes(root.replace(/\\/g,'/')));
    await fs.writeFile(path.join(input.workspace,'top.xdc'),'source external.tcl');
    const next=await resolveContext(input),capture=await captureInputs(next,'synth_1');
    await assert.rejects(materialize(capture,next,path.join(input.workspace,'.svtools','other')),{code:'SNAPSHOT_UNSUPPORTED'});
    await fs.writeFile(path.join(input.workspace,'top.xpr'),configuration().replace('<File Path="$PPRDIR/top.sv"/>','<File Path="$PPRDIR/top.sv"/><File Path="$PPRDIR/ip.xci"/>'));
    await assert.rejects(captureInputs(await resolveContext(input),'synth_1'),{code:'SNAPSHOT_UNSUPPORTED'});
});
test('非完成状态和缺检查点均不能写成功绑定',async t=>{
    const input=await fixture(t);
    for(const status of ['synth_design Cancelled 25%','synth_design Running 20%','synth_design ERROR Complete! 100%']) {
        await assert.rejects(run(input,{runner:async()=> 'SVTOOLS_RUN_STATUS '+status+'\nSVTOOLS_DONE\n'}),{code:'VIVADO_RUN_FAILED'});
    }
    await assert.rejects(run(input,{runner:async()=> 'SVTOOLS_RUN_STATUS synth_design Complete! 100%\nSVTOOLS_DONE\n'}),{code:'VIVADO_NO_RESULT'});
});

test('后台结果当前性包含初始化数据，不能仅比较RTL上下文revision',async t=>{
    const input=await fixture(t),xpr=path.join(input.workspace,'top.xpr'),data=path.join(input.workspace,'rom.mem');
    await fs.writeFile(data,'00');
    await fs.writeFile(xpr,configuration().replace('<File Path="$PPRDIR/top.sv"/>','<File Path="$PPRDIR/top.sv"/><File Path="$PPRDIR/rom.mem"/>'));
    const original=(await resolveContext(input)).context.revision,output=await run(input,{runner:completed});
    const id=randomUUID(),folder=await directory(input.workspace,'tasks',id);
    await writeJson(path.join(folder,'request.json'),{operation:'vivado.run',options:input});
    await writeJson(path.join(folder,'status.json'),{id,state:'succeeded',createdAt:new Date().toISOString()});
    await writeJson(path.join(folder,'result.json'),output);
    assert.equal((await tasks.status(input,id)).data.sourceCurrent,true);
    await fs.writeFile(data,'FF');
    assert.equal((await resolveContext(input)).context.revision,original);
    assert.equal((await tasks.status(input,id)).data.sourceCurrent,false);
    assert.equal((await report({...input,kind:'timing'},{runner:timing})).data.stale,true);
});

test('没有绑定的既有IP工程仍可查询报告，但只能返回来源未知',async t=>{
    const input=await fixture(t),xpr=path.join(input.workspace,'top.xpr');
    await fs.writeFile(xpr,configuration().replace('<File Path="$PPRDIR/top.sv"/>','<File Path="$PPRDIR/top.sv"/><File Path="$PPRDIR/ip.xci"/>'));
    const output=await report({...input,kind:'timing'},{runner:timing});
    assert.equal(output.status,'success');assert.equal(output.data.stale,null);assert.equal(output.data.runInfo,null);
    await assert.rejects(run(input,{runner:completed}),{code:'SNAPSHOT_UNSUPPORTED'});
});
