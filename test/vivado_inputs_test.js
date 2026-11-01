'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {run,report,incrementalStatus}=require('../src/agent/vivado');
const {resolveContext}=require('../src/agent/context');
const {captureInputs,materialize}=require('../src/agent/vivado-inputs');
const {parseXprText}=require('../src/vivado/xpr');
const {createHash,randomUUID}=require('node:crypto');
const {directory,writeJson}=require('../src/agent/storage');
const tasks=require('../src/agent/tasks');
const configuration=(top='top',part='xc7z100ffg900-2',define='8',state='current')=>`<Project><Configuration><Option Name="Part" Val="${part}"/></Configuration><FileSets><FileSet Name="sources_1" Type="DesignSrcs"><File Path="$PPRDIR/top.sv"/><Config><Option Name="TopModule" Val="${top}"/><Define Name="WIDTH" Val="${define}"/></Config></FileSet><FileSet Name="constrs_1" Type="Constrs"><File Path="$PPRDIR/top.xdc"/></FileSet></FileSets><Runs><Run Id="synth_1" SrcSet="sources_1" Part="${part}" State="${state}"/></Runs></Project>`;
const incrementalConfiguration=(checkpoint='ref.dcp',auto='false')=>configuration().replace('</Runs>',`<Run Id="impl_1" SrcSet="sources_1" Part="xc7z100ffg900-2" State="current" SynthRun="synth_1" IncrementalCheckpoint="$PPRDIR/${checkpoint}" AutoIncrementalCheckpoint="${auto}"/></Runs>`);
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


test('预算按输入类别独立：二进制大文件不受文本单文件上限约束',async t=>{
    const input=await fixture(t);
    const big=Buffer.alloc(20*1024*1024,0x41);
    await fs.writeFile(path.join(input.workspace,'big.dat'),big);
    await fs.writeFile(path.join(input.workspace,'top.xpr'),configuration().replace('<File Path="$PPRDIR/top.sv"/>','<File Path="$PPRDIR/top.sv"/><File Path="$PPRDIR/big.dat"/>'));
    const resolved=await resolveContext(input),captured=await captureInputs(resolved,'synth_1');
    const binary=captured.inputs.find(entry=>entry.path.endsWith('big.dat'));
    assert.equal(binary.kind,'binary');assert.equal(binary.size,big.length);
    assert(captured.used.binary>=big.length);
    await assert.rejects(captureInputs(await resolveContext({...input,budget:{binaryFileMiB:1}}),'synth_1'),{code:'SOURCE_LIMIT'});
});

test('文本文件按单文件预算拒绝，且错误给出实测大小',async t=>{
    const input=await fixture(t);
    await fs.writeFile(path.join(input.workspace,'top.sv'),'// '+('x'.repeat(2*1024*1024))+'\nmodule top;endmodule');
    await assert.rejects(resolveContext({...input,budget:{textFileMiB:1}}),error=>error.code==='SOURCE_LIMIT' && error.details.limit===1024*1024);
});

test('相同内容按哈希去重：两个文件只落一份缓存对象',async t=>{
    const input=await fixture(t),shared='module shared;endmodule';
    await fs.writeFile(path.join(input.workspace,'a.sv'),shared);
    await fs.writeFile(path.join(input.workspace,'b.sv'),shared);
    await fs.writeFile(path.join(input.workspace,'top.xpr'),configuration().replace('<File Path="$PPRDIR/top.sv"/>','<File Path="$PPRDIR/top.sv"/><File Path="$PPRDIR/a.sv"/><File Path="$PPRDIR/b.sv"/>'));
    const captured=await captureInputs(await resolveContext(input),'synth_1');
    const both=captured.inputs.filter(entry=>/a\.sv$|b\.sv$/.test(entry.path));
    assert.equal(both.length,2);assert.equal(both[0].sha256,both[1].sha256);
    const cache=path.join(input.workspace,'.svtools','agent','vivado','cache');
    const objects=[];for(const bucket of await fs.readdir(cache)) for(const name of await fs.readdir(path.join(cache,bucket))) if(!name.startsWith('.tmp-')) objects.push(name);
    assert.equal(objects.length,new Set(captured.inputs.map(entry=>entry.sha256)).size);
});

test('结果分四轴表达：执行/输入/可重建/验证不合并为单一可信',async t=>{
    const input=await fixture(t);
    const output=await run(input,{runner:completed});
    const evidence=output.data.evidence;
    assert.equal(evidence.execution.status,'synth_design Complete! 100%');assert.equal(evidence.execution.toolVersion,'test');
    assert.equal(evidence.inputs.completeness,'complete');assert(evidence.inputs.fingerprint);
    assert.equal(evidence.regeneration.mode,'source');
    assert.deepEqual(evidence.verification.checks,['synth']);assert.equal(evidence.verification.acceptance,false);
    const reportOut=await report({...input,kind:'timing'},{runner:timing});
    assert.equal(reportOut.data.evidence.regeneration.mode,'source');assert.equal(reportOut.data.stale,false);
});

test('没有绑定的既有IP工程仍可查询报告，但只能返回来源未知',async t=>{
    const input=await fixture(t),xpr=path.join(input.workspace,'top.xpr');
    await fs.writeFile(xpr,configuration().replace('<File Path="$PPRDIR/top.sv"/>','<File Path="$PPRDIR/top.sv"/><File Path="$PPRDIR/ip.xci"/>'));
    const output=await report({...input,kind:'timing'},{runner:timing});
    assert.equal(output.status,'success');assert.equal(output.data.stale,null);assert.equal(output.data.runInfo,null);
    await assert.rejects(run(input,{runner:completed}),{code:'SNAPSHOT_UNSUPPORTED'});
});

test('增量复用结论来自runme日志：两种Reuse Summary格式按表头解析，未加载时不声称复用',()=>{
    const four=['Command: read_checkpoint -incremental C:/ref.dcp',"INFO: [Vivado 12-9151] Incremental flow is being run with directive 'RuntimeOptimized'.",'| Reuse mode            |             High |','| Auto Incremental      |               No |','|  Type | Matched % (of Total) | Current Reuse % (of Total) | Fixed % (of Total) | Total |','| Cells |               100.00 |                     100.00 |               0.00 |    52 |','| Non-Reused Cells      | 0.00 |'];
    const status=incrementalStatus({lines:four},{sha256:'a'.repeat(64),size:10});
    assert.equal(status.requested,true);assert.equal(status.applied,true);assert.equal(status.reused,true);
    assert.equal(status.directive,'RuntimeOptimized');assert.equal(status.reuseMode,'High');assert.equal(status.autoIncremental,false);
    assert.deepEqual(status.reuse.Cells,{matched:100,reused:100,total:52});
    assert(status.evidence.some(line=>line.includes('12-9151')));assert.equal(status.nonReusedCells,0);
    const five=['|  Type | Matched % (of Initial Total) | Initial Reuse % (of Initial Total) | Current Reuse % (of Total) | Fixed % (of Total) | Total |','| Cells |                       100.00 |                             100.00 |                     100.00 |               0.00 |    52 |'];
    const partial=incrementalStatus({lines:five},{sha256:'b'.repeat(64),size:5});
    assert.equal(partial.reused,true);assert.equal(partial.reuse.Cells.reused,100);
    const none=incrementalStatus({lines:['Starting synth_design']},{sha256:'c'.repeat(64),size:1});
    assert.equal(none.applied,false);assert.equal(none.reused,false);assert.deepEqual(none.evidence,[]);
    const missing=incrementalStatus(null,{sha256:'d'.repeat(64),size:1});
    assert.equal(missing.applied,null);assert.equal(missing.reused,null);assert.equal(missing.requested,true);
    assert.equal(incrementalStatus({lines:[]},null).requested,false);
});

test('显式增量检查点按输入流式哈希并重定位；自动增量引用不复制',async t=>{
    const input=await fixture(t),ref=path.join(input.workspace,'ref.dcp'),bytes=Buffer.alloc(4096,0x5a);
    await fs.writeFile(ref,bytes);
    await fs.writeFile(path.join(input.workspace,'top.xpr'),incrementalConfiguration());
    const resolved=await resolveContext(input),captured=await captureInputs(resolved,'impl_1');
    assert.equal(captured.checkpoint.path,ref);
    assert.equal(captured.checkpoint.sha256,createHash('sha256').update(bytes).digest('hex'));
    const entry=captured.inputs.find(file=>file.role==='incremental-checkpoint');
    assert.equal(entry.path,ref);assert.equal(entry.kind,'binary');assert.equal(entry.size,bytes.length);
    const root=path.join(input.workspace,'.svtools','build'),snapshot=await materialize(captured,resolved,root);
    const text=await fs.readFile(snapshot.project,'utf8'),attr=/\bIncrementalCheckpoint="([^"]+)"/.exec(text)?.[1];
    assert(attr);assert(attr.startsWith(root.replace(/\\/g,'/')+'/'));assert(attr.endsWith('/ref.dcp'));
    assert.equal(Buffer.compare(await fs.readFile(attr),bytes),0);
    assert.match(text,/AutoIncrementalCheckpoint="false"/);
    await fs.writeFile(ref,Buffer.from('changed'));
    assert.notEqual((await captureInputs(await resolveContext(input),'impl_1')).fingerprint,captured.fingerprint);
    await fs.writeFile(path.join(input.workspace,'top.xpr'),incrementalConfiguration('impl_1/top_routed.dcp','true'));
    const auto=await captureInputs(await resolveContext(input),'impl_1');
    assert.equal(auto.checkpoint,null);
    const autoSnapshot=await materialize(auto,await resolveContext(input),path.join(input.workspace,'.svtools','auto'));
    assert.doesNotMatch(await fs.readFile(autoSnapshot.project,'utf8'),/\bIncrementalCheckpoint=/);
});

test('显式增量检查点缺失或不是DCP时明确失败，不回退到未绑定运行',async t=>{
    const input=await fixture(t);
    await fs.writeFile(path.join(input.workspace,'top.xpr'),incrementalConfiguration());
    await assert.rejects(captureInputs(await resolveContext(input),'impl_1'),{code:'SOURCE_NOT_FOUND'});
    await fs.writeFile(path.join(input.workspace,'ref.txt'),'not a dcp');
    await fs.writeFile(path.join(input.workspace,'top.xpr'),incrementalConfiguration('ref.txt'));
    await assert.rejects(captureInputs(await resolveContext(input),'impl_1'),{code:'SNAPSHOT_UNSUPPORTED'});
});

test('运行时区分输入/输出DCP，并以runme日志记录实际增量复用',async t=>{
    const input=await fixture(t);
    await fs.writeFile(path.join(input.workspace,'ref.dcp'),'reference checkpoint');
    await fs.writeFile(path.join(input.workspace,'top.xpr'),incrementalConfiguration());
    const output=await run({...input,run:'impl_1'},{runner:async({snapshot})=>{
        const base=path.basename(snapshot.project,'.xpr'),dir=path.join(path.dirname(snapshot.project),base+'.runs','impl_1');
        await fs.mkdir(dir,{recursive:true});
        await fs.writeFile(path.join(dir,'runme.log'),['Command: read_checkpoint -incremental C:/ref.dcp',"INFO: [Vivado 12-9151] Incremental flow is being run with directive 'RuntimeOptimized'.",'| Reuse mode            |             High |','| Auto Incremental      |               No |','|  Type | Matched % (of Total) | Current Reuse % (of Total) | Fixed % (of Total) | Total |','| Cells |               100.00 |                     100.00 |               0.00 |    52 |','| Non-Reused Cells      | 0.00 |'].join('\n'));
        const checkpoint=path.join(snapshot.root,'impl.dcp');await fs.writeFile(checkpoint,'routed checkpoint');
        return 'SVTOOLS_RUN_STATUS impl_design Complete! 100%\nSVTOOLS_RUN_VERSION test\nSVTOOLS_CHECKPOINT '+checkpoint+'\nSVTOOLS_DONE\n';
    }});
    const incremental=output.data.evidence.execution.incremental;
    assert.equal(incremental.requested,true);assert.equal(incremental.applied,true);assert.equal(incremental.reused,true);
    assert.equal(incremental.directive,'RuntimeOptimized');assert.equal(incremental.reuse.Cells.reused,100);
    assert(output.data.evidence.inputs.checkpoint.sha256);assert(output.data.evidence.inputs.checkpoint.size>0);
    const manifest=JSON.parse(await fs.readFile(output.artifacts.find(artifact=>artifact.kind==='manifest').path,'utf8'));
    const staged=manifest.inputs.filter(file=>file.role==='incremental-checkpoint');
    assert.equal(staged.length,1);assert(staged[0].path.endsWith('ref.dcp'));
    assert(!manifest.inputs.some(file=>file.path.endsWith('impl.dcp')));
    assert(manifest.checkpoints.some(file=>file.path.endsWith('impl.dcp')));
    assert(output.artifacts.some(artifact=>artifact.kind==='run-log'));
});

test('请求了增量检查点但工具未加载时记录为未复用',async t=>{
    const input=await fixture(t);
    await fs.writeFile(path.join(input.workspace,'ref.dcp'),'reference');
    await fs.writeFile(path.join(input.workspace,'top.xpr'),incrementalConfiguration());
    const output=await run({...input,run:'impl_1'},{runner:async({snapshot})=>{
        const base=path.basename(snapshot.project,'.xpr'),dir=path.join(path.dirname(snapshot.project),base+'.runs','impl_1');
        await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'runme.log'),'Starting impl_design\n');
        const checkpoint=path.join(snapshot.root,'impl.dcp');await fs.writeFile(checkpoint,'routed');
        return 'SVTOOLS_RUN_STATUS impl_design Complete! 100%\nSVTOOLS_CHECKPOINT '+checkpoint+'\nSVTOOLS_DONE\n';
    }});
    const incremental=output.data.evidence.execution.incremental;
    assert.equal(incremental.requested,true);assert.equal(incremental.applied,false);assert.equal(incremental.reused,false);
    assert.equal(incremental.reuse,null);assert.deepEqual(incremental.evidence,[]);
});

