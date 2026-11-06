'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');const {run}=require('../src/cli/main');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'svtools-design-workflow-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('svtools-design-workflow-'));await fs.rm(root,{recursive:true,force:true});});
    await fs.mkdir(path.join(root,'rtl'));await fs.mkdir(path.join(root,'reports'));await fs.writeFile(path.join(root,'rtl/a.sv'),'module a; endmodule\n');await fs.writeFile(path.join(root,'reports/design.md'),'Protocol fixture design notes');
    const spec={schemaVersion:1,id:'plan-a',title:'Pipeline architecture',top:'a',overview:'Two explicitly specified protocol modules',clocks:['clk: rising edge'],resets:['rst_n: active low'],requirements:[{id:'R1',text:'Output follows the specified data transform'}],modules:[{id:'a',name:'a',responsibility:'Data transform',sources:['rtl/a.sv'],requirements:['R1'],deltaSignals:['tb.q']}]};
    await fs.writeFile(path.join(root,'spec.json'),JSON.stringify(spec));return {root,spec};}
const command=(f,action,args=[])=>run(['design',action,'--workspace',f.root,...args]);
async function success(promise){const value=await promise;assert.equal(value.exitCode,0,JSON.stringify(value.output));return value.output.data;}
async function init(f){return success(command(f,'plan',['--spec','spec.json']));}
async function claim(f,role,actor,revision=0,module='a'){return success(command(f,'claim',['--module',module,'--role',role,'--actor',actor,'--revision',String(revision)]));}
async function submit(f,actor,token,revision,evidence='reports/design.md'){return success(command(f,'submit',['--module','a','--actor',actor,'--token',token,'--revision',String(revision),'--evidence',evidence]));}
async function artifact(f,file,content){await fs.writeFile(path.join(f.root,file),typeof content==='string'?content:JSON.stringify(content));return {path:file,sha256:digest(await fs.readFile(path.join(f.root,file)))};}
async function verification(f,current,{failed=false,unresolved=false}={}){
    const candidate=current.modules[0].candidateId,inputs=current.modules[0].candidateInputs;
    const tb=await artifact(f,'reports/tb.sv','// protocol fixture verification inputs'),verificationInputs=[tb];
    const compile=await artifact(f,'reports/compile.json',{schemaVersion:1,kind:'compile',candidateId:candidate,inputs:[...inputs,tb],status:'passed',exitCode:0,completed:true});
    const wave=await artifact(f,'reports/wave.vcd','$timescale 1ns $end $scope module tb $end $var wire 1 ! q $end $upscope $end $enddefinitions $end #0 0! #10 1! 0!');
    const deltaResponse=await run(['wave','glitches','--workspace',f.root,'--file',wave.path,'--signals','tb.q']);assert.equal(deltaResponse.exitCode,0);
    const delta=await artifact(f,'reports/delta.json',deltaResponse.output);
    const sim=await artifact(f,'reports/simulation.json',{schemaVersion:1,kind:'simulation',candidateId:candidate,inputs:[...inputs,tb],status:failed?'failed':'passed',exitCode:failed?1:0,completed:true,waveforms:[wave],cases:[{id:'TC1',requirements:['R1'],status:failed?'failed':'passed',oracle:'Protocol fixture independent expectation'}]});
    const log=await artifact(f,'reports/run.log','Protocol fixture run log');
    const evidence={schemaVersion:1,planId:'plan-a',moduleId:'a',candidateId:candidate,inputs,verificationInputs,checks:[
        {id:'compile',status:'passed',command:['protocol','compile'],toolVersion:'fixture-1',report:compile,log},
        {id:'simulation',status:failed?'failed':'passed',command:['protocol','simulation'],toolVersion:'fixture-1',report:sim,log},
        {id:'delta-cycle',status:'passed',command:['wave','glitches'],toolVersion:'fixture-1',report:delta,waveform:wave,dispositions:unresolved?[]:[{signal:'tb.q',t:'10',status:'resolved',reason:'Fixture explicitly expects this recorded settling pulse'}]}
    ]};await artifact(f,'reports/evidence.json',evidence);return evidence;
}
test('架构计划生成报告和稳定任务ID；只读查询不创建运行目录、不覆盖已有计划',async t=>{const f=await fixture(t);await init(f);let state=await success(command(f,'tasks'));assert.equal(state.revision,0);assert.equal(state.summary.total,1);assert.match(await fs.readFile(path.join(f.root,'svtools.design.md'),'utf8'),/R1/);await assert.rejects(fs.stat(path.join(f.root,'.svtools')),{code:'ENOENT'});assert.equal((await command(f,'plan',['--spec','spec.json'])).output.diagnostics[0].code,'PLAN_EXISTS');});
test('领取、提交、独立验证、核验和输入变化失效完整闭环',async t=>{const f=await fixture(t);await init(f);const design=await claim(f,'design','designer');assert.equal(design.revision,1);
    let state=await submit(f,'designer',design.token,1);assert.equal(state.modules[0].stage,'design-submitted');assert.equal(state.modules[0].designCurrent,true);
    const verify=await claim(f,'verification','verifier',2);await verification(f,state);state=await submit(f,'verifier',verify.token,3,'reports/evidence.json');assert.equal(state.modules[0].verification,'submitted');assert.equal(state.summary.accepted,0);
    state=await success(command(f,'review',['--module','a','--actor','coordinator','--revision','4','--reason','Reviewed specification, original logs, testcase and delta disposition']));assert.equal(state.summary.accepted,1);assert.equal(state.modules[0].independentActors,true);
    await fs.appendFile(path.join(f.root,'reports/tb.sv'),'// changed verification stimulus');state=await success(command(f,'tasks'));assert.equal(state.modules[0].verification,'stale');assert.equal(state.summary.accepted,0);
    await fs.appendFile(path.join(f.root,'rtl/a.sv'),'// changed DUT');state=await success(command(f,'tasks'));assert.equal(state.modules[0].designCurrent,false);
});
test('失败验证可提交显示失败；退回后旧令牌失效并可重新设计',async t=>{const f=await fixture(t);await init(f);const design=await claim(f,'design','d');let state=await submit(f,'d',design.token,1);const verify=await claim(f,'verification','v',2);await verification(f,state,{failed:true});state=await submit(f,'v',verify.token,3,'reports/evidence.json');assert.equal(state.modules[0].verification,'failed');
    const review=await command(f,'review',['--module','a','--actor','c','--revision','4','--reason','Should refuse failed checks']);assert.notEqual(review.exitCode,0);
    state=await success(command(f,'return',['--module','a','--actor','c','--revision','4','--reason','TC1 failed; fix transform']));assert.equal(state.modules[0].stage,'returned');assert.equal(state.history.at(-1).evidence.path,'reports/evidence.json');
    const retry=await claim(f,'design','d',5);assert.notEqual(retry.token,design.token);
    assert.notEqual((await command(f,'submit',['--module','a','--actor','d','--revision','6','--token',design.token,'--evidence','reports/design.md'])).exitCode,0);
});
test('未处置ΔCycle、错误哈希和缺失功能用例不能核验通过',async t=>{const f=await fixture(t);await init(f);const design=await claim(f,'design','d');const state=await submit(f,'d',design.token,1);const data=await verification(f,state,{unresolved:true});let checked=await command(f,'evidence',['--module','a','--evidence','reports/evidence.json']);assert.equal(checked.exitCode,1);assert.ok(checked.output.data.issues.some(issue=>/尚未处置/.test(issue.message)));
    data.checks[0].report.sha256='0'.repeat(64);await artifact(f,'reports/evidence.json',data);checked=await command(f,'evidence',['--module','a','--evidence','reports/evidence.json']);assert.equal(checked.exitCode,2);assert.equal(checked.output.diagnostics[0].code,'EVIDENCE_STALE');});
test('跨进程相同revision仅一个领取成功，不丢状态',async t=>{const f=await fixture(t);await init(f);function processClaim(actor){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(__dirname,'../src/cli/main.js'),'design','claim','--workspace',f.root,'--module','a','--role','design','--actor',actor,'--revision','0'],{windowsHide:true});let stdout='';child.stdout.on('data',chunk=>stdout+=chunk);child.once('error',reject);child.once('close',code=>resolve({code,data:JSON.parse(stdout)}));});}
    const attempts=await Promise.all([processClaim('agent-a'),processClaim('agent-b')]);assert.deepEqual(attempts.map(item=>item.code).sort(),[0,2]);assert.equal((await success(command(f,'tasks'))).revision,1);});
test('依赖门槛、共享文件归属与接口变更会约束进展',async t=>{const f=await fixture(t);f.spec.modules.push({...f.spec.modules[0],id:'b',name:'b',dependencies:[{module:'a',gate:'submitted'}]});await fs.writeFile(path.join(f.root,'spec.json'),JSON.stringify(f.spec));await init(f);let state=await success(command(f,'tasks'));assert.deepEqual(state.modules[1].blockedBy,['a']);const d=await claim(f,'design','d');state=await submit(f,'d',d.token,1);assert.deepEqual(state.modules[1].blockedBy,[]);
    const next=await claim(f,'design','d',2);const collision=await command(f,'claim',['--module','b','--role','design','--actor','other','--revision','3']);assert.equal(collision.output.diagnostics[0].code,'TASK_BLOCKED');
    const plan=JSON.parse(await fs.readFile(path.join(f.root,'svtools.design.json'),'utf8'));plan.modules[0].interfaceVersion='2';await fs.writeFile(path.join(f.root,'svtools.design.json'),JSON.stringify(plan));state=await success(command(f,'tasks'));assert.equal(state.modules[0].designCurrent,false);assert.ok(next.token);});
test('计划约束拒绝目录逃逸、循环依赖和原型键，状态读路径拒绝链接',async t=>{for(const mutate of [spec=>spec.modules[0].sources=['../outside.sv'],spec=>spec.modules[0].sources=['.GIT/config'],spec=>spec.modules[0].sources=['rtl/a.sv:stream'],spec=>spec.modules[0].dependencies=[{module:'a'}],spec=>spec.modules[0].id='__proto__']){const f=await fixture(t);mutate(f.spec);await fs.writeFile(path.join(f.root,'spec.json'),JSON.stringify(f.spec));assert.equal((await command(f,'plan',['--spec','spec.json'])).exitCode,2);}
    const f=await fixture(t);await init(f);await fs.mkdir(path.join(f.root,'.svtools'));await fs.symlink(os.tmpdir(),path.join(f.root,'.svtools','agent'),process.platform==='win32'?'junction':'dir');const response=await command(f,'claim',['--module','a','--role','design','--actor','d','--revision','0']);assert.equal(response.exitCode,2);assert.equal(response.output.diagnostics[0].code,'UNSAFE_PATH');});

test('ΔCycle 不能跳过计划信号或缩短窗口；验证输入不能冒用设计源',async t=>{
    const f=await fixture(t);await init(f);const d=await claim(f,'design','d');const state=await submit(f,'d',d.token,1);const data=await verification(f,state);
    const deltaFile=path.join(f.root,'reports/delta.json');const report=JSON.parse(await fs.readFile(deltaFile,'utf8'));
    report.data.to='5';data.checks[2].report=await artifact(f,'reports/delta.json',report);await artifact(f,'reports/evidence.json',data);
    let result=await command(f,'evidence',['--module','a','--evidence','reports/evidence.json']);assert.equal(result.exitCode,1);assert.ok(result.output.data.issues.some(issue=>/时间范围/.test(issue.message)));
    report.data.to='10';report.data.series[0].path='tb.other';data.checks[2].report=await artifact(f,'reports/delta.json',report);await artifact(f,'reports/evidence.json',data);
    result=await command(f,'evidence',['--module','a','--evidence','reports/evidence.json']);assert.ok(result.output.data.issues.some(issue=>/缺少计划信号/.test(issue.message)));
    data.verificationInputs=data.inputs;await artifact(f,'reports/evidence.json',data);assert.equal((await command(f,'evidence',['--module','a','--evidence','reports/evidence.json'])).exitCode,2);
});
test('架构报告可显式重生成；设计说明变化会撤销当前候选',async t=>{
    const f=await fixture(t);await init(f);const d=await claim(f,'design','d');await submit(f,'d',d.token,1);
    await fs.appendFile(path.join(f.root,'reports/design.md'),'changed contract discussion');assert.equal((await success(command(f,'tasks'))).modules[0].designCurrent,false);
    const planFile=path.join(f.root,'svtools.design.json'),plan=JSON.parse(await fs.readFile(planFile,'utf8'));plan.title='Changed plan';await fs.writeFile(planFile,JSON.stringify(plan));
    assert.notEqual((await command(f,'plan-report')).exitCode,0);await success(command(f,'plan-report',['--force']));assert.match(await fs.readFile(path.join(f.root,'svtools.design.md'),'utf8'),/Changed plan/);
    assert.equal((await command(f,'plan-report',['--out','reports/design.md','--force'])).exitCode,2);
});
test('依赖候选变化会连带撤销下游设计当前性',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.root,'rtl/b.sv'),'module b; endmodule');
    f.spec.modules.push({...f.spec.modules[0],id:'b',name:'b',sources:['rtl/b.sv'],dependencies:[{module:'a',gate:'submitted'}]});
    await fs.writeFile(path.join(f.root,'spec.json'),JSON.stringify(f.spec));await init(f);const d=await claim(f,'design','d');await submit(f,'d',d.token,1);
    const b=await claim(f,'design','d',2,'b');await success(command(f,'submit',['--module','b','--actor','d','--token',b.token,'--revision','3','--evidence','reports/design.md']));
    assert.equal((await success(command(f,'tasks'))).modules[1].designCurrent,true);await fs.appendFile(path.join(f.root,'rtl/a.sv'),'// new upstream');
    assert.equal((await success(command(f,'tasks'))).modules[1].designCurrent,false);
});
