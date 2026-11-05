'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const tool=path.resolve(__dirname,'..'),{run}=require(path.join(tool,'src/cli/main'));
const {parseArgs}=require('node:util');
const {values}=parseArgs({options:{iverilog:{type:'string'},cygwin:{type:'string'}}});
const {findIverilogBinDir,findCygwinBinDir,buildChildEnv}=require(path.join(tool,'src/toolchains/iverilog'));
const toolBin=findIverilogBinDir(values.iverilog);
assert.ok(toolBin,'Icarus 不可用；使用 --iverilog <bin> 指定安装位置');
const root=path.join(tool,'bin','workflow-e2e-'+Date.now());
const env={...buildChildEnv(findCygwinBinDir(values.cygwin,toolBin)),IVERILOG_DUMPER:'vcd'};
const outcomes=[];
async function command(action,args=[]){const r=await run(['design',action,'--workspace',root,...args]);assert.equal(r.exitCode,0,JSON.stringify(r.output));return r.output.data;}
async function file(name,bytes){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),typeof bytes==='string'?bytes:JSON.stringify(bytes,null,2));return ref(name);}
async function ref(name){return {path:name,sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex')};}
function execute(exe,args){return new Promise((resolve,reject)=>{const child=spawn(exe,args,{cwd:root,env,windowsHide:true});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));});}
async function main(){
    await fs.mkdir(root,{recursive:true});
    const rtl="module transform(input clk, input rst_n, input [7:0] d, output reg [7:0] q); always @(posedge clk or negedge rst_n) if (!rst_n) q <= 0; else q <= ~d; endmodule\n";
    await file('rtl/transform.sv',rtl);
    await file('sim/tb.sv',`module tb;
reg clk=0, rst_n=1; reg [7:0] d=0; wire [7:0] q;
transform dut(clk,rst_n,d,q);
always #5 clk=~clk;
integer i; reg [7:0] expected;
initial begin
 $dumpfile(".svtools/vcd/tb.vcd"); $dumpvars(0,tb);
 #1; rst_n=0; #1; if(q!==0) $fatal(1,"reset mismatch");
 #1; rst_n=1;
 for(i=0;i<16;i=i+1) begin
   @(negedge clk); d=i*13;
   @(posedge clk); expected=d ^ 8'hff;
   #1; if(q!==expected) $fatal(1,"TC1_FAIL input=%h got=%h expected=%h",d,q,expected);
 end
 $display("TC1_PASS 16 independent expected-value comparisons"); $finish;
end
endmodule
`);
    await file('reports/design.md','Registered inverter, asynchronous active-low reset, 8-bit data. RTL ownership is design; TB owns independent XOR reference.');
    await file('spec.json',{schemaVersion:1,id:'m5-real-e2e',title:'M5 real Icarus trial',top:'transform',overview:'Synchronous transform evidence chain',clocks:['clk rising edge'],resets:['rst_n asynchronous low'],requirements:[{id:'R1',text:'After reset q is registered bitwise inverse of sampled d'}],modules:[{id:'transform',name:'transform',responsibility:'Registered inversion',sources:['rtl/transform.sv'],requirements:['R1'],deltaSignals:['tb.clk','tb.rst_n','tb.q']}]});
    await command('plan',['--spec','spec.json']);await fs.mkdir(path.join(root,'.svtools','vcd'),{recursive:true});
    const compiler=path.join(toolBin,process.platform==='win32'?'iverilog.exe':'iverilog'),runtime=path.join(toolBin,process.platform==='win32'?'vvp.exe':'vvp');
    const version=(await execute(compiler,['-V'])).stdout.split('\n')[0];
    async function cycle(label,expectedPass){
        let state=await command('tasks');const design=await command('claim',['--module','transform','--role','design','--actor','design-phase','--revision',String(state.revision)]);
        state=await command('submit',['--module','transform','--actor','design-phase','--token',design.token,'--revision',String(design.revision),'--evidence','reports/design.md']);
        const verify=await command('claim',['--module','transform','--role','verification','--actor','verification-phase','--revision',String(state.revision)]);
        const candidateId=state.modules[0].candidateId,inputs=state.modules[0].candidateInputs,verificationInputs=[await ref('sim/tb.sv')];
        const compileArgs=['-g2012','-s','tb','-o','simulation.vvp','rtl/transform.sv','sim/tb.sv'];
        const compiled=await execute(compiler,compileArgs);assert.equal(compiled.code,0,compiled.stderr);
        const compileLog=await file('reports/'+label+'-compile.log',compiled.stdout+compiled.stderr);
        const compile=await file('reports/'+label+'-compile.json',{schemaVersion:1,kind:'compile',candidateId,inputs:[...inputs,...verificationInputs],status:'passed',completed:true,exitCode:compiled.code});
        const simulated=await execute(runtime,['simulation.vvp']);assert.equal(simulated.code===0,expectedPass,simulated.stdout+simulated.stderr);
        const passed=simulated.code===0&&simulated.stdout.includes('TC1_PASS');
        const simLog=await file('reports/'+label+'-simulation.log',simulated.stdout+simulated.stderr),waveform=await ref('.svtools/vcd/tb.vcd');
        const sim=await file('reports/'+label+'-simulation.json',{schemaVersion:1,kind:'simulation',candidateId,inputs:[...inputs,...verificationInputs],status:passed?'passed':'failed',completed:true,exitCode:simulated.code,waveforms:[waveform],cases:[{id:'TC1',requirements:['R1'],status:passed?'passed':'failed',oracle:'16 observed DUT outputs compared to independent sampled d XOR 8hff; reset checked at t=2'}]});
        const query=['wave','glitches','--workspace',root,'--file',waveform.path,'--signals','tb.clk,tb.rst_n,tb.q'];
        const glitches=await run(query);assert.equal(glitches.exitCode,0);assert.equal(glitches.output.data.complete,true);
        // 真实记录若有同刻活动须人工解释；此试点预期没有被文件记录的同刻瞬态。
        assert.equal(glitches.output.data.matched,0,JSON.stringify(glitches.output.data.series));
        const delta=await file('reports/'+label+'-delta.json',glitches.output);
        const evidenceFile='reports/'+label+'-evidence.json';await file(evidenceFile,{schemaVersion:1,planId:'m5-real-e2e',moduleId:'transform',candidateId,inputs,verificationInputs,checks:[
            {id:'compile',status:'passed',command:[compiler,...compileArgs],toolVersion:version,report:compile,log:compileLog},
            {id:'simulation',status:passed?'passed':'failed',command:[runtime,'simulation.vvp'],toolVersion:version,report:sim,log:simLog},
            {id:'delta-cycle',status:'passed',command:['node',path.join(tool,'src/cli/main.js'),...query],toolVersion:require(path.join(tool,'package.json')).version,report:delta,waveform,dispositions:[]}
        ]});
        state=await command('submit',['--module','transform','--actor','verification-phase','--token',verify.token,'--revision',String(verify.revision),'--evidence',evidenceFile]);
        if(passed){state=await command('review',['--module','transform','--actor','review-phase','--revision',String(state.revision),'--reason','Reviewed actual compiler/simulator logs, independent XOR checks and full recorded DeltaCycle query; single Agent phased execution.']);assert.equal(state.summary.accepted,1);}
        else {assert.equal(state.modules[0].verification,'failed');const review=await run(['design','review','--workspace',root,'--module','transform','--actor','review-phase','--revision',String(state.revision),'--reason','Must refuse failed functionality']);assert.notEqual(review.exitCode,0);}
        outcomes.push({label,compilerExit:compiled.code,simulationExit:simulated.code,verification:state.modules[0].verification,accepted:state.summary.accepted});return state;
    }
    await cycle('baseline',true);
    await file('rtl/transform.sv',rtl.replace('q <= ~d','q <= d'));let state=await command('tasks');assert.equal(state.modules[0].designCurrent,false);assert.equal(state.summary.accepted,0);
    await command('return',['--module','transform','--actor','review-phase','--revision',String(state.revision),'--reason','Inject wrong transform and verify same checker catches defect']);
    state=await cycle('injected-defect',false);
    await command('return',['--module','transform','--actor','review-phase','--revision',String(state.revision),'--reason','TC1 fails independent XOR expected value; restore inverse transform']);
    await file('rtl/transform.sv',rtl);await cycle('repaired',true);
    await fs.appendFile(path.join(root,'sim/tb.sv'),'// verification input changed\n');state=await command('tasks');assert.equal(state.modules[0].verification,'stale');assert.equal(state.summary.accepted,0);
    const {projectProgress}=require(path.join(tool,'src/project/progress'));const progress=await projectProgress({id:'e2e',root});assert.equal(progress.snapshot.summary.stale,1);
    const summary={root,version,outcomes,tbEditDetected:true,progressReadOnly:progress.snapshot.readOnly,execution:'single-agent-phased',independentAgentExecution:false};await file('reports/summary.json',summary);console.log(JSON.stringify(summary,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
